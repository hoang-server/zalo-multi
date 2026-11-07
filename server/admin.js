// Trang quản trị: người dùng, mã mời, cài đặt tính năng, thống kê
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, now, allSettings, setSetting } from "./db.js";
import { DATA_DIR } from "./config.js";
import { httpError, hashPassword } from "./auth.js";
import { stopAccountsOfUser, startAccountsOfUser, liveCount } from "./zalo.js";
import { removeMediaOfAccount, mediaUsage } from "./media.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const startedAt = now();

export function requireAdmin(user) {
  if (!user?.is_admin) throw httpError(403, "Chỉ quản trị viên");
}

export function listUsers() {
  return db.prepare(
    `SELECT u.id, u.username, u.is_admin isAdmin, u.disabled, u.created_at createdAt, u.last_seen lastSeen,
            (SELECT COUNT(*) FROM zalo_accounts a WHERE a.user_id = u.id) accounts,
            (SELECT COUNT(*) FROM zalo_accounts a WHERE a.user_id = u.id AND a.status = 'online') online,
            (SELECT COUNT(*) FROM push_subs p WHERE p.user_id = u.id) devices, u.totp_on otp
     FROM users u ORDER BY u.created_at`
  ).all();
}

function target(admin, id) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id));
  if (!u) throw httpError(404, "Không tìm thấy người dùng");
  return u;
}
const adminCount = () => db.prepare("SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND disabled = 0").get().n;

export function updateUser(admin, id, { isAdmin, disabled }) {
  const u = target(admin, id);
  if (u.id === admin.id && (isAdmin === false || disabled === true)) throw httpError(400, "Không tự bỏ quyền hoặc tự khoá chính mình");
  if (isAdmin !== undefined) {
    if (!isAdmin && u.is_admin && adminCount() <= 1) throw httpError(400, "Phải còn ít nhất một quản trị viên");
    db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, u.id);
  }
  if (disabled !== undefined && !!disabled !== !!u.disabled) {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, u.id);
    if (disabled) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
      stopAccountsOfUser(u.id);
    } else startAccountsOfUser(u.id);
  }
}

export function resetPassword(admin, id) {
  const u = target(admin, id);
  const pw = crypto.randomBytes(9).toString("base64url");
  db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hashPassword(pw), u.id);
  if (u.id !== admin.id) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  return pw;
}

export function deleteUser(admin, id) {
  const u = target(admin, id);
  if (u.id === admin.id) throw httpError(400, "Không tự xoá chính mình");
  stopAccountsOfUser(u.id);
  for (const a of db.prepare("SELECT id FROM zalo_accounts WHERE user_id = ?").all(u.id)) removeMediaOfAccount(a.id);
  db.prepare("UPDATE invites SET used_by = NULL WHERE used_by = ?").run(u.id);
  db.prepare("DELETE FROM invites WHERE created_by = ?").run(u.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
}

export function deleteInvite(code) {
  db.prepare("DELETE FROM invites WHERE code = ? AND used_by IS NULL").run(String(code));
}

// Khoá bí mật: không gửi giá trị thật về trình duyệt, chỉ báo đã đặt hay chưa
const SECRET_KEYS = ["telegram_bot_token"];
const MASK = "••••••••";
export function getSettings() {
  const s = allSettings();
  for (const k of SECRET_KEYS) s[k] = s[k] ? MASK : "";
  return s;
}
export function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (SECRET_KEYS.includes(k) && v === MASK) continue; // không đổi
    setSetting(k, typeof v === "string" ? v.trim() : v);
  }
  return getSettings();
}

export function stats() {
  const n = (sql) => db.prepare(sql).get().n;
  const dbFile = path.join(DATA_DIR, "app.db");
  const dbBytes = ["", "-wal"].reduce((s, x) => s + (fs.existsSync(dbFile + x) ? fs.statSync(dbFile + x).size : 0), 0);
  return {
    version: pkg.version, node: process.version, startedAt,
    users: n("SELECT COUNT(*) n FROM users"),
    zaloAccounts: n("SELECT COUNT(*) n FROM zalo_accounts"), zaloOnline: liveCount(),
    messages: n("SELECT COUNT(*) n FROM messages"), threads: n("SELECT COUNT(*) n FROM threads"),
    devices: n("SELECT COUNT(*) n FROM push_subs"),
    dbBytes, media: mediaUsage(),
  };
}
