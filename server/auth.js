import crypto from 'crypto';
import { readConfig } from './store.js';

// ---------- 登入密碼保護(部署到公開網路時使用) ----------
//
// 兩種設定密碼的方式,擇一即可:
//   1. 環境變數 NUWA_PASSWORD —— 優先,適合雲端 / 容器部署(不落地在資料夾)。
//   2. 介面「設定」開啟「登入保護」並設定密碼 —— 以 scrypt 雜湊存進 config.json。
// 兩者皆未設定時,服務維持無驗證(等同原本的本機模式)。
//
// 工作階段以隨機 token + HttpOnly cookie 維持,token 只存在記憶體:
// 伺服器重啟後所有人需重新登入(對單機個人服務足夠且單純)。

export const COOKIE_NAME = 'nuwa_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 天

// ---------- 密碼雜湊 / 比對(scrypt,constant-time) ----------

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(plain), salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// 明文對明文的定時安全比較(給環境變數密碼用):先各自 sha256 成定長再比,避免長度洩漏。
function safeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- 目前的保護狀態 ----------

function envPassword() {
  const p = process.env.NUWA_PASSWORD;
  return p && p.length ? p : null;
}

export function authEnvManaged() {
  return envPassword() !== null;
}

// 是否已設有可用密碼(環境變數或設定檔),供啟用前驗證與 UI 顯示用。
export function hasPassword() {
  if (envPassword()) return true;
  return Boolean(readConfig().authPasswordHash);
}

// 服務目前是否需要登入。
export function authRequired() {
  if (envPassword()) return true;
  const cfg = readConfig();
  return Boolean(cfg.authEnabled && cfg.authPasswordHash);
}

export function checkPassword(plain) {
  if (!plain) return false;
  const env = envPassword();
  if (env) return safeEqualStr(plain, env); // 有環境變數時只認它
  const cfg = readConfig();
  if (cfg.authEnabled && cfg.authPasswordHash) return verifyPassword(plain, cfg.authPasswordHash);
  return false;
}

// ---------- 工作階段 token(記憶體) ----------

const sessions = new Map(); // token -> expiresAt(ms)

export function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function verifyToken(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function revokeToken(token) {
  if (token) sessions.delete(token);
}

// ---------- cookie 解析(不引入 cookie-parser) ----------

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthenticated(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

// Express 中介層:未啟用保護時直接放行;啟用時要求有效工作階段。
export function requireAuth(req, res, next) {
  if (!authRequired()) return next();
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: '請先登入', authRequired: true });
}

// ---------- 登入嘗試節流(以來源 IP,防暴力破解) ----------

const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 1000 * 60 * 15; // 15 分鐘內

export function loginBlocked(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

export function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count++;
  }
}

export function noteLoginSuccess(ip) {
  attempts.delete(ip);
}
