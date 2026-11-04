// Zalo Multi – giao diện web (không cần build)
import { emoticons } from "./emoticons.js";
const $app = document.getElementById("app");
const state = { user: null, needsInvite: false, vapidKey: null, accounts: [], threads: [], messages: [], route: null, qr: null };

// ---------- tiện ích ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https:\/\//i.test(u || "") ? esc(u) : "");
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function toast(msg, ms = 2600) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms);
}

async function api(method, path, body) {
  const r = await fetch("api/" + path, {
    method, credentials: "same-origin",
    headers: { "X-Requested-With": "zalo-multi", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "login") { state.user = null; go("#/login"); }
  if (!r.ok) throw new Error(data.error || "Lỗi " + r.status);
  return data;
}

function timeLabel(ts) {
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const diff = (n - d) / 864e5;
  if (diff < 7) return ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][d.getDay()];
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
}
const avatar = (src, name, cls = "") =>
  src ? `<img class="avatar ${cls}" src="${safeUrl(src)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
      : `<div class="avatar ${cls} ph">${esc((name || "?").trim().charAt(0).toUpperCase())}</div>`;
// avatar kèm số tin chưa đọc ở góc
const avBadge = (src, name, n, cls = "", muted = false) =>
  `<span class="avw">${avatar(src, name, cls)}${n ? `<span class="ab ${muted ? "mute" : ""}">${n > 99 ? "99+" : n}</span>` : ""}</span>`;
// file đã lưu trên server, nếu chưa có thì dùng link Zalo
const mediaSrc = (m, fallback) => (m.media && m.id ? `api/media/${m.id}` : safeUrl(fallback));
// số tin chưa đọc trên icon app (iPhone iOS 16.4+ khi đã thêm ra MH chính, Android/máy tính Chrome)
function setBadge(n) {
  state.badge = n;
  if (state.user?.prefs?.app_badge === false) n = 0;
  try { n > 0 ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch {}
}
const statusText = { online: "Đang hoạt động", connecting: "Đang kết nối…", reconnecting: "Đang kết nối lại…", offline: "Ngoại tuyến", kicked: "Bị ngắt (mở Zalo Web nơi khác)", expired: "Phiên hết hạn – cần quét lại QR" };

// ---------- định tuyến ----------
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (h[0] === "login") return { name: "login" };
  if (h[0] === "settings") return { name: "settings" };
  if (h[0] === "admin") return { name: "admin" };
  if (h[0] === "inbox") return { name: "inbox" };
  if (h[0] === "a" && h[1] && h[3] && h[4] === "media") return { name: "gallery", acc: Number(h[1]), type: Number(h[2]), tid: decodeURIComponent(h[3]) };
  if (h[0] === "a" && h[1] && h[3] && h[4] === "m" && h[5]) return { name: "chat", acc: Number(h[1]), type: Number(h[2]), tid: decodeURIComponent(h[3]), around: decodeURIComponent(h[5]) };
  if (h[0] === "a" && h[2] === "me") return { name: "profile", acc: Number(h[1]), own: true };
  if (h[0] === "a" && h[2] === "u" && h[3]) return { name: "profile", acc: Number(h[1]), uid: decodeURIComponent(h[3]), back: "history" };
  if (h[0] === "a" && h[1] && h[3] && h[4] === "info") return h[2] === "1"
    ? { name: "group", acc: Number(h[1]), tid: decodeURIComponent(h[3]) }
    : { name: "profile", acc: Number(h[1]), uid: decodeURIComponent(h[3]), back: `#/a/${h[1]}/0/${h[3]}` };
  if (h[0] === "a" && h[1] && h[3]) return { name: "chat", acc: Number(h[1]), type: Number(h[2]), tid: decodeURIComponent(h[3]) };
  if (h[0] === "a" && h[1]) return { name: "threads", acc: Number(h[1]) };
  return { name: "home" };
}
addEventListener("hashchange", render);
document.addEventListener("click", (e) => { if (e.target.closest("[data-back]")) history.length > 1 ? history.back() : go("#/"); });
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "open") go(e.data.hash); });

async function render() {
  const r = parseRoute();
  state.route = r;
  if (!state.user && r.name !== "login") return go("#/login");
  if (state.user && r.name === "login") return go("#/");
  try {
    if (r.name === "login") return renderLogin();
    if (r.name === "settings") return renderSettings();
    if (r.name === "admin") return renderAdmin();
    await loadAccounts();
    if (r.name === "home") {
      // Chỉ tự mở thẳng tài khoản duy nhất khi vừa mở app; bấm ‹ quay lại thì ở lại màn hình chính
      const auto = !state.opened && state.accounts.length === 1;
      state.opened = true;
      if (auto) return go(`#/a/${state.accounts[0].id}`);
      return renderHome();
    }
    state.opened = true;
    if (r.name === "threads") return renderThreads(r.acc);
    if (r.name === "inbox") return renderInbox();
    if (r.name === "gallery") return renderGallery(r);
    if (r.name === "chat") return renderChat(r);
    if (r.name === "profile") return renderProfile(r);
    if (r.name === "group") return renderGroupInfo(r);
  } catch (e) { toast(e.message); }
}

// ---------- đăng nhập / đăng ký ----------
function renderLogin(mode = state.loginMode || "login") {
  state.loginMode = mode;
  const reg = mode === "register";
  $app.innerHTML = `
  <div class="auth">
    <img src="icons/icon.svg" class="logo" alt="">
    <h1>Zalo Multi</h1>
    <p class="muted">Nhiều tài khoản Zalo trong một ứng dụng</p>
    <form id="f" class="card">
      <label>Tên đăng nhập<input name="username" autocomplete="username" autocapitalize="none" required minlength="3"></label>
      <label>Mật khẩu<input name="password" type="password" autocomplete="${reg ? "new-password" : "current-password"}" required minlength="8"></label>
      ${reg && state.needsInvite ? `<label>${state.firstUser ? "Mã khởi tạo (quản trị viên)" : "Mã mời"}<input name="invite" autocapitalize="none" required></label>` : ""}
      <button class="btn primary" type="submit">${reg ? "Tạo tài khoản" : "Đăng nhập"}</button>
      <p class="err" id="err"></p>
    </form>
    <button class="link" id="sw">${reg ? "Đã có tài khoản? Đăng nhập" : "Chưa có tài khoản? Đăng ký"}</button>
    ${reg && state.needsInvite ? `<p class="muted small">${state.firstUser ? "Tài khoản đầu tiên sẽ là quản trị viên." : "Cần mã mời từ quản trị viên."}</p>` : ""}
  </div>`;
  document.getElementById("sw").onclick = () => renderLogin(reg ? "login" : "register");
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const { user } = await api("POST", reg ? "register" : "login", body);
      state.user = (await api("GET", "me")).user || user; state.firstUser = false; startEvents(); go("#/");
    } catch (err) { document.getElementById("err").textContent = err.message; }
  };
}

// ---------- tài khoản Zalo ----------
async function loadAccounts() { const r = await api("GET", "accounts"); state.accounts = r.accounts; setBadge(r.badge); }

function header(title, { back, right = "" } = {}) {
  return `<header class="bar">
    ${back === "history" ? `<button class="icon-btn" data-back aria-label="Quay lại">‹</button>`
      : back ? `<a class="icon-btn" href="${back}" aria-label="Quay lại">‹</a>` : `<span class="icon-btn"></span>`}
    <div class="title">${title}</div>${right || `<span class="icon-btn"></span>`}</header>`;
}

function installHint() {
  if (isStandalone) return "";
  if (isIOS) return `<div class="hint">📲 Để nhận thông báo trên iPhone: bấm nút <b>Chia sẻ</b> <span class="ios-share">⬆︎</span> → <b>Thêm vào MH chính</b>, rồi mở app từ màn hình chính.</div>`;
  if (state.installEvt) return `<div class="hint">📲 <button class="link" id="install">Cài app ra màn hình chính</button> để dùng như ứng dụng thật.</div>`;
  return "";
}

function renderHome() {
  $app.innerHTML = `
  ${header("Tài khoản Zalo", { right: `<a class="icon-btn" href="#/settings" aria-label="Cài đặt">⚙︎</a>` })}
  <main class="scroll">
    ${installHint()}
    ${pushBanner()}
    ${state.accounts.length ? `<a class="row inbox-row" href="#/inbox"><span class="avatar ph big-ico">📥</span>
      <div class="grow"><div class="name">Hộp thư chung</div><div class="sub">Tin mới của mọi tài khoản · tìm trong tin nhắn</div></div>
      ${(() => { const n = state.accounts.reduce((s, a) => s + (a.unread || 0), 0); return n ? `<span class="pill">${n > 99 ? "99+" : n}</span>` : ""; })()}</a>` : ""}
    <ul class="list">
      ${state.accounts.map((a) => `
        <li><a class="row" href="#/a/${a.id}">
          ${avBadge(a.avatar, a.name, a.unread, "", !a.notify)}
          <div class="grow"><div class="name">${esc(a.name)}${a.notify ? "" : " 🔕"}</div>
            <div class="sub st-${a.status}">${esc(statusText[a.status] || a.status)}</div></div>
        </a></li>`).join("")}
    </ul>
    ${state.accounts.length ? "" : `<p class="center muted">Chưa có tài khoản Zalo nào.<br>Bấm nút bên dưới và quét mã QR bằng app Zalo trên điện thoại khác hoặc máy này.</p>`}
    <div class="pad"><button class="btn primary block" id="add">＋ Thêm tài khoản Zalo</button></div>
    <div class="pad"><button class="btn block" id="logout">🚪 Đăng xuất khỏi app (${esc(state.user.username)})</button></div>
    <p class="muted small pad">Lưu ý: Zalo chỉ cho một phiên Zalo Web cùng lúc cho mỗi tài khoản. Nếu mở chat.zalo.me ở nơi khác, tài khoản sẽ bị ngắt ở đây.</p>
  </main>`;
  document.getElementById("add").onclick = startQr;
  document.getElementById("logout").onclick = logout;
  bindInstall(); bindPush();
}

