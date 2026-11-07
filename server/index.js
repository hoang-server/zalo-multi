import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, HOST, BASE_PATH, VAPID } from "./config.js";
import * as auth from "./auth.js";
import * as zalo from "./zalo.js";
import * as crm from "./crm.js";
import * as contacts from "./contacts.js";
import { logActivity, listActivity } from "./activity.js";
import * as alerts from "./alerts.js";
import { exportThread } from "./export.js";
import { saveSubscription, removeSubscription, addStream, pushToUser } from "./push.js";
import * as admin from "./admin.js";
import { serveMedia } from "./media.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const MAX_BODY = 30 * 1048576;

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(auth.httpError(413, "Dữ liệu quá lớn")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(auth.httpError(400, "JSON không hợp lệ")); }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, rel) {
  if (rel === "" || rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA: mọi đường dẫn lạ trả về index.html
      if (!path.extname(rel)) return serveStatic(req, res, "/index.html");
      res.writeHead(404); return res.end("Not found");
    }
    const ext = path.extname(file);
    // html/js/css luôn hỏi lại server (304 nếu chưa đổi) để bản cập nhật tới máy ngay
    const noCache = [".html", ".js", ".css", ".webmanifest"].includes(ext);
    const lastMod = st.mtime.toUTCString();
    if (req.headers["if-modified-since"] === lastMod) { res.writeHead(304); return res.end(); }
    res.writeHead(200, {
      "Last-Modified": lastMod,
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": noCache ? "no-cache" : "public, max-age=86400",
      ...(rel === "/sw.js" ? { "Service-Worker-Allowed": BASE_PATH + "/" } : {}),
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- Định tuyến API ----------
const routes = [];
const route = (method, pattern, handler, { open = false } = {}) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler, open, log: LOG[`${method} ${pattern}`] });
};
// Thao tác ghi vào nhật ký hoạt động (khi thành công). Nội dung tin nhắn không được ghi.
const LOG = {
  "POST /api/logout": "logout", "POST /api/password": "password", "POST /api/invites": "invite",
  "POST /api/otp/enable": "otp_on", "POST /api/otp/disable": "otp_off",
  "DELETE /api/accounts/:id": "remove_account", "POST /api/accounts/:id/reconnect": "reconnect",
  "POST /api/accounts/:id/notify": "account_notify",
  "POST /api/accounts/:id/threads/:type/:tid/text": "send_text", "POST /api/accounts/:id/threads/:type/:tid/image": "send_image",
  "POST /api/accounts/:id/threads/:type/:tid/file": "send_file", "POST /api/accounts/:id/threads/:type/:tid/sticker": "send_sticker",
  "POST /api/accounts/:id/messages/:mid/recall": "recall", "DELETE /api/accounts/:id/messages/:mid": "delete_msg",
  "POST /api/accounts/:id/shares": "share", "DELETE /api/accounts/:id/shares/:uid": "unshare", "POST /api/accounts/:id/leave": "leave",
  "POST /api/accounts/:id/threads/:type/:tid/labels": "labels", "POST /api/accounts/:id/threads/:type/:tid/notes": "note",
  "POST /api/accounts/:id/threads/:type/:tid/schedules": "schedule", "DELETE /api/schedules/:sid": "schedule_cancel",
  "GET /api/accounts/:id/threads/:type/:tid/export": "export",
  "POST /api/admin/users/:uid": "admin_user", "POST /api/admin/users/:uid/reset-password": "admin_reset_password",
  "POST /api/admin/users/:uid/reset-otp": "admin_reset_otp", "DELETE /api/admin/users/:uid": "admin_delete_user",
  "POST /api/admin/settings": "admin_settings",
  "POST /api/accounts/:id/friends/:uid/:action": (p) => `friend_${p.action}`,
  "POST /api/accounts/:id/groups": "group_create",
  "POST /api/accounts/:id/groups/:gid/:action": (p) => `group_${p.action}`,
};

