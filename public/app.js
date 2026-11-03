// Zalo Multi – giao diện web (không cần build)
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
const statusText = { online: "Đang hoạt động", connecting: "Đang kết nối…", reconnecting: "Đang kết nối lại…", offline: "Ngoại tuyến", kicked: "Bị ngắt (mở Zalo Web nơi khác)", expired: "Phiên hết hạn – cần quét lại QR" };

// ---------- định tuyến ----------
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (h[0] === "login") return { name: "login" };
  if (h[0] === "settings") return { name: "settings" };
  if (h[0] === "a" && h[1] && h[3]) return { name: "chat", acc: Number(h[1]), type: Number(h[2]), tid: decodeURIComponent(h[3]) };
  if (h[0] === "a" && h[1]) return { name: "threads", acc: Number(h[1]) };
  return { name: "home" };
}
addEventListener("hashchange", render);
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "open") go(e.data.hash); });

async function render() {
  const r = parseRoute();
  state.route = r;
  if (!state.user && r.name !== "login") return go("#/login");
  if (state.user && r.name === "login") return go("#/");
  try {
    if (r.name === "login") return renderLogin();
    if (r.name === "settings") return renderSettings();
    await loadAccounts();
    if (r.name === "home") {
      if (state.accounts.length === 1 && !sessionStorage.getItem("stayHome")) return go(`#/a/${state.accounts[0].id}`);
      return renderHome();
    }
    if (r.name === "threads") return renderThreads(r.acc);
    if (r.name === "chat") return renderChat(r);
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
      state.user = user; state.firstUser = false; startEvents(); go("#/");
    } catch (err) { document.getElementById("err").textContent = err.message; }
  };
}

// ---------- tài khoản Zalo ----------
async function loadAccounts() { state.accounts = (await api("GET", "accounts")).accounts; }