function accountSwitcher(activeId) {
  if (state.accounts.length < 2) return "";
  return `<nav class="switcher">${state.accounts.map((a) => `
    <a href="#/a/${a.id}" class="sw ${a.id === activeId ? "on" : ""}" title="${esc(a.name)}">
      ${avBadge(a.avatar, a.name, a.id !== activeId ? a.unread : 0, "sm", !a.notify)}
    </a>`).join("")}</nav>`;
}

// Bộ lọc hội thoại dùng chung cho danh sách của tài khoản và hộp thư chung
const FILTERS = [["all", "Tất cả"], ["unread", "Chưa đọc"], ["user", "Cá nhân"], ["group", "Nhóm"]];
const filterBar = (f) => `<div class="filters">${FILTERS.map(([k, t]) => `<button type="button" data-f="${k}" class="${f === k ? "on" : ""}">${t}</button>`).join("")}</div>`;
const chatHash = (acc, type, tid, msgId) => `#/a/${acc}/${type}/${encodeURIComponent(tid)}${msgId ? `/m/${encodeURIComponent(msgId)}` : ""}`;
function threadRow(t, acc, showAcc) {
  return `<li><a class="row" href="${chatHash(acc, t.type, t.threadId)}" data-acc="${acc}" data-type="${t.type}" data-tid="${esc(t.threadId)}">
    <span class="avw">${avBadge(t.avatar, t.name, t.unread, "", t.muted)}${showAcc ? `<span class="acc-mini">${avatar(t.accountAvatar, t.accountName, "xs")}</span>` : ""}</span>
    <div class="grow"><div class="name">${t.type === 1 ? "👥 " : ""}${esc(t.name)}${t.muted ? " 🔕" : ""}</div>
      <div class="sub ${t.unread ? "bold" : ""}">${showAcc ? `<span class="muted">${esc(t.accountName)}: </span>` : ""}${esc(emoticons(t.lastText || ""))}</div></div>
    <div class="meta"><div class="time">${t.lastTs ? timeLabel(t.lastTs) : ""}</div>${t.pinned ? `<div class="pin" title="Đã ghim">📌</div>` : ""}</div>
  </a></li>`;
}
const hitText = (m) => (m.kind === "text" ? m.text : m.title || m.text || "");
function searchRow(m, showAcc) {
  return `<li><a class="row" href="${chatHash(m.accountId, m.type, m.threadId, m.msgId)}">${avatar(m.avatar, m.threadName, "sm")}
    <div class="grow"><div class="name small">${esc(m.threadName || m.threadId)}${showAcc ? ` <span class="muted">· ${esc(m.accountName)}</span>` : ""}</div>
      <div class="sub">${esc(m.isSelf ? "Bạn" : m.fromName || "")}: ${esc(emoticons(hitText(m)))}</div></div>
    <div class="meta"><div class="time">${timeLabel(m.ts)}</div></div></a></li>`;
}
// Giữ lâu / chuột phải vào một hội thoại: ghim, tắt thông báo
function bindThreadMenu(list, findThread) {
  const open = (row) => {
    const acc = Number(row.dataset.acc), type = Number(row.dataset.type), tid = row.dataset.tid;
    const t = findThread(acc, type, tid); if (!t) return;
    const path = `accounts/${acc}/threads/${type}/${encodeURIComponent(tid)}`;
    sheet([
      [t.pinned ? "📌 Bỏ ghim" : "📌 Ghim lên đầu", () => api("POST", `${path}/pin`, { pinned: !t.pinned }).then(render)],
      [t.muted ? "🔔 Bật thông báo" : "🔕 Tắt thông báo", () => api("POST", `${path}/mute`, { muted: !t.muted }).then(render)],
      ["🖼 Ảnh, file, link", () => go(`#/a/${acc}/${type}/${encodeURIComponent(tid)}/media`)],
    ]);
  };
  list.oncontextmenu = (e) => { const row = e.target.closest(".row[data-tid]"); if (row) { e.preventDefault(); open(row); } };
  let press, fired = false;
  list.addEventListener("touchstart", (e) => {
    const row = e.target.closest(".row[data-tid]"); if (!row) return;
    fired = false;
    press = setTimeout(() => { fired = true; navigator.vibrate?.(15); open(row); }, 500);
  }, { passive: true });
  const cancel = () => clearTimeout(press);
  list.addEventListener("touchmove", cancel, { passive: true });
  list.addEventListener("touchend", (e) => { cancel(); if (fired) e.preventDefault(); }); // đã mở menu thì không mở hội thoại
}

async function renderThreads(accId, q = state.q || "") {
  const acc = state.accounts.find((a) => a.id === accId);
  if (!acc) return go("#/");
  const f = state.filter || "all";
  const [{ threads }, hits] = await Promise.all([
    api("GET", `accounts/${accId}/threads?q=${encodeURIComponent(q)}&f=${f}`),
    q.trim().length >= 2 ? api("GET", `search?acc=${accId}&q=${encodeURIComponent(q.trim())}`).then((r) => r.results) : [],
  ]);
  state.threads = threads; state.threadsAcc = accId;
  const keepFocus = document.activeElement?.id === "q";
  $app.innerHTML = `
  ${header(esc(acc.name), { back: "#/", right: `<a class="icon-btn" href="#/settings" aria-label="Cài đặt">⚙︎</a><button class="icon-btn" id="menu" aria-label="Tuỳ chọn">⋯</button>` })}
  ${accountSwitcher(accId)}
  ${acc.status !== "online" ? `<div class="warn">${esc(acc.statusMsg || statusText[acc.status])}
     ${["kicked", "offline", "reconnecting"].includes(acc.status) ? `<button class="btn sm" id="rc">Kết nối lại</button>` : ""}
     ${acc.status === "expired" ? `<button class="btn sm" id="reqr">Quét QR</button>` : ""}</div>` : ""}
  <div class="search"><input id="q" type="search" placeholder="Tìm hội thoại hoặc nội dung tin nhắn" value="${esc(q)}"></div>
  ${q ? "" : filterBar(f)}
  <main class="scroll">
    ${q && state.threads.length ? `<div class="sec">Hội thoại</div>` : ""}
    <ul class="list" id="tlist">${state.threads.map((t) => threadRow(t, accId)).join("")}</ul>
    ${hits.length ? `<div class="sec">Tin nhắn (${hits.length}${hits.length >= 80 ? "+" : ""})</div><ul class="list">${hits.map((m) => searchRow(m)).join("")}</ul>` : ""}
    ${state.threads.length || hits.length ? "" : q ? `<p class="center muted">Không tìm thấy “${esc(q)}”.</p>`
      : f !== "all" ? `<p class="center muted">Không có hội thoại nào ở mục này.</p>`
      : `<p class="center muted">Chưa có tin nhắn. Tin mới sẽ hiện ở đây.<br><button class="link" id="sync2">Tải danh bạ & nhóm</button></p>`}
    ${q || state.threads.length < 3 ? "" : `<p class="muted small center pad">Giữ lâu một hội thoại để ghim lên đầu.</p>`}
  </main>`;
  document.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { state.filter = b.dataset.f; renderThreads(accId, q); });
  bindThreadMenu(document.getElementById("tlist"), (a, type, tid) => state.threads.find((t) => t.type === type && t.threadId === tid));
  const qEl = document.getElementById("q");
  if (keepFocus) { qEl.focus(); qEl.setSelectionRange(q.length, q.length); }
  qEl.oninput = () => { clearTimeout(renderThreads.t); renderThreads.t = setTimeout(() => { state.q = qEl.value; renderThreads(accId, qEl.value); }, 250); };
  const sync = async () => { toast("Đang tải danh bạ…"); try { const r = await api("POST", `accounts/${accId}/sync`); toast(`Đã tải ${r.friends} bạn, ${r.groups} nhóm`); renderThreads(accId); } catch (e) { toast(e.message); } };
  document.getElementById("sync2")?.addEventListener("click", sync);
  document.getElementById("rc")?.addEventListener("click", () => api("POST", `accounts/${accId}/reconnect`).then(() => toast("Đang kết nối lại…")));
  document.getElementById("reqr")?.addEventListener("click", startQr);
  const setNotify = (body, msg) => api("POST", `accounts/${accId}/notify`, body).then(() => { toast(msg); render(); });
  document.getElementById("menu").onclick = () => sheet([
    ["👤 Thông tin tài khoản", () => go(`#/a/${accId}/me`)],
    [acc.notify ? "🔕 Tắt thông báo tài khoản này" : "🔔 Bật thông báo tài khoản này",
      () => setNotify({ notify: !acc.notify }, acc.notify ? "Đã tắt thông báo của tài khoản" : "Đã bật thông báo của tài khoản")],
    [acc.notifyGroups ? "🔕 Tắt thông báo tin nhóm" : "🔔 Bật thông báo tin nhóm",
      () => setNotify({ notifyGroups: !acc.notifyGroups }, acc.notifyGroups ? "Đã tắt thông báo tin nhóm" : "Đã bật thông báo tin nhóm")],
    ["✓ Đánh dấu tất cả đã đọc", () => api("POST", `accounts/${accId}/read-all`).then(render)],
    ["Tải danh bạ & nhóm", sync],
    ["Kết nối lại", () => api("POST", `accounts/${accId}/reconnect`).then(() => toast("Đang kết nối lại…"))],
    ["Quét lại mã QR", startQr],
    ["Xoá tài khoản khỏi app", async () => {
      if (!confirm(`Xoá ${acc.name} khỏi app? Tin nhắn đã lưu trong app cũng bị xoá (không ảnh hưởng Zalo).`)) return;
      await api("DELETE", `accounts/${accId}`); go("#/");
    }, "danger"],
    ["🏠 Danh sách tài khoản Zalo", () => go("#/")],
    ["⚙︎ Cài đặt", () => go("#/settings")],
    ["🚪 Đăng xuất khỏi app", logout],
  ]);
}

