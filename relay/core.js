// Relay core: Web-standard (Request / Response / WebCrypto) so the same code runs in a Cloudflare
// Worker Durable Object and, for tests and self-hosting, in plain Node 20+.
//
// Model: the phone records a wake *request*; the Mac agent polls, acts, and *acks*. The relay never
// talks to the Mac - the Mac always calls out - so nothing at home needs to be exposed or running.

const enc = new TextEncoder();

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

const toB64u = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (str) => {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

async function hmacBytes(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const hmacB64u = async (key, msg) => toB64u(await hmacBytes(key, msg));

/** Constant-time string compare that also hides length differences. */
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([hmacBytes('cmp', String(a)), hmacBytes('cmp', String(b))]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/**
 * Keyed PIN digest. PIN_KEY lives only in the Worker's encrypted secrets, so the digest is not
 * brute-forceable offline, and online guessing is stopped by the persistent lockout below.
 * (scrypt/PBKDF2 would blow the Workers free-tier CPU budget.)
 */
export const pinDigest = (pinKey, pin) => hmacB64u(pinKey, `pin:${pin}`);

const parseCookies = (header = '') => {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

const COOKIE = 'macon_session';
const RL = { perIpMax: 5, globalMax: 20, windowMs: 15 * 60_000 };

export function configProblems(env) {
  const bad = [];
  for (const k of ['PIN_KEY', 'PIN_HMAC']) if (!env[k]) bad.push(k);
  for (const k of ['SESSION_SECRET', 'AGENT_TOKEN']) if (!env[k] || String(env[k]).length < 32) bad.push(`${k} (>=32 chars)`);
  return bad;
}

export function createRelay(env, store, opts = {}) {
  const now = opts.now ?? Date.now;
  const ttlMs = (Number(env.WAKE_TTL_SEC) || 1200) * 1000;
  const sessionMs = (Number(env.SESSION_DAYS) || 90) * 86_400_000;
  const name = env.NAME || 'My Mac';
  const FRESH_MS = 45_000; // an agent that polled this recently means "the Mac is running right now"

  const respond = (body, status = 200, headers = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: {
        ...SECURITY_HEADERS,
        'Cache-Control': 'no-store',
        'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        ...headers,
      },
    });

  const blank = () => ({ seq: 0, request: null, agent: null });
  const loadState = async () => (await store.get('state')) ?? blank();

  async function sessionToken(t) {
    const payload = toB64u(enc.encode(JSON.stringify({ exp: t + sessionMs, n: crypto.randomUUID() })));
    return `${payload}.${await hmacB64u(env.SESSION_SECRET, `session:${payload}`)}`;
  }
  async function sessionValid(token, t) {
    if (typeof token !== 'string') return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    if (!(await safeEqual(sig, await hmacB64u(env.SESSION_SECRET, `session:${payload}`)))) return false;
    try {
      return JSON.parse(new TextDecoder().decode(fromB64u(payload))).exp > t;
    } catch {
      return false;
    }
  }
  const authed = (request) => sessionValid(parseCookies(request.headers.get('cookie') || '')[COOKIE], now());
  async function agentAuthed(request) {
    const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
    return Boolean(m) && (await safeEqual(m[1], env.AGENT_TOKEN));
  }

  const pending = (st, t) => Boolean(st.request && !st.request.ackedAt && t - st.request.at <= ttlMs);

  function view(st, t) {
    const r = st.request;
    const a = st.agent;
    const fresh = Boolean(a && t - a.lastSeenAt < FRESH_MS);
    let state = 'idle';
    if (r && !r.ackedAt) state = t - r.at <= ttlMs ? 'queued' : 'expired';
    else if (r && r.ackedAt && t - r.ackedAt < 120_000) state = 'awake';
    const expectedBy = state === 'queued' && a ? (fresh && a.awake === 1 ? a.lastSeenAt + 20_000 : a.lastSeenAt + a.intervalSec * 1000) : null;
    return {
      now: t,
      name,
      awake: a ? (fresh ? a.awake === 1 : false) : null,
      canConfirm: true,
      mode: 'relay',
      wake: { state, requestedAt: r?.at ?? null, ackedAt: r?.ackedAt ?? null, expectedBy, ttlSec: ttlMs / 1000 },
      relay: { agentSeenAt: a?.lastSeenAt ?? null, agentOnline: fresh, intervalSec: a?.intervalSec ?? null, onAC: a ? a.ac === 1 : null },
    };
  }

  // ---- login throttling (persisted, so it survives Durable Object eviction) ----
  async function lockWait(ip, t) {
    const rl = (await store.get('rl')) ?? { g: [], ip: {} };
    const cut = t - RL.windowMs;
    const g = rl.g.filter((x) => x > cut);
    const k = (rl.ip[ip] ?? []).filter((x) => x > cut);
    const w = (arr, max) => (arr.length >= max ? arr[0] + RL.windowMs - t : 0);
    return Math.max(w(k, RL.perIpMax), w(g, RL.globalMax), 0);
  }
  async function recordLogin(ip, ok, t) {
    // No non-storage awaits between get and put: the Durable Object serialises storage access.
    const rl = (await store.get('rl')) ?? { g: [], ip: {} };
    const cut = t - RL.windowMs;
    rl.g = rl.g.filter((x) => x > cut);
    for (const k of Object.keys(rl.ip)) {
      rl.ip[k] = rl.ip[k].filter((x) => x > cut);
      if (!rl.ip[k].length) delete rl.ip[k];
    }
    if (ok) delete rl.ip[ip];
    else {
      rl.g.push(t);
      (rl.ip[ip] ??= []).push(t);
    }
    await store.put('rl', rl);
  }

  async function readJson(request, limit = 1024) {
    const text = await request.text();
    if (text.length > limit) throw Object.assign(new Error('too large'), { status: 413 });
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw Object.assign(new Error('bad json'), { status: 400 });
    }
  }

  const clampInt = (v, lo, hi, d) => {
    const n = Number(v);
    return v !== null && v !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };

  async function handle(request) {
    try {
      const bad = configProblems(env);
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if (!path.startsWith('/api/')) return respond({ error: 'not found' }, 404);
      if (bad.length) return respond({ error: `Relay not configured: missing ${bad.join(', ')}` }, 503);
      const ip = request.headers.get('x-client-ip') || request.headers.get('cf-connecting-ip') || 'unknown';

      // ---------- Mac agent (bearer token) ----------
      if (path.startsWith('/api/agent/')) {
        if (!(await agentAuthed(request))) return respond('unauthorized\n', 401);

        if (path === '/api/agent/poll' && method === 'GET') {
          const t = now();
          const q = url.searchParams;
          const st = await loadState();
          st.agent = {
            lastSeenAt: t,
            intervalSec: clampInt(q.get('interval'), 15, 86_400, st.agent?.intervalSec ?? 300),
            awake: clampInt(q.get('awake'), 0, 1, 0),
            ac: clampInt(q.get('ac'), 0, 1, 1),
            v: clampInt(q.get('v'), 0, 999, 0),
          };
          await store.put('state', st);
          const wake = pending(st, t);
          // Plain key=value lines so the Mac agent needs no JSON parser.
          return respond(
            `wake=${wake ? 1 : 0}\n${wake ? `id=${st.request.id}\nage=${Math.floor((t - st.request.at) / 1000)}\n` : ''}ttl=${ttlMs / 1000}\nnow=${Math.floor(t / 1000)}\n`,
          );
        }
        if (path === '/api/agent/ack' && method === 'POST') {
          const t = now();
          const id = clampInt(url.searchParams.get('id'), 1, Number.MAX_SAFE_INTEGER, 0);
          const st = await loadState();
          if (st.request && st.request.id === id && !st.request.ackedAt) {
            st.request.ackedAt = t;
            await store.put('state', st);
            return respond('ok\n');
          }
          return respond('stale\n');
        }
        return respond('not found\n', 404);
      }

      // ---------- Phone (PIN session) ----------
      if (method === 'POST' && request.headers.get('x-macon') !== '1') return respond({ error: 'forbidden' }, 403);

      if (path === '/api/login' && method === 'POST') {
        const wait = await lockWait(ip, now());
        if (wait > 0) {
          const s = Math.ceil(wait / 1000);
          return respond({ error: 'Too many attempts. Try again later.', retryAfterSec: s }, 429, { 'Retry-After': String(s) });
        }
        const body = await readJson(request);
        const ok = typeof body.pin === 'string' && body.pin.length > 0 && body.pin.length <= 128 && (await safeEqual(await pinDigest(env.PIN_KEY, body.pin), env.PIN_HMAC));
        const t = now();
        await recordLogin(ip, ok, t);
        if (!ok) return respond({ error: 'Wrong PIN' }, 401);
        const token = await sessionToken(t);
        return respond({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${Math.floor(sessionMs / 1000)}` });
      }
      if (path === '/api/logout' && method === 'POST') {
        return respond({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0` });
      }

      if (!(await authed(request))) return respond({ error: 'unauthorized' }, 401);

      if (path === '/api/status' && method === 'GET') return respond(view(await loadState(), now()));

      if (path === '/api/wake' && method === 'POST') {
        const t = now();
        const st = await loadState();
        if (pending(st, t)) return respond({ started: false, reason: 'busy', ...view(st, t) });
        st.request = { id: st.seq + 1, at: t, ackedAt: null };
        st.seq += 1;
        await store.put('state', st);
        return respond({ started: true, ...view(st, t) }, 202);
      }
      return respond({ error: 'not found' }, 404);
    } catch (e) {
      return respond({ error: e.status ? e.message : 'internal error' }, e.status || 500);
    }
  }

  return { handle };
}

/** In-memory store for tests / single-process self-hosting. */
export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(k) { const v = this.m.get(k); return v === undefined ? undefined : structuredClone(v); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
}
