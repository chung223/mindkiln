import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword, verifyPassword, parseCookies,
  issueToken, verifyToken, revokeToken,
  authRequired, authEnvManaged, hasPassword, checkPassword,
  loginBlocked, noteLoginFailure, noteLoginSuccess,
} from '../server/auth.js';

// ---------- 密碼雜湊 / 比對 ----------

test('hashPassword + verifyPassword round-trips and rejects wrong / malformed', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
  // 每次雜湊鹽不同,同密碼兩次結果不應相同
  assert.notEqual(stored, hashPassword('correct horse battery staple'));
  // 壞掉 / 非字串的儲存值一律 false,不可拋例外
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'scrypt$$'), false);
  assert.equal(verifyPassword('x', null), false);
  assert.equal(verifyPassword('x', undefined), false);
});

// ---------- cookie 解析 ----------

test('parseCookies handles multiple cookies, spaces, and empty input', () => {
  assert.deepEqual(parseCookies('nuwa_session=abc123; other=zzz'), { nuwa_session: 'abc123', other: 'zzz' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1%20b'), { a: '1 b' }); // URL 解碼
});

// ---------- 工作階段 token ----------

test('token lifecycle: issue → verify → revoke', () => {
  const token = issueToken();
  assert.equal(verifyToken(token), true);
  assert.equal(verifyToken('bogus-token'), false);
  assert.equal(verifyToken(''), false);
  assert.equal(verifyToken(undefined), false);
  revokeToken(token);
  assert.equal(verifyToken(token), false);
});

// ---------- 環境變數密碼(NUWA_PASSWORD 優先) ----------

test('NUWA_PASSWORD env enables auth and gates checkPassword', () => {
  const prev = process.env.NUWA_PASSWORD;
  try {
    process.env.NUWA_PASSWORD = 's3cret-pass';
    assert.equal(authEnvManaged(), true);
    assert.equal(authRequired(), true);
    assert.equal(hasPassword(), true);
    assert.equal(checkPassword('s3cret-pass'), true);
    assert.equal(checkPassword('nope'), false);
    assert.equal(checkPassword(''), false);
    assert.equal(checkPassword(undefined), false);
  } finally {
    if (prev === undefined) delete process.env.NUWA_PASSWORD;
    else process.env.NUWA_PASSWORD = prev;
  }
});

test('without NUWA_PASSWORD and no config, auth is not required', () => {
  const prev = process.env.NUWA_PASSWORD;
  delete process.env.NUWA_PASSWORD;
  try {
    // 乾淨開發環境(data/config.json 無 authEnabled)下應為關閉
    assert.equal(authEnvManaged(), false);
    assert.equal(authRequired(), false);
  } finally {
    if (prev !== undefined) process.env.NUWA_PASSWORD = prev;
  }
});

// ---------- 登入嘗試節流 ----------

test('login rate limiter blocks after repeated failures and clears on success', () => {
  const ip = '203.0.113.7'; // 測試專用 IP,避免與其他測試互撞
  assert.equal(loginBlocked(ip), false);
  for (let i = 0; i < 10; i++) noteLoginFailure(ip);
  assert.equal(loginBlocked(ip), true);
  noteLoginSuccess(ip); // 登入成功應清除計數
  assert.equal(loginBlocked(ip), false);
});
