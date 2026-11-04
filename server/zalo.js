import crypto from "node:crypto";
import { Zalo, ThreadType, LoginQRCallbackEventType } from "zca-js";
import { db, encrypt, decrypt, now, getSetting } from "./db.js";
import { saveMedia, removeMediaOfAccount } from "./media.js";
import { emit, pushToUser } from "./push.js";
import { httpError } from "./auth.js";
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
      return { kind: "sticker", text: "[Sticker]", stickerId: Number(c.id || c.sticker_id) || null };
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
  const old = db.prepare("SELECT id, url FROM messages WHERE account_id = ? AND msg_id = ?").get(acc.id, String(d.msgId));
  if (old) {
    // tin đã có: chỉ bổ sung ảnh sticker cho tin lưu từ bản cũ
    if (!old.url && p.url) db.prepare("UPDATE messages SET url = ? WHERE id = ?").run(p.url, old.id);
    return false;
  }
  const ins = db.prepare(
    `INSERT OR IGNORE INTO messages (account_id, thread_id, type, msg_id, from_uid, from_name, ts, is_self, kind, text, url, thumb, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(acc.id, threadId, type, String(d.msgId), d.uidFrom, d.dName || null, ts, msg.isSelf ? 1 : 0,
        p.kind, p.text ?? null, p.url ?? null, p.thumb ?? null, p.title ?? null);
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
    ts, isSelf: msg.isSelf, ...p,
  };
  emit(acc.userId, "message", { ...out, threadName: info.name, threadAvatar: info.avatar });

  // Lưu ảnh/file về server (chạy nền, không chặn tin nhắn)
  if (p.url && ["image", "file", "video", "voice"].includes(p.kind)) {
    const msgRowId = Number(ins.lastInsertRowid);
    saveMedia(acc.id, msgRowId, p).catch((e) => console.error("lưu media lỗi", e?.message || e));
  }

  if (notify && !msg.isSelf) {
    const a = db.prepare("SELECT name, notify, notify_groups FROM zalo_accounts WHERE id = ?").get(acc.id);
    const muted = db.prepare("SELECT muted FROM threads WHERE account_id = ? AND thread_id = ? AND type = ?").get(acc.id, threadId, type)?.muted;
    const prefs = userPrefs(acc.userId);
    if (a?.notify && !muted && (type !== ThreadType.Group || a.notify_groups)) {
      const who = type === ThreadType.Group ? `${d.dName}: ` : "";
      pushToUser(acc.userId, {
        title: prefs.push_preview ? `${info.name} · ${a.name || "Zalo"}` : a.name || "Zalo Multi",
        body: prefs.push_preview ? who + text : "Bạn có tin nhắn mới",
        icon: prefs.push_preview ? info.avatar || undefined : undefined,
        tag: `${acc.id}-${type}-${threadId}`,
        url: `#/a/${acc.id}/${type}/${threadId}`,
        badge: prefs.app_badge ? unreadTotal(acc.userId) : 0,
      });
    }
  }
  return true;
}

function userPrefs(userId) {
  const row = db.prepare("SELECT prefs FROM users WHERE id = ?").get(userId);
  return { push_preview: true, app_badge: true, ...JSON.parse(row?.prefs || "{}") };
}

// Tổng tin chưa đọc của người dùng (bỏ qua hội thoại đã tắt thông báo / tài khoản tắt thông báo) – dùng cho số trên icon app
export function unreadTotal(userId) {
  return db.prepare(
    `SELECT COALESCE(SUM(t.unread), 0) n FROM threads t JOIN zalo_accounts a ON a.id = t.account_id
     WHERE a.user_id = ? AND a.notify = 1 AND t.muted = 0 AND (t.type = 0 OR a.notify_groups = 1)`
  ).get(userId).n;
}

function setStatus(accountId, userId, status, msg = null) {
  db.prepare("UPDATE zalo_accounts SET status = ?, status_msg = ? WHERE id = ?").run(status, msg, accountId);
  emit(userId, "account", { id: accountId, status, statusMsg: msg });
}

// ---------- Đồng bộ tin cũ ----------
// Zalo trả tin cũ theo từng trang qua websocket; xin tiếp trang sau bằng msgId cũ nhất của trang trước.
const OLD_MAX_PAGES = 40;
function syncOld(acc) {
  acc.old = { [ThreadType.User]: { pages: 0, oldest: Infinity }, [ThreadType.Group]: { pages: 0, oldest: Infinity } };
  try { acc.api.listener.requestOldMessages(ThreadType.User); acc.api.listener.requestOldMessages(ThreadType.Group); } catch {}
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
    finish("success", { account: { id, name, avatar } });
  }).catch((e) => finish("error", { message: e?.message || "Lỗi đăng nhập Zalo" }));

  return key;
}

