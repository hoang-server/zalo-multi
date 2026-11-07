// Cảnh báo khi tài khoản Zalo bị ngắt / hết phiên: thông báo push + Telegram (bot do quản trị viên cài)
import crypto from "node:crypto";
import { db, now, getSetting } from "./db.js";
import { httpError } from "./auth.js";
import { pushToUser } from "./push.js";
import { statusHooks, audience } from "./zalo.js";
import { logActivity } from "./activity.js";

const ALERT = {
  kicked: "đã bị ngắt vì đang mở Zalo Web ở nơi khác. Mở app → bấm Kết nối lại.",
  expired: "đã hết phiên đăng nhập. Mở app → quét lại mã QR.",
};
const REPEAT = 6 * 3600e3; // cùng một trạng thái: nhắc lại sau 6 giờ nếu vẫn chưa xử lý

// ---------- Telegram ----------
const token = () => String(getSetting("telegram_bot_token") || "").trim();
async function tg(method, body) {
  const t = token();
  if (!t) throw httpError(400, "Quản trị viên chưa cài bot Telegram");
  const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(40e3),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw httpError(502, `Telegram: ${j.description || r.status}`);
  return j.result;
}
const sendTg = (chatId, text) => tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }).catch((e) => console.error("telegram lỗi", e.message));

let botName = null, botFor = null;
async function botUsername() {
  if (botFor !== token()) { botName = (await tg("getMe")).username; botFor = token(); }
  return botName;
}

// Mã kết nối: người dùng mở t.me/<bot>?start=<mã>, bot nhận /start <mã> và lưu chat_id
const linkCodes = new Map(); // code -> { userId, exp }
export async function telegramLink(user) {
  const code = crypto.randomBytes(9).toString("base64url");
  linkCodes.set(code, { userId: user.id, exp: now() + 15 * 60e3 });
  return { url: `https://t.me/${await botUsername()}?start=${code}` };
}
export function telegramUnlink(user) {
  db.prepare("UPDATE users SET telegram_chat = NULL WHERE id = ?").run(user.id);
}
export async function telegramTest(user) {
  const chat = db.prepare("SELECT telegram_chat FROM users WHERE id = ?").get(user.id)?.telegram_chat;
  if (!chat) throw httpError(400, "Chưa kết nối Telegram");
  await tg("sendMessage", { chat_id: chat, text: "✅ Zalo Multi: cảnh báo Telegram đã hoạt động." });
}
export function telegramStatus(user) {
  return { available: !!token(), linked: !!db.prepare("SELECT telegram_chat FROM users WHERE id = ?").get(user.id)?.telegram_chat };
}

// Nhận tin nhắn gửi tới bot (long polling, chỉ chạy khi đã cài token)
let offset = 0, polling = false;
async function poll() {
  if (polling || !token()) return;
  polling = true;
  try {
    for (;;) {
      if (!token()) break;
      const updates = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        const code = /^\/start\s+(\S+)/.exec(m?.text || "")?.[1];
        if (!code || m.chat?.type !== "private") {
          if (m?.chat?.type === "private") sendTg(m.chat.id, "Mở Zalo Multi → Cài đặt → Cảnh báo → Kết nối Telegram để nhận cảnh báo ở đây.");
          continue;
        }
        const c = linkCodes.get(code);
        linkCodes.delete(code);
        if (!c || c.exp < now()) { sendTg(m.chat.id, "Mã kết nối đã hết hạn. Hãy bấm Kết nối Telegram lại trong app."); continue; }
        db.prepare("UPDATE users SET telegram_chat = ? WHERE id = ?").run(String(m.chat.id), c.userId);
        const name = db.prepare("SELECT username FROM users WHERE id = ?").get(c.userId)?.username;
        sendTg(m.chat.id, `✅ Đã kết nối với tài khoản Zalo Multi "${name}". Bạn sẽ nhận cảnh báo khi tài khoản Zalo bị ngắt.`);
      }
    }
  } catch (e) {
    console.error("telegram poll lỗi", e.message);
    await new Promise((r) => setTimeout(r, 60e3)); // lỗi mạng / token sai: chờ rồi thử lại
  } finally { polling = false; }
}
setInterval(poll, 30e3).unref();
setTimeout(poll, 3e3).unref();

// ---------- Gửi cảnh báo khi đổi trạng thái ----------
statusHooks.push((accountId, status) => {
  const a = db.prepare("SELECT name, alerted_status, alerted_at FROM zalo_accounts WHERE id = ?").get(accountId);
  if (!a) return;
  if (status === "online") {
    if (a.alerted_status) db.prepare("UPDATE zalo_accounts SET alerted_status = NULL, alerted_at = NULL WHERE id = ?").run(accountId);
    return;
  }
  if (!ALERT[status]) return;
  if (a.alerted_status === status && now() - (a.alerted_at || 0) < REPEAT) return;
  db.prepare("UPDATE zalo_accounts SET alerted_status = ?, alerted_at = ? WHERE id = ?").run(status, now(), accountId);
  logActivity({ username: "hệ thống", action: status === "kicked" ? "zalo_kicked" : "zalo_expired", accountId });
  const text = `⚠️ Tài khoản Zalo "${a.name || accountId}" ${ALERT[status]}`;
  for (const uid of audience(accountId)) {
    const u = db.prepare("SELECT prefs, telegram_chat FROM users WHERE id = ?").get(uid);
    const prefs = JSON.parse(u?.prefs || "{}");
    if (prefs.alert_push !== false) pushToUser(uid, { title: "⚠️ Zalo bị ngắt", body: text.slice(2), tag: `alert-${accountId}`, url: `#/a/${accountId}` });
    if (u?.telegram_chat && token()) sendTg(u.telegram_chat, text);
  }
});
