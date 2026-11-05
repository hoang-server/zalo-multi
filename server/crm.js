// Chăm sóc khách: nhãn, ghi chú nội bộ, hẹn giờ gửi tin / nhắc việc, thống kê
import { db, now } from "./db.js";
import { httpError } from "./auth.js";
import { emit, pushToUser } from "./push.js";
import { ownAccount, accessOf, sendAsAccount, isLive } from "./zalo.js";

const thread = (accountId, type, threadId) =>
  db.prepare("SELECT name, avatar FROM threads WHERE account_id = ? AND type = ? AND thread_id = ?").get(accountId, Number(type), String(threadId)) || {};
const chatUrl = (accountId, type, threadId) => `#/a/${accountId}/${type}/${encodeURIComponent(threadId)}`;

// ---------- Nhãn ----------
export const LABEL_COLORS = ["#e53935", "#fb8c00", "#fdd835", "#43a047", "#00897b", "#1e88e5", "#8e24aa", "#6d4c41", "#546e7a"];
const DEFAULT_LABELS = [["Khách mới", "#1e88e5"], ["Đang tư vấn", "#fb8c00"], ["Đã chốt", "#43a047"], ["Cần gọi lại", "#e53935"]];

// Nhãn người dùng thấy: của mình + của chủ các tài khoản được giao
export function visibleLabels(user) {
  const own = db.prepare("SELECT COUNT(*) n FROM labels WHERE user_id = ?").get(user.id).n;
  if (!own && !db.prepare("SELECT 1 FROM users WHERE id = ? AND prefs LIKE '%\"labels_seeded\":true%'").get(user.id)) {
    // bộ nhãn mẫu cho lần đầu (xoá/sửa được)
    const ins = db.prepare("INSERT INTO labels (user_id, name, color, pos) VALUES (?, ?, ?, ?)");
    DEFAULT_LABELS.forEach(([n, c], i) => ins.run(user.id, n, c, i));
    const prefs = JSON.parse(db.prepare("SELECT prefs FROM users WHERE id = ?").get(user.id)?.prefs || "{}");
    db.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify({ ...prefs, labels_seeded: true }), user.id);
  }
  return db.prepare(
    `SELECT id, user_id userId, name, color FROM labels
     WHERE user_id = ? OR user_id IN (SELECT a.user_id FROM account_shares s JOIN zalo_accounts a ON a.id = s.account_id WHERE s.user_id = ?)
     ORDER BY user_id != ?, pos, id`
  ).all(user.id, user.id, user.id);
}
export function saveLabel(user, { id, name, color }) {
  name = String(name || "").trim().slice(0, 30);
  if (!name) throw httpError(400, "Cần có tên nhãn");
  color = LABEL_COLORS.includes(color) ? color : LABEL_COLORS[5];
  if (id) {
    const r = db.prepare("UPDATE labels SET name = ?, color = ? WHERE id = ? AND user_id = ?").run(name, color, Number(id), user.id);
    if (!r.changes) throw httpError(404, "Không tìm thấy nhãn");
  } else {
    if (db.prepare("SELECT COUNT(*) n FROM labels WHERE user_id = ?").get(user.id).n >= 50) throw httpError(400, "Tối đa 50 nhãn");
    const pos = db.prepare("SELECT COALESCE(MAX(pos), 0) + 1 p FROM labels WHERE user_id = ?").get(user.id).p;
    db.prepare("INSERT INTO labels (user_id, name, color, pos) VALUES (?, ?, ?, ?)").run(user.id, name, color, pos);
  }
  return visibleLabels(user);
}
export function deleteLabel(user, id) {
  db.prepare("DELETE FROM labels WHERE id = ? AND user_id = ?").run(Number(id), user.id);
  return visibleLabels(user);
}
// Đặt bộ nhãn cho một hội thoại (chỉ nhãn của chủ tài khoản Zalo)
export function setThreadLabels(user, accountId, type, threadId, labelIds) {
  const row = ownAccount(user, accountId, "reply");
  const valid = new Set(db.prepare("SELECT id FROM labels WHERE user_id = ?").all(row.user_id).map((r) => r.id));
  const ids = [...new Set((Array.isArray(labelIds) ? labelIds : []).map(Number))].filter((i) => valid.has(i));
  db.prepare("DELETE FROM thread_labels WHERE account_id = ? AND type = ? AND thread_id = ?").run(row.id, Number(type), String(threadId));
  const ins = db.prepare("INSERT INTO thread_labels (account_id, thread_id, type, label_id) VALUES (?, ?, ?, ?)");
  for (const i of ids) ins.run(row.id, String(threadId), Number(type), i);
  return ids;
}

