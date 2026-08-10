import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth';

test('passwords use salted scrypt hashes and verify safely', () => {
  const first = hashPassword('correct horse battery staple');
  const second = hashPassword('correct horse battery staple');

  assert.match(first, /^scrypt\$/);
  assert.notEqual(first, second);
  assert.deepEqual(verifyPassword('correct horse battery staple', first), { valid: true, legacy: false });
  assert.deepEqual(verifyPassword('wrong password', first), { valid: false, legacy: false });
});

test('legacy seeded SHA-256 passwords are recognized for one-time upgrade', () => {
  const legacy = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918';
  assert.deepEqual(verifyPassword('admin', legacy), { valid: true, legacy: true });
  assert.deepEqual(verifyPassword('not-admin', legacy), { valid: false, legacy: true });
});
