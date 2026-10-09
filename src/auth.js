import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

export function verifyPin(pin, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const dk = crypto.scryptSync(String(pin), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/** Stateless signed session token: base64url(payload).base64url(hmac). */
export function signSession(secret, ttlMs, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + ttlMs, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return false;
  const want = crypto.createHmac('sha256', secret).update(payload).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > now;
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Failed-login limiter. Tracks per-key failures and a global total, because behind a
 * reverse proxy / Tailscale serve every client can share one source address.
 */
export class LoginLimiter {
  constructor({ perKeyMax = 5, globalMax = 20, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { perKeyMax, globalMax, windowMs, now });
    this.keys = new Map();
    this.global = [];
  }
  _prune(arr) {
    const cut = this.now() - this.windowMs;
    while (arr.length && arr[0] < cut) arr.shift();
    return arr;
  }
  /** Returns ms to wait (0 if allowed). */
  retryAfter(key) {
    const g = this._prune(this.global);
    const k = this._prune(this.keys.get(key) || []);
    const tooMany = (arr, max) => (arr.length >= max ? arr[0] + this.windowMs - this.now() : 0);
    return Math.max(tooMany(k, this.perKeyMax), tooMany(g, this.globalMax), 0);
  }
  fail(key) {
    const t = this.now();
    this.global.push(t);
    const arr = this.keys.get(key) || [];
    arr.push(t);
    this.keys.set(key, arr);
    if (this.keys.size > 1000) for (const [k, v] of this.keys) if (!this._prune(v).length) this.keys.delete(k);
  }
  success(key) {
    this.keys.delete(key);
  }
}