// ---------- Hồ sơ khách: nhãn + ghi chú + lịch hẹn của một hội thoại ----------
export function customer(user, accountId, type, threadId) {
  const row = ownAccount(user, accountId);
  const args = [row.id, Number(type), String(threadId)];
  return {
    access: row.access,
    thread: thread(...args),
    labels: db.prepare("SELECT label_id FROM thread_labels WHERE account_id = ? AND type = ? AND thread_id = ?").all(...args).map((r) => r.label_id),
    ownerLabels: db.prepare("SELECT id, name, color FROM labels WHERE user_id = ? ORDER BY pos, id").all(row.user_id),
    notes: db.prepare(
      `SELECT n.id, n.text, n.ts, n.user_id userId, u.username FROM thread_notes n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.account_id = ? AND n.type = ? AND n.thread_id = ? ORDER BY n.ts DESC LIMIT 200`
    ).all(...args),
    schedules: listSchedules(user, { accountId: row.id, type, threadId, all: true }),
  };
}

export function addNote(user, accountId, type, threadId, text) {
  const row = ownAccount(user, accountId);
  text = String(text || "").trim().slice(0, 5000);
  if (!text) throw httpError(400, "Ghi chú trống");
  db.prepare("INSERT INTO thread_notes (account_id, thread_id, type, user_id, text, ts) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.id, String(threadId), Number(type), user.id, text, now());
  return customer(user, accountId, type, threadId).notes;
}
export function deleteNote(user, noteId) {
  const n = db.prepare("SELECT * FROM thread_notes WHERE id = ?").get(Number(noteId));
  const a = n && accessOf(user, n.account_id);
  if (!a || (n.user_id !== user.id && a.access !== "owner")) throw httpError(403, "Chỉ người viết hoặc chủ tài khoản xoá được ghi chú");
  db.prepare("DELETE FROM thread_notes WHERE id = ?").run(n.id);
  return { ok: true };
}

// ---------- Hẹn giờ gửi tin / nhắc việc ----------
export function createSchedule(user, accountId, type, threadId, { kind, text, at }) {
  kind = kind === "remind" ? "remind" : "send";
  const row = ownAccount(user, accountId, kind === "send" ? "reply" : "view");
  text = String(text || "").trim().slice(0, 5000);
  at = Number(at);
  if (!text) throw httpError(400, kind === "send" ? "Tin nhắn trống" : "Cần ghi nội dung nhắc");
  if (!at || at < now() - 60e3) throw httpError(400, "Thời gian phải ở tương lai");
  if (at > now() + 366 * 864e5) throw httpError(400, "Hẹn tối đa 1 năm");
  if (db.prepare("SELECT COUNT(*) n FROM schedules WHERE user_id = ? AND status = 'pending'").get(user.id).n >= 300) throw httpError(400, "Quá nhiều lịch đang chờ");
  db.prepare(
    `INSERT INTO schedules (kind, account_id, thread_id, type, user_id, text, at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(kind, row.id, String(threadId), Number(type), user.id, text, at, now());
  return listSchedules(user, { accountId: row.id, type, threadId, all: true });
}

// Lịch của một hội thoại (mọi người dùng chung tài khoản đều thấy) hoặc tất cả lịch đang chờ mà người dùng thấy được
export function listSchedules(user, { accountId, type, threadId, all } = {}) {
  const base = `SELECT s.id, s.kind, s.account_id accountId, a.name accountName, s.thread_id threadId, s.type, t.name threadName, t.avatar,
      s.user_id userId, u.username, s.text, s.at, s.status, s.error, s.created_at createdAt
    FROM schedules s JOIN zalo_accounts a ON a.id = s.account_id LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN threads t ON t.account_id = s.account_id AND t.thread_id = s.thread_id AND t.type = s.type`;
  if (accountId) {
    return db.prepare(`${base} WHERE s.account_id = ? AND s.type = ? AND s.thread_id = ?
      AND (s.status = 'pending' OR s.at > ?) ORDER BY s.status != 'pending', s.at LIMIT 100`)
      .all(Number(accountId), Number(type), String(threadId), all ? now() - 7 * 864e5 : now());
  }
  // trang tổng: lịch của chính mình + tin hẹn gửi trên tài khoản mình được dùng
  return db.prepare(`${base}
    WHERE (s.user_id = ? OR (s.kind = 'send' AND s.account_id IN (SELECT id FROM zalo_accounts WHERE user_id = ? UNION SELECT account_id FROM account_shares WHERE user_id = ?)))
      AND (s.status = 'pending' OR s.at > ?)
    ORDER BY s.status != 'pending', s.at LIMIT 300`).all(user.id, user.id, user.id, now() - 3 * 864e5);
}
export function cancelSchedule(user, id) {
  const s = db.prepare("SELECT * FROM schedules WHERE id = ?").get(Number(id));
  const a = s && accessOf(user, s.account_id);
  if (!a || (s.user_id !== user.id && a.access !== "owner")) throw httpError(403, "Chỉ người hẹn hoặc chủ tài khoản huỷ được");
  if (s.status !== "pending") throw httpError(400, "Lịch này đã chạy xong");
  db.prepare("UPDATE schedules SET status = 'cancelled' WHERE id = ?").run(s.id);
  return { ok: true };
}

// Chạy lịch đến giờ (mỗi 15 giây)
const OFFLINE_GRACE = 30 * 60e3; // tài khoản mất kết nối: chờ tối đa 30 phút rồi báo lỗi
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const due = db.prepare("SELECT * FROM schedules WHERE status = 'pending' AND at <= ? ORDER BY at LIMIT 20").all(now());
    for (const s of due) {
      const t = thread(s.account_id, s.type, s.thread_id);
      const url = chatUrl(s.account_id, s.type, s.thread_id);
      const done = (status, error = null) => {
        db.prepare("UPDATE schedules SET status = ?, error = ? WHERE id = ?").run(status, error, s.id);
        emit(s.user_id, "schedule", { id: s.id, status });
      };
      if (s.kind === "remind") {
        done("sent");
        pushToUser(s.user_id, { title: `⏰ Nhắc việc · ${t.name || "Zalo"}`, body: s.text, tag: `remind-${s.id}`, url });
        continue;
      }
      const author = db.prepare("SELECT id, disabled FROM users WHERE id = ?").get(s.user_id);
      const a = author && !author.disabled && accessOf(author, s.account_id);
      if (!a || a.access === "view") { done("failed", "Người hẹn không còn quyền gửi tin ở tài khoản này"); continue; }
      if (!isLive(s.account_id)) {
        if (now() - s.at < OFFLINE_GRACE) continue; // thử lại lần sau
        done("failed", "Tài khoản Zalo không kết nối");
      } else {
        try { await sendAsAccount(s.account_id, s.type, s.thread_id, s.text); done("sent"); continue; }
        catch (e) { done("failed", String(e?.message || e).slice(0, 200)); }
      }
      pushToUser(s.user_id, { title: `⚠️ Tin hẹn giờ chưa gửi được · ${t.name || "Zalo"}`, body: s.text.slice(0, 120), tag: `sched-${s.id}`, url });
    }
  } catch (e) { console.error("lịch hẹn lỗi", e); }
  finally { running = false; }
}
setInterval(tick, 15e3).unref();
setTimeout(tick, 5e3).unref();

// ---------- Thống kê ----------
const TZ = 7 * 3600e3; // giờ Việt Nam
export function stats(user, accountId, days = 14) {
  const row = ownAccount(user, accountId);
  days = Math.min(90, Math.max(1, Number(days) || 14));
  const since = (() => { const d = new Date(now() + TZ); d.setUTCHours(0, 0, 0, 0); return d.getTime() - TZ - (days - 1) * 864e5; })();
  const perDay = db.prepare(
    `SELECT date((ts + ${TZ}) / 1000, 'unixepoch') day, SUM(is_self = 0) incoming, SUM(is_self = 1) outgoing
     FROM messages WHERE account_id = ? AND ts >= ? AND recalled = 0 GROUP BY day ORDER BY day`
  ).all(row.id, since);
  // điền đủ ngày không có tin
  const byDay = new Map(perDay.map((r) => [r.day, r]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(since + TZ + i * 864e5).toISOString().slice(0, 10);
    const r = byDay.get(day);
    series.push({ day, incoming: r?.incoming || 0, outgoing: r?.outgoing || 0 });
  }

  // Thời gian trả lời: từ tin đầu tiên của khách (sau lượt mình) tới tin trả lời kế tiếp của mình, chỉ chat cá nhân, bỏ khoảng > 24 giờ
  const msgs = db.prepare(
    `SELECT thread_id, ts, is_self FROM messages WHERE account_id = ? AND type = 0 AND ts >= ? AND recalled = 0 ORDER BY thread_id, ts`
  ).all(row.id, since);
  const waits = [];
  let cur = null, start = null;
  for (const m of msgs) {
    if (m.thread_id !== cur) { cur = m.thread_id; start = null; }
    if (!m.is_self) { if (start == null) start = m.ts; }
    else if (start != null) { const w = m.ts - start; if (w >= 0 && w <= 864e5) waits.push(w); start = null; }
  }
  waits.sort((a, b) => a - b);
  const avg = waits.length ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : null;
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;

  const unanswered = db.prepare(
    `SELECT t.thread_id threadId, t.type, t.name, t.avatar, t.last_ts lastTs, t.last_text lastText FROM threads t
     WHERE t.account_id = ? AND t.type = 0 AND (SELECT is_self FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.thread_id
       AND m.type = t.type AND m.recalled = 0 ORDER BY m.ts DESC LIMIT 1) = 0
     ORDER BY t.last_ts ASC LIMIT 50`
  ).all(row.id);
  const labels = db.prepare(
    `SELECT l.id, l.name, l.color, COUNT(tl.label_id) n FROM labels l
     LEFT JOIN thread_labels tl ON tl.label_id = l.id AND tl.account_id = ?
     WHERE l.user_id = ? GROUP BY l.id ORDER BY l.pos, l.id`
  ).all(row.id, row.user_id);
  const active = db.prepare("SELECT COUNT(DISTINCT thread_id || ':' || type) n FROM messages WHERE account_id = ? AND ts >= ?").get(row.id, since).n;
  const newThreads = db.prepare(
    `SELECT COUNT(*) n FROM (SELECT MIN(ts) f FROM messages WHERE account_id = ? AND type = 0 GROUP BY thread_id) WHERE f >= ?`
  ).get(row.id, since).n;
  return {
    days, series, active, newThreads,
    totals: series.reduce((t, d) => ({ incoming: t.incoming + d.incoming, outgoing: t.outgoing + d.outgoing }), { incoming: 0, outgoing: 0 }),
    response: { count: waits.length, avg, median },
    unanswered, labels,
  };
}
