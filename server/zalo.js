import crypto from "node:crypto";
import { Zalo, ThreadType, LoginQRCallbackEventType, Reactions } from "zca-js";
import { db, encrypt, decrypt, now, getSetting, unaccent } from "./db.js";
import { saveMedia, removeMediaOfAccount } from "./media.js";
import { emit, pushToUser } from "./push.js";
import { httpError } from "./auth.js";
import { logActivity } from "./activity.js";
import { emoticons } from "../public/emoticons.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const zaloOpts = { selfListen: true, checkUpdate: false, logging: false };

const live = new Map(); // accountId -> { api, userId, retries, timer }

// ---------- Chuyển tin nhắn Zalo thành dạng gọn để lưu/hiển thị ----------
function parseContent(msgType, content) {
  if (typeof content === "string") return { kind: "text", text: content };
  const c = content || {};
  let params = {};
  try { params = typeof c.params === "string" ? JSON.parse(c.params) : c.params || {}; } catch {}
  switch (msgType) {
    case "chat.photo":
      return { kind: "image", url: params.hd || c.href, thumb: c.thumb || c.href, text: c.title || c.description || "" };
    case "chat.gif":
      return { kind: "image", url: c.href, thumb: c.thumb || c.href };
    case "share.file":
      return { kind: "file", url: c.href, title: c.title, text: params.fileSize ? fmtSize(Number(params.fileSize)) : "" };
    case "chat.video.msg":
      return { kind: "video", url: c.href, thumb: c.thumb, text: c.title || "" };
    case "chat.voice":
      return { kind: "voice", url: c.href };
    case "chat.sticker":
      return { kind: "sticker", text: "[Sticker]", stickerId: Number(c.id || c.sticker_id) || null, title: JSON.stringify({ id: Number(c.id), cateId: Number(c.catId ?? c.cateId), type: Number(c.type) }) };
    case "chat.recommended":
    case "chat.link":
      return { kind: "link", url: c.href, title: c.title, thumb: c.thumb, text: c.description || "" };
    default:
      return { kind: "other", text: c.title || c.description || `[${msgType}]`, url: c.href || null };
  }
}
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB");

export function preview(m) {
  switch (m.kind) {
    case "text": return emoticons(m.text);
    case "image": return "[Hình ảnh]" + (m.text ? " " + m.text : "");
    case "file": return "[File] " + (m.title || "");
    case "video": return "[Video]";
    case "voice": return "[Tin nhắn thoại]";
    case "link": return m.title || m.url || "[Liên kết]";
    default: return m.text || "";
  }
}

// Phần tin gốc cần giữ để trả lời (quote), thả cảm xúc, thu hồi, báo đã xem
const rawOf = (d) => JSON.stringify({
  msgId: String(d.msgId), cliMsgId: String(d.cliMsgId ?? ""), uidFrom: String(d.uidFrom), idTo: String(d.idTo ?? ""),
  msgType: d.msgType, content: d.content, propertyExt: d.propertyExt, ttl: d.ttl ?? 0, ts: String(d.ts),
  st: d.st, at: d.at, cmd: d.cmd,
});
function quoteOf(d) {
  const q = d.quote;
  if (!q) return null;
  let text = q.msg || "";
  if (!text && q.attach) { try { const a = JSON.parse(q.attach); text = a.title || (a.href ? "[Đính kèm]" : ""); } catch { text = "[Đính kèm]"; } }
  return JSON.stringify({ name: q.fromD || "", text: text || "[Tin nhắn]", msgId: String(q.globalMsgId || "") });
}

// ---------- Ảnh sticker (cache theo id) ----------
const stickerCache = new Map();
async function stickerUrl(acc, id) {
  if (!id) return null;
  if (stickerCache.has(id)) return stickerCache.get(id);
  let url = null;
  try {
    const [d] = await acc.api.getStickersDetail(id);
    url = d?.stickerWebpUrl || d?.stickerUrl || null;
  } catch {}
  url ||= `https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=${id}&size=130`;
  stickerCache.set(id, url);
  return url;
}

// ---------- Tên & ảnh đại diện của hội thoại (có cache trong bảng threads) ----------
async function resolveThread(acc, threadId, type, hint) {
  const row = db.prepare("SELECT name, avatar FROM threads WHERE account_id = ? AND thread_id = ? AND type = ?").get(acc.id, threadId, type);
  if (row?.name) return row;
  let name = null, avatar = null;
  try {
    if (type === ThreadType.Group) {
      const r = await acc.api.getGroupInfo(threadId);
      const g = r.gridInfoMap?.[threadId];
      name = g?.name; avatar = g?.avt || g?.fullAvt;
    } else {
      const r = await acc.api.getUserInfo(threadId);
      const p = r.changed_profiles?.[threadId] || r.changed_profiles?.[`${threadId}_0`];
      name = p?.displayName || p?.zaloName; avatar = p?.avatar;
    }
  } catch (e) { /* bỏ qua, dùng tên gợi ý */ }
  return { name: name || hint || threadId, avatar };
}