async function renderInbox(q = state.iq || "") {
  const f = state.ifilter || "all";
  const [{ threads }, hits] = await Promise.all([
    api("GET", `inbox?f=${f}`),
    q.trim().length >= 2 ? api("GET", `search?q=${encodeURIComponent(q.trim())}`).then((r) => r.results) : [],
  ]);
  const nq = q.trim() ? unaccentJs(q.trim()) : "";
  const list = nq ? threads.filter((t) => unaccentJs(t.name).includes(nq)) : threads;
  state.inbox = threads;
  const keepFocus = document.activeElement?.id === "iq";
  $app.innerHTML = `
  ${header("Hộp thư chung", { back: "#/", right: `<a class="icon-btn" href="#/settings" aria-label="Cài đặt">⚙︎</a>` })}
  <div class="search"><input id="iq" type="search" placeholder="Tìm trong mọi tài khoản" value="${esc(q)}"></div>
  ${q ? "" : filterBar(f)}
  <main class="scroll">
    ${q && list.length ? `<div class="sec">Hội thoại</div>` : ""}
    <ul class="list" id="tlist">${list.map((t) => threadRow(t, t.accountId, true)).join("")}</ul>
    ${hits.length ? `<div class="sec">Tin nhắn (${hits.length}${hits.length >= 80 ? "+" : ""})</div><ul class="list">${hits.map((m) => searchRow(m, true)).join("")}</ul>` : ""}
    ${list.length || hits.length ? "" : `<p class="center muted">${q ? `Không tìm thấy “${esc(q)}”.` : "Không có hội thoại nào ở mục này."}</p>`}
  </main>`;
  const qEl = document.getElementById("iq");
  if (keepFocus) { qEl.focus(); qEl.setSelectionRange(q.length, q.length); }
  qEl.oninput = () => { clearTimeout(renderInbox.t); renderInbox.t = setTimeout(() => { state.iq = qEl.value; renderInbox(qEl.value); }, 300); };
  document.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { state.ifilter = b.dataset.f; renderInbox(q); });
  bindThreadMenu(document.getElementById("tlist"), (a, type, tid) => state.inbox.find((t) => t.accountId === a && t.type === type && t.threadId === tid));
}
const unaccentJs = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

function sheet(items) {
  const el = document.createElement("div");
  el.className = "sheet-bg";
  el.innerHTML = `<div class="sheet">${items.map(([t, , cls], i) => `<button class="sheet-item ${cls || ""}" data-i="${i}">${esc(t)}</button>`).join("")}
    <button class="sheet-item cancel">Huỷ</button></div>`;
  el.onclick = (e) => {
    const i = e.target.dataset?.i;
    el.remove();
    if (i !== undefined) items[i][1]();
  };
  document.body.appendChild(el);
}

// ---------- quét QR ----------
async function startQr() {
  const el = document.createElement("div");
  el.className = "modal-bg";
  el.innerHTML = `<div class="modal"><h2>Quét mã bằng app Zalo</h2>
    <div id="qrbox" class="qrbox"><div class="spinner"></div></div>
    <p class="muted small" id="qrmsg">Mở Zalo trên điện thoại có tài khoản cần thêm → biểu tượng quét mã QR → quét mã này.<br>Nếu tài khoản ở ngay máy này: chụp màn hình mã, rồi trong Zalo chọn quét QR → chọn ảnh.</p>
    <button class="btn block" id="qrclose">Đóng</button></div>`;
  document.body.appendChild(el);
  let key = null;
  const close = () => { el.remove(); state.qr = null; if (key) api("POST", "accounts/qr/cancel", { key }).catch(() => {}); };
  el.querySelector("#qrclose").onclick = close;
  try { key = (await api("POST", "accounts/qr")).key; } catch (e) { toast(e.message); return close(); }
  state.qr = {
    key,
    on(d) {
      const box = el.querySelector("#qrbox"), msg = el.querySelector("#qrmsg");
      if (d.event === "code") box.innerHTML = `<img src="data:image/png;base64,${d.image.replace(/^data:image\/png;base64,/, "")}" alt="Mã QR đăng nhập Zalo">`;
      if (d.event === "scanned") { box.innerHTML = `${avatar(d.avatar, d.name, "lg")}`; msg.textContent = `${d.name}: hãy bấm "Đăng nhập" trên điện thoại.`; }
      if (d.event === "success") { key = null; el.remove(); state.qr = null; toast(`Đã thêm ${d.account.name}`); go(`#/a/${d.account.id}`); }
      if (["declined", "expired", "error"].includes(d.event)) { key = null; box.innerHTML = "⚠️"; msg.textContent = d.message; }
    },
  };
}

// ---------- khung chat ----------
const REACTS = ["/-heart", "/-strong", ":>", ":o", ":-((", ":-h"];
const MORE_REACTS = ["/-rose", "/-ok", "_()_", ";xx", ":-*", ":')", "/-break", "/-weak", "/-v", "/-thanks", ":handclap", "/-bd", "--b", ";-/", "b-)", ":-bye", "/-beer", "/-shit"];
const EMOJIS = "😀 😁 😂 🤣 😃 😄 😅 😆 😉 😊 😋 😎 😍 😘 🥰 😗 🙂 🤗 🤩 🤔 🤨 😐 😑 😶 🙄 😏 😣 😥 😮 🤐 😯 😪 😫 🥱 😴 😌 😛 😜 😝 🤤 😒 😓 😔 😕 🙃 🤑 😲 🙁 😖 😞 😟 😤 😢 😭 😦 😧 😨 😩 🤯 😬 😰 😱 🥵 🥶 😳 🤪 😵 🥴 😠 😡 🤬 😷 🤒 🤕 🤢 🤮 🤧 😇 🥳 🥺 🤠 🤡 🤥 🤫 🤭 🧐 🤓 😈 💀 👻 👽 🤖 💩 😺 😸 😻 👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👋 👏 🙌 👐 🤝 🙏 💪 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💞 💓 💗 💖 💘 💝 💯 🔥 ✨ 🌟 🎉 🎊 🎁 🎂 🌹 🌸 🌷 🌻 ☕ 🍺 🍻 🍰 🍜 🍕 🏆 ⚽ 🚗 ✈️ 📞 💰 ✅ ❌ ⭐".split(" ");
const STICKER_KEYS = ["haha", "yêu", "chào", "cảm ơn", "ok", "buồn", "giận", "hihi", "ngủ", "chúc mừng"];
const tpath = (r) => `accounts/${r.acc}/threads/${r.type}/${encodeURIComponent(r.tid)}`;
const reactEmoji = (code) => emoticons(code);