export function cancelQrLogin(user, key) {
  const s = qrSessions.get(key);
  if (s && s.userId === user.id) { s.abort?.(); qrSessions.delete(key); }
}

// ---------- Thao tác cho API ----------
function ownAccount(user, accountId) {
  const row = db.prepare("SELECT * FROM zalo_accounts WHERE id = ? AND user_id = ?").get(Number(accountId), user.id);
  if (!row) throw httpError(404, "Không tìm thấy tài khoản");
  return row;
}
function liveApi(user, accountId) {
  ownAccount(user, accountId);
  const acc = live.get(Number(accountId));
  if (!acc) throw httpError(409, "Tài khoản Zalo chưa kết nối");
  return acc.api;
}

export function listAccounts(user) {
  return db.prepare(
    `SELECT a.id, a.name, a.avatar, a.status, a.status_msg statusMsg, a.notify, a.notify_groups notifyGroups,
            (SELECT COALESCE(SUM(unread),0) FROM threads t WHERE t.account_id = a.id AND t.muted = 0) unread
     FROM zalo_accounts a WHERE a.user_id = ? ORDER BY a.created_at`
  ).all(user.id);
}

export function removeAccount(user, accountId) {
  const row = ownAccount(user, accountId);
  const acc = live.get(row.id);
  live.delete(row.id);
  try { acc?.api.listener.stop(); } catch {}
  db.prepare("DELETE FROM zalo_accounts WHERE id = ?").run(row.id);
  removeMediaOfAccount(row.id);
}

export function reconnect(user, accountId) {
  const row = ownAccount(user, accountId);
  connect(row.id).catch(() => {});
}

export function listThreads(user, accountId, q = "") {
  const row = ownAccount(user, accountId);
  return db.prepare(
    `SELECT thread_id threadId, type, name, avatar, last_ts lastTs, last_text lastText, unread, muted
     FROM threads WHERE account_id = ? AND (? = '' OR name LIKE ?) ORDER BY last_ts DESC LIMIT 300`
  ).all(row.id, q, `%${q}%`);
}

export function listMessages(user, accountId, type, threadId, before) {
  const row = ownAccount(user, accountId);
  const rows = db.prepare(
    `SELECT id, msg_id msgId, from_uid fromUid, from_name fromName, ts, is_self isSelf, kind, text, url, thumb, title, media
     FROM messages WHERE account_id = ? AND type = ? AND thread_id = ? AND ts < ?
     ORDER BY ts DESC LIMIT 60`
  ).all(row.id, Number(type), String(threadId), Number(before) || 9e15);
  db.prepare("UPDATE threads SET unread = 0 WHERE account_id = ? AND type = ? AND thread_id = ?").run(row.id, Number(type), String(threadId));
  return rows.reverse();
}

export async function sendText(user, accountId, type, threadId, text) {
  if (typeof text !== "string" || !text.trim()) throw httpError(400, "Tin nhắn trống");
  if (text.length > 5000) throw httpError(400, "Tin nhắn quá dài");
  const api = liveApi(user, accountId);
  return api.sendMessage({ msg: text }, String(threadId), Number(type) === 1 ? ThreadType.Group : ThreadType.User);
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
  const api = liveApi(user, accountId);
  const acc = live.get(row.id);
  const r = await api.getGroupChatHistory(String(threadId), Math.min(500, getSetting("group_history")) || 50);
  historyDone.add(key);
  let added = 0;
  for (const m of r.groupMsgs || []) if (await storeMessage(acc, m, { notify: false })) added++;
  return { added };
}

// ---------- Cài đặt thông báo ----------
export function setAccountNotify(user, accountId, { notify, notifyGroups }) {
  const row = ownAccount(user, accountId);
  if (notify !== undefined) db.prepare("UPDATE zalo_accounts SET notify = ? WHERE id = ?").run(notify ? 1 : 0, row.id);
  if (notifyGroups !== undefined) db.prepare("UPDATE zalo_accounts SET notify_groups = ? WHERE id = ?").run(notifyGroups ? 1 : 0, row.id);
}
export function setThreadMuted(user, accountId, type, threadId, muted) {
  const row = ownAccount(user, accountId);
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

export function mediaRow(user, messageId) {
  return db.prepare(
    `SELECT m.media, m.title FROM messages m JOIN zalo_accounts a ON a.id = m.account_id
     WHERE m.id = ? AND a.user_id = ? AND m.media IS NOT NULL`
  ).get(Number(messageId), user.id);
}
