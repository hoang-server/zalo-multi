import crypto from "node:crypto";
import { db, now, getSetting } from "./db.js";
import { BASE_PATH, SETUP_CODE } from "./config.js";

const COOKIE = "zm_sid";
const SESSION_DAYS = 60;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  const [, salt, key] = stored.split("$");
  const k = crypto.scryptSync(pw, Buffer.from(salt, "base64"), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(key, "base64");
  return expected.length === k.length && crypto.timingSafeEqual(expected, k);
}

// Chống dò mật khẩu: tối đa 10 lần sai / 15 phút cho mỗi IP
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(ip); return false; }
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=${BASE_PATH || "/"}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.is_admin, u.prefs, u.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
  ).get(sha256(token), now());
  if (!row) return null;
  if (!row.last_seen || now() - row.last_seen > 300e3) db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now(), row.id);
  const { prefs, last_seen, ...user } = row;
  user.prefs = { ...PREF_DEFAULTS, ...JSON.parse(prefs || "{}") };
  return user;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), userId, now() + SESSION_DAYS * 864e5);
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
}

const validUsername = (u) => typeof u === "string" && /^[a-zA-Z0-9_.-]{3,32}$/.test(u);
const validPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 200;

export const noUsers = () => db.prepare("SELECT COUNT(*) n FROM users").get().n === 0;

export function needsInvite() {
  const count = db.prepare("SELECT COUNT(*) n FROM users").get().n;
  return count === 0 ? !!SETUP_CODE : !getSetting("open_signup");
}

export function register(req, res, { username, password, invite }) {
  if (!validUsername(username)) throw httpError(400, "Tên đăng nhập 3–32 ký tự: chữ, số, _ . -");
  if (!validPassword(password)) throw httpError(400, "Mật khẩu tối thiểu 8 ký tự");
  const first = db.prepare("SELECT COUNT(*) n FROM users").get().n === 0;
  let inviteRow = null;
  if (first && SETUP_CODE && String(invite || "").trim() !== SETUP_CODE) throw httpError(403, "Mã khởi tạo không đúng");
  if (!first && !getSetting("open_signup")) {
    inviteRow = db.prepare("SELECT code FROM invites WHERE code = ? AND used_by IS NULL").get(String(invite || "").trim());
    if (!inviteRow) throw httpError(403, "Mã mời không đúng hoặc đã dùng");
  }
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw httpError(409, "Tên đăng nhập đã có người dùng");
  const { lastInsertRowid: id } = db.prepare(
    "INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?)"
  ).run(username, hashPassword(password), first ? 1 : 0, now());
  if (inviteRow) db.prepare("UPDATE invites SET used_by = ? WHERE code = ?").run(id, inviteRow.code);
  startSession(res, Number(id));
  return { id: Number(id), username, is_admin: first ? 1 : 0 };
}

export function login(req, res, { username, password }, ip) {
  if (tooManyFailures(ip)) throw httpError(429, "Sai quá nhiều lần, thử lại sau 15 phút");
  const u = typeof username === "string" && db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u || typeof password !== "string" || !verifyPassword(password, u.pass_hash)) {
    recordFailure(ip);
    throw httpError(401, "Sai tên đăng nhập hoặc mật khẩu");
  }
  if (u.disabled) throw httpError(403, "Tài khoản đã bị khoá. Liên hệ quản trị viên.");
  failures.delete(ip);
  startSession(res, u.id);
  return { id: u.id, username: u.username, is_admin: u.is_admin };
}

export function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  res.setHeader("Set-Cookie", sessionCookie("", 0));
}

export function changePassword(user, { current, password }) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (!verifyPassword(String(current || ""), u.pass_hash)) throw httpError(401, "Mật khẩu hiện tại không đúng");
  if (!validPassword(password)) throw httpError(400, "Mật khẩu tối thiểu 8 ký tự");
  db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
}

// Tuỳ chọn riêng của từng người dùng
export const PREF_DEFAULTS = {
  push_preview: true,   // hiện nội dung tin trong thông báo
  app_badge: true,      // hiện số tin chưa đọc trên icon app
};
export function setPrefs(user, patch) {
  const prefs = { ...user.prefs };
  for (const [k, v] of Object.entries(patch || {})) if (k in PREF_DEFAULTS) prefs[k] = typeof PREF_DEFAULTS[k] === "boolean" ? !!v : v;
  db.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify(prefs), user.id);
  return prefs;
}

export function createInvite(user) {
  if (!user.is_admin) throw httpError(403, "Chỉ quản trị viên tạo được mã mời");
  const code = crypto.randomBytes(6).toString("base64url");
  db.prepare("INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)").run(code, user.id, now());
  return code;
}

export function listInvites(user) {
  if (!user.is_admin) return [];
  return db.prepare(
    `SELECT i.code, i.created_at, u.username used_by FROM invites i LEFT JOIN users u ON u.id = i.used_by
     ORDER BY i.created_at DESC LIMIT 50`
  ).all();
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Dọn phiên hết hạn mỗi giờ
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now()), 3600e3).unref();