async function renderChat(r) {
  const acc = state.accounts.find((a) => a.id === r.acc);
  if (!acc) return go("#/");
  const [{ messages }, { threads }] = await Promise.all([
    api("GET", `${tpath(r)}/messages${r.around ? `?around=${encodeURIComponent(r.around)}` : ""}`),
    state.threads.length && state.threadsAcc === r.acc ? { threads: state.threads } : api("GET", `accounts/${r.acc}/threads`),
  ]);
  state.threads = threads; state.threadsAcc = r.acc;
  state.messages = messages;
  state.reply = null; state.tray = [];
  // đang xem quanh một tin tìm được: có thể còn tin mới hơn chưa tải
  const target = r.around && messages.find((m) => m.msgId === r.around);
  const newer = target ? messages.filter((m) => m.ts > target.ts).length >= 30 : false;
  state.gap = newer;
  const t = threads.find((x) => x.threadId === r.tid && x.type === r.type) || { name: r.tid };
  const online = acc.status === "online";
  $app.innerHTML = `
  ${header(`<a class="chat-title" href="#/a/${r.acc}/${r.type}/${encodeURIComponent(r.tid)}/info">${avatar(t.avatar, t.name, "sm")}<div><div>${esc(t.name)}${t.muted ? " 🔕" : ""}</div><div class="sub small" id="csub">${esc(acc.name)}</div></div></a>`,
    { back: `#/a/${r.acc}`, right: `<button class="icon-btn" id="cmenu" aria-label="Tuỳ chọn">⋯</button>` })}
  <main class="scroll chat" id="msgs">
    ${messages.length >= 60 ? `<div class="center"><button class="link" id="older">Xem tin cũ hơn</button></div>` : ""}
    <div id="mlist">${messages.map((m) => bubble(m, r.type)).join("")}</div>
    ${newer ? `<div class="center"><a class="link" href="${chatHash(r.acc, r.type, r.tid)}">Xem tin mới nhất ↓</a></div>` : ""}
  </main>
  <div id="tray" class="tray" hidden></div>
  <div id="qsug" class="qsug" hidden></div>
  <div id="replybar" class="replybar" hidden></div>
  <div id="panel" class="panel" hidden></div>
  <form class="composer" id="cf">
    <button type="button" class="icon-btn" id="emo" aria-label="Sticker và biểu tượng" ${online ? "" : "disabled"}>😊</button>
    <label class="icon-btn attach" aria-label="Gửi ảnh">🖼<input type="file" accept="image/*" id="pic" hidden multiple ${online ? "" : "disabled"}></label>
    <label class="icon-btn attach" aria-label="Gửi file">📎<input type="file" id="fil" hidden ${online ? "" : "disabled"}></label>
    <textarea id="txt" rows="1" placeholder="Nhập tin nhắn" ${online ? "" : "disabled"}></textarea>
    <button class="icon-btn send" type="submit" aria-label="Gửi">➤</button>
  </form>`;
  if (target) {
    const el = document.querySelector(`.msg[data-mid="${CSS.escape(r.around)}"]`);
    el?.scrollIntoView({ block: "center" }); el?.classList.add("hl");
  } else scrollBottom();
  loadAccounts().catch(() => {}); // cập nhật số trên icon app sau khi đọc
  navigator.serviceWorker?.ready.then((reg) => reg.getNotifications({ tag: `${r.acc}-${r.type}-${r.tid}` }))
    .then((ns) => ns?.forEach((n) => n.close())).catch(() => {});
  const muteToggle = async () => {
    await api("POST", `${tpath(r)}/mute`, { muted: !t.muted });
    t.muted = t.muted ? 0 : 1; toast(t.muted ? "Đã tắt thông báo hội thoại" : "Đã bật thông báo hội thoại"); renderChat(r);
  };
  const media = `#/a/${r.acc}/${r.type}/${encodeURIComponent(r.tid)}/media`;
  document.getElementById("cmenu").onclick = () => sheet([
    [r.type === 1 ? "👥 Thông tin nhóm" : "👤 Xem trang cá nhân", () => go(`#/a/${r.acc}/${r.type}/${encodeURIComponent(r.tid)}/info`)],
    ["🔍 Tìm tin nhắn", () => { state.galleryTab = "search"; go(media); }],
    ["🖼 Ảnh, file, link đã gửi", () => { state.galleryTab = "media"; go(media); }],
    [t.pinned ? "📌 Bỏ ghim hội thoại" : "📌 Ghim hội thoại lên đầu", async () => {
      await api("POST", `${tpath(r)}/pin`, { pinned: !t.pinned }); t.pinned = t.pinned ? 0 : 1;
      toast(t.pinned ? "Đã ghim" : "Đã bỏ ghim");
    }],
    [t.muted ? "🔔 Bật thông báo hội thoại này" : "🔕 Tắt thông báo hội thoại này", muteToggle],
  ]);

  // soạn & gửi
  const txt = document.getElementById("txt");
  let lastTyping = 0;
  loadQuick();
  txt.oninput = () => {
    txt.style.height = "auto"; txt.style.height = Math.min(txt.scrollHeight, 140) + "px";
    quickSuggest(txt);
    if (txt.value && Date.now() - lastTyping > 4000) { lastTyping = Date.now(); api("POST", `${tpath(r)}/typing`).catch(() => {}); }
  };
  txt.onkeydown = (e) => {
    const first = document.querySelector("#qsug:not([hidden]) [data-qi]");
    if (first && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) { e.preventDefault(); first.click(); return; }
    if (e.key === "Escape") document.getElementById("qsug").hidden = true;
    if (e.key === "Enter" && !e.shiftKey && !isIOS && !/Android/.test(navigator.userAgent)) { e.preventDefault(); document.getElementById("cf").requestSubmit(); }
  };
  txt.onfocus = () => { document.getElementById("panel").hidden = true; };
  document.getElementById("cf").onsubmit = async (e) => {
    e.preventDefault();
    const text = txt.value.trim();
    if (!text) return;
    const quote = state.reply?.msgId;
    txt.value = ""; txt.oninput(); setReply(null); document.getElementById("qsug").hidden = true;
    try { await api("POST", `${tpath(r)}/text`, { text, quote }); }
    catch (err) { toast(err.message); txt.value = text; }
  };
  document.getElementById("pic").onchange = (e) => { addToTray(r, [...e.target.files]); e.target.value = ""; };
  const sendFile = async (f) => {
    if (f.size > 20 * 1048576) return toast("File tối đa 20MB");
    try {
      toast("Đang gửi file…", 30000);
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.onerror = rej; fr.readAsDataURL(f); });
      await api("POST", `${tpath(r)}/file`, { data, filename: f.name });
      toast("Đã gửi file");
    } catch (err) { toast(err.message); }
  };
  document.getElementById("fil").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) sendFile(f); };
  // Dán ảnh (Ctrl+V / giữ ô nhập → Dán) và kéo thả ảnh, file vào khung chat
  txt.onpaste = (e) => {
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (imgs.length && online) { e.preventDefault(); addToTray(r, imgs); }
  };
  const chatEl = document.getElementById("msgs");
  chatEl.ondragover = (e) => { if (online && e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); chatEl.classList.add("drop"); } };
  chatEl.ondragleave = () => chatEl.classList.remove("drop");
  chatEl.ondrop = (e) => {
    chatEl.classList.remove("drop");
    const files = [...(e.dataTransfer?.files || [])]; if (!files.length || !online) return;
    e.preventDefault();
    addToTray(r, files.filter((f) => f.type.startsWith("image/")));
    files.filter((f) => !f.type.startsWith("image/")).forEach(sendFile);
  };
  document.getElementById("emo").onclick = () => togglePanel(r);

  document.getElementById("older")?.addEventListener("click", async () => {
    const before = state.messages[0]?.ts;
    const { messages: older } = await api("GET", `${tpath(r)}/messages?before=${before}`);
    state.messages = older.concat(state.messages);
    const box = document.getElementById("msgs"), h = box.scrollHeight;
    document.getElementById("mlist").insertAdjacentHTML("afterbegin", older.map((m) => bubble(m, r.type)).join(""));
    box.scrollTop = box.scrollHeight - h;
    if (older.length < 60) document.getElementById("older").remove();
  });
  // Nhóm: lấy thêm lịch sử từ Zalo (một lần mỗi nhóm), có tin mới thì vẽ lại
  if (r.type === 1 && online && !renderChat.hist?.has(r.acc + ":" + r.tid)) {
    (renderChat.hist ||= new Set()).add(r.acc + ":" + r.tid);
    api("POST", `accounts/${r.acc}/threads/1/${encodeURIComponent(r.tid)}/history`)
      .then((h) => { if (h.added && state.route?.name === "chat" && state.route.tid === r.tid) renderChat(r); }).catch(() => {});
  }

  // bấm vào tin: xem ảnh, mở trang cá nhân người gửi, thả nhanh cảm xúc; giữ lâu / chuột phải: menu thao tác
  const box = document.getElementById("msgs");
  box.onclick = (e) => {
    const im = e.target.closest("img.photo");
    if (im) { const v = document.createElement("div"); v.className = "viewer"; v.innerHTML = `<img src="${esc(im.dataset.full)}" referrerpolicy="no-referrer" alt="">`; v.onclick = () => v.remove(); document.body.appendChild(v); return; }
    const from = e.target.closest("[data-uid]");
    if (from) return go(`#/a/${r.acc}/u/${encodeURIComponent(from.dataset.uid)}`);
    const rx = e.target.closest(".rx");
    if (rx) return showReactors(rx.closest(".msg").dataset.mid);
    const more = e.target.closest(".more");
    if (more) return msgActions(r, more.closest(".msg").dataset.mid);
    const q = e.target.closest(".quote");
    if (q?.dataset.q) document.querySelector(`.msg[data-mid="${CSS.escape(q.dataset.q)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  box.oncontextmenu = (e) => { const m = e.target.closest(".msg[data-mid]"); if (m) { e.preventDefault(); msgActions(r, m.dataset.mid); } };
  let press;
  box.addEventListener("touchstart", (e) => {
    const m = e.target.closest(".bubble")?.closest(".msg[data-mid]");
    if (!m) return;
    press = setTimeout(() => { press = null; navigator.vibrate?.(15); msgActions(r, m.dataset.mid); }, 450);
  }, { passive: true });
  const cancel = () => { clearTimeout(press); press = null; };
  box.addEventListener("touchend", cancel); box.addEventListener("touchmove", cancel, { passive: true });
}

// ---------- tin mẫu ----------
async function loadQuick(force) {
  if (state.quick && !force) return state.quick;
  try { state.quick = (await api("GET", "quick-replies")).items; } catch { state.quick ||= []; }
  return state.quick;
}
function insertText(txt, text) {
  txt.value = text; txt.focus(); txt.selectionStart = txt.selectionEnd = text.length;
  txt.oninput();
}
// Gõ "/" ở đầu ô nhập: hiện tin mẫu khớp tên tắt hoặc nội dung
function quickSuggest(txt) {
  const box = document.getElementById("qsug"); if (!box) return;
  const m = txt.value.match(/^\/(\S*)$/);
  if (!m) { box.hidden = true; return; }
  const k = unaccentJs(m[1]);
  const items = (state.quick || []).filter((x) => unaccentJs(x.shortcut).startsWith(k) || (k && unaccentJs(x.text).includes(k))).slice(0, 8);
  box.hidden = false;
  box.innerHTML = items.length
    ? items.map((x) => `<button type="button" data-qi="${x.id}"><b>/${esc(x.shortcut)}</b> <span class="muted">${esc(x.text.slice(0, 80))}</span></button>`).join("")
    : `<div class="small muted pad">${state.quick?.length ? "Không có tin mẫu khớp." : "Chưa có tin mẫu."} <a href="#/settings" class="link">Thêm tin mẫu</a></div>`;
  box.onclick = (e) => {
    const b = e.target.closest("[data-qi]"); if (!b) return;
    const q = state.quick.find((x) => x.id === Number(b.dataset.qi));
    box.hidden = true;
    if (q) insertText(txt, q.text);
  };
}

// ---------- khay ảnh chờ gửi ----------
function addToTray(r, files) {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return;
  state.tray = (state.tray || []).concat(imgs.map((f) => ({ f, url: URL.createObjectURL(f) }))).slice(0, 30);
  drawTray(r);
}
function drawTray(r) {
  const el = document.getElementById("tray"); if (!el) return;
  const items = state.tray || [];
  el.hidden = !items.length;
  if (!items.length) return;
  el.innerHTML = `<div class="tray-imgs">${items.map((x, i) => `<div class="ti"><img src="${x.url}" alt=""><button type="button" data-rm="${i}" aria-label="Bỏ ảnh">✕</button></div>`).join("")}
    <label class="ti add" aria-label="Thêm ảnh">＋<input type="file" accept="image/*" multiple hidden></label></div>
    <div class="tray-bar"><button type="button" class="btn sm" data-cancel>Huỷ</button><button type="button" class="btn primary sm" data-send>Gửi ${items.length} ảnh</button></div>`;
  el.querySelector("input").onchange = (e) => addToTray(r, [...e.target.files]);
  el.onclick = async (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { URL.revokeObjectURL(items[rm.dataset.rm].url); items.splice(Number(rm.dataset.rm), 1); return drawTray(r); }
    if (e.target.closest("[data-cancel]")) { items.forEach((x) => URL.revokeObjectURL(x.url)); state.tray = []; return drawTray(r); }
    if (!e.target.closest("[data-send]")) return;
    const list = items.splice(0); drawTray(r);
    let ok = 0;
    for (const [i, x] of list.entries()) {
      try {
        toast(list.length > 1 ? `Đang gửi ảnh ${i + 1}/${list.length}…` : "Đang gửi ảnh…", 30000);
        await api("POST", `${tpath(r)}/image`, await prepareImage(x.f)); ok++;
      } catch (err) { toast(err.message, 4000); }
      URL.revokeObjectURL(x.url);
    }
    if (ok) toast(ok === list.length ? `Đã gửi ${ok} ảnh` : `Đã gửi ${ok}/${list.length} ảnh`);
  };
}

function setReply(m) {
  state.reply = m;
  const bar = document.getElementById("replybar");
  if (!bar) return;
  bar.hidden = !m;
  if (m) {
    bar.innerHTML = `<div class="grow"><b>Trả lời ${esc(m.isSelf ? "chính mình" : m.fromName || "")}</b><div class="small muted ell">${esc(previewOf(m))}</div></div><button class="icon-btn" id="rx0" aria-label="Huỷ trả lời">✕</button>`;
    bar.querySelector("#rx0").onclick = () => setReply(null);
    document.getElementById("txt")?.focus();
  }
}
const previewOf = (m) => ({ image: "[Hình ảnh]", sticker: "[Sticker]", file: "[File] " + (m.title || ""), video: "[Video]", voice: "[Tin nhắn thoại]", link: m.title || m.url, recalled: "Tin nhắn đã thu hồi" }[m.kind] ?? emoticons(m.text || ""));

function msgActions(r, mid) {
  const m = state.messages.find((x) => x.msgId === mid);
  if (!m || m.kind === "recalled") return;
  const acc = state.accounts.find((a) => a.id === r.acc);
  const online = acc?.status === "online";
  const mine = (m.reactions || []).find((x) => x.uid === acc?.zaloUid)?.icon;
  const el = document.createElement("div");
  el.className = "sheet-bg";
  const items = [
    online && ["↩️ Trả lời", () => setReply(m)],
    m.text && ["📋 Sao chép", () => navigator.clipboard.writeText(m.text).then(() => toast("Đã sao chép"))],
    (m.media || m.url) && m.kind !== "sticker" && ["⬇️ Mở / tải về", () => window.open(m.media ? `api/media/${m.id}` : m.url, "_blank", "noopener")],
    online && m.isSelf && ["↶ Thu hồi", async () => { if (confirm("Thu hồi tin nhắn này với mọi người?")) await api("POST", `accounts/${r.acc}/messages/${mid}/recall`).catch((e) => toast(e.message)); }],
    ["🗑 Xoá ở phía tôi", async () => {
      if (!confirm("Xoá tin nhắn này ở phía bạn?")) return;
      await api("DELETE", `accounts/${r.acc}/messages/${mid}`).catch((e) => toast(e.message));
      state.messages = state.messages.filter((x) => x.msgId !== mid);
      document.querySelector(`.msg[data-mid="${CSS.escape(mid)}"]`)?.remove();
    }, "danger"],
  ].filter(Boolean);
  el.innerHTML = `<div class="sheet">
    ${online ? `<div class="reacts">${REACTS.map((c) => `<button class="react ${mine === c ? "on" : ""}" data-r="${esc(c)}">${reactEmoji(c)}</button>`).join("")}<button class="react" data-r="+">＋</button></div>
    <div class="reacts more-reacts" hidden>${MORE_REACTS.map((c) => `<button class="react ${mine === c ? "on" : ""}" data-r="${esc(c)}">${reactEmoji(c)}</button>`).join("")}</div>` : ""}
    <div class="sheet-preview small muted ell">${esc(previewOf(m))}</div>
    ${items.map(([t, , cls], i) => `<button class="sheet-item ${cls || ""}" data-i="${i}">${esc(t)}</button>`).join("")}
    <button class="sheet-item cancel">Huỷ</button></div>`;
  el.onclick = async (e) => {
    const rb = e.target.closest("[data-r]");
    if (rb) {
      if (rb.dataset.r === "+") { el.querySelector(".more-reacts").hidden = false; rb.remove(); return; }
      el.remove();
      const icon = rb.dataset.r === mine ? "" : rb.dataset.r; // bấm lại cảm xúc cũ = bỏ
      try { const res = await api("POST", `accounts/${r.acc}/messages/${mid}/react`, { icon }); updateMsg(mid, { reactions: res.reactions }); }
      catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest(".reacts")) return;
    const i = e.target.dataset?.i;
    el.remove();
    if (i !== undefined) items[i][1]();
  };
  document.body.appendChild(el);
}

function showReactors(mid) {
  const m = state.messages.find((x) => x.msgId === mid);
  if (!m?.reactions?.length) return;
  const acc = state.accounts.find((a) => a.id === state.route.acc);
  toast(m.reactions.map((x) => `${reactEmoji(x.icon)} ${x.uid === acc?.zaloUid ? "Bạn" : x.name || "Thành viên"}`).join(" · "), 5000);
}

function updateMsg(mid, patch) {
  const m = state.messages.find((x) => x.msgId === mid);
  if (!m) return;
  Object.assign(m, patch);
  const el = document.querySelector(`.msg[data-mid="${CSS.escape(mid)}"]`);
  if (el) el.outerHTML = bubble(m, state.route.type);
}

// bảng sticker / emoji
async function togglePanel(r) {
  const p = document.getElementById("panel");
  if (!p.hidden) { p.hidden = true; return; }
  p.hidden = false;
  document.getElementById("txt").blur();
  const tab = state.panelTab || "sticker";
  p.innerHTML = `<div class="tabs"><button data-tab="sticker" class="${tab === "sticker" ? "on" : ""}">Sticker</button><button data-tab="emoji" class="${tab === "emoji" ? "on" : ""}">Emoji</button><button data-tab="quick" class="${tab === "quick" ? "on" : ""}">Tin mẫu</button></div><div id="pbody" class="pbody"></div>`;
  p.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { state.panelTab = b.dataset.tab; p.hidden = true; togglePanel(r); });
  const body = p.querySelector("#pbody");
  if (tab === "quick") {
    const items = await loadQuick();
    body.innerHTML = `<div class="quick-list">${items.map((x) => `<button type="button" data-qi="${x.id}"><b>/${esc(x.shortcut)}</b><span>${esc(x.text)}</span></button>`).join("")}</div>
      <p class="small muted">${items.length ? "Mẹo: gõ <b>/</b> + tên tắt trong ô nhập để chèn nhanh." : "Chưa có tin mẫu."} <a class="link" href="#/settings">Quản lý tin mẫu</a></p>`;
    body.onclick = (e) => {
      const b = e.target.closest("[data-qi]"); if (!b) return;
      const q = items.find((x) => x.id === Number(b.dataset.qi));
      p.hidden = true;
      if (q) insertText(document.getElementById("txt"), q.text);
    };
    return;
  }
  if (tab === "emoji") {
    body.innerHTML = `<div class="emoji-grid">${EMOJIS.map((e) => `<button type="button">${e}</button>`).join("")}</div>`;
    body.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const txt = document.getElementById("txt"), s = txt.selectionStart ?? txt.value.length;
      txt.value = txt.value.slice(0, s) + b.textContent + txt.value.slice(txt.selectionEnd ?? s);
      txt.selectionStart = txt.selectionEnd = s + b.textContent.length;
      txt.oninput();
    };
    return;
  }
  body.innerHTML = `<input type="search" id="sq" placeholder="Tìm sticker (vd: haha, yêu, chào)">
    <div class="chips">${STICKER_KEYS.map((k) => `<button type="button" data-k="${esc(k)}">${esc(k)}</button>`).join("")}</div>
    <div id="sgrid" class="sticker-grid"><div class="spinner"></div></div>`;
  const grid = body.querySelector("#sgrid");
  const load = async (q) => {
    grid.innerHTML = `<div class="spinner"></div>`;
    try {
      let { stickers } = await api("GET", `accounts/${r.acc}/stickers${q ? "?q=" + encodeURIComponent(q) : ""}`);
      if (!q && !stickers.length) return load("haha");
      grid.innerHTML = (!q ? `<div class="small muted full">Đã dùng gần đây</div>` : "") +
        (stickers.map((s) => `<button type="button" data-s='${esc(JSON.stringify({ id: s.id, cateId: s.cateId, type: s.type }))}'><img src="${safeUrl(s.url)}" loading="lazy" referrerpolicy="no-referrer" alt=""></button>`).join("") || `<p class="muted small">Không tìm thấy sticker</p>`);
    } catch (e) { grid.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
  };
  load("");
  const sq = body.querySelector("#sq");
  sq.oninput = () => { clearTimeout(sq.t); sq.t = setTimeout(() => load(sq.value.trim()), 400); };
  body.onclick = async (e) => {
    const k = e.target.closest("[data-k]"); if (k) { sq.value = k.dataset.k; return load(k.dataset.k); }
    const b = e.target.closest("[data-s]"); if (!b) return;
    try { await api("POST", `${tpath(r)}/sticker`, JSON.parse(b.dataset.s)); } catch (err) { toast(err.message); }
  };
}

function bubble(m, type) {
  let body;
  const kind = m.recalled ? "recalled" : m.kind;
  switch (kind) {
    case "image": body = `<img class="photo" src="${mediaSrc(m, m.thumb || m.url)}" data-full="${mediaSrc(m, m.url || m.thumb)}" referrerpolicy="no-referrer" loading="lazy" alt="Ảnh">${m.text ? `<div>${esc(m.text)}</div>` : ""}`; break;
    case "file": body = `<a class="file" href="${mediaSrc(m, m.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(m.title || "Tệp")}<span class="small muted"> ${esc(m.text || "")}${m.media ? " · đã lưu" : ""}</span></a>`; break;
    case "video": body = m.media ? `<video controls preload="metadata" playsinline src="${mediaSrc(m)}"></video>` : `<a class="file" href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">🎬 Video</a>`; break;
    case "voice": body = m.url || m.media ? `<audio controls preload="none" src="${mediaSrc(m, m.url)}"></audio>` : "[Tin nhắn thoại]"; break;
    case "link": body = `<a class="file" href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(m.title || m.url)}</a>${m.text ? `<div class="small">${esc(m.text)}</div>` : ""}`; break;
    case "sticker": body = m.url ? `<img class="sticker" src="${safeUrl(m.url)}" referrerpolicy="no-referrer" loading="lazy" alt="Sticker">` : "[Sticker]"; break;
    case "recalled": body = `<i class="muted">Tin nhắn đã được thu hồi</i>`; break;
    default: body = linkify(esc(emoticons(m.text || "")));
  }
  const q = m.quote && kind !== "recalled" ? `<div class="quote" data-q="${esc(m.quote.msgId || "")}"><b>${esc(m.quote.name)}</b><div class="ell">${esc(emoticons(m.quote.text))}</div></div>` : "";
  // gom cảm xúc: ❤️ 2 👍 1
  const counts = {};
  for (const x of m.reactions || []) counts[x.icon] = (counts[x.icon] || 0) + 1;
  const rx = Object.keys(counts).length ? `<button class="rx">${Object.entries(counts).map(([i, n]) => `${reactEmoji(i)}${n > 1 ? `<small>${n}</small>` : ""}`).join(" ")}</button>` : "";
  return `<div class="msg ${m.isSelf ? "me" : ""} ${kind === "sticker" && m.url ? "stk" : ""} ${rx ? "has-rx" : ""}" data-mid="${esc(m.msgId)}">
    ${type === 1 && !m.isSelf ? `<button class="from" data-uid="${esc(m.fromUid)}">${esc(m.fromName || "")}</button>` : ""}
    <div class="brow"><div class="bubble">${q}${body}<span class="ts">${new Date(m.ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</span>${rx}</div>
    ${kind !== "recalled" ? `<button class="more" aria-label="Thao tác">⋯</button>` : ""}</div></div>`;
}
const linkify = (s) => s.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`).replace(/\n/g, "<br>");
function scrollBottom() { const b = document.getElementById("msgs"); if (b) b.scrollTop = b.scrollHeight; }

// ---------- ảnh, file, link & tìm trong một hội thoại ----------
const GTABS = [["media", "Ảnh/Video"], ["file", "File"], ["link", "Link"], ["search", "Tìm tin"]];
async function renderGallery(r, q = "") {
  const tab = state.galleryTab || "media";
  const t = (state.threadsAcc === r.acc && state.threads.find((x) => x.threadId === r.tid && x.type === r.type)) || {};
  const back = chatHash(r.acc, r.type, r.tid);
  let items = [];
  if (tab !== "search") items = (await api("GET", `${tpath(r)}/gallery?kind=${tab}`)).items;
  else if (q.trim().length >= 2) items = (await api("GET", `search?acc=${r.acc}&type=${r.type}&tid=${encodeURIComponent(r.tid)}&q=${encodeURIComponent(q.trim())}`)).results;
  const date = (ts) => new Date(ts).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  let body;
  if (tab === "media") body = items.length ? `<div class="gallery">${items.map((m) => m.kind === "video"
      ? `<a class="gi vid" href="${chatHash(r.acc, r.type, r.tid, m.msgId)}">${m.thumb ? `<img src="${safeUrl(m.thumb)}" referrerpolicy="no-referrer" loading="lazy" alt="">` : ""}<span>▶</span></a>`
      : `<button class="gi" data-full="${mediaSrc(m, m.url || m.thumb)}" data-mid="${esc(m.msgId)}"><img src="${mediaSrc(m, m.thumb || m.url)}" referrerpolicy="no-referrer" loading="lazy" alt=""></button>`).join("")}</div>`
    : `<p class="center muted">Chưa có ảnh, video nào trong hội thoại này.</p>`;
  else if (tab === "file" || tab === "link") body = items.length ? `<ul class="list">${items.map((m) => `<li class="row">
      <span class="big-ico">${tab === "link" ? "🔗" : m.kind === "voice" ? "🎤" : "📎"}</span>
      <a class="grow" href="${tab === "link" ? safeUrl(m.url) : mediaSrc(m, m.url)}" target="_blank" rel="noopener noreferrer">
        <div class="name ell">${esc(m.title || (m.kind === "voice" ? "Tin nhắn thoại" : m.url) || "Tệp")}</div>
        <div class="sub">${esc(m.isSelf ? "Bạn" : m.fromName || "")} · ${date(m.ts)}${m.media ? " · đã lưu" : ""}</div></a>
      <a class="icon-btn" href="${chatHash(r.acc, r.type, r.tid, m.msgId)}" aria-label="Đi tới tin nhắn">💬</a></li>`).join("")}</ul>`
    : `<p class="center muted">Chưa có ${tab === "link" ? "link" : "file"} nào.</p>`;
  else body = `<ul class="list">${items.map((m) => `<li><a class="row" href="${chatHash(r.acc, r.type, r.tid, m.msgId)}">
      <div class="grow"><div class="sub">${esc(m.isSelf ? "Bạn" : m.fromName || "")} · ${date(m.ts)}</div><div>${esc(emoticons(hitText(m)))}</div></div></a></li>`).join("")}</ul>
    ${q.trim().length >= 2 && !items.length ? `<p class="center muted">Không tìm thấy “${esc(q)}”.</p>` : ""}
    ${q.trim().length < 2 ? `<p class="center muted small">Nhập ít nhất 2 ký tự. Tìm được cả khi gõ không dấu.</p>` : ""}`;
  $app.innerHTML = `
  ${header(esc(t.name || "Hội thoại"), { back })}
  <div class="tabs">${GTABS.map(([k, n]) => `<button data-g="${k}" class="${tab === k ? "on" : ""}">${n}</button>`).join("")}</div>
  ${tab === "search" ? `<div class="search"><input id="gq" type="search" placeholder="Tìm trong hội thoại này" value="${esc(q)}"></div>` : ""}
  <main class="scroll">${body}
    ${tab !== "search" && items.length >= 90 ? `<p class="center muted small">Đang hiện 90 mục gần nhất.</p>` : ""}</main>`;
  document.querySelectorAll("[data-g]").forEach((b) => b.onclick = () => { state.galleryTab = b.dataset.g; renderGallery(r); });
  const gq = document.getElementById("gq");
  if (gq) {
    if (q || tab === "search") { gq.focus(); gq.setSelectionRange(q.length, q.length); }
    gq.oninput = () => { clearTimeout(renderGallery.t); renderGallery.t = setTimeout(() => renderGallery(r, gq.value), 350); };
  }
  document.querySelector(".gallery")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-full]"); if (!b) return;
    const v = document.createElement("div"); v.className = "viewer";
    v.innerHTML = `<img src="${b.dataset.full}" referrerpolicy="no-referrer" alt=""><a class="btn viewer-go" href="${chatHash(r.acc, r.type, r.tid, b.dataset.mid)}">💬 Đi tới tin nhắn</a>`;
    v.onclick = () => v.remove();
    document.body.appendChild(v);
  });
}

// ---------- trang cá nhân / thông tin nhóm ----------
const GENDER = { 0: "Nam", 1: "Nữ" };
async function renderProfile(r) {
  const acc = state.accounts.find((a) => a.id === r.acc);
  if (!acc) return go("#/");
  const back = r.back || `#/a/${r.acc}`;
  $app.innerHTML = `${header("Đang tải…", { back })}<main class="scroll"><div class="center pad"><div class="spinner"></div></div></main>`;
  let p;
  try {
    p = r.own ? await api("GET", `accounts/${r.acc}/profile`) : await api("GET", `accounts/${r.acc}/users/${encodeURIComponent(r.uid)}`);
  } catch (e) {
    $app.querySelector("main").innerHTML = `<p class="center muted pad">${esc(e.message)}</p>`; return;
  }
  const rows = [
    ["Giới tính", GENDER[p.gender]], ["Ngày sinh", p.dob], ["Điện thoại", p.phone],
    ["Tên Zalo", p.zaloName !== p.name ? p.zaloName : ""],
    ["Hoạt động", p.lastActive ? timeLabel(p.lastActive) : ""],
  ].filter(([, v]) => v);
  $app.innerHTML = `
  ${header(r.own ? "Tài khoản của tôi" : "Trang cá nhân", { back })}
  <main class="scroll">
    <div class="profile">
      <div class="cover" ${p.cover ? `style="background-image:url('${safeUrl(p.cover)}')"` : ""}></div>
      ${avatar(p.avatar, p.name, "lg")}
      <h2>${esc(p.name)}</h2>
      ${p.status ? `<p class="bio">${esc(p.status)}</p>` : ""}
      ${!r.own ? `<div class="pad"><a class="btn primary" href="#/a/${r.acc}/0/${encodeURIComponent(p.uid)}">💬 Nhắn tin</a></div>` : ""}
    </div>
    <section class="card mx"><h3>Thông tin</h3>
      ${rows.length ? `<dl class="info">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : `<p class="muted small">Người này ẩn thông tin cá nhân.</p>`}
    </section>
    <p class="muted small pad">Nhật ký (tường) chưa xem được: Zalo không mở chức năng này cho Zalo Web.</p>
  </main>`;
}

async function renderGroupInfo(r) {
  const acc = state.accounts.find((a) => a.id === r.acc);
  if (!acc) return go("#/");
  const back = `#/a/${r.acc}/1/${encodeURIComponent(r.tid)}`;
  $app.innerHTML = `${header("Thông tin nhóm", { back })}<main class="scroll"><div class="center pad"><div class="spinner"></div></div></main>`;
  let g;
  try { g = await api("GET", `accounts/${r.acc}/groups/${encodeURIComponent(r.tid)}`); }
  catch (e) { $app.querySelector("main").innerHTML = `<p class="center muted pad">${esc(e.message)}</p>`; return; }
  const t = state.threads.find((x) => x.threadId === r.tid && x.type === 1) || {};
  $app.innerHTML = `
  ${header("Thông tin nhóm", { back })}
  <main class="scroll">
    <div class="profile">${avatar(g.avatar, g.name, "lg")}<h2>${esc(g.name)}</h2>
      ${g.desc ? `<p class="bio">${esc(g.desc)}</p>` : ""}
      <p class="muted small">${g.total || g.members.length} thành viên${g.created ? " · tạo " + new Date(g.created).toLocaleDateString("vi-VN") : ""}</p>
      <div class="pad"><button class="btn" id="gm">${t.muted ? "🔔 Bật thông báo" : "🔕 Tắt thông báo"}</button></div>
    </div>
    <section class="card mx"><h3>Thành viên${g.members.length < g.total ? ` (hiện ${g.members.length})` : ""}</h3>
      <ul class="list">${g.members.map((m) => `<li><a class="row" href="#/a/${r.acc}/u/${encodeURIComponent(m.uid)}">${avatar(m.avatar, m.name, "sm")}
        <div class="grow"><div class="name">${esc(m.name || m.uid)}</div>${m.role ? `<div class="sub small">${esc(m.role)}</div>` : ""}</div></a></li>`).join("")}</ul>
    </section>
  </main>`;
  document.getElementById("gm").onclick = async () => {
    await api("POST", `accounts/${r.acc}/threads/1/${encodeURIComponent(r.tid)}/mute`, { muted: !t.muted });
    state.threads = []; toast(t.muted ? "Đã bật thông báo" : "Đã tắt thông báo"); go(back);
  };
}

