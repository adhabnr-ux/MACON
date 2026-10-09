import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelay, MemoryStore, pinDigest } from '../relay/core.js';

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mac', 'macon-agent.sh');
const TOKEN = 't'.repeat(48);
const PIN = 'long-test-pin';
const NOW = 1_800_000_000; // 2027-01-15 08:00:00 UTC
const realCurl = spawnSync('sh', ['-c', 'command -v curl']).stdout.toString().trim();

async function rig({ conf = '', batt = "Now drawing from 'AC Power'", idle = 500, assertions = '', pmsetFail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macon-agent-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls.log');
  const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  stub('pmset', `echo "pmset $*" >> "${calls}"
case "$1 $2" in
  "-g batt") echo "${batt}" ;;
  "-g assertions") cat "${dir}/assertions" 2>/dev/null ;;
  "schedule wake") ${pmsetFail ? 'exit 1' : 'exit 0'} ;;
esac`);
  stub('caffeinate', `echo "caffeinate $*" >> "${calls}"`);
  stub('ioreg', `echo "    | |   \\"HIDIdleTime\\" = $(cat "${dir}/idle")000000000"`);
  // Wrap real curl so we can assert the token never appears in argv (visible to `ps`).
  stub('curl', `echo "curl $*" >> "${calls}"\nexec "${realCurl}" "$@"`);
  fs.writeFileSync(path.join(dir, 'idle'), String(idle));
  fs.writeFileSync(path.join(dir, 'assertions'), assertions);

  const env = { NAME: 'T', PIN_KEY: 'k'.repeat(40), SESSION_SECRET: 's'.repeat(48), AGENT_TOKEN: TOKEN };
  env.PIN_HMAC = await pinDigest(env.PIN_KEY, PIN);
  const relay = createRelay(env, new MemoryStore());
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const r = await relay.handle(new Request('http://x' + req.url, { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, 'agent.conf'), `RELAY_URL="${url}"\nAGENT_TOKEN="${TOKEN}"\n${conf}`);

  const call = (p, { method = 'GET', cookie, body } = {}) => fetch(url + p, { method, headers: { ...(method === 'POST' ? { 'x-macon': '1', 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const login = async () => (await call('/api/login', { method: 'POST', body: { pin: PIN } })).headers.get('set-cookie').split(';')[0];
  const run = (mode = 'once', extra = {}) => new Promise((resolve) => {
    const p = spawn('sh', [AGENT, mode], { env: { PATH: `${bin}:${process.env.PATH}`, MACON_CONF: path.join(dir, 'agent.conf'), MACON_STATE_DIR: path.join(dir, 'state'), MACON_LOG: path.join(dir, 'agent.log'), MACON_NOW: String(NOW), MACON_VERBOSE: '1', MACON_DISPLAY_DELAY: '0', TZ: 'UTC', ...extra } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
  const callLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  const state = (n) => (fs.existsSync(path.join(dir, 'state', n)) ? fs.readFileSync(path.join(dir, 'state', n), 'utf8') : null);
  return { dir, url, server, call, login, run, callLog, state, setIdle: (v) => fs.writeFileSync(path.join(dir, 'idle'), String(v)), close: () => { server.closeAllConnections(); server.close(); } };
}

test('idle check-in: polls relay, schedules a chain of 3 owned wake events, never wakes the screen', async () => {
  const r = await rig();
  const { code } = await r.run();
  assert.equal(code, 0);
  const log = r.callLog();
  assert.doesNotMatch(log, /caffeinate/);
  const sched = [...log.matchAll(/pmset schedule wake (\d\d\/\d\d\/\d\d \d\d:\d\d:\d\d) macon/g)].map((m) => m[1]);
  assert.deepEqual(sched, ['01/15/27 08:05:00', '01/15/27 08:10:00', '01/15/27 08:15:00']);
  assert.equal(r.state('sched').trim().split('\n').length, 3);
  const st = await (await r.call('/api/status', { cookie: await r.login() })).json();
  assert.equal(st.relay.agentOnline, true);
  assert.equal(st.relay.intervalSec, 300);
  r.close();
});

test('the token is sent over stdin config, never on the command line', async () => {
  const r = await rig();
  await r.run();
  assert.doesNotMatch(r.callLog(), new RegExp(TOKEN));
  assert.match(r.callLog(), /curl .*-K -/);
  r.close();
});

test('phone presses Wake -> next check-in lights the screen, holds it, acks once', async () => {
  const r = await rig();
  const cookie = await r.login();
  await r.run();                                           // check-in 1: nothing pending
  assert.equal((await (await r.call('/api/wake', { method: 'POST', cookie })).json()).started, true);
  const { out } = await r.run();
  assert.match(out, /wake request 1/);
  const log = r.callLog();
  assert.match(log, /caffeinate -u -t 10/);
  assert.match(log, /caffeinate -d -i -t 300/);
  assert.equal(r.state('hold_until').trim(), String(NOW + 300));
  const st = await (await r.call('/api/status', { cookie })).json();
  assert.equal(st.wake.state, 'awake');
  await r.run();                                           // next check-in must not re-trigger
  assert.equal((log.match(/caffeinate -u/g) || []).length, 1);
  assert.equal((r.callLog().match(/caffeinate -u/g) || []).length, 1);
  r.close();
});

test('battery uses the longer interval; interval is reported to the relay', async () => {
  const r = await rig({ batt: "Now drawing from 'Battery Power'" });
  await r.run();
  const sched = [...r.callLog().matchAll(/pmset schedule wake (\S+ \S+) macon/g)].map((m) => m[1]);
  assert.deepEqual(sched, ['01/15/27 08:15:00', '01/15/27 08:30:00', '01/15/27 08:45:00']);
  const st = await (await r.call('/api/status', { cookie: await r.login() })).json();
  assert.equal(st.relay.intervalSec, 900);
  assert.equal(st.relay.onAC, false);
  r.close();
});

test('schedule is rebuilt when it is about to expire, cancelling only our own events', async () => {
  const r = await rig();
  await r.run();
  const first = r.state('sched');
  await r.run('once', { MACON_NOW: String(NOW + 30) });    // head is 270s away: no rebuild
  assert.equal(r.state('sched'), first);
  await r.run('once', { MACON_NOW: String(NOW + 260) });   // head within 90s: rebuild
  const log = r.callLog();
  assert.match(log, /pmset schedule cancel wake 01\/15\/27 08:05:00 macon/);
  assert.notEqual(r.state('sched'), first);
  assert.doesNotMatch(log, /pmset schedule cancel wake \S+ \S+ (?!macon)/);
  r.close();
});

test('quiet hours: wake-ups never land inside the window (overnight window)', async () => {
  const r = await rig({ conf: 'QUIET_START="23:00"\nQUIET_END="07:00"\n' });
  await r.run('once', { MACON_NOW: String(NOW + 15 * 3600 + 55 * 60) }); // 23:55 UTC
  const sched = [...r.callLog().matchAll(/pmset schedule wake (\S+) (\S+) macon/g)].map((m) => m[2]);
  assert.equal(sched.length, 3);
  for (const s of sched) assert.ok(s >= '07:00:00' && s < '23:00:00', s);
  assert.equal(sched[0], '07:00:00');
  r.close();
});

test('self-sleep: after our own wake with nobody present, display off then sleep, once', async () => {
  const r = await rig({ idle: 600 });
  await r.run();                                           // builds chain, head = 08:05:00
  const at = String(NOW + 300 + 10);                       // 10s after the scheduled wake
  const { out } = await r.run('once', { MACON_NOW: at });
  assert.match(out, /back to sleep/);
  const log = r.callLog();
  assert.match(log, /pmset displaysleepnow/);
  assert.match(log, /pmset sleepnow/);
  await r.run('once', { MACON_NOW: String(NOW + 300 + 20) });
  assert.equal((r.callLog().match(/pmset sleepnow/g) || []).length, 1, 'does not retry for the same wake');
  r.close();
});

test('self-sleep is skipped when a person touched the keyboard after the wake', async () => {
  const r = await rig({ idle: 3 });
  await r.run();
  const { out } = await r.run('once', { MACON_NOW: String(NOW + 300 + 30) });
  assert.match(out, /someone is using the Mac/);
  assert.doesNotMatch(r.callLog(), /pmset sleepnow/);
  r.close();
});

test('self-sleep is skipped when another process holds a sleep assertion, and when disabled', async () => {
  const held = await rig({ idle: 600, assertions: '   pid 412(Music): [0x1] 00:10:00 PreventUserIdleSystemSleep named: "audio"\n' });
  await held.run();
  const a = await held.run('once', { MACON_NOW: String(NOW + 310) });
  assert.match(a.out, /another process is keeping the Mac awake/);
  assert.doesNotMatch(held.callLog(), /pmset sleepnow/);
  held.close();

  const off = await rig({ idle: 600, conf: 'SELF_SLEEP=0\n' });
  await off.run();
  await off.run('once', { MACON_NOW: String(NOW + 310) });
  assert.doesNotMatch(off.callLog(), /pmset (sleepnow|displaysleepnow)/);
  off.close();
});

test('never sleeps a Mac that was not woken by our schedule, or that is holding for a wake request', async () => {
  const r = await rig({ idle: 600 });
  await r.run();
  await r.run('once', { MACON_NOW: String(NOW + 150) });   // mid-interval, user-initiated
  assert.doesNotMatch(r.callLog(), /pmset sleepnow/);
  const cookie = await r.login();
  await r.call('/api/wake', { method: 'POST', cookie });
  await r.run('once', { MACON_NOW: String(NOW + 305) });   // inside our window, but a wake request is being served
  assert.doesNotMatch(r.callLog(), /pmset sleepnow/);
  r.close();
});

test('relay down: no crash, no screen wake, retries; recovers and logs it', async () => {
  const r = await rig();
  fs.writeFileSync(r.dir + '/agent.conf', `RELAY_URL="http://127.0.0.1:9"\nAGENT_TOKEN="${TOKEN}"\n`);
  const a = await r.run();
  assert.equal(a.code, 0);
  assert.match(a.out, /relay unreachable/);
  assert.doesNotMatch(r.callLog(), /caffeinate/);
  assert.match(r.callLog(), /pmset schedule wake/, 'still keeps its wake chain so it can recover later');
  r.close();
});

test('pmset failures are logged, not fatal', async () => {
  const r = await rig({ pmsetFail: true });
  const a = await r.run();
  assert.equal(a.code, 0);
  assert.match(a.out, /pmset schedule wake failed/);
  r.close();
});

test('config validation rejects unsafe or malformed settings', async () => {
  const bad = [
    ['RELAY_URL="http://example.com"\nAGENT_TOKEN="' + TOKEN + '"\n', /must start with https/],
    ['RELAY_URL="https://x.workers.dev"\nAGENT_TOKEN="short"\n', /AGENT_TOKEN/],
    ['RELAY_URL="https://x.workers.dev"\nAGENT_TOKEN="' + TOKEN + '"\nINTERVAL=5\n', /INTERVAL/],
    ['RELAY_URL="https://x.workers.dev"\nAGENT_TOKEN="' + TOKEN + '"\nINTERVAL=abc\n', /whole number/],
    ['RELAY_URL="https://x.workers.dev"\nAGENT_TOKEN="' + TOKEN + '"\nQUIET_START="25:99"\nQUIET_END="07:00"\n', /QUIET/],
    ['RELAY_URL="https://x.workers.dev"\nAGENT_TOKEN="' + TOKEN + '"\nQUIET_START="22:00"\nQUIET_END="22:00"\n', /differ/],
  ];
  const r = await rig();
  for (const [conf, re] of bad) {
    fs.writeFileSync(r.dir + '/agent.conf', conf);
    const a = await r.run();
    assert.notEqual(a.code, 0, conf);
    assert.match(a.out, re, conf);
  }
  fs.rmSync(r.dir + '/agent.conf');
  assert.match((await r.run()).out, /config not found/);
  r.close();
});

test('a hostile relay response cannot inject anything', async () => {
  const r = await rig();
  const evil = http.createServer((q, s) => s.end('wake=1\nid=5; touch /tmp/pwned\n'));
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  fs.writeFileSync(r.dir + '/agent.conf', `RELAY_URL="http://127.0.0.1:${evil.address().port}"\nAGENT_TOKEN="${TOKEN}"\n`);
  const a = await r.run();
  assert.doesNotMatch(r.callLog(), /caffeinate/, 'malformed id is rejected, so no wake');
  assert.ok(!fs.existsSync('/tmp/pwned'));
  assert.match(a.out, /relay unreachable/);
  evil.close(); r.close();
});

test('script is POSIX: parses under dash and bash -n; version/usage work', () => {
  for (const sh of ['sh', 'bash', 'dash']) {
    if (spawnSync('sh', ['-c', `command -v ${sh}`]).status !== 0) continue;
    assert.equal(spawnSync(sh, ['-n', AGENT]).status, 0, `${sh} -n`);
  }
  assert.match(spawnSync('sh', [AGENT, 'version']).stdout.toString(), /macon-agent 1/);
  assert.notEqual(spawnSync('sh', [AGENT, 'bogus'], { env: { PATH: process.env.PATH } }).status, 0);
});
