import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMac, buildMagicPacket, directedBroadcast } from '../src/magic.js';

test('normalizeMac accepts common formats', () => {
  for (const m of ['AA:BB:CC:DD:EE:FF', 'aa-bb-cc-dd-ee-ff', 'aabbccddeeff', 'aabb.ccdd.eeff', ' aa:bb:cc:dd:ee:ff ']) {
    assert.equal(normalizeMac(m), 'aa:bb:cc:dd:ee:ff');
  }
});
test('normalizeMac rejects bad / reserved input', () => {
  for (const m of ['', 'zz:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', null, 'aa:bb:cc:dd:ee:ff; rm']) {
    assert.throws(() => normalizeMac(m), /Invalid|reserved/, String(m));
  }
});
test('magic packet is 6xFF + 16 repetitions of the MAC (102 bytes)', () => {
  const p = buildMagicPacket('aa:bb:cc:dd:ee:ff');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], Array(6).fill(255));
  for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), 'aabbccddeeff');
});
test('directedBroadcast', () => {
  assert.equal(directedBroadcast('192.168.1.20', 24), '192.168.1.255');
  assert.equal(directedBroadcast('10.1.2.3', 16), '10.1.255.255');
  assert.equal(directedBroadcast('10.1.2.3', 8), '10.255.255.255');
  assert.equal(directedBroadcast('10.1.2.3', 32), '10.1.2.3');
  assert.throws(() => directedBroadcast('300.1.1.1'));
});