// Thu nhỏ ảnh (tối đa 2560px, JPEG) trước khi gửi để nhanh hơn
async function prepareImage(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("Không đọc được ảnh");
  const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
  const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(blob); });
  return { data: b64, filename: "photo.jpg", width: w, height: h };
}

// ---------- cài đặt ----------
async function renderSettings() {
  const pf = state.user.prefs || {};
  $app.innerHTML = `
  ${header("Cài đặt", { back: "#/" })}
  <main class="scroll pad">
    <p>Đăng nhập: <b>${esc(state.user.username)}</b>${state.user.is_admin ? " (quản trị)" : ""}</p>
    ${installHint()}
    <section class="card"><h3>Thông báo</h3>
      <p class="muted small" id="pushstate"></p>
      <button class="btn primary" id="pushon">Bật thông báo trên máy này</button>
      <button class="btn" id="pushtest">Gửi thử</button>
      <button class="btn" id="pushoff">Tắt trên máy này</button>
      <label class="toggle"><input type="checkbox" data-pref="push_preview" ${pf.push_preview !== false ? "checked" : ""}> Hiện tên người gửi & nội dung tin trong thông báo</label>
      <label class="toggle"><input type="checkbox" data-pref="app_badge" ${pf.app_badge !== false ? "checked" : ""}> Hiện số tin chưa đọc trên icon app</label>
      <p class="muted small">Tắt thông báo riêng từng tài khoản Zalo hoặc từng hội thoại: bấm nút ⋯ ở góc trên của tài khoản / hội thoại đó.</p>
    </section>
    <section class="card"><h3>Tin mẫu (trả lời nhanh)</h3>
      <p class="muted small">Câu hay gửi (báo giá, số tài khoản, địa chỉ…). Khi chat, gõ <b>/</b> + tên tắt hoặc bấm 😊 → <b>Tin mẫu</b>.</p>
      <ul class="list quick-admin" id="qlist"></ul>
      <form id="qform"><input type="hidden" name="id">
        <input name="shortcut" placeholder="Tên tắt, vd: baogia" maxlength="30" required>
        <textarea name="text" rows="3" placeholder="Nội dung tin" maxlength="5000" required></textarea>
        <button class="btn primary" id="qsave">Thêm tin mẫu</button> <button type="button" class="btn" id="qnew" hidden>Huỷ sửa</button></form>
    </section>
    ${state.user.is_admin ? `<a class="btn block" href="#/admin">🛠 Trang quản trị (người dùng, mã mời, tính năng)</a>` : ""}
    <section class="card"><h3>Đổi mật khẩu</h3>
      <form id="pw"><input name="current" type="password" placeholder="Mật khẩu hiện tại" autocomplete="current-password" required>
      <input name="password" type="password" placeholder="Mật khẩu mới (≥ 8 ký tự)" autocomplete="new-password" required minlength="8">
      <button class="btn">Đổi</button></form>
    </section>
    <button class="btn danger block" id="logout">🚪 Đăng xuất khỏi app</button>
    <p class="muted small center">Mã nguồn: <a href="https://github.com/hoang-server/zalo-multi" target="_blank" rel="noopener">github.com/hoang-server/zalo-multi</a></p>
  </main>`;
  bindInstall();
  updatePushState();
  document.getElementById("pushon").onclick = () => enablePush().then(updatePushState);
  document.getElementById("pushtest").onclick = () => api("POST", "push/test").then(() => toast("Đã gửi, chờ vài giây…"));
  document.getElementById("pushoff").onclick = () => disablePush().then(updatePushState);
  document.querySelectorAll("[data-pref]").forEach((el) => el.onchange = async () => {
    try {
      state.user.prefs = (await api("POST", "prefs", { [el.dataset.pref]: el.checked })).prefs;
      if (el.dataset.pref === "app_badge") setBadge(state.badge || 0);
      toast("Đã lưu");
    } catch (e) { toast(e.message); el.checked = !el.checked; }
  });
  document.getElementById("pw").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("POST", "password", Object.fromEntries(new FormData(e.target))); toast("Đã đổi mật khẩu"); e.target.reset(); } catch (err) { toast(err.message); }
  };
  document.getElementById("logout").onclick = logout;
  const qf = document.getElementById("qform"), qid = qf.querySelector("[name=id]");
  const resetQ = () => { qf.reset(); qid.value = ""; document.getElementById("qsave").textContent = "Thêm tin mẫu"; document.getElementById("qnew").hidden = true; };
  const drawQ = (items) => {
    state.quick = items;
    document.getElementById("qlist").innerHTML = items.map((x) => `<li class="row"><div class="grow"><b>/${esc(x.shortcut)}</b><div class="sub pre">${esc(x.text)}</div></div>
      <button class="icon-btn" data-qe="${x.id}" aria-label="Sửa">✎</button><button class="icon-btn" data-qd="${x.id}" aria-label="Xoá">🗑</button></li>`).join("")
      || `<li class="muted small">Chưa có tin mẫu nào.</li>`;
  };
  loadQuick(true).then(drawQ);
  document.getElementById("qlist").onclick = async (e) => {
    const ed = e.target.closest("[data-qe]"), del = e.target.closest("[data-qd]");
    if (ed) {
      const x = state.quick.find((q) => q.id === Number(ed.dataset.qe));
      qid.value = x.id; qf.shortcut.value = x.shortcut; qf.text.value = x.text;
      document.getElementById("qsave").textContent = "Lưu thay đổi"; document.getElementById("qnew").hidden = false; qf.text.focus();
    }
    if (del && confirm("Xoá tin mẫu này?")) drawQ((await api("DELETE", `quick-replies/${del.dataset.qd}`)).items);
  };
  document.getElementById("qnew").onclick = resetQ;
  qf.onsubmit = async (e) => {
    e.preventDefault();
    try { drawQ((await api("POST", "quick-replies", Object.fromEntries(new FormData(qf)))).items); resetQ(); toast("Đã lưu tin mẫu"); }
    catch (err) { toast(err.message); }
  };
}

