import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaker, sendMagicPacket } from '../src/wake.js';
import { buildMagicPacket } from '../src/magic.js';
import { testConfig, udpSink, MAC } from './helpers.js';

const fast = { sleep: async () => {}, roundGapMs: 0, pollMs: 0 };

test('sendMagicPacket delivers the exact magic packet over UDP', async () => {
  const sink = await udpSink();
  await sendMagicPacket({ mac: MAC, address: '127.0.0.1', port: sink.port });
  await new Promise((r) => setTimeout(r, 50));
  sink.close();
  assert.equal(sink.packets.length, 1);
  assert.ok(sink.packets[0].equals(buildMagicPacket(MAC)));
});

test('wake sends to broadcast + unicast on all ports for several rounds, then confirms awake', async () => {
  const cfg = testConfig({ macIp: '192.168.1.20', wakePorts: [9, 7], probePorts: [22] });
  const sent = []; const knocks = [];
  let polls = 0;
  const w = createWaker(cfg, { ...fast, rounds: 3, send: async (x) => { sent.push(x); }, knock: async (ip, p) => knocks.push([ip, p]), awake: async () => ++polls >= 3 });
  assert.equal(w.start().started, true);
  const r = await w.finished();
  assert.equal(r.state, 'awake');
  assert.equal(sent.length, 3 * 3 * 2); // 3 rounds x (255.255.255.255, 192.168.1.255, 192.168.1.20) x 2 ports
  assert.ok(sent.every((s) => s.mac === cfg.mac));
  assert.deepEqual(new Set(sent.map((s) => s.address)), new Set(['255.255.255.255', '192.168.1.255', '192.168.1.20']));
  assert.equal(knocks.length, 3);
  assert.ok(polls >= 3, 'needs two consecutive awake polls');
});

test('a single dark-wake blip does not count as awake', async () => {
  const cfg = testConfig({ macIp: '10.0.0.5' });
  const seq = [true, false, true, true];
  const w = createWaker(cfg, { ...fast, rounds: 1, send: async () => {}, knock: async () => {}, awake: async () => seq.shift() ?? true });
  w.start();
  assert.equal((await w.finished()).state, 'awake');
  assert.equal(seq.length, 0);
});

test('times out when the Mac never answers', async () => {
  const cfg = testConfig({ macIp: '10.0.0.5' });
  let t = 0;
  const w = createWaker(cfg, { ...fast, rounds: 1, timeoutMs: 100, now: () => (t += 30), send: async () => {}, knock: async () => {}, awake: async () => false });
  w.start();
  assert.equal((await w.finished()).state, 'timeout');
});

test('without macIp it reports "sent" (cannot confirm)', async () => {
  const w = createWaker(testConfig(), { ...fast, rounds: 2, send: async () => {} });
  w.start();
  assert.equal((await w.finished()).state, 'sent');
});

test('error when no packet can be sent', async () => {
  const w = createWaker(testConfig(), { ...fast, rounds: 2, send: async () => { throw new Error('ENETUNREACH'); } });
  w.start();
  const r = await w.finished();
  assert.equal(r.state, 'error');
  assert.match(r.error, /No magic packet/);
});

test('re-press while busy and during cooldown is ignored', async () => {
  let t = 1000;
  const w = createWaker(testConfig(), { ...fast, rounds: 1, now: () => t, cooldownMs: 4000, send: async () => {} });
  assert.equal(w.start().started, true);
  assert.equal(w.start().reason, 'busy');
  await w.finished();
  assert.equal(w.start().reason, 'cooldown');
  t += 5000;
  assert.equal(w.start().started, true);
  await w.finished();
});
