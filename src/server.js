import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPin, signSession, verifySession, parseCookies, LoginLimiter } from './auth.js';
import { createWaker } from './wake.js';
import { isAwake } from './probe.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'macon_session';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Builds the HTTP server. The server exposes exactly one capability - waking the single Mac in `cfg` -
 * and never accepts a target (MAC/host) from a request.
 */
export function createServer(cfg, deps = {}) {
  const waker = deps.waker ?? createWaker(cfg, { awake: () => isAwake(cfg) });
  const limiter = deps.limiter ?? new LoginLimiter();
  const awakeFn = deps.awake ?? (() => isAwake(cfg));
  const ttlMs = cfg.sessionDays * 86_400_000;
  const log = deps.log ?? (() => {});

  const clientKey = (req) =>
    (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  const isSecure = (req) => req.socket.encrypted || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const authed = (req) => verifySession(cfg.secret, parseCookies(req.headers.cookie)[COOKIE]);

  function send(res, status, body, headers = {}) {
    const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readJson(req, limit = 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, { error: 'not found' });
    }
    const ext = path.extname(file);
    const immutable = rel.startsWith('icons/');
    send(res, 200, fs.readFileSync(file), {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=86400' : rel === 'sw.js' ? 'no-cache' : 'no-store',
    });
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const { pathname } = url;

      if (pathname === '/healthz') return send(res, 200, { ok: true });

      if (pathname.startsWith('/api/')) {
        // CSRF: state-changing calls must carry a custom header (forces a CORS preflight, which we never grant).
        if (req.method === 'POST' && req.headers['x-macon'] !== '1') return send(res, 403, { error: 'forbidden' });

        if (pathname === '/api/login' && req.method === 'POST') {
          const key = clientKey(req);
          const wait = limiter.retryAfter(key);
          if (wait > 0) return send(res, 429, { error: 'Too many attempts. Try again later.', retryAfterSec: Math.ceil(wait / 1000) }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
          const body = await readJson(req);
          if (typeof body.pin === 'string' && body.pin.length <= 128 && verifyPin(body.pin, cfg.pinHash)) {
            limiter.success(key);
            const token = signSession(cfg.secret, ttlMs);
            const cookie = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}${isSecure(req) ? '; Secure' : ''}`;
            log('login ok', key);
            return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
          }
          limiter.fail(key);
          log('login failed', key);
          return send(res, 401, { error: 'Wrong PIN' });
        }

        if (pathname === '/api/logout' && req.method === 'POST') {
          return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
        }

        if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

        if (pathname === '/api/status' && req.method === 'GET') {
          const wake = waker.status();
          // Only probe the network when idle; during a wake the waker is already polling.
          const awake = ['sending', 'waiting'].includes(wake.state) ? null : await awakeFn();
          return send(res, 200, { name: cfg.name, awake, canConfirm: Boolean(cfg.macIp), wake });
        }

        if (pathname === '/api/wake' && req.method === 'POST') {
          const r = waker.start();
          log('wake', r.started ? 'started' : r.reason);
          return send(res, r.started ? 202 : 200, { started: r.started, reason: r.reason, wake: r.job });
        }

        return send(res, 404, { error: 'not found' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      return serveStatic(req, res, pathname);
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
    }
  };

  const server = http.createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return Object.assign(server, { waker, limiter });
}
