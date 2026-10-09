import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'macon.js');
const run = (args, cfg) => spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, MACON_CONFIG: cfg }, encoding: 'utf8', timeout: 20000 });

test('init writes a private, valid config; doctor accepts it; bad MAC is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macon-cli-'));
  const cfg = path.join(dir, 'c.json');
  const bad = run(['init', '--yes', '--mac=nope', '--pin=123456'], cfg);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid MAC/);
  const short = run(['init', '--yes', '--mac=aa:bb:cc:dd:ee:ff', '--pin=123'], cfg);
  assert.notEqual(short.status, 0);
  const ok = run(['init', '--yes', '--mac=AA-BB-CC-DD-EE-FF', '--ip=', '--random-pin', '--trust-proxy'], cfg);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Your PIN is: \d{6}/);
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(c.mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(c.host, '127.0.0.1');
  assert.match(c.pinHash, /^scrypt\$/);
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(cfg, 'utf8'), /Your PIN/);
  const doc = run(['doctor'], cfg);
  assert.match(doc.stdout, /Config OK/);
});