function header(title, { back, right = "" } = {}) {
  return `<header class="bar">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Quay lại">‹</a>` : `<span class="icon-btn"></span>`}
    <div class="title">${title}</div>${right || `<span class="icon-btn"></span>`}</header>`;
}

function installHint() {
  if (isStandalone) return "";
  if (isIOS) return `<div class="hint">📲 Để nhận thông báo trên iPhone: bấm nút <b>Chia sẻ</b> <span class="ios-share">⬆︎</span> → <b>Thêm vào MH chính</b>, rồi mở app từ màn hình chính.</div>`;
  if (state.installEvt) return `<div class="hint">📲 <button class="link" id="install">Cài app ra màn hình chính</button> để dùng như ứng dụng thật.</div>`;
  return "";
}

function renderHome() {
  sessionStorage.removeItem("stayHome");
  $app.innerHTML = `
  ${header("Tài khoản Zalo", { right: `<a class="icon-btn" href="#/settings" aria-label="Cài đặt">⚙︎</a>` })}
  <main class="scroll">
    ${installHint()}
    ${pushBanner()}
    <ul class="list">
      ${state.accounts.map((a) => `
        <li><a class="row" href="#/a/${a.id}">
          ${avatar(a.avatar, a.name)}
          <div class="grow"><div class="name">${esc(a.name)}</div>
            <div class="sub st-${a.status}">${esc(statusText[a.status] || a.status)}</div></div>
          ${a.unread ? `<span class="badge">${a.unread > 99 ? "99+" : a.unread}</span>` : ""}
        </a></li>`).join("")}
    </ul>
    ${state.accounts.length ? "" : `<p class="center muted">Chưa có tài khoản Zalo nào.<br>Bấm nút bên dưới và quét mã QR bằng app Zalo trên điện thoại khác hoặc máy này.</p>`}
    <div class="pad"><button class="btn primary block" id="add">＋ Thêm tài khoản Zalo</button></div>
    <p class="muted small pad">Lưu ý: Zalo chỉ cho một phiên Zalo Web cùng lúc cho mỗi tài khoản. Nếu mở chat.zalo.me ở nơi khác, tài khoản sẽ bị ngắt ở đây.</p>
  </main>`;
  document.getElementById("add").onclick = startQr;
  bindInstall(); bindPush();
}

function accountSwitcher(activeId) {
  if (state.accounts.length < 2) return "";
  return `<nav class="switcher">${state.accounts.map((a) => `
    <a href="#/a/${a.id}" class="sw ${a.id === activeId ? "on" : ""}" title="${esc(a.name)}">
      ${avatar(a.avatar, a.name, "sm")}${a.unread && a.id !== activeId ? `<span class="dot"></span>` : ""}
    </a>`).join("")}</nav>`;
}

async function renderThreads(accId, q = state.q || "") {
  const acc = state.accounts.find((a) => a.id === accId);
  if (!acc) return go("#/");
  state.threads = (await api("GET", `accounts/${accId}/threads?q=${encodeURIComponent(q)}`)).threads;
  const keepFocus = document.activeElement?.id === "q";
  $app.innerHTML = `
  ${header(esc(acc.name), { back: "#/", right: `<button class="icon-btn" id="menu" aria-label="Tuỳ chọn">⋯</button>` })}
  ${accountSwitcher(accId)}
  ${acc.status !== "online" ? `<div class="warn">${esc(acc.statusMsg || statusText[acc.status])}
     ${["kicked", "offline", "reconnecting"].includes(acc.status) ? `<button class="btn sm" id="rc">Kết nối lại</button>` : ""}
     ${acc.status === "expired" ? `<button class="btn sm" id="reqr">Quét QR</button>` : ""}</div>` : ""}
  <div class="search"><input id="q" type="search" placeholder="Tìm hội thoại" value="${esc(q)}"></div>
  <main class="scroll">
    <ul class="list">${state.threads.map((t) => `
      <li><a class="row" href="#/a/${accId}/${t.type}/${encodeURIComponent(t.threadId)}">
        ${avatar(t.avatar, t.name)}
        <div class="grow"><div class="name">${t.type === 1 ? "👥 " : ""}${esc(t.name)}</div>
          <div class="sub ${t.unread ? "bold" : ""}">${esc(t.lastText || "")}</div></div>
        <div class="meta"><div class="time">${t.lastTs ? timeLabel(t.lastTs) : ""}</div>
          ${t.unread ? `<span class="badge">${t.unread > 99 ? "99+" : t.unread}</span>` : ""}</div>
      </a></li>`).join("")}</ul>
    ${state.threads.length ? "" : `<p class="center muted">Chưa có tin nhắn. Tin mới sẽ hiện ở đây.<br><button class="link" id="sync2">Tải danh bạ & nhóm</button></p>`}
  </main>`;
  const qEl = document.getElementById("q");
  if (keepFocus) { qEl.focus(); qEl.setSelectionRange(q.length, q.length); }
  qEl.oninput = () => { clearTimeout(renderThreads.t); renderThreads.t = setTimeout(() => { state.q = qEl.value; renderThreads(accId, qEl.value); }, 250); };
  const sync = async () => { toast("Đang tải danh bạ…"); try { const r = await api("POST", `accounts/${accId}/sync`); toast(`Đã tải ${r.friends} bạn, ${r.groups} nhóm`); renderThreads(accId); } catch (e) { toast(e.message); } };
  document.getElementById("sync2")?.addEventListener("click", sync);
  document.getElementById("rc")?.addEventListener("click", () => api("POST", `accounts/${accId}/reconnect`).then(() => toast("Đang kết nối lại…")));
  document.getElementById("reqr")?.addEventListener("click", startQr);
  document.getElementById("menu").onclick = () => sheet([
    ["Tải danh bạ & nhóm", sync],
    ["Kết nối lại", () => api("POST", `accounts/${accId}/reconnect`).then(() => toast("Đang kết nối lại…"))],
    ["Quét lại mã QR", startQr],
    ["Xoá tài khoản khỏi app", async () => {
      if (!confirm(`Xoá ${acc.name} khỏi app? Tin nhắn đã lưu trong app cũng bị xoá (không ảnh hưởng Zalo).`)) return;
      await api("DELETE", `accounts/${accId}`); go("#/");
    }, "danger"],
  ]);
}

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
      if (d.event === "success") { key = null; el.remove(); state.qr = null; toast(`Đã thêm ${d.account.name}`); sessionStorage.setItem("stayHome", "1"); go(`#/a/${d.account.id}`); }
      if (["declined", "expired", "error"].includes(d.event)) { key = null; box.innerHTML = "⚠️"; msg.textContent = d.message; }
    },
  };
}

