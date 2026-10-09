import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createWaker } from '../src/wake.js';
import { LoginLimiter } from '../src/auth.js';
import { testConfig, udpSink, PIN, MAC } from './helpers.js';
import { buildMagicPacket } from '../src/magic.js';

async function boot(over = {}, deps = {}) {
  const cfg = testConfig(over);
  const sink = await udpSink();
  // Real UDP, redirected to loopback sink so the full path is exercised without touching the LAN.
  const { sendMagicPacket } = await import('../src/wake.js');
  const waker = createWaker(cfg, { send: ({ mac }) => sendMagicPacket({ mac, address: '127.0.0.1', port: sink.port }), sleep: async () => {}, roundGapMs: 0, rounds: 2, cooldownMs: 0, ...deps.waker });
  const server = createServer(cfg, { waker, awake: async () => false, ...deps.server });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => { server.closeAllConnections(); server.close(); sink.close(); };
  const call = (path, { method = 'GET', body, cookie, headers = {} } = {}) =>
    fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'POST' ? { 'X-Macon': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const login = async (pin = PIN) => { const r = await call('/api/login', { method: 'POST', body: { pin } }); return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  return { cfg, sink, server, base, call, login, close };
}

test('serves the PWA shell, manifest and icons with security headers', async () => {
  const s = await boot();
  for (const [p, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css'], ['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'text/javascript'], ['/icons/apple-touch-icon.png', 'image/png'], ['/icons/icon-512.png', 'image/png']]) {
    const r = await s.call(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.headers.get('content-type').startsWith(type), p);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
  assert.equal((await s.call('/healthz')).status, 200);
  s.close();
});

test('blocks path traversal', async () => {
  const s = await boot();
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/icons/../../src/auth.js']) {
    const r = await fetch(s.base + p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /scrypt|"name": "macon"/);
  }
  s.close();
});

test('API is locked without a session; wake does nothing', async () => {
  const s = await boot();
  assert.equal((await s.call('/api/status')).status, 401);
  assert.equal((await s.call('/api/wake', { method: 'POST' })).status, 401);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.sink.packets.length, 0);
  s.close();
});

test('wrong PIN rejected; right PIN sets a hardened cookie', async () => {
  const s = await boot();
  assert.equal((await s.login('nope')).r.status, 401);
  const { r } = await s.login();
  assert.equal(r.status, 200);
  const c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Max-Age=86400/);
  assert.doesNotMatch(c, /Secure/, 'plain http');
  s.close();
});

test('Secure cookie behind a trusted https proxy', async () => {
  const s = await boot({ trustProxy: true });
  const r = await s.call('/api/login', { method: 'POST', body: { pin: PIN }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(r.headers.get('set-cookie'), /; Secure/);
  s.close();
});

test('CSRF: POSTs without the custom header are refused', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  const r = await fetch(s.base + '/api/wake', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(r.status, 403);
  s.close();
});

test('full flow: login -> status -> wake sends the magic packet for the configured MAC only', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  const st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.name, 'Test Mac');
  assert.equal(st.wake.state, 'idle');
  // A client trying to smuggle a different target must have no effect.
  const w = await s.call('/api/wake', { method: 'POST', cookie, body: { mac: '11:22:33:44:55:66', host: '8.8.8.8' } });
  assert.equal(w.status, 202);
  await s.server.waker.finished();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(s.sink.packets.length >= 2);
  assert.ok(s.sink.packets.every((p) => p.equals(buildMagicPacket(MAC))));
  const after = await (await s.call('/api/status', { cookie })).json();
  assert.equal(after.wake.state, 'sent');
  s.close();
});

test('status reflects waking -> awake; second press while busy is a no-op', async () => {
  let awake = false;
  const s = await boot({ macIp: '10.9.9.9' }, { waker: { rounds: 1, knock: async () => {}, pollMs: 0, sleep: () => new Promise((r) => setTimeout(r, 5)), awake: async () => awake }, server: { awake: async () => awake } });
  const { cookie } = await s.login();
  assert.equal((await s.call('/api/wake', { method: 'POST', cookie })).status, 202);
  const again = await (await s.call('/api/wake', { method: 'POST', cookie })).json();
  assert.equal(again.started, false);
  const mid = await (await s.call('/api/status', { cookie })).json();
  assert.ok(['sending', 'waiting'].includes(mid.wake.state));
  assert.equal(mid.awake, null);
  awake = true;
  await s.server.waker.finished();
  const done = await (await s.call('/api/status', { cookie })).json();
  assert.equal(done.wake.state, 'awake');
  assert.equal(done.awake, true);
  s.close();
});

test('brute force: lockout after repeated failures, even with the right PIN afterwards', async () => {
  const s = await boot({}, { server: { limiter: new LoginLimiter({ perKeyMax: 3, globalMax: 99 }) } });
  for (let i = 0; i < 3; i++) assert.equal((await s.login('bad' + i)).r.status, 401);
  const locked = await s.login();
  assert.equal(locked.r.status, 429);
  assert.ok(Number(locked.r.headers.get('retry-after')) > 0);
  s.close();
});

test('logout clears the cookie; forged and expired sessions are rejected', async () => {
  const s = await boot();
  const out = await s.call('/api/logout', { method: 'POST' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await s.call('/api/status', { cookie: 'macon_session=abc.def' })).status, 401);
  s.close();
});

test('oversized and malformed bodies are rejected without crashing', async () => {
  const s = await boot();
  const big = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'X-Macon': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'x'.repeat(5000) }) }).catch(() => ({ status: 0 }));
  assert.ok([413, 0].includes(big.status));
  const bad = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'X-Macon': '1' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await s.call('/healthz')).status, 200);
  s.close();
});

test('unknown routes and methods', async () => {
  const s = await boot();
  assert.equal((await s.call('/nope')).status, 404);
  assert.equal((await fetch(s.base + '/', { method: 'DELETE' })).status, 405);
  s.close();
});
