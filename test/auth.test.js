import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, signSession, verifySession, parseCookies, LoginLimiter } from '../src/auth.js';

test('pin hash verifies only the right pin and is salted', () => {
  const h = hashPin('123456');
  assert.ok(verifyPin('123456', h));
  assert.ok(!verifyPin('654321', h));
  assert.ok(!verifyPin('123456', 'garbage'));
  assert.notEqual(hashPin('123456'), h);
});
test('sessions: valid, tampered, wrong secret, expired', () => {
  const t = signSession('s'.repeat(40), 1000, 0);
  assert.ok(verifySession('s'.repeat(40), t, 500));
  assert.ok(!verifySession('s'.repeat(40), t, 1001));
  assert.ok(!verifySession('o'.repeat(40), t, 500));
  const [p, m] = t.split('.');
  assert.ok(!verifySession('s'.repeat(40), `${p}x.${m}`, 500));
  assert.ok(!verifySession('s'.repeat(40), undefined));
  assert.ok(!verifySession('s'.repeat(40), 'nodot'));
});
test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20w; c='), { a: '1', b: 'hello w', c: '' });
});
test('limiter locks per key and globally, then recovers', () => {
  let t = 0;
  const l = new LoginLimiter({ perKeyMax: 3, globalMax: 5, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) { assert.equal(l.retryAfter('a'), 0); l.fail('a'); }
  assert.ok(l.retryAfter('a') > 0);
  assert.equal(l.retryAfter('b'), 0);
  l.fail('b'); l.fail('c');
  assert.ok(l.retryAfter('d') > 0, 'global limit hit');
  t = 1500;
  assert.equal(l.retryAfter('a'), 0);
});