route("GET", "/api/me", (req, res, { user }) => send(res, 200, {
  user, needsInvite: auth.needsInvite(), firstUser: auth.noUsers(), vapidPublicKey: VAPID.publicKey,
}), { open: true });
route("POST", "/api/register", async (req, res, { ip }) => {
  const user = auth.register(req, res, await readJson(req));
  logActivity({ user, action: "register", ip });
  send(res, 200, { user });
}, { open: true });
route("POST", "/api/login", async (req, res, { ip }) => {
  const body = await readJson(req);
  let r;
  try { r = auth.login(req, res, body, ip); }
  catch (e) { if (e.status === 401) logActivity({ username: String(body.username || "").slice(0, 32), action: "login_fail", ip }); throw e; }
  if (r.otp) return send(res, 200, { otp: true, ticket: r.ticket });
  logActivity({ user: r, action: "login", ip });
  send(res, 200, { user: r });
}, { open: true });
route("POST", "/api/login/otp", async (req, res, { ip }) => {
  let r;
  try { r = auth.loginOtp(req, res, await readJson(req), ip); }
  catch (e) { if (e.status === 401) logActivity({ action: "login_otp_fail", ip }); throw e; }
  logActivity({ user: r, action: "login", detail: "có mã 2 lớp", ip });
  send(res, 200, { user: r });
}, { open: true });
route("POST", "/api/otp/setup", (req, res, { user }) => send(res, 200, auth.otpSetup(user)));
route("POST", "/api/otp/enable", async (req, res, { user }) => send(res, 200, auth.otpEnable(user, await readJson(req))));
route("POST", "/api/otp/disable", async (req, res, { user }) => { auth.otpDisable(user, await readJson(req)); send(res, 200, { ok: true }); });
route("GET", "/api/accounts/:id/threads/:type/:tid/export", (req, res, { user, p, url }) => {
  const s = url.searchParams;
  const f = exportThread(user, p.id, p.type, p.tid, { format: s.get("format"), from: s.get("from"), to: s.get("to") });
  res.writeHead(200, {
    "Content-Type": f.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    // HTML xuất ra chỉ để tải về, không chạy trong trang app
    "Content-Disposition": `attachment; filename="${f.filename}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    "Content-Security-Policy": "default-src 'none'; img-src https:; style-src 'unsafe-inline'; sandbox",
  });
  res.end(f.data);
});
route("GET", "/api/telegram", (req, res, { user }) => send(res, 200, alerts.telegramStatus(user)));
route("POST", "/api/telegram/link", async (req, res, { user }) => send(res, 200, await alerts.telegramLink(user)));
route("POST", "/api/telegram/unlink", (req, res, { user }) => { alerts.telegramUnlink(user); send(res, 200, { ok: true }); });
route("POST", "/api/telegram/test", async (req, res, { user }) => { await alerts.telegramTest(user); send(res, 200, { ok: true }); });
route("GET", "/api/activity", (req, res, { user, url }) => {
  const s = url.searchParams;
  send(res, 200, { items: listActivity(user, { userId: s.get("user"), accountId: s.get("acc"), action: s.get("action"), before: s.get("before") }) });
});
route("POST", "/api/logout", (req, res) => { auth.logout(req, res); send(res, 200, { ok: true }); }, { open: true });
route("POST", "/api/password", async (req, res, { user }) => { auth.changePassword(user, await readJson(req)); send(res, 200, { ok: true }); });
route("POST", "/api/prefs", async (req, res, { user }) => send(res, 200, { prefs: auth.setPrefs(user, await readJson(req)) }));
route("GET", "/api/invites", (req, res, { user }) => send(res, 200, { invites: auth.listInvites(user) }));
route("POST", "/api/invites", (req, res, { user }) => send(res, 200, { code: auth.createInvite(user) }));

route("GET", "/api/events", (req, res, { user }) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
  res.write("retry: 3000\n\n");
  addStream(user.id, res);
});

route("POST", "/api/push/subscribe", async (req, res, { user }) => { saveSubscription(user.id, await readJson(req)); send(res, 200, { ok: true }); });
route("POST", "/api/push/unsubscribe", async (req, res, { user }) => { removeSubscription(user.id, (await readJson(req)).endpoint); send(res, 200, { ok: true }); });
route("POST", "/api/push/test", async (req, res, { user }) => {
  await pushToUser(user.id, { title: "Zalo Multi", body: "Thông báo đã hoạt động ✅", tag: "test", url: "#/" });
  send(res, 200, { ok: true });
});

route("GET", "/api/accounts", (req, res, { user }) => send(res, 200, { accounts: zalo.listAccounts(user), badge: zalo.unreadTotal(user.id) }));
route("POST", "/api/accounts/:id/notify", async (req, res, { user, p }) => { zalo.setAccountNotify(user, p.id, await readJson(req)); send(res, 200, { ok: true }); });
route("POST", "/api/accounts/:id/read-all", (req, res, { user, p }) => { zalo.markAllRead(user, p.id); send(res, 200, { ok: true }); });
route("POST", "/api/accounts/:id/threads/:type/:tid/mute", async (req, res, { user, p }) => {
  zalo.setThreadMuted(user, p.id, p.type, p.tid, (await readJson(req)).muted); send(res, 200, { ok: true });
});
route("GET", "/api/media/:mid", (req, res, { user, p }) => {
  const row = zalo.mediaRow(user, p.mid);
  if (!row) throw auth.httpError(404, "Không có file");
  serveMedia(req, res, row);
});
route("POST", "/api/accounts/qr", async (req, res, { user }) => send(res, 200, { key: zalo.startQrLogin(user) }));
route("POST", "/api/accounts/qr/cancel", async (req, res, { user }) => { zalo.cancelQrLogin(user, (await readJson(req)).key); send(res, 200, { ok: true }); });
route("DELETE", "/api/accounts/:id", (req, res, { user, p }) => { zalo.removeAccount(user, p.id); send(res, 200, { ok: true }); });
route("POST", "/api/accounts/:id/reconnect", (req, res, { user, p }) => { zalo.reconnect(user, p.id); send(res, 200, { ok: true }); });
route("POST", "/api/accounts/:id/sync", async (req, res, { user, p }) => send(res, 200, await zalo.syncContacts(user, p.id)));
route("GET", "/api/accounts/:id/threads", (req, res, { user, p, url }) =>
  send(res, 200, { threads: zalo.listThreads(user, p.id, (url.searchParams.get("q") || "").slice(0, 100), url.searchParams.get("f")) }));
route("GET", "/api/accounts/:id/threads/:type/:tid/messages", (req, res, { user, p, url }) =>
  send(res, 200, { messages: zalo.listMessages(user, p.id, p.type, p.tid, url.searchParams.get("before"),
    { after: url.searchParams.get("after"), around: url.searchParams.get("around") }) }));
route("POST", "/api/accounts/:id/threads/:type/:tid/pin", async (req, res, { user, p }) => {
  zalo.setThreadPinned(user, p.id, p.type, p.tid, (await readJson(req)).pinned); send(res, 200, { ok: true });
});
route("GET", "/api/accounts/:id/threads/:type/:tid/gallery", (req, res, { user, p, url }) =>
  send(res, 200, { items: zalo.gallery(user, p.id, p.type, p.tid, url.searchParams.get("kind"), url.searchParams.get("before")) }));
route("GET", "/api/inbox", (req, res, { user, url }) => send(res, 200, { threads: zalo.inbox(user, url.searchParams.get("f")) }));
route("GET", "/api/search", (req, res, { user, url }) => {
  const s = url.searchParams;
  send(res, 200, { results: zalo.searchMessages(user, s.get("acc"), (s.get("q") || "").slice(0, 100),
    s.get("tid") ? { type: s.get("type"), threadId: s.get("tid") } : {}) });
});
route("GET", "/api/quick-replies", (req, res, { user }) => send(res, 200, { items: zalo.listQuickReplies(user) }));
route("POST", "/api/quick-replies", async (req, res, { user }) => send(res, 200, { items: zalo.saveQuickReply(user, await readJson(req)) }));
route("DELETE", "/api/quick-replies/:qid", (req, res, { user, p }) => send(res, 200, { items: zalo.deleteQuickReply(user, p.qid) }));
route("POST", "/api/accounts/:id/threads/:type/:tid/history", async (req, res, { user, p }) =>
  send(res, 200, await zalo.fetchHistory(user, p.id, p.type, p.tid)));
route("POST", "/api/accounts/:id/threads/:type/:tid/text", async (req, res, { user, p }) => {
  const b = await readJson(req);
  send(res, 200, await zalo.sendText(user, p.id, p.type, p.tid, b.text, b.quote));
});
route("POST", "/api/accounts/:id/threads/:type/:tid/sticker", async (req, res, { user, p }) =>
  send(res, 200, await zalo.sendSticker(user, p.id, p.type, p.tid, await readJson(req))));
route("POST", "/api/accounts/:id/threads/:type/:tid/file", async (req, res, { user, p }) =>
  send(res, 200, await zalo.sendFile(user, p.id, p.type, p.tid, await readJson(req))));
route("POST", "/api/accounts/:id/threads/:type/:tid/typing", async (req, res, { user, p }) =>
  send(res, 200, await zalo.sendTyping(user, p.id, p.type, p.tid)));
route("POST", "/api/accounts/:id/messages/:mid/react", async (req, res, { user, p }) =>
  send(res, 200, await zalo.react(user, p.id, p.mid, (await readJson(req)).icon)));
route("POST", "/api/accounts/:id/messages/:mid/recall", async (req, res, { user, p }) => send(res, 200, await zalo.recall(user, p.id, p.mid)));
route("DELETE", "/api/accounts/:id/messages/:mid", async (req, res, { user, p }) => send(res, 200, await zalo.deleteForMe(user, p.id, p.mid)));
route("GET", "/api/accounts/:id/stickers", async (req, res, { user, p, url }) => {
  const q = (url.searchParams.get("q") || "").trim();
  send(res, 200, { stickers: q ? await zalo.searchStickers(user, p.id, q) : zalo.recentStickers(user, p.id) });
});
route("GET", "/api/accounts/:id/profile", async (req, res, { user, p }) => send(res, 200, await zalo.ownProfile(user, p.id)));
route("GET", "/api/accounts/:id/users/:uid", async (req, res, { user, p }) => send(res, 200, await zalo.userProfile(user, p.id, p.uid)));
route("GET", "/api/accounts/:id/groups/:gid", async (req, res, { user, p }) => send(res, 200, await zalo.groupProfile(user, p.id, p.gid)));
route("POST", "/api/accounts/:id/threads/:type/:tid/image", async (req, res, { user, p }) =>
  send(res, 200, await zalo.sendImage(user, p.id, p.type, p.tid, await readJson(req))));

// ---------- danh bạ & nhóm ----------
route("GET", "/api/accounts/:id/friends", async (req, res, { user, p, url }) =>
  send(res, 200, { friends: await contacts.friends(user, p.id, { refresh: url.searchParams.has("refresh") }) }));
route("GET", "/api/accounts/:id/find", async (req, res, { user, p, url }) => send(res, 200, await contacts.findByPhone(user, p.id, url.searchParams.get("phone"))));
route("POST", "/api/accounts/:id/check-phones", async (req, res, { user, p }) => send(res, 200, await contacts.checkPhones(user, p.id, (await readJson(req)).phones)));
route("POST", "/api/accounts/:id/open-chat", async (req, res, { user, p }) => send(res, 200, contacts.openChat(user, p.id, await readJson(req))));
route("GET", "/api/accounts/:id/friend-requests", async (req, res, { user, p }) => send(res, 200, await contacts.friendRequests(user, p.id)));
route("POST", "/api/accounts/:id/friends/:uid/:action", async (req, res, { user, p }) =>
  send(res, 200, await contacts.friendAction(user, p.id, p.uid, p.action, await readJson(req))));
route("POST", "/api/accounts/:id/groups", async (req, res, { user, p }) => send(res, 200, await contacts.createGroup(user, p.id, await readJson(req))));
route("GET", "/api/accounts/:id/groups/:gid/link", async (req, res, { user, p }) => send(res, 200, await contacts.groupLink(user, p.id, p.gid)));
route("POST", "/api/accounts/:id/groups/:gid/:action", async (req, res, { user, p }) =>
  send(res, 200, await contacts.groupAction(user, p.id, p.gid, p.action, await readJson(req))));

// ---------- giao tài khoản cho nhân viên ----------
route("GET", "/api/accounts/:id/shares", (req, res, { user, p }) => send(res, 200, { shares: zalo.listShares(user, p.id) }));
route("POST", "/api/accounts/:id/shares", async (req, res, { user, p }) => send(res, 200, { shares: zalo.saveShare(user, p.id, await readJson(req)) }));
route("DELETE", "/api/accounts/:id/shares/:uid", (req, res, { user, p }) => send(res, 200, { shares: zalo.removeShare(user, p.id, p.uid) }));
route("POST", "/api/accounts/:id/leave", (req, res, { user, p }) => { zalo.leaveShare(user, p.id); send(res, 200, { ok: true }); });

// ---------- chăm sóc khách ----------
route("GET", "/api/labels", (req, res, { user }) => send(res, 200, { labels: crm.visibleLabels(user), colors: crm.LABEL_COLORS }));
route("POST", "/api/labels", async (req, res, { user }) => send(res, 200, { labels: crm.saveLabel(user, await readJson(req)) }));
route("DELETE", "/api/labels/:lid", (req, res, { user, p }) => send(res, 200, { labels: crm.deleteLabel(user, p.lid) }));
route("GET", "/api/accounts/:id/threads/:type/:tid/customer", (req, res, { user, p }) => send(res, 200, crm.customer(user, p.id, p.type, p.tid)));
route("POST", "/api/accounts/:id/threads/:type/:tid/labels", async (req, res, { user, p }) =>
  send(res, 200, { labels: crm.setThreadLabels(user, p.id, p.type, p.tid, (await readJson(req)).labels) }));
route("POST", "/api/accounts/:id/threads/:type/:tid/notes", async (req, res, { user, p }) =>
  send(res, 200, { notes: crm.addNote(user, p.id, p.type, p.tid, (await readJson(req)).text) }));
route("DELETE", "/api/notes/:nid", (req, res, { user, p }) => send(res, 200, crm.deleteNote(user, p.nid)));
route("POST", "/api/accounts/:id/threads/:type/:tid/schedules", async (req, res, { user, p }) =>
  send(res, 200, { schedules: crm.createSchedule(user, p.id, p.type, p.tid, await readJson(req)) }));
route("GET", "/api/schedules", (req, res, { user }) => send(res, 200, { schedules: crm.listSchedules(user) }));
route("DELETE", "/api/schedules/:sid", (req, res, { user, p }) => send(res, 200, crm.cancelSchedule(user, p.sid)));
route("GET", "/api/accounts/:id/stats", (req, res, { user, p, url }) => send(res, 200, crm.stats(user, p.id, url.searchParams.get("days"))));

// ---------- quản trị ----------
const adminRoute = (method, pattern, handler) =>
  route(method, pattern, async (req, res, ctx) => { admin.requireAdmin(ctx.user); await handler(req, res, ctx); });
adminRoute("GET", "/api/admin/overview", (req, res) => send(res, 200, {
  stats: admin.stats(), users: admin.listUsers(), settings: admin.getSettings(), invites: auth.listInvites({ is_admin: 1 }),
}));
adminRoute("POST", "/api/admin/users/:uid", async (req, res, { user, p }) => { admin.updateUser(user, p.uid, await readJson(req)); send(res, 200, { ok: true }); });
adminRoute("POST", "/api/admin/users/:uid/reset-password", (req, res, { user, p }) => send(res, 200, { password: admin.resetPassword(user, p.uid) }));
adminRoute("POST", "/api/admin/users/:uid/reset-otp", (req, res, { p }) => { auth.resetOtp(p.uid); send(res, 200, { ok: true }); });
adminRoute("DELETE", "/api/admin/users/:uid", (req, res, { user, p }) => { admin.deleteUser(user, p.uid); send(res, 200, { ok: true }); });
adminRoute("DELETE", "/api/admin/invites/:code", (req, res, { p }) => { admin.deleteInvite(p.code); send(res, 200, { ok: true }); });
adminRoute("POST", "/api/admin/settings", async (req, res) => send(res, 200, { settings: admin.saveSettings(await readJson(req)) }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let p = url.pathname;
  if (BASE_PATH) {
    if (p === BASE_PATH) { res.writeHead(301, { Location: BASE_PATH + "/" }); return res.end(); }
    if (!p.startsWith(BASE_PATH + "/")) { res.writeHead(404); return res.end(); }
    p = p.slice(BASE_PATH.length);
  }
  if (!p.startsWith("/api/")) return serveStatic(req, res, decodeURIComponent(p));

  try {
    // Chống CSRF: request ghi phải là JSON từ chính app (trình duyệt không cho site khác gửi header này)
    if (req.method !== "GET" && req.headers["x-requested-with"] !== "zalo-multi") throw auth.httpError(403, "Forbidden");
    const r = routes.find((r) => r.method === req.method && r.re.test(p));
    if (!r) throw auth.httpError(404, "Không có API này");
    const m = p.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const user = auth.currentUser(req);
    if (!r.open && !user) throw auth.httpError(401, "Chưa đăng nhập");
    const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress);
    await r.handler(req, res, { user, p: params, url, ip });
    if (r.log && res.statusCode < 400) logActivity({
      user, ip, action: typeof r.log === "function" ? r.log(params) : r.log, accountId: params.id,
      type: params.gid ? 1 : params.type, threadId: params.gid || params.tid,
      detail: params.uid ? `user #${params.uid}` : params.sid ? `lịch #${params.sid}` : null,
    });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Lỗi máy chủ: " + (e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`zalo-multi chạy tại http://${HOST}:${PORT}${BASE_PATH}/`);
  zalo.connectAll();
});
