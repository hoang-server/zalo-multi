import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, HOST, BASE_PATH, VAPID } from "./config.js";
import * as auth from "./auth.js";
import * as zalo from "./zalo.js";
import { saveSubscription, removeSubscription, addStream, pushToUser } from "./push.js";

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
  routes.push({ method, re, keys, handler, open });
};

route("GET", "/api/me", (req, res, { user }) => send(res, 200, {
  user, needsInvite: auth.needsInvite(), firstUser: auth.noUsers(), vapidPublicKey: VAPID.publicKey,
}), { open: true });
route("POST", "/api/register", async (req, res) => send(res, 200, { user: auth.register(req, res, await readJson(req)) }), { open: true });
route("POST", "/api/login", async (req, res, { ip }) => send(res, 200, { user: auth.login(req, res, await readJson(req), ip) }), { open: true });
route("POST", "/api/logout", (req, res) => { auth.logout(req, res); send(res, 200, { ok: true }); }, { open: true });
route("POST", "/api/password", async (req, res, { user }) => { auth.changePassword(user, await readJson(req)); send(res, 200, { ok: true }); });
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

route("GET", "/api/accounts", (req, res, { user }) => send(res, 200, { accounts: zalo.listAccounts(user) }));
route("POST", "/api/accounts/qr", async (req, res, { user }) => send(res, 200, { key: zalo.startQrLogin(user) }));
route("POST", "/api/accounts/qr/cancel", async (req, res, { user }) => { zalo.cancelQrLogin(user, (await readJson(req)).key); send(res, 200, { ok: true }); });
route("DELETE", "/api/accounts/:id", (req, res, { user, p }) => { zalo.removeAccount(user, p.id); send(res, 200, { ok: true }); });
route("POST", "/api/accounts/:id/reconnect", (req, res, { user, p }) => { zalo.reconnect(user, p.id); send(res, 200, { ok: true }); });
route("POST", "/api/accounts/:id/sync", async (req, res, { user, p }) => send(res, 200, await zalo.syncContacts(user, p.id)));
route("GET", "/api/accounts/:id/threads", (req, res, { user, p, url }) =>
  send(res, 200, { threads: zalo.listThreads(user, p.id, (url.searchParams.get("q") || "").slice(0, 100)) }));
route("GET", "/api/accounts/:id/threads/:type/:tid/messages", (req, res, { user, p, url }) =>
  send(res, 200, { messages: zalo.listMessages(user, p.id, p.type, p.tid, url.searchParams.get("before")) }));
route("POST", "/api/accounts/:id/threads/:type/:tid/history", async (req, res, { user, p }) =>
  send(res, 200, await zalo.fetchHistory(user, p.id, p.type, p.tid)));
route("POST", "/api/accounts/:id/threads/:type/:tid/text", async (req, res, { user, p }) =>
  send(res, 200, await zalo.sendText(user, p.id, p.type, p.tid, (await readJson(req)).text)));
route("POST", "/api/accounts/:id/threads/:type/:tid/image", async (req, res, { user, p }) =>
  send(res, 200, await zalo.sendImage(user, p.id, p.type, p.tid, await readJson(req))));

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
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Lỗi máy chủ: " + (e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`zalo-multi chạy tại http://${HOST}:${PORT}${BASE_PATH}/`);
  zalo.connectAll();
});