// Đăng xuất khỏi app (các tài khoản Zalo vẫn chạy trên server, đăng nhập lại là thấy)
async function logout() {
  if (!confirm("Đăng xuất khỏi app trên máy này? Máy này sẽ không nhận thông báo nữa cho tới khi đăng nhập lại.")) return;
  await disablePush().catch(() => {});
  await api("POST", "logout").catch(() => {});
  Object.assign(state, { user: null, accounts: [], threads: [], messages: [], opened: false });
  setBadge(0);
  go("#/login");
}

// ---------- quản trị ----------
const fmtBytes = (n) => (n > 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB");
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const SETTING_INFO = {
  open_signup: ["Cho đăng ký tự do", "Bật: ai có link cũng tự tạo tài khoản được, không cần mã mời.", "bool"],
  media_store: ["Lưu ảnh/file về server", "Tải ảnh, file, video, tin thoại nhận được về server để xem lại khi link Zalo hết hạn.", "bool"],
  media_max_mb: ["Giới hạn dung lượng mỗi file (MB)", "File lớn hơn sẽ không lưu, vẫn mở bằng link Zalo. 0 = không giới hạn.", "num"],
  group_history: ["Số tin lịch sử nhóm", "Số tin cũ lấy từ Zalo khi mở một nhóm lần đầu (tối đa 500).", "num"],
};
async function renderAdmin() {
  if (!state.user.is_admin) return go("#/settings");
  const { stats: st, users, settings, invites } = await api("GET", "admin/overview");
  $app.innerHTML = `
  ${header("Quản trị", { back: "#/settings" })}
  <main class="scroll pad">
    <section class="card"><h3>Tổng quan</h3>
      <div class="stats">
        <div><b>${st.users}</b><span>người dùng</span></div>
        <div><b>${st.zaloOnline}/${st.zaloAccounts}</b><span>Zalo đang kết nối</span></div>
        <div><b>${st.messages.toLocaleString("vi-VN")}</b><span>tin nhắn</span></div>
        <div><b>${st.devices}</b><span>máy nhận thông báo</span></div>
        <div><b>${fmtBytes(st.dbBytes)}</b><span>dữ liệu</span></div>
        <div><b>${fmtBytes(st.media.bytes)}</b><span>${st.media.files} file đã lưu</span></div>
      </div>
      <p class="muted small">Phiên bản ${esc(st.version)} · Node ${esc(st.node)} · chạy từ ${fmtDate(st.startedAt)}</p>
    </section>

    <section class="card"><h3>Người dùng</h3>
      <ul class="list admin-users">${users.map((u) => `
        <li class="row">
          <div class="grow"><div class="name">${esc(u.username)} ${u.isAdmin ? `<span class="tag">quản trị</span>` : ""} ${u.disabled ? `<span class="tag red">đã khoá</span>` : ""}</div>
            <div class="sub small">${u.accounts} Zalo (${u.online} online) · ${u.devices} máy · vào lần cuối ${fmtDate(u.lastSeen)}</div></div>
          ${u.id === state.user.id ? `<span class="muted small">bạn</span>` : `<button class="icon-btn" data-u="${u.id}" aria-label="Tuỳ chọn">⋯</button>`}
        </li>`).join("")}</ul>
    </section>

    <section class="card"><h3>Mã mời</h3>
      <button class="btn" id="inv">＋ Tạo mã mời</button>
      <ul class="plain">${invites.map((i) => `<li><code>${esc(i.code)}</code> ${i.used_by ? `– đã dùng bởi ${esc(i.used_by)}` : `– chưa dùng <button class="link" data-delinv="${esc(i.code)}">xoá</button>`}</li>`).join("")}</ul>
    </section>

    <section class="card"><h3>Tính năng</h3>
      <form id="setf">${Object.entries(settings).map(([k, v]) => {
        const [label, help, kind] = SETTING_INFO[k] || [k, "", typeof v === "boolean" ? "bool" : "num"];
        return kind === "bool"
          ? `<label class="toggle"><input type="checkbox" name="${k}" ${v ? "checked" : ""}> <span><b>${esc(label)}</b><br><span class="muted small">${esc(help)}</span></span></label>`
          : `<label>${esc(label)}<input type="number" min="0" name="${k}" value="${esc(v)}"><span class="muted small">${esc(help)}</span></label>`;
      }).join("")}
      <button class="btn primary">Lưu cài đặt</button></form>
    </section>
  </main>`;
  document.getElementById("inv").onclick = async () => {
    const { code } = await api("POST", "invites");
    try { await navigator.clipboard.writeText(code); toast("Đã tạo & copy mã: " + code); } catch { toast("Mã mời: " + code, 8000); }
    renderAdmin();
  };
  document.querySelectorAll("[data-delinv]").forEach((b) => b.onclick = () => api("DELETE", `admin/invites/${encodeURIComponent(b.dataset.delinv)}`).then(renderAdmin));
  document.getElementById("setf").onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const el of e.target.elements) if (el.name) body[el.name] = el.type === "checkbox" ? el.checked : Number(el.value);
    try { await api("POST", "admin/settings", body); toast("Đã lưu cài đặt"); renderAdmin(); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll("[data-u]").forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.id === Number(b.dataset.u));
    const act = (body, msg) => api("POST", `admin/users/${u.id}`, body).then(() => { toast(msg); renderAdmin(); }).catch((e) => toast(e.message));
    sheet([
      [u.isAdmin ? "Bỏ quyền quản trị" : "Cấp quyền quản trị", () => act({ isAdmin: !u.isAdmin }, "Đã cập nhật quyền")],
      [u.disabled ? "Mở khoá tài khoản" : "Khoá tài khoản (ngắt Zalo, đăng xuất)", () => act({ disabled: !u.disabled }, u.disabled ? "Đã mở khoá" : "Đã khoá")],
      ["Đặt lại mật khẩu", async () => {
        if (!confirm(`Đặt lại mật khẩu cho ${u.username}?`)) return;
        try { const { password } = await api("POST", `admin/users/${u.id}/reset-password`); prompt(`Mật khẩu mới của ${u.username} (gửi cho họ, họ nên đổi lại):`, password); }
        catch (e) { toast(e.message); }
      }],
      ["Xoá người dùng", async () => {
        if (!confirm(`Xoá ${u.username}? Toàn bộ tài khoản Zalo, tin nhắn và file đã lưu của người này trong app sẽ bị xoá.`)) return;
        api("DELETE", `admin/users/${u.id}`).then(() => { toast("Đã xoá"); renderAdmin(); }).catch((e) => toast(e.message));
      }, "danger"],
    ]);
  });
}