async function storeMessage(acc, msg, { notify }) {
  const d = msg.data;
  const type = msg.type;
  const threadId = msg.threadId;
  const p = parseContent(d.msgType, d.content);
  const ts = Number(d.ts) || now();
  if (p.kind === "sticker") { p.url = await stickerUrl(acc, p.stickerId); delete p.stickerId; }
  const old = db.prepare("SELECT id, url, raw FROM messages WHERE account_id = ? AND msg_id = ?").get(acc.id, String(d.msgId));
  if (old) {
    // tin đã có: bổ sung phần còn thiếu cho tin lưu từ bản cũ
    if (!old.url && p.url) db.prepare("UPDATE messages SET url = ? WHERE id = ?").run(p.url, old.id);
    if (!old.raw) db.prepare("UPDATE messages SET raw = ?, cli_msg_id = ?, quote = ?, title = COALESCE(title, ?) WHERE id = ?")
      .run(rawOf(d), d.cliMsgId ? String(d.cliMsgId) : null, quoteOf(d), p.kind === "sticker" ? p.title : null, old.id);
    return false;
  }
  const ins = db.prepare(
    `INSERT OR IGNORE INTO messages (account_id, thread_id, type, msg_id, from_uid, from_name, ts, is_self, kind, text, url, thumb, title, cli_msg_id, raw, quote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(acc.id, threadId, type, String(d.msgId), d.uidFrom, d.dName || null, ts, msg.isSelf ? 1 : 0,
        p.kind, p.text ?? null, p.url ?? null, p.thumb ?? null, p.title ?? null, d.cliMsgId ? String(d.cliMsgId) : null,
        rawOf(d), quoteOf(d));
  if (!ins.changes) return false;

  const info = await resolveThread(acc, threadId, type, type === ThreadType.User && !msg.isSelf ? d.dName : null);
  const text = preview(p);
  db.prepare(
    `INSERT INTO threads (account_id, thread_id, type, name, avatar, last_ts, last_text, unread)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_id, type) DO UPDATE SET
       name = COALESCE(excluded.name, name), avatar = COALESCE(excluded.avatar, avatar),
       last_ts = MAX(last_ts, excluded.last_ts),
       last_text = CASE WHEN excluded.last_ts >= last_ts THEN excluded.last_text ELSE last_text END,
       unread = CASE WHEN ? THEN unread + 1 ELSE unread END`
  ).run(acc.id, threadId, type, info.name, info.avatar, ts, text, notify && !msg.isSelf ? 1 : 0, notify && !msg.isSelf ? 1 : 0);

  const out = {
    id: Number(ins.lastInsertRowid), accountId: acc.id, threadId, type, msgId: String(d.msgId), fromUid: d.uidFrom, fromName: d.dName,
    ts, isSelf: msg.isSelf, ...p, quote: quoteOf(d) ? JSON.parse(quoteOf(d)) : null, reactions: [],
  };
  emitAcc(acc.id, "message", { ...out, threadName: info.name, threadAvatar: info.avatar });

  // Lưu ảnh/file về server (chạy nền, không chặn tin nhắn)
  if (p.url && ["image", "file", "video", "voice"].includes(p.kind)) {
    const msgRowId = Number(ins.lastInsertRowid);
    saveMedia(acc.id, msgRowId, p).catch((e) => console.error("lưu media lỗi", e?.message || e));
  }

  if (notify && !msg.isSelf) {
    const a = db.prepare("SELECT name, notify, notify_groups FROM zalo_accounts WHERE id = ?").get(acc.id);
    const muted = db.prepare("SELECT muted FROM threads WHERE account_id = ? AND thread_id = ? AND type = ?").get(acc.id, threadId, type)?.muted;
    if (a?.notify && !muted && (type !== ThreadType.Group || a.notify_groups)) {
      const who = type === ThreadType.Group ? `${d.dName}: ` : "";
      for (const uid of audience(acc.id)) {
        const prefs = userPrefs(uid);
        pushToUser(uid, {
          title: prefs.push_preview ? `${info.name} · ${a.name || "Zalo"}` : a.name || "Zalo Multi",
          body: prefs.push_preview ? who + text : "Bạn có tin nhắn mới",
          icon: prefs.push_preview ? info.avatar || undefined : undefined,
          tag: `${acc.id}-${type}-${threadId}`,
          url: `#/a/${acc.id}/${type}/${threadId}`,
          badge: prefs.app_badge ? unreadTotal(uid) : 0,
        });
      }
    }
  }
  return true;
}

// Chủ tài khoản Zalo + nhân viên được giao: cùng nhận tin realtime và thông báo
export function audience(accountId) {
  return db.prepare(
    `SELECT user_id FROM zalo_accounts WHERE id = ? UNION
     SELECT s.user_id FROM account_shares s JOIN users u ON u.id = s.user_id WHERE s.account_id = ? AND u.disabled = 0`
  ).all(accountId, accountId).map((r) => r.user_id);
}
const emitAcc = (accountId, event, data) => { for (const uid of audience(accountId)) emit(uid, event, data); };
// Điều kiện SQL "tài khoản Zalo mà người dùng được dùng" (của mình hoặc được giao)
const myAccounts = (userId) =>
  `(SELECT id FROM zalo_accounts WHERE user_id = ${Number(userId)} UNION SELECT account_id FROM account_shares WHERE user_id = ${Number(userId)})`;

function userPrefs(userId) {
  const row = db.prepare("SELECT prefs FROM users WHERE id = ?").get(userId);
  return { push_preview: true, app_badge: true, ...JSON.parse(row?.prefs || "{}") };
}

// Tổng tin chưa đọc của người dùng (bỏ qua hội thoại đã tắt thông báo / tài khoản tắt thông báo) – dùng cho số trên icon app
export function unreadTotal(userId) {
  return db.prepare(
    `SELECT COALESCE(SUM(t.unread), 0) n FROM threads t JOIN zalo_accounts a ON a.id = t.account_id
     WHERE a.id IN ${myAccounts(userId)} AND a.notify = 1 AND t.muted = 0 AND (t.type = 0 OR a.notify_groups = 1)`
  ).get().n;
}

// Hàm được gọi mỗi khi trạng thái tài khoản đổi (alerts.js đăng ký để gửi cảnh báo)
export const statusHooks = [];
function setStatus(accountId, userId, status, msg = null) {
  db.prepare("UPDATE zalo_accounts SET status = ?, status_msg = ? WHERE id = ?").run(status, msg, accountId);
  for (const h of statusHooks) try { h(accountId, status); } catch (e) { console.error("hook trạng thái lỗi", e); }
  emitAcc(accountId, "account", { id: accountId, status, statusMsg: msg });
}

// ---------- Đồng bộ tin cũ ----------
// Zalo trả tin cũ theo từng trang qua websocket; xin tiếp trang sau bằng msgId cũ nhất của trang trước.
const OLD_MAX_PAGES = 40;
function syncOld(acc) {
  acc.old = { [ThreadType.User]: { pages: 0, oldest: Infinity }, [ThreadType.Group]: { pages: 0, oldest: Infinity } };
  try {
    const l = acc.api.listener;
    l.requestOldMessages(ThreadType.User); l.requestOldMessages(ThreadType.Group);
    l.requestOldReactions(ThreadType.User); l.requestOldReactions(ThreadType.Group);
  } catch {}
}
async function onOldMessages(acc, list, type) {
  let added = 0, oldest = null;
  for (const m of list) {
    if (await storeMessage(acc, m, { notify: false })) added++;
    if (!oldest || Number(m.data.ts) < Number(oldest.data.ts)) oldest = m;
  }
  const st = acc.old?.[type];
  console.log(`zalo #${acc.id} tin cũ ${type === ThreadType.Group ? "nhóm" : "cá nhân"}: ${list.length} tin, ${added} mới, trang ${st ? st.pages + 1 : "-"}`);
  if (!st || !oldest) return;
  st.pages++;
  const ts = Number(oldest.data.ts);
  if (ts >= st.oldest || st.pages >= OLD_MAX_PAGES) return; // hết tin cũ hơn
  st.oldest = ts;
  try { acc.api.listener.requestOldMessages(type, String(oldest.data.msgId)); } catch {}
}

