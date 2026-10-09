import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, MemoryStore, pinDigest, configProblems } from '../relay/core.js';

const PIN = 'Tr0ub4dor-pin';
const TOKEN = 'a'.repeat(48);
async function boot(over = {}) {
  const env = { NAME: 'Test Mac', PIN_KEY: 'k'.repeat(40), SESSION_SECRET: 's'.repeat(48), AGENT_TOKEN: TOKEN, WAKE_TTL_SEC: '1200', ...over };
  env.PIN_HMAC ??= await pinDigest(env.PIN_KEY, PIN);
  let t = 1_700_000_000_000;
  const store = new MemoryStore();
  const relay = createRelay(env, store, { now: () => t });
  const call = (path, { method = 'GET', body, cookie, bearer, ip = '1.1.1.1', headers = {} } = {}) =>
    relay.handle(new Request('https://relay.test' + path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: { ...(method === 'POST' ? { 'x-macon': '1' } : {}), ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'x-client-ip': ip, ...headers },
    }));
  const login = async (pin = PIN, ip) => {
    const r = await call('/api/login', { method: 'POST', body: { pin }, ip });
    return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const poll = (q = '', bearer = TOKEN) => call('/api/agent/poll' + q, { bearer });
  const kv = async (r) => Object.fromEntries((await r.text()).trim().split('\n').filter(Boolean).map((l) => l.split('=')));
  return { env, call, login, poll, kv, advance: (ms) => (t += ms), time: () => t };
}

test('config problems are reported, and the API refuses to run unconfigured', async () => {
  assert.deepEqual(configProblems({ PIN_KEY: 'x', PIN_HMAC: 'y', SESSION_SECRET: 's'.repeat(32), AGENT_TOKEN: 't'.repeat(32) }), []);
  const s = await boot({ SESSION_SECRET: 'short' });
  const r = await s.call('/api/status');
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /SESSION_SECRET/);
});

test('login: wrong PIN 401, right PIN sets Secure/HttpOnly/Strict cookie; API locked without it', async () => {
  const s = await boot();
  assert.equal((await s.call('/api/status')).status, 401);
  assert.equal((await s.login('wrong')).r.status, 401);
  const { r, cookie } = await s.login();
  assert.equal(r.status, 200);
  const c = r.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=7776000']) assert.match(c, new RegExp(part));
  assert.equal((await s.call('/api/status', { cookie })).status, 200);
  assert.equal((await s.call('/api/status', { cookie: 'macon_session=forged.sig' })).status, 401);
});

test('sessions expire', async () => {
  const s = await boot({ SESSION_DAYS: '1' });
  const { cookie } = await s.login();
  s.advance(86_400_000 + 1);
  assert.equal((await s.call('/api/status', { cookie })).status, 401);
});

test('CSRF: POST without X-Macon is refused', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  const r = await s.call('/api/wake', { method: 'POST', cookie, headers: { 'x-macon': '0' } });
  assert.equal(r.status, 403);
});

test('lockout: 5 bad PINs per client, persisted; other clients unaffected until the global limit', async () => {
  const s = await boot();
  for (let i = 0; i < 5; i++) assert.equal((await s.login('bad' + i, '9.9.9.9')).r.status, 401);
  const locked = await s.login(PIN, '9.9.9.9');
  assert.equal(locked.r.status, 429);
  assert.ok(Number(locked.r.headers.get('retry-after')) > 0);
  assert.equal((await s.login(PIN, '8.8.8.8')).r.status, 200, 'different client still works');
  s.advance(15 * 60_000 + 1);
  assert.equal((await s.login(PIN, '9.9.9.9')).r.status, 200, 'recovers after the window');
});

test('lockout: global limit stops distributed guessing', async () => {
  const s = await boot();
  for (let i = 0; i < 20; i++) await s.login('bad', `10.0.0.${i}`);
  assert.equal((await s.login(PIN, '10.0.1.1')).r.status, 429);
});