// ---------- push ----------
function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function pushBanner() {
  if (!pushSupported() || Notification.permission !== "default" || (isIOS && !isStandalone)) return "";
  return `<div class="hint">🔔 <button class="link" id="pushbanner">Bật thông báo tin nhắn mới</button></div>`;
}
function bindPush() { document.getElementById("pushbanner")?.addEventListener("click", () => enablePush().then(render)); }
async function updatePushState() {
  const el = document.getElementById("pushstate"); if (!el) return;
  if (!pushSupported()) { el.textContent = isIOS && !isStandalone ? "Trên iPhone, cần thêm app ra màn hình chính rồi mở từ đó mới bật được thông báo (iOS 16.4 trở lên)." : "Trình duyệt này không hỗ trợ thông báo."; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  el.textContent = Notification.permission === "denied" ? "Bạn đã chặn thông báo. Hãy bật lại trong cài đặt trình duyệt/điện thoại."
    : sub ? "Đang bật trên máy này ✅" : "Chưa bật trên máy này.";
}
const b64ToU8 = (b64) => { const s = atob((b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function enablePush() {
  if (!pushSupported()) return toast("Máy này chưa hỗ trợ thông báo" + (isIOS ? " – hãy thêm app ra màn hình chính trước" : ""));
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("Chưa được cấp quyền thông báo");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(state.vapidKey) });
  await api("POST", "push/subscribe", sub.toJSON());
  toast("Đã bật thông báo");
}
async function disablePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api("POST", "push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}

// ---------- cài PWA (Android/Chrome) ----------
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); state.installEvt = e; });
function bindInstall() {
  document.getElementById("install")?.addEventListener("click", async () => { state.installEvt.prompt(); await state.installEvt.userChoice; state.installEvt = null; render(); });
}

