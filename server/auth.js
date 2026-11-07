import crypto from "node:crypto";
import { db, now, getSetting, encrypt, decrypt } from "./db.js";
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
    `SELECT u.id, u.username, u.is_admin, u.prefs, u.last_seen, u.totp_on FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
  ).get(sha256(token), now());
  if (!row) return null;
  if (!row.last_seen || now() - row.last_seen > 300e3) db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now(), row.id);
  const { prefs, last_seen, totp_on, ...user } = row;
  user.prefs = { ...PREF_DEFAULTS, ...JSON.parse(prefs || "{}") };
  user.otp = !!totp_on;
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
  if (u.totp_on) {
    // bật 2 lớp: chưa tạo phiên, chờ nhập mã OTP (vé có hạn 5 phút)
    const ticket = crypto.randomBytes(24).toString("base64url");
    otpTickets.set(ticket, { userId: u.id, exp: Date.now() + 300e3, tries: 0 });
    return { otp: true, ticket, username: u.username };
  }
  startSession(res, u.id);
  return { id: u.id, username: u.username, is_admin: u.is_admin };
}

// ---------- Đăng nhập 2 lớp (TOTP, tương thích Google Authenticator / Authy / Microsoft Authenticator) ----------
const otpTickets = new Map();
setInterval(() => { for (const [k, v] of otpTickets) if (v.exp < Date.now()) otpTickets.delete(k); }, 60e3).unref();
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32encode = (buf) => { let bits = "", out = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const b32decode = (str) => { let bits = ""; for (const c of str.replace(/=+$/, "").toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, "0"); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function totp(secret, step) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}
// chấp nhận lệch ±30 giây; mỗi mã chỉ dùng được 1 lần
function checkTotp(u, code) {
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;
  const secret = decrypt(u.totp_secret).s, cur = Math.floor(Date.now() / 30e3);
  for (const step of [cur - 1, cur, cur + 1]) {
    if (step <= (u.totp_last || 0)) continue;
    const a = Buffer.from(totp(secret, step)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) { db.prepare("UPDATE users SET totp_last = ? WHERE id = ?").run(step, u.id); return true; }
  }
  return false;
}
// mã dự phòng (dùng khi mất điện thoại): lưu dạng băm, dùng xong là xoá
function useRecovery(u, code) {
  const list = JSON.parse(u.totp_recovery || "[]");
  const h = sha256(String(code || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  const i = list.indexOf(h);
  if (i < 0) return false;
  list.splice(i, 1);
  db.prepare("UPDATE users SET totp_recovery = ? WHERE id = ?").run(JSON.stringify(list), u.id);
  return true;
}

export function loginOtp(req, res, { ticket, code }, ip) {
  if (tooManyFailures(ip)) throw httpError(429, "Sai quá nhiều lần, thử lại sau 15 phút");
  const t = otpTickets.get(String(ticket || ""));
  if (!t || t.exp < Date.now()) throw httpError(401, "Phiên đăng nhập đã hết hạn, nhập lại mật khẩu");
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(t.userId);
  if (!u || u.disabled) throw httpError(403, "Tài khoản đã bị khoá");
  const ok = u.totp_on && (checkTotp(u, code) || (String(code || "").replace(/\s/g, "").length > 6 && useRecovery(u, code)));
  if (!ok) {
    recordFailure(ip);
    if (++t.tries >= 5) otpTickets.delete(String(ticket));
    throw httpError(401, "Mã xác thực không đúng");
  }
  otpTickets.delete(String(ticket));
  failures.delete(ip);
  startSession(res, u.id);
  return { id: u.id, username: u.username, is_admin: u.is_admin };
}

export function otpSetup(user) {
  const secret = b32encode(crypto.randomBytes(20));
  db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(encrypt({ s: secret }), user.id);
  const label = encodeURIComponent(`Zalo Multi:${user.username}`);
  return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri: `otpauth://totp/${label}?secret=${secret}&issuer=Zalo%20Multi` };
}
export function otpEnable(user, { code }) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (!u.totp_pending) throw httpError(400, "Hãy bấm Bật lại để lấy khoá mới");
  if (!checkTotp({ ...u, totp_secret: u.totp_pending, totp_last: 0 }, code)) throw httpError(400, "Mã không đúng. Kiểm tra giờ trên điện thoại và nhập mã đang hiện.");
  const recovery = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString("hex"));
  db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_on = 1, totp_recovery = ? WHERE id = ?")
    .run(JSON.stringify(recovery.map((c) => sha256(c))), user.id);
  return { recovery: recovery.map((c) => c.replace(/(.{5})/, "$1-")) };
}
export function otpDisable(user, { password }) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  if (!verifyPassword(String(password || ""), u.pass_hash)) throw httpError(401, "Mật khẩu không đúng");
  resetOtp(user.id);
}
export function resetOtp(userId) {
  db.prepare("UPDATE users SET totp_on = 0, totp_secret = NULL, totp_pending = NULL, totp_recovery = NULL WHERE id = ?").run(Number(userId));
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
  alert_push: true,     // thông báo khi tài khoản Zalo bị ngắt / hết phiên
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