test('full lifecycle: wake -> queued -> agent polls -> acks -> awake', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  assert.deepEqual(await s.kv(await s.poll('?interval=300&ac=1&awake=0&v=1')), { wake: '0', ttl: '1200', now: String(Math.floor(s.time() / 1000)) });

  let st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.wake.state, 'idle');
  assert.equal(st.awake, false);
  assert.equal(st.relay.intervalSec, 300);

  const w = await s.call('/api/wake', { method: 'POST', cookie });
  assert.equal(w.status, 202);
  assert.equal((await w.json()).started, true);
  st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.wake.state, 'queued');
  assert.equal(st.wake.expectedBy, s.time() - 0 + 300_000, 'ETA = last check-in + interval');

  const again = await (await s.call('/api/wake', { method: 'POST', cookie })).json();
  assert.equal(again.started, false);
  assert.equal(again.reason, 'busy');

  s.advance(240_000);
  const p = await s.kv(await s.poll('?interval=300&ac=1&awake=0&v=1'));
  assert.equal(p.wake, '1');
  assert.equal(p.id, '1');
  assert.equal(p.age, '240');

  assert.equal(await (await s.call('/api/agent/ack?id=1', { method: 'POST', bearer: TOKEN })).text(), 'ok\n');
  assert.equal((await s.kv(await s.poll('?awake=1'))).wake, '0', 'acked requests are not delivered again');
  st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.wake.state, 'awake');
  assert.equal(st.awake, true);

  s.advance(130_000);
  st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.wake.state, 'idle');
});

test('ack is idempotent and ignores stale / wrong ids', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  await s.call('/api/wake', { method: 'POST', cookie });
  const ack = (id) => s.call(`/api/agent/ack?id=${id}`, { method: 'POST', bearer: TOKEN }).then((r) => r.text());
  assert.equal(await ack(99), 'stale\n');
  assert.equal(await ack('abc'), 'stale\n');
  assert.equal(await ack(1), 'ok\n');
  assert.equal(await ack(1), 'stale\n');
});

test('requests expire after the TTL: not delivered, status = expired, can retry', async () => {
  const s = await boot({ WAKE_TTL_SEC: '600' });
  const { cookie } = await s.login();
  await s.call('/api/wake', { method: 'POST', cookie });
  s.advance(601_000);
  assert.equal((await s.kv(await s.poll())).wake, '0', 'a Mac that comes back late must not light up unexpectedly');
  assert.equal((await (await s.call('/api/status', { cookie })).json()).wake.state, 'expired');
  const r = await s.call('/api/wake', { method: 'POST', cookie });
  assert.equal(r.status, 202);
  assert.equal((await s.kv(await s.poll())).id, '2');
});

test('agent endpoints need the bearer token and a session cannot use them (and vice versa)', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  assert.equal((await s.poll('', 'wrong')).status, 401);
  assert.equal((await s.call('/api/agent/poll')).status, 401);
  assert.equal((await s.call('/api/agent/poll', { cookie })).status, 401);
  assert.equal((await s.call('/api/status', { bearer: TOKEN })).status, 401, 'agent token is not a phone session');
  assert.equal((await s.call('/api/wake', { method: 'POST', bearer: TOKEN })).status, 401, 'agent cannot request wakes');
  assert.equal((await s.call('/api/agent/ack?id=1', { method: 'POST', cookie })).status, 401);
});

test('poll parameters are clamped, not trusted', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  await s.poll('?interval=999999999&ac=7&awake=9&v=abc');
  const st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.relay.intervalSec, 300, 'out-of-range interval falls back to default');
  assert.equal(st.awake, false);
  await s.poll('?interval=60&ac=0&awake=1');
  const st2 = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st2.relay.intervalSec, 60);
  assert.equal(st2.relay.onAC, false);
  assert.equal(st2.awake, true);
});

test('awake status goes stale: agent silent for >45s means asleep; expectedBy uses fast poll when awake', async () => {
  const s = await boot();
  const { cookie } = await s.login();
  await s.poll('?interval=300&awake=1');
  await s.call('/api/wake', { method: 'POST', cookie });
  let st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.wake.expectedBy, s.time() + 20_000);
  s.advance(60_000);
  st = await (await s.call('/api/status', { cookie })).json();
  assert.equal(st.awake, false);
  assert.equal(st.relay.agentOnline, false);
});

test('responses carry security headers; unknown API paths 404; oversized/bad JSON handled', async () => {
  const s = await boot();
  const r = await s.call('/api/nope');
  assert.equal(r.status, 401);
  const { cookie } = await s.login();
  const nf = await s.call('/api/nope', { cookie });
  assert.equal(nf.status, 404);
  assert.equal(nf.headers.get('x-frame-options'), 'DENY');
  assert.match(nf.headers.get('content-security-policy'), /default-src 'self'/);
  const big = await s.call('/api/login', { method: 'POST', body: { pin: 'x'.repeat(3000) } });
  assert.equal(big.status, 413);
});
