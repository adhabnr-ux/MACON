import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, validateConfig } from '../src/config.js';
import { hashPin } from '../src/auth.js';

const base = () => ({ mac: 'aa:bb:cc:dd:ee:ff', macIp: '192.168.1.20', pinHash: hashPin('123456'), secret: 'y'.repeat(48), port: 8787, prefix: 24, broadcast: [], sessionDays: 90 });

test('validateConfig derives broadcast addresses and normalises mac', () => {
  const c = validateConfig({ ...base(), mac: 'AA-BB-CC-DD-EE-FF' });
  assert.equal(c.mac, 'aa:bb:cc:dd:ee:ff');
  assert.deepEqual(new Set(c.broadcast), new Set(['255.255.255.255', '192.168.1.255']));
});
test('validateConfig rejects missing/invalid fields', () => {
  assert.throws(() => validateConfig({ ...base(), mac: '' }), /mac/);
  assert.throws(() => validateConfig({ ...base(), macIp: '999.1.1.1' }), /macIp/);
  assert.throws(() => validateConfig({ ...base(), port: 70000 }), /port/);
  assert.throws(() => validateConfig({ ...base(), pinHash: '' }), /pinHash/);
  assert.throws(() => validateConfig({ ...base(), secret: 'short' }), /secret/);
});
test('save/load round-trip with 0600 perms; env overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macon-'));
  const f = path.join(dir, 'c.json');
  saveConfig(base(), f);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(loadConfig(f, {}).macIp, '192.168.1.20');
  assert.equal(loadConfig(f, { MACON_PORT: '9000' }).port, 9000);
  fs.writeFileSync(f, '{bad');
  assert.throws(() => loadConfig(f, {}), /parse/);
});
