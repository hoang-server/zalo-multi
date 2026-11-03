import webpush from "web-push";
import { db, now } from "./db.js";
import { VAPID, VAPID_SUBJECT } from "./config.js";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID.publicKey, VAPID.privateKey);

export function saveSubscription(userId, sub) {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error("Subscription không hợp lệ"), { status: 400 });
  db.prepare(
    `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
}

export function removeSubscription(userId, endpoint) {
  db.prepare("DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?").run(userId, String(endpoint || ""));
}

export async function pushToUser(userId, payload) {
  const subs = db.prepare("SELECT * FROM push_subs WHERE user_id = ?").all(userId);
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 3600, urgency: "high", topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) }
      );
    } catch (e) {
      // 404/410: thiết bị đã huỷ đăng ký thông báo
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare("DELETE FROM push_subs WHERE id = ?").run(s.id);
      else console.error("push lỗi", e.statusCode || e.message);
    }
  }));
}

// Kênh realtime (Server-Sent Events) theo từng người dùng
const streams = new Map(); // userId -> Set<res>

export function addStream(userId, res) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  res.on("close", () => streams.get(userId)?.delete(res));
}

export function emit(userId, event, data) {
  const set = streams.get(userId);
  if (!set) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(chunk);
}

setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(": ping\n\n");
}, 25e3).unref();
