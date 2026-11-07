// Nhật ký hoạt động: ai đăng nhập, gửi tin, xoá tài khoản… (không lưu nội dung tin nhắn)
import { db, now } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  account_id INTEGER,
  thread_id TEXT,
  type INTEGER,
  detail TEXT,
  ip TEXT,
  ts INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts)");
db.exec("CREATE INDEX IF NOT EXISTS activity_acc ON activity(account_id, ts)");

const KEEP_DAYS = 180;

export function logActivity({ user, username, action, accountId, type, threadId, detail, ip }) {
  try {
    db.prepare(
      `INSERT INTO activity (user_id, username, action, account_id, thread_id, type, detail, ip, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(user?.id ?? null, user?.username ?? username ?? null, action, accountId != null ? Number(accountId) || null : null,
      threadId != null ? String(threadId) : null, type != null ? Number(type) : null, detail != null ? String(detail).slice(0, 300) : null, ip || null, now());
  } catch (e) { console.error("ghi nhật ký lỗi", e.message); }
}

// Quản trị viên xem tất cả; người khác xem việc của mình + việc người khác làm trên tài khoản Zalo mình sở hữu
export function listActivity(user, { userId, accountId, action, before } = {}) {
  const where = [], args = [];
  if (!user.is_admin) {
    where.push("(a.user_id = ? OR a.account_id IN (SELECT id FROM zalo_accounts WHERE user_id = ?))");
    args.push(user.id, user.id);
  }
  if (userId) { where.push("a.user_id = ?"); args.push(Number(userId)); }
  if (accountId) { where.push("a.account_id = ?"); args.push(Number(accountId)); }
  if (action) { where.push("a.action = ?"); args.push(String(action)); }
  if (before) { where.push("a.ts < ?"); args.push(Number(before)); }
  return db.prepare(
    `SELECT a.id, a.user_id userId, a.username, a.action, a.account_id accountId, z.name accountName, a.thread_id threadId, a.type,
            t.name threadName, a.detail, a.ip, a.ts
     FROM activity a LEFT JOIN zalo_accounts z ON z.id = a.account_id
     LEFT JOIN threads t ON t.account_id = a.account_id AND t.thread_id = a.thread_id AND t.type = a.type
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.ts DESC LIMIT 100`
  ).all(...args);
}

setInterval(() => db.prepare("DELETE FROM activity WHERE ts < ?").run(now() - KEEP_DAYS * 864e5), 6 * 3600e3).unref();