// ---------- Kết nối / lắng nghe ----------
function attach(accountId, userId, api) {
  const acc = { id: accountId, userId, api, retries: 0 };
  live.set(accountId, acc);
  const l = api.listener;
  l.on("connected", () => {
    acc.retries = 0;
    setStatus(accountId, userId, "online");
    // Lấy lại tin gần đây (lúc server tắt / mới đăng nhập)
    syncOld(acc);
  });
  l.on("message", (m) => storeMessage(acc, m, { notify: true }).catch((e) => console.error("lưu tin lỗi", e)));
  l.on("old_messages", (list, type) => onOldMessages(acc, list, type).catch((e) => console.error("tin cũ lỗi", e)));
  l.on("reaction", (r) => { try { handleReaction(acc, r); } catch (e) { console.error("cảm xúc lỗi", e); } });
  l.on("old_reactions", (list) => { for (const r of list) try { handleReaction(acc, r, true); } catch {} });
  l.on("undo", (u) => { try { handleUndo(acc, u); } catch (e) { console.error("thu hồi lỗi", e); } });
  l.on("typing", (t) => emitAcc(accountId, "typing", { accountId, threadId: String(t.threadId), type: t.type, uid: String(t.data?.uid || "") }));
  l.on("error", (e) => console.error(`zalo #${accountId} lỗi`, e?.message || e));
  l.on("closed", (code, reason) => {
    if (live.get(accountId) !== acc) return; // đã được thay thế/gỡ
    live.delete(accountId);
    if (code === 3000 || code === 3003) {
      // Zalo chỉ cho 1 phiên web cùng lúc: mở Zalo Web/PC nơi khác sẽ đá phiên này ra
      setStatus(accountId, userId, "kicked", "Tài khoản đang mở Zalo Web ở nơi khác. Bấm Kết nối lại để dùng ở đây.");
      return;
    }
    setStatus(accountId, userId, "reconnecting", `Mất kết nối (${code}), đang thử lại…`);
    const delay = Math.min(300e3, 5e3 * 2 ** Math.min(acc.retries, 6));
    setTimeout(() => connect(accountId).catch(() => {}), delay);
  });
  l.start({ retryOnClose: false });
}

export async function connect(accountId) {
  const row = db.prepare("SELECT * FROM zalo_accounts WHERE id = ?").get(accountId);
  if (!row) return;
  const prev = live.get(accountId);
  if (prev) { live.delete(accountId); try { prev.api.listener.stop(); } catch {} }
  setStatus(row.id, row.user_id, "connecting");
  try {
    const api = await new Zalo(zaloOpts).login(decrypt(row.creds_enc));
    attach(row.id, row.user_id, api);
  } catch (e) {
    console.error(`zalo #${accountId} đăng nhập lỗi`, e?.message || e);
    setStatus(row.id, row.user_id, "expired", "Phiên đăng nhập Zalo đã hết hạn. Hãy quét mã QR lại.");
  }
}

export function connectAll() {
  const rows = db.prepare("SELECT a.id FROM zalo_accounts a JOIN users u ON u.id = a.user_id WHERE u.disabled = 0").all();
  rows.forEach((r, i) => setTimeout(() => connect(r.id).catch(() => {}), i * 2000));
}

// ---------- Đăng nhập bằng QR ----------
const qrSessions = new Map(); // key -> { userId, abort }