// ---------- khung chat ----------
async function renderChat(r) {
  const acc = state.accounts.find((a) => a.id === r.acc);
  if (!acc) return go("#/");
  const [{ messages }, { threads }] = await Promise.all([
    api("GET", `accounts/${r.acc}/threads/${r.type}/${encodeURIComponent(r.tid)}/messages`),
    state.threads.length && state.threadsAcc === r.acc ? { threads: state.threads } : api("GET", `accounts/${r.acc}/threads`),
  ]);
  state.threads = threads; state.threadsAcc = r.acc;
  state.messages = messages;
  const t = threads.find((x) => x.threadId === r.tid && x.type === r.type) || { name: r.tid };
  $app.innerHTML = `
  ${header(`<div class="chat-title">${avatar(t.avatar, t.name, "sm")}<div><div>${esc(t.name)}</div><div class="sub small">${esc(acc.name)}</div></div></div>`, { back: `#/a/${r.acc}` })}
  <main class="scroll chat" id="msgs">
    ${messages.length >= 60 ? `<div class="center"><button class="link" id="older">Xem tin cũ hơn</button></div>` : ""}
    <div id="mlist">${messages.map((m) => bubble(m, r.type)).join("")}</div>
  </main>
  <form class="composer" id="cf">
    <label class="icon-btn attach" aria-label="Gửi ảnh">📷<input type="file" accept="image/*" id="pic" hidden multiple></label>
    <textarea id="txt" rows="1" placeholder="Nhập tin nhắn" ${acc.status !== "online" ? "disabled" : ""}></textarea>
    <button class="icon-btn send" type="submit" aria-label="Gửi">➤</button>
  </form>`;
  scrollBottom();
  const txt = document.getElementById("txt");
  txt.oninput = () => { txt.style.height = "auto"; txt.style.height = Math.min(txt.scrollHeight, 140) + "px"; };
  txt.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !isIOS && !/Android/.test(navigator.userAgent)) { e.preventDefault(); document.getElementById("cf").requestSubmit(); } };
  document.getElementById("cf").onsubmit = async (e) => {
    e.preventDefault();
    const text = txt.value.trim();
    if (!text) return;
    txt.value = ""; txt.oninput();
    try { await api("POST", `accounts/${r.acc}/threads/${r.type}/${encodeURIComponent(r.tid)}/text`, { text }); }
    catch (err) { toast(err.message); txt.value = text; }
  };
  document.getElementById("pic").onchange = async (e) => {
    for (const f of e.target.files) {
      try {
        toast("Đang gửi ảnh…", 10000);
        const img = await prepareImage(f);
        await api("POST", `accounts/${r.acc}/threads/${r.type}/${encodeURIComponent(r.tid)}/image`, img);
        toast("Đã gửi ảnh");
      } catch (err) { toast(err.message); }
    }
    e.target.value = "";
  };
  document.getElementById("older")?.addEventListener("click", async () => {
    const before = state.messages[0]?.ts;
    const { messages: older } = await api("GET", `accounts/${r.acc}/threads/${r.type}/${encodeURIComponent(r.tid)}/messages?before=${before}`);
    state.messages = older.concat(state.messages);
    const box = document.getElementById("msgs"), h = box.scrollHeight;
    document.getElementById("mlist").insertAdjacentHTML("afterbegin", older.map((m) => bubble(m, r.type)).join(""));
    box.scrollTop = box.scrollHeight - h;
    if (older.length < 60) document.getElementById("older").remove();
  });
  // ảnh: bấm để xem lớn
  document.getElementById("msgs").onclick = (e) => {
    const im = e.target.closest("img.photo");
    if (im) { const v = document.createElement("div"); v.className = "viewer"; v.innerHTML = `<img src="${esc(im.dataset.full)}" referrerpolicy="no-referrer" alt="">`; v.onclick = () => v.remove(); document.body.appendChild(v); }
  };
}

function bubble(m, type) {
  let body;
  switch (m.kind) {
    case "image": body = `<img class="photo" src="${safeUrl(m.thumb || m.url)}" data-full="${safeUrl(m.url || m.thumb)}" referrerpolicy="no-referrer" loading="lazy" alt="Ảnh">${m.text ? `<div>${esc(m.text)}</div>` : ""}`; break;
    case "file": body = `<a class="file" href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(m.title || "Tệp")}<span class="small muted"> ${esc(m.text || "")}</span></a>`; break;
    case "video": body = `<a class="file" href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">🎬 Video</a>`; break;
    case "voice": body = m.url ? `<audio controls preload="none" src="${safeUrl(m.url)}"></audio>` : "[Tin nhắn thoại]"; break;
    case "link": body = `<a class="file" href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(m.title || m.url)}</a>${m.text ? `<div class="small">${esc(m.text)}</div>` : ""}`; break;
    default: body = linkify(esc(m.text || ""));
  }
  return `<div class="msg ${m.isSelf ? "me" : ""}">
    ${type === 1 && !m.isSelf ? `<div class="from">${esc(m.fromName || "")}</div>` : ""}
    <div class="bubble">${body}<span class="ts">${new Date(m.ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</span></div></div>`;
}
const linkify = (s) => s.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`).replace(/\n/g, "<br>");
function scrollBottom() { const b = document.getElementById("msgs"); if (b) b.scrollTop = b.scrollHeight; }

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
  const { invites } = state.user.is_admin ? await api("GET", "invites") : { invites: [] };
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
    </section>
    ${state.user.is_admin ? `<section class="card"><h3>Mã mời người dùng mới</h3>
      <button class="btn" id="inv">Tạo mã mời</button>
      <ul class="plain">${invites.map((i) => `<li><code>${esc(i.code)}</code> ${i.used_by ? `– đã dùng bởi ${esc(i.used_by)}` : "– chưa dùng"}</li>`).join("")}</ul>
    </section>` : ""}
    <section class="card"><h3>Đổi mật khẩu</h3>
      <form id="pw"><input name="current" type="password" placeholder="Mật khẩu hiện tại" autocomplete="current-password" required>
      <input name="password" type="password" placeholder="Mật khẩu mới (≥ 8 ký tự)" autocomplete="new-password" required minlength="8">
      <button class="btn">Đổi</button></form>
    </section>
    <button class="btn danger block" id="logout">Đăng xuất</button>
    <p class="muted small center">Mã nguồn: <a href="https://github.com/hoang-server/zalo-multi" target="_blank" rel="noopener">github.com/hoang-server/zalo-multi</a></p>
  </main>`;
  bindInstall();
  updatePushState();
  document.getElementById("pushon").onclick = () => enablePush().then(updatePushState);
  document.getElementById("pushtest").onclick = () => api("POST", "push/test").then(() => toast("Đã gửi, chờ vài giây…"));
  document.getElementById("pushoff").onclick = () => disablePush().then(updatePushState);
  document.getElementById("inv")?.addEventListener("click", async () => {
    const { code } = await api("POST", "invites");
    try { await navigator.clipboard.writeText(code); toast("Đã tạo & copy mã: " + code); } catch { toast("Mã mời: " + code, 8000); }
    renderSettings();
  });
  document.getElementById("pw").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("POST", "password", Object.fromEntries(new FormData(e.target))); toast("Đã đổi mật khẩu"); e.target.reset(); } catch (err) { toast(err.message); }
  };
  document.getElementById("logout").onclick = async () => { await disablePush().catch(() => {}); await api("POST", "logout"); state.user = null; go("#/login"); };
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
      state.messages.push(m);
      const box = document.getElementById("msgs");
      const atBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      document.getElementById("mlist")?.insertAdjacentHTML("beforeend", bubble(m, m.type));
      if (atBottom || m.isSelf) scrollBottom();
      api("GET", `accounts/${m.accountId}/threads/${m.type}/${encodeURIComponent(m.threadId)}/messages?before=1`).catch(() => {}); // đánh dấu đã đọc
    } else if (r?.name === "threads" || r?.name === "home") {
      clearTimeout(startEvents.t); startEvents.t = setTimeout(render, 300);
    } else if (r?.name === "chat") {
      const a = state.accounts.find((x) => x.id === m.accountId); if (a && !m.isSelf) a.unread++;
    }
  });
  es.addEventListener("account", (e) => {
    const d = JSON.parse(e.data);
    const a = state.accounts.find((x) => x.id === d.id);
    if (a) { a.status = d.status; a.statusMsg = d.statusMsg; }
    if (state.route?.name !== "chat") { clearTimeout(startEvents.t); startEvents.t = setTimeout(render, 300); }
    else { const t = document.getElementById("txt"); if (t) t.disabled = d.status !== "online"; }
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