// ---------- realtime ----------
let es;
function startEvents() {
  es?.close();
  es = new EventSource("api/events");
  es.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const r = state.route;
    if (r?.name === "chat" && r.acc === m.accountId && r.tid === m.threadId && r.type === m.type) {
      if (state.messages.some((x) => x.msgId === m.msgId)) return;
      if (state.messages.length && m.ts < state.messages[state.messages.length - 1].ts) {
        // tin cũ vừa đồng bộ về: vẽ lại để đúng thứ tự
        clearTimeout(startEvents.c); startEvents.c = setTimeout(() => state.route?.name === "chat" && renderChat(state.route), 800);
        return;
      }
      if (state.gap) return; // đang xem tin cũ (từ kết quả tìm): đã có nút "Xem tin mới nhất"
      state.messages.push(m);
      const box = document.getElementById("msgs");
      const atBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      document.getElementById("mlist")?.insertAdjacentHTML("beforeend", bubble(m, m.type));
      if (atBottom || m.isSelf) scrollBottom();
      api("GET", `accounts/${m.accountId}/threads/${m.type}/${encodeURIComponent(m.threadId)}/messages?before=1`).catch(() => {}); // đánh dấu đã đọc
    } else if (r?.name === "threads" || r?.name === "home" || r?.name === "inbox") {
      clearTimeout(startEvents.t); startEvents.t = setTimeout(render, 300);
    } else if (r?.name === "chat") {
      const a = state.accounts.find((x) => x.id === m.accountId); if (a && !m.isSelf) a.unread++;
    }
    if (!m.isSelf && !(r?.name === "chat" && r.acc === m.accountId && r.tid === m.threadId)) setBadge((state.badge || 0) + 1);
  });
  es.addEventListener("account", (e) => {
    const d = JSON.parse(e.data);
    const a = state.accounts.find((x) => x.id === d.id);
    if (a) { a.status = d.status; a.statusMsg = d.statusMsg; }
    if (state.route?.name !== "chat") { clearTimeout(startEvents.t); startEvents.t = setTimeout(render, 300); }
    else { const t = document.getElementById("txt"); if (t) t.disabled = d.status !== "online"; }
  });
  const inChat = (d) => state.route?.name === "chat" && state.route.acc === d.accountId && state.route.tid === d.threadId && state.route.type === d.type;
  es.addEventListener("reaction", (e) => { const d = JSON.parse(e.data); if (inChat(d)) updateMsg(d.msgId, { reactions: d.reactions }); });
  es.addEventListener("recall", (e) => { const d = JSON.parse(e.data); if (inChat(d)) updateMsg(d.msgId, { recalled: 1 }); });
  es.addEventListener("typing", (e) => {
    const d = JSON.parse(e.data); if (!inChat(d)) return;
    const sub = document.getElementById("csub"); if (!sub) return;
    const acc = state.accounts.find((a) => a.id === d.accountId);
    sub.textContent = "đang soạn tin…"; sub.classList.add("typing");
    clearTimeout(startEvents.ty); startEvents.ty = setTimeout(() => { sub.textContent = acc?.name || ""; sub.classList.remove("typing"); }, 6000);
  });
  es.addEventListener("qr", (e) => { const d = JSON.parse(e.data); if (state.qr?.key === d.key) state.qr.on(d); });
}
// Quay lại app sau khi ở nền: tải lại dữ liệu (iOS hay ngắt kết nối nền)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user) { if (!es || es.readyState === 2) startEvents(); if (state.route?.name !== "login") render(); }
});

// ---------- khởi động ----------
(async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
  try {
    const me = await api("GET", "me");
    Object.assign(state, { user: me.user, needsInvite: me.needsInvite, firstUser: me.firstUser, vapidKey: me.vapidPublicKey });
    if (!me.user && me.firstUser) state.loginMode = "register";
    if (state.user) startEvents();
  } catch (e) { toast(e.message); }
  render();
})();