export function startQrLogin(user, replaceAccountId = null) {
  const key = crypto.randomBytes(8).toString("hex");
  const s = { userId: user.id, abort: null, done: false };
  qrSessions.set(key, s);
  const zalo = new Zalo(zaloOpts);
  let creds = null, scanned = null;
  const timeout = setTimeout(() => { s.abort?.(); finish("expired", { message: "Hết thời gian chờ quét mã" }); }, 5 * 60e3);
  const finish = (event, data) => {
    if (s.done) return;
    s.done = true; clearTimeout(timeout); qrSessions.delete(key);
    emit(user.id, "qr", { key, event, ...data });
  };

  zalo.loginQR({ userAgent: UA }, (ev) => {
    if (ev.actions?.abort) s.abort = ev.actions.abort;
    switch (ev.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        emit(user.id, "qr", { key, event: "code", image: ev.data.image });
        break;
      case LoginQRCallbackEventType.QRCodeExpired:
        ev.actions.retry();
        break;
      case LoginQRCallbackEventType.QRCodeScanned:
        scanned = ev.data;
        emit(user.id, "qr", { key, event: "scanned", name: ev.data.display_name, avatar: ev.data.avatar });
        break;
      case LoginQRCallbackEventType.QRCodeDeclined:
        finish("declined", { message: "Đã từ chối đăng nhập trên điện thoại" });
        break;
      case LoginQRCallbackEventType.GotLoginInfo:
        creds = ev.data;
        break;
    }
  }).then(async (api) => {
    if (!api || !creds) return finish("error", { message: "Không đăng nhập được" });
    const uid = String(api.getOwnId());
    let name = scanned?.display_name, avatar = scanned?.avatar;
    try {
      const info = await api.fetchAccountInfo();
      const p = info?.profile || info;
      name = p?.displayName || p?.zaloName || name; avatar = p?.avatar || avatar;
    } catch {}
    const existing = db.prepare("SELECT * FROM zalo_accounts WHERE zalo_uid = ?").get(uid);
    if (existing && existing.user_id !== user.id) {
      try { api.listener.stop(); } catch {}
      return finish("error", { message: "Tài khoản Zalo này đang được người khác dùng trong app" });
    }
    if (replaceAccountId && existing && existing.id !== Number(replaceAccountId)) {
      // quét nhầm tài khoản khác: vẫn lưu như một tài khoản mới
    }
    const enc = encrypt({ imei: creds.imei, cookie: creds.cookie, userAgent: creds.userAgent });
    let id;
    if (existing) {
      db.prepare("UPDATE zalo_accounts SET creds_enc = ?, name = ?, avatar = ? WHERE id = ?").run(enc, name, avatar, existing.id);
      id = existing.id;
      const prev = live.get(id);
      if (prev) { live.delete(id); try { prev.api.listener.stop(); } catch {} }
    } else {
      id = Number(db.prepare(
        "INSERT INTO zalo_accounts (user_id, zalo_uid, name, avatar, creds_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(user.id, uid, name, avatar, enc, now()).lastInsertRowid);
    }
    attach(id, user.id, api);
    logActivity({ user, action: existing ? "reqr_account" : "add_account", accountId: id });
    finish("success", { account: { id, name, avatar } });
  }).catch((e) => finish("error", { message: e?.message || "Lỗi đăng nhập Zalo" }));

  return key;
}

export function cancelQrLogin(user, key) {
  const s = qrSessions.get(key);
  if (s && s.userId === user.id) { s.abort?.(); qrSessions.delete(key); }
}

// ---------- Thao tác cho API ----------
// Quyền với một tài khoản Zalo: view (chỉ xem) < reply (được trả lời) < owner (chủ)
const LEVEL = { view: 0, reply: 1, owner: 2 };
export function accessOf(user, accountId) {
  const row = db.prepare("SELECT * FROM zalo_accounts WHERE id = ?").get(Number(accountId));
  if (!row) return null;
  if (row.user_id === user.id) return { row, access: "owner" };
  const sh = db.prepare("SELECT can_reply FROM account_shares WHERE account_id = ? AND user_id = ?").get(row.id, user.id);
  return sh ? { row, access: sh.can_reply ? "reply" : "view" } : null;
}
export function ownAccount(user, accountId, need = "view") {
  const a = accessOf(user, accountId);
  if (!a) throw httpError(404, "Không tìm thấy tài khoản");
  if (LEVEL[a.access] < LEVEL[need]) throw httpError(403, need === "owner" ? "Chỉ chủ tài khoản Zalo làm được việc này" : "Bạn chỉ có quyền xem tài khoản này");
  return Object.assign(a.row, { access: a.access });
}
export function liveApi(user, accountId, need = "reply") {
  ownAccount(user, accountId, need);
  const acc = live.get(Number(accountId));
  if (!acc) throw httpError(409, "Tài khoản Zalo chưa kết nối");
  return acc.api;
}

export function listAccounts(user) {
  return db.prepare(
    `SELECT a.id, a.zalo_uid zaloUid, a.name, a.avatar, a.status, a.status_msg statusMsg, a.notify, a.notify_groups notifyGroups,
            (SELECT COALESCE(SUM(unread),0) FROM threads t WHERE t.account_id = a.id AND t.muted = 0) unread,
            CASE WHEN a.user_id = ? THEN 'owner' WHEN s.can_reply = 1 THEN 'reply' ELSE 'view' END access,
            CASE WHEN a.user_id = ? THEN NULL ELSE o.username END owner, a.user_id ownerId
     FROM zalo_accounts a JOIN users o ON o.id = a.user_id
     LEFT JOIN account_shares s ON s.account_id = a.id AND s.user_id = ?
     WHERE a.user_id = ? OR s.user_id IS NOT NULL ORDER BY a.user_id != ?, a.created_at`
  ).all(user.id, user.id, user.id, user.id, user.id);
}

// ---------- Giao tài khoản cho nhân viên ----------
export function listShares(user, accountId) {
  const row = ownAccount(user, accountId, "owner");
  return db.prepare(
    `SELECT u.id userId, u.username, s.can_reply canReply, s.created_at createdAt FROM account_shares s JOIN users u ON u.id = s.user_id
     WHERE s.account_id = ? ORDER BY u.username`
  ).all(row.id);
}
export function saveShare(user, accountId, { username, canReply }) {
  const row = ownAccount(user, accountId, "owner");
  const u = db.prepare("SELECT id FROM users WHERE username = ?").get(String(username || "").trim());
  if (!u) throw httpError(404, "Không có người dùng này trong app (nhân viên cần đăng ký tài khoản app trước)");
  if (u.id === row.user_id) throw httpError(400, "Đây là chủ tài khoản");
  db.prepare(
    `INSERT INTO account_shares (account_id, user_id, can_reply, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, user_id) DO UPDATE SET can_reply = excluded.can_reply`
  ).run(row.id, u.id, canReply ? 1 : 0, now());
  emit(u.id, "accounts", {});
  return listShares(user, accountId);
}
export function removeShare(user, accountId, userId) {
  const row = ownAccount(user, accountId, "owner");
  db.prepare("DELETE FROM account_shares WHERE account_id = ? AND user_id = ?").run(row.id, Number(userId));
  emit(Number(userId), "accounts", {});
  return listShares(user, accountId);
}
// Nhân viên tự bỏ tài khoản được giao
export function leaveShare(user, accountId) {
  db.prepare("DELETE FROM account_shares WHERE account_id = ? AND user_id = ?").run(Number(accountId), user.id);
}

export function removeAccount(user, accountId) {
  const row = ownAccount(user, accountId, "owner");
  const acc = live.get(row.id);
  live.delete(row.id);
  try { acc?.api.listener.stop(); } catch {}
  db.prepare("DELETE FROM zalo_accounts WHERE id = ?").run(row.id);
  removeMediaOfAccount(row.id);
}

export function reconnect(user, accountId) {
  const row = ownAccount(user, accountId, "reply");
  connect(row.id).catch(() => {});
}

// Bộ lọc danh sách hội thoại: all | unread | user | group | unanswered | label:<id>
const THREAD_FILTER = {
  unread: "AND t.unread > 0", user: "AND t.type = 0", group: "AND t.type = 1",
  // chat cá nhân mà tin cuối cùng là của khách
  unanswered: `AND t.type = 0 AND (SELECT is_self FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.thread_id
    AND m.type = t.type AND m.recalled = 0 ORDER BY m.ts DESC LIMIT 1) = 0`,
};
function threadFilter(f = "") {
  const lb = /^label:(\d+)$/.exec(f);
  if (lb) return `AND EXISTS (SELECT 1 FROM thread_labels l WHERE l.account_id = t.account_id AND l.thread_id = t.thread_id AND l.type = t.type AND l.label_id = ${Number(lb[1])})`;
  return THREAD_FILTER[f] || "";
}
// Gắn danh sách id nhãn vào từng hội thoại
function withLabels(threads, accountIds) {
  if (!threads.length) return threads;
  const rows = db.prepare(`SELECT account_id, thread_id, type, label_id FROM thread_labels WHERE account_id IN (${accountIds.map(Number).join(",")})`).all();
  const map = new Map();
  for (const r of rows) { const k = `${r.account_id}:${r.type}:${r.thread_id}`; (map.get(k) || map.set(k, []).get(k)).push(r.label_id); }
  for (const t of threads) t.labels = map.get(`${t.accountId ?? accountIds[0]}:${t.type}:${t.threadId}`) || [];
  return threads;
}
const likeArg = (q) => `%${unaccent(q).replace(/[\\%_]/g, "\\$&")}%`;

export function listThreads(user, accountId, q = "", filter = "all") {
  const row = ownAccount(user, accountId);
  const rows = db.prepare(
    `SELECT thread_id threadId, type, name, avatar, last_ts lastTs, last_text lastText, unread, muted, pinned
     FROM threads t WHERE account_id = ? AND (? = '' OR unaccent(name) LIKE ? ESCAPE '\\') ${threadFilter(filter)}
     ORDER BY pinned > 0 DESC, pinned DESC, last_ts DESC LIMIT 300`
  ).all(row.id, q, likeArg(q));
  return withLabels(rows, [row.id]);
}

// Hộp thư chung: hội thoại của mọi tài khoản Zalo của người dùng, mới nhất lên đầu
export function inbox(user, filter = "all") {
  const rows = db.prepare(
    `SELECT t.account_id accountId, a.name accountName, a.avatar accountAvatar, t.thread_id threadId, t.type, t.name, t.avatar,
            t.last_ts lastTs, t.last_text lastText, t.unread, t.muted, t.pinned
     FROM threads t JOIN zalo_accounts a ON a.id = t.account_id
     WHERE a.id IN ${myAccounts(user.id)} AND t.last_ts > 0 ${threadFilter(filter)}
     ORDER BY t.last_ts DESC LIMIT 200`
  ).all();
  return withLabels(rows, [...new Set(rows.map((r) => r.accountId))]);
}

export function setThreadPinned(user, accountId, type, threadId, pinned) {
  const row = ownAccount(user, accountId, "reply");
  db.prepare("UPDATE threads SET pinned = ? WHERE account_id = ? AND type = ? AND thread_id = ?").run(pinned ? now() : 0, row.id, Number(type), String(threadId));
}

// Tìm trong nội dung tin đã lưu (chữ, tên file, tiêu đề link); accountId trống = mọi tài khoản
export function searchMessages(user, accountId, q, { type, threadId } = {}) {
  q = String(q || "").trim();
  if (q.length < 2) return [];
  const acc = accountId ? ownAccount(user, accountId).id : null;
  return db.prepare(
    `SELECT m.id, m.msg_id msgId, m.account_id accountId, a.name accountName, m.thread_id threadId, m.type, t.name threadName, t.avatar,
            m.from_name fromName, m.is_self isSelf, m.ts, m.kind, m.text, m.title
     FROM messages m JOIN zalo_accounts a ON a.id = m.account_id
     LEFT JOIN threads t ON t.account_id = m.account_id AND t.thread_id = m.thread_id AND t.type = m.type
     WHERE a.id IN ${myAccounts(user.id)} AND (? IS NULL OR m.account_id = ?) AND (? IS NULL OR (m.type = ? AND m.thread_id = ?)) AND m.recalled = 0
       AND (unaccent(m.text) LIKE ? ESCAPE '\\' OR unaccent(m.title) LIKE ? ESCAPE '\\')
     ORDER BY m.ts DESC LIMIT 80`
  ).all(acc, acc, threadId == null ? null : 1, Number(type), String(threadId ?? ""), likeArg(q), likeArg(q));
}

const MSG_COLS = "id, msg_id msgId, from_uid fromUid, from_name fromName, ts, is_self isSelf, kind, text, url, thumb, title, media, quote, recalled";
// before: tin cũ hơn mốc; after: tin mới hơn mốc; around: msgId cần nhảy tới (lấy tin quanh nó)
export function listMessages(user, accountId, type, threadId, before, { after, around } = {}) {
  const row = ownAccount(user, accountId);
  const args = [row.id, Number(type), String(threadId)];
  const page = (cond, val, dir, n) => db.prepare(
    `SELECT ${MSG_COLS} FROM messages WHERE account_id = ? AND type = ? AND thread_id = ? AND ts ${cond} ? ORDER BY ts ${dir} LIMIT ${n}`).all(...args, val);
  let rows;
  const target = around && db.prepare("SELECT ts FROM messages WHERE account_id = ? AND type = ? AND thread_id = ? AND msg_id = ?").get(...args, String(around));
  if (target) rows = page("<=", target.ts, "DESC", 40).concat(page(">", target.ts, "ASC", 30).reverse()).sort((a, b) => b.ts - a.ts);
  else if (after) rows = page(">", Number(after), "ASC", 60).reverse();
  else rows = page("<", Number(before) || 9e15, "DESC", 60);
  const wasUnread = db.prepare("SELECT unread FROM threads WHERE account_id = ? AND type = ? AND thread_id = ?").get(row.id, Number(type), String(threadId))?.unread;
  db.prepare("UPDATE threads SET unread = 0 WHERE account_id = ? AND type = ? AND thread_id = ?").run(row.id, Number(type), String(threadId));
  const react = db.prepare("SELECT uid, icon, name FROM reactions WHERE account_id = ? AND msg_id = ?");
  for (const m of rows) {
    m.quote = m.quote ? JSON.parse(m.quote) : null;
    m.reactions = react.all(row.id, m.msgId);
    if (m.recalled) Object.assign(m, { kind: "recalled", text: null, url: null, thumb: null, media: null });
  }
  if (wasUnread && !before && !around && row.access !== "view") sendSeen(row.id, Number(type), String(threadId));
  return rows.reverse();
}

export async function sendText(user, accountId, type, threadId, text, quoteMsgId) {
  if (typeof text !== "string" || !text.trim()) throw httpError(400, "Tin nhắn trống");
  if (text.length > 5000) throw httpError(400, "Tin nhắn quá dài");
  const api = liveApi(user, accountId);
  let quote;
  if (quoteMsgId) {
    const r = rawMsg(Number(accountId), quoteMsgId);
    quote = { content: r.content, msgType: r.msgType, propertyExt: r.propertyExt, uidFrom: r.uidFrom, msgId: r.msgId, cliMsgId: r.cliMsgId, ts: r.ts, ttl: r.ttl };
  }
  return api.sendMessage({ msg: text, quote }, String(threadId), tType(type));
}

export async function sendImage(user, accountId, type, threadId, { data, filename, width, height, caption }) {
  const buf = Buffer.from(String(data || ""), "base64");
  if (!buf.length) throw httpError(400, "Ảnh trống");
  if (buf.length > 20 * 1048576) throw httpError(413, "Ảnh quá lớn (tối đa 20MB)");
  const ext = (String(filename || "").match(/\.(jpe?g|png|webp|gif)$/i)?.[1] || "jpg").toLowerCase();
  const api = liveApi(user, accountId);
  return api.sendMessage({
    msg: String(caption || ""),
    attachments: [{ data: buf, filename: `photo_${Date.now()}.${ext}`, metadata: { totalSize: buf.length, width: Number(width) || 0, height: Number(height) || 0 } }],
  }, String(threadId), Number(type) === 1 ? ThreadType.Group : ThreadType.User);
}

export async function syncContacts(user, accountId) {
  // Nạp danh sách nhóm + bạn bè vào danh sách hội thoại (chưa có tin) để có thể nhắn mới
  const row = ownAccount(user, accountId);
  const api = liveApi(user, accountId);
  const ins = db.prepare(
    `INSERT INTO threads (account_id, thread_id, type, name, avatar) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_id, type) DO UPDATE SET name = excluded.name, avatar = COALESCE(excluded.avatar, avatar)`
  );
  let friends = 0, groups = 0;
  try {
    for (const f of await api.getAllFriends()) { ins.run(row.id, String(f.userId), 0, f.displayName || f.zaloName, f.avatar); friends++; }
  } catch (e) { console.error("getAllFriends", e?.message); }
  try {
    const ids = Object.keys((await api.getAllGroups()).gridVerMap || {});
    for (let i = 0; i < ids.length; i += 50) {
      const info = await api.getGroupInfo(ids.slice(i, i + 50));
      for (const [gid, g] of Object.entries(info.gridInfoMap || {})) { ins.run(row.id, gid, 1, g.name, g.avt || g.fullAvt); groups++; }
    }
  } catch (e) { console.error("getAllGroups", e?.message); }
  return { friends, groups };
}

// Tin cũ của một nhóm (Zalo có API lịch sử cho nhóm; chat cá nhân chỉ có phần tin cũ đồng bộ khi kết nối)
const historyDone = new Set();
export async function fetchHistory(user, accountId, type, threadId) {
  const row = ownAccount(user, accountId);
  if (Number(type) !== ThreadType.Group) return { added: 0 };
  const key = `${row.id}:${threadId}`;
  if (historyDone.has(key)) return { added: 0 };
  const api = liveApi(user, accountId, "view");
  const acc = live.get(row.id);
  const r = await api.getGroupChatHistory(String(threadId), Math.min(500, getSetting("group_history")) || 50);
  historyDone.add(key);
  let added = 0;
  for (const m of r.groupMsgs || []) if (await storeMessage(acc, m, { notify: false })) added++;
  return { added };
}

// ---------- Cài đặt thông báo ----------
export function setAccountNotify(user, accountId, { notify, notifyGroups }) {
  const row = ownAccount(user, accountId, "owner");
  if (notify !== undefined) db.prepare("UPDATE zalo_accounts SET notify = ? WHERE id = ?").run(notify ? 1 : 0, row.id);
  if (notifyGroups !== undefined) db.prepare("UPDATE zalo_accounts SET notify_groups = ? WHERE id = ?").run(notifyGroups ? 1 : 0, row.id);
}
export function setThreadMuted(user, accountId, type, threadId, muted) {
  const row = ownAccount(user, accountId, "reply");
  db.prepare("UPDATE threads SET muted = ? WHERE account_id = ? AND type = ? AND thread_id = ?").run(muted ? 1 : 0, row.id, Number(type), String(threadId));
}
export function markAllRead(user, accountId) {
  const row = ownAccount(user, accountId);
  db.prepare("UPDATE threads SET unread = 0 WHERE account_id = ?").run(row.id);
}

// ---------- Cho trang quản trị ----------
export function stopAccountsOfUser(userId) {
  for (const r of db.prepare("SELECT id FROM zalo_accounts WHERE user_id = ?").all(userId)) {
    const acc = live.get(r.id);
    live.delete(r.id);
    try { acc?.api.listener.stop(); } catch {}
    setStatus(r.id, userId, "offline", "Người dùng đã bị khoá");
  }
}
export function startAccountsOfUser(userId) {
  for (const r of db.prepare("SELECT id FROM zalo_accounts WHERE user_id = ?").all(userId)) connect(r.id).catch(() => {});
}
export const liveCount = () => live.size;

// Thư viện của hội thoại: ảnh/video, file, link
const GALLERY = { media: "('image','video')", file: "('file','voice')", link: "('link')" };
export function gallery(user, accountId, type, threadId, kind = "media", before) {
  const row = ownAccount(user, accountId);
  return db.prepare(
    `SELECT ${MSG_COLS} FROM messages WHERE account_id = ? AND type = ? AND thread_id = ? AND recalled = 0
       AND kind IN ${GALLERY[kind] || GALLERY.media} AND ts < ? ORDER BY ts DESC LIMIT 90`
  ).all(row.id, Number(type), String(threadId), Number(before) || 9e15);
}

// Gửi tin chữ từ server (tin hẹn giờ): cần tài khoản đang kết nối
export async function sendAsAccount(accountId, type, threadId, text) {
  const acc = live.get(Number(accountId));
  if (!acc) throw httpError(409, "Tài khoản Zalo chưa kết nối");
  return acc.api.sendMessage({ msg: text }, String(threadId), tType(type));
}
export const isLive = (accountId) => live.has(Number(accountId));

// ---------- Tin mẫu (trả lời nhanh) ----------
export const listQuickReplies = (user) =>
  db.prepare("SELECT id, shortcut, text FROM quick_replies WHERE user_id = ? ORDER BY shortcut").all(user.id);
export function saveQuickReply(user, { id, shortcut, text }) {
  shortcut = String(shortcut || "").trim().replace(/^\//, "").replace(/\s+/g, "-").slice(0, 30);
  text = String(text || "").trim().slice(0, 5000);
  if (!shortcut || !text) throw httpError(400, "Cần có tên tắt và nội dung");
  if (id) {
    const r = db.prepare("UPDATE quick_replies SET shortcut = ?, text = ? WHERE id = ? AND user_id = ?").run(shortcut, text, Number(id), user.id);
    if (!r.changes) throw httpError(404, "Không tìm thấy tin mẫu");
  } else {
    if (db.prepare("SELECT COUNT(*) n FROM quick_replies WHERE user_id = ?").get(user.id).n >= 200) throw httpError(400, "Tối đa 200 tin mẫu");
    db.prepare("INSERT INTO quick_replies (user_id, shortcut, text, created_at) VALUES (?, ?, ?, ?)").run(user.id, shortcut, text, now());
  }
  return listQuickReplies(user);
}
export function deleteQuickReply(user, id) {
  db.prepare("DELETE FROM quick_replies WHERE id = ? AND user_id = ?").run(Number(id), user.id);
  return listQuickReplies(user);
}

export function mediaRow(user, messageId) {
  return db.prepare(
    `SELECT m.media, m.title FROM messages m JOIN zalo_accounts a ON a.id = m.account_id
     WHERE m.id = ? AND a.id IN ${myAccounts(user.id)} AND m.media IS NOT NULL`
  ).get(Number(messageId));
}

// ---------- Tính năng chat giống Zalo ----------
const tType = (t) => (Number(t) === 1 ? ThreadType.Group : ThreadType.User);
function rawMsg(accountId, msgId) {
  const row = db.prepare("SELECT raw, thread_id, type, is_self, recalled FROM messages WHERE account_id = ? AND msg_id = ?").get(accountId, String(msgId));
  if (!row?.raw) throw httpError(404, "Không tìm thấy tin nhắn (tin cũ từ bản trước chưa hỗ trợ thao tác này)");
  return { ...JSON.parse(row.raw), threadId: row.thread_id, type: row.type, isSelf: row.is_self, recalled: row.recalled };
}

function reactionsOf(accountId, msgId) {
  return db.prepare("SELECT uid, icon, name FROM reactions WHERE account_id = ? AND msg_id = ?").all(accountId, msgId);
}
function handleReaction(acc, r, old = false) {
  const c = r.data.content || {};
  const uid = String(r.data.uidFrom);
  for (const t of c.rMsg || []) {
    const msgId = String(t.gMsgID);
    const m = db.prepare("SELECT thread_id, type, is_self FROM messages WHERE account_id = ? AND msg_id = ?").get(acc.id, msgId);
    if (!m) continue;
    if (!c.rIcon) db.prepare("DELETE FROM reactions WHERE account_id = ? AND msg_id = ? AND uid = ?").run(acc.id, msgId, uid);
    else db.prepare(
      `INSERT INTO reactions (account_id, msg_id, uid, icon, name, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, msg_id, uid) DO UPDATE SET icon = excluded.icon, name = COALESCE(excluded.name, name), ts = excluded.ts`
    ).run(acc.id, msgId, uid, c.rIcon, r.data.dName || null, Number(r.data.ts) || now());
    emitAcc(acc.id, "reaction", { accountId: acc.id, threadId: m.thread_id, type: m.type, msgId, reactions: reactionsOf(acc.id, msgId) });
    // Báo khi có người thả cảm xúc vào tin của mình
    if (!old && c.rIcon && m.is_self && !r.isSelf) {
      const a = db.prepare("SELECT name, notify FROM zalo_accounts WHERE id = ?").get(acc.id);
      const th = db.prepare("SELECT name, muted FROM threads WHERE account_id = ? AND thread_id = ? AND type = ?").get(acc.id, m.thread_id, m.type);
      if (a?.notify && !th?.muted) for (const uid of audience(acc.id)) if (userPrefs(uid).push_preview) pushToUser(uid, {
        title: `${th?.name || "Zalo"} · ${a.name}`, body: `${r.data.dName || "Ai đó"} đã bày tỏ cảm xúc ${emoticons(c.rIcon)} với tin nhắn của bạn`,
        tag: `${acc.id}-${m.type}-${m.thread_id}`, url: `#/a/${acc.id}/${m.type}/${m.thread_id}`,
      });
    }
  }
}

function handleUndo(acc, u) {
  const msgId = String(u.data.content?.globalMsgId || "");
  const m = db.prepare("SELECT id, thread_id, type FROM messages WHERE account_id = ? AND msg_id = ?").get(acc.id, msgId);
  if (!m) return;
  db.prepare("UPDATE messages SET recalled = 1 WHERE id = ?").run(m.id);
  const last = db.prepare("SELECT msg_id FROM messages WHERE account_id = ? AND thread_id = ? AND type = ? ORDER BY ts DESC LIMIT 1").get(acc.id, m.thread_id, m.type);
  if (last?.msg_id === msgId) db.prepare("UPDATE threads SET last_text = ? WHERE account_id = ? AND thread_id = ? AND type = ?").run("Tin nhắn đã được thu hồi", acc.id, m.thread_id, m.type);
  emitAcc(acc.id, "recall", { accountId: acc.id, threadId: m.thread_id, type: m.type, msgId });
}

export async function react(user, accountId, msgId, icon) {
  const api = liveApi(user, accountId);
  const r = rawMsg(Number(accountId), msgId);
  if (icon && !Object.values(Reactions).includes(icon)) throw httpError(400, "Biểu tượng không hợp lệ");
  await api.addReaction(icon || Reactions.NONE, { data: { msgId: r.msgId, cliMsgId: r.cliMsgId }, threadId: r.threadId, type: tType(r.type) });
  // cập nhật ngay, không chờ Zalo gửi lại
  const acc = live.get(Number(accountId));
  const me = String(acc.api.getOwnId());
  if (icon) db.prepare(`INSERT INTO reactions (account_id, msg_id, uid, icon, ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, msg_id, uid) DO UPDATE SET icon = excluded.icon, ts = excluded.ts`).run(Number(accountId), r.msgId, me, icon, now());
  else db.prepare("DELETE FROM reactions WHERE account_id = ? AND msg_id = ? AND uid = ?").run(Number(accountId), r.msgId, me);
  const reactions = reactionsOf(Number(accountId), r.msgId);
  emitAcc(Number(accountId), "reaction", { accountId: Number(accountId), threadId: r.threadId, type: r.type, msgId: r.msgId, reactions });
  return { reactions };
}

export async function recall(user, accountId, msgId) {
  const api = liveApi(user, accountId);
  const r = rawMsg(Number(accountId), msgId);
  if (!r.isSelf) throw httpError(403, "Chỉ thu hồi được tin của mình");
  await api.undo({ msgId: r.msgId, cliMsgId: r.cliMsgId }, r.threadId, tType(r.type));
  db.prepare("UPDATE messages SET recalled = 1 WHERE account_id = ? AND msg_id = ?").run(Number(accountId), r.msgId);
  emitAcc(Number(accountId), "recall", { accountId: Number(accountId), threadId: r.threadId, type: r.type, msgId: r.msgId });
  return { ok: true };
}

export async function deleteForMe(user, accountId, msgId) {
  const row = ownAccount(user, accountId, "reply");
  const r = rawMsg(row.id, msgId);
  const acc = live.get(row.id);
  if (acc) {
    try { await acc.api.deleteMessage({ data: { cliMsgId: r.cliMsgId, msgId: r.msgId, uidFrom: r.uidFrom }, threadId: r.threadId, type: tType(r.type) }, true); }
    catch (e) { console.error("xoá tin trên Zalo lỗi", e?.message); }
  }
  db.prepare("DELETE FROM messages WHERE account_id = ? AND msg_id = ?").run(row.id, r.msgId);
  return { ok: true };
}

function sendSeen(accountId, type, threadId) {
  const acc = live.get(accountId);
  if (!acc) return;
  const rows = db.prepare(
    "SELECT raw FROM messages WHERE account_id = ? AND type = ? AND thread_id = ? AND is_self = 0 AND raw IS NOT NULL ORDER BY ts DESC LIMIT 5"
  ).all(accountId, type, threadId);
  if (!rows.length) return;
  const msgs = rows.map((r) => {
    const d = JSON.parse(r.raw);
    return { msgId: d.msgId, cliMsgId: d.cliMsgId, uidFrom: d.uidFrom, idTo: d.idTo, msgType: d.msgType, st: d.st ?? 3, at: d.at ?? 0, cmd: d.cmd ?? 501, ts: d.ts };
  });
  acc.api.sendSeenEvent(msgs, tType(type)).catch((e) => console.error("báo đã xem lỗi", e?.message || e));
}

export async function sendTyping(user, accountId, type, threadId) {
  const api = liveApi(user, accountId);
  await api.sendTypingEvent(String(threadId), tType(type)).catch(() => {});
  return { ok: true };
}

// Sticker: id ảnh dùng chung đường dẫn công khai của Zalo
const stickerImg = (id) => `https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=${id}&size=130`;
export function recentStickers(user, accountId) {
  const row = ownAccount(user, accountId);
  return db.prepare(
    `SELECT title FROM messages WHERE account_id = ? AND kind = 'sticker' AND title IS NOT NULL
     GROUP BY title ORDER BY MAX(ts) DESC LIMIT 40`
  ).all(row.id).map((r) => { const s = JSON.parse(r.title); return { ...s, url: stickerImg(s.id) }; }).filter((s) => s.id);
}
export async function searchStickers(user, accountId, q) {
  const api = liveApi(user, accountId);
  const list = await api.searchSticker(String(q).slice(0, 50), 40);
  return list.map((s) => ({ id: s.sticker_id, cateId: s.cate_id, type: s.type, url: stickerImg(s.sticker_id) }));
}
export async function sendSticker(user, accountId, type, threadId, { id, cateId, type: stype }) {
  const api = liveApi(user, accountId);
  if (!Number(id)) throw httpError(400, "Sticker không hợp lệ");
  return api.sendSticker({ id: Number(id), cateId: Number(cateId), type: Number(stype) }, String(threadId), tType(type));
}

export async function sendFile(user, accountId, type, threadId, { data, filename }) {
  const buf = Buffer.from(String(data || ""), "base64");
  if (!buf.length) throw httpError(400, "File trống");
  if (buf.length > 20 * 1048576) throw httpError(413, "File quá lớn (tối đa 20MB)");
  const name = String(filename || "tep").replace(/[\\/\0]/g, "_").slice(0, 120) || "tep";
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) throw httpError(400, "Tên file cần có đuôi (ví dụ .pdf)");
  const api = liveApi(user, accountId);
  return api.sendMessage({ msg: "", attachments: [{ data: buf, filename: name, metadata: { totalSize: buf.length } }] }, String(threadId), tType(type));
}

// ---------- Trang cá nhân / thông tin nhóm ----------
const pick = (p) => p && ({
  uid: String(p.userId || p.id || ""), name: p.displayName || p.zaloName, zaloName: p.zaloName, avatar: p.avatar, cover: p.cover || null,
  status: p.status || "", gender: p.gender, dob: p.sdob || (p.dob ? new Date(p.dob * 1000).toLocaleDateString("vi-VN") : ""),
  phone: p.phoneNumber || "", isFriend: !!p.isFr, lastActive: p.lastActionTime || null,
});
export async function userProfile(user, accountId, uid) {
  const api = liveApi(user, accountId, "view");
  const r = await api.getUserInfo(String(uid));
  const p = r.changed_profiles?.[uid] || r.changed_profiles?.[`${uid}_0`] || Object.values(r.changed_profiles || {})[0];
  if (!p) throw httpError(404, "Không lấy được thông tin");
  return pick(p);
}
export async function ownProfile(user, accountId) {
  const api = liveApi(user, accountId, "view");
  const info = await api.fetchAccountInfo();
  return pick(info?.profile || info);
}
export async function groupProfile(user, accountId, gid) {
  const api = liveApi(user, accountId, "view");
  const g = (await api.getGroupInfo(String(gid))).gridInfoMap?.[gid];
  if (!g) throw httpError(404, "Không lấy được thông tin nhóm");
  let members = (g.currentMems || []).map((m) => ({ uid: String(m.id), name: m.dName || m.zaloName, avatar: m.avatar }));
  if (!members.length && g.memVerList?.length) {
    const ids = g.memVerList.slice(0, 100).map((x) => String(x).split("_")[0]);
    try {
      const r = await api.getGroupMembersInfo(ids);
      members = Object.values(r.profiles || {}).map((m) => ({ uid: String(m.id), name: m.displayName || m.zaloName, avatar: m.avatar }));
    } catch {}
  }
  const admins = new Set([String(g.creatorId), ...(g.adminIds || []).map(String)]);
  const roleOf = (uid) => (uid === String(g.creatorId) ? "owner" : admins.has(uid) ? "deputy" : "");
  for (const m of members) { m.roleKey = roleOf(m.uid); m.role = m.roleKey === "owner" ? "Trưởng nhóm" : m.roleKey === "deputy" ? "Phó nhóm" : ""; }
  members.sort((a, b) => (b.role ? 1 : 0) - (a.role ? 1 : 0));
  const me = String(db.prepare("SELECT zalo_uid FROM zalo_accounts WHERE id = ?").get(Number(accountId))?.zalo_uid || "");
  return { name: g.name, avatar: g.fullAvt || g.avt, desc: g.desc || "", total: g.totalMember, created: g.createdTime || null, members, myRole: roleOf(me), me };
}
