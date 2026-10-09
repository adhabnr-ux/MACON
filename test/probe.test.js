import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { isAwake, tcpProbe } from '../src/probe.js';

test('isAwake: null without IP; true if any probe answers; false if none', async () => {
  assert.equal(await isAwake({ macIp: '' }), null);
  const no = async () => false;
  assert.equal(await isAwake({ macIp: '1.2.3.4', probePorts: [22, 80] }, { icmp: no, tcp: async (_, p) => p === 80 }), true);
  assert.equal(await isAwake({ macIp: '1.2.3.4', probePorts: [22] }, { icmp: async () => true, tcp: no }), true);
  assert.equal(await isAwake({ macIp: '1.2.3.4', probePorts: [22] }, { icmp: no, tcp: no }), false);
});

test('tcpProbe: open and refused ports both mean the host is up; timeout means not', async () => {
  const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  assert.equal(await tcpProbe('127.0.0.1', port), true);
  srv.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await tcpProbe('127.0.0.1', port), true, 'refused => host up');
  assert.equal(await tcpProbe('10.255.255.1', 9, 150), false);
});
