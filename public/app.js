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
      if (state.accounts.length === 1 && !sessionStorage.getItem("stayHome")) return go(`#/a/${state.accounts[0].id}`);
      return renderHome();
    }
    if (r.name === "threads") return renderThreads(r.acc);
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
  sessionStorage.removeItem("stayHome");
  $app.innerHTML = `
  ${header("Tài khoản Zalo", { right: `<a class="icon-btn" href="#/settings" aria-label="Cài đặt">⚙︎</a>` })}
  <main class="scroll">
    ${installHint()}
    ${pushBanner()}
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
    <p class="muted small pad">Lưu ý: Zalo chỉ cho một phiên Zalo Web cùng lúc cho mỗi tài khoản. Nếu mở chat.zalo.me ở nơi khác, tài khoản sẽ bị ngắt ở đây.</p>
  </main>`;
  document.getElementById("add").onclick = startQr;
  bindInstall(); bindPush();
}

function accountSwitcher(activeId) {
  if (state.accounts.length < 2) return "";
  return `<nav class="switcher">${state.accounts.map((a) => `
    <a href="#/a/${a.id}" class="sw ${a.id === activeId ? "on" : ""}" title="${esc(a.name)}">
      ${avBadge(a.avatar, a.name, a.id !== activeId ? a.unread : 0, "sm", !a.notify)}
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
        ${avBadge(t.avatar, t.name, t.unread, "", t.muted)}
        <div class="grow"><div class="name">${t.type === 1 ? "👥 " : ""}${esc(t.name)}${t.muted ? " 🔕" : ""}</div>
          <div class="sub ${t.unread ? "bold" : ""}">${esc(emoticons(t.lastText || ""))}</div></div>
        <div class="meta"><div class="time">${t.lastTs ? timeLabel(t.lastTs) : ""}</div>
          </div>
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
    api("GET", `${tpath(r)}/messages`),
    state.threads.length && state.threadsAcc === r.acc ? { threads: state.threads } : api("GET", `accounts/${r.acc}/threads`),
  ]);
  state.threads = threads; state.threadsAcc = r.acc;
  state.messages = messages;
  state.reply = null;
  const t = threads.find((x) => x.threadId === r.tid && x.type === r.type) || { name: r.tid };
  const online = acc.status === "online";
  $app.innerHTML = `
  ${header(`<a class="chat-title" href="#/a/${r.acc}/${r.type}/${encodeURIComponent(r.tid)}/info">${avatar(t.avatar, t.name, "sm")}<div><div>${esc(t.name)}${t.muted ? " 🔕" : ""}</div><div class="sub small" id="csub">${esc(acc.name)}</div></div></a>`,
    { back: `#/a/${r.acc}`, right: `<button class="icon-btn" id="cmenu" aria-label="Tuỳ chọn">⋯</button>` })}
  <main class="scroll chat" id="msgs">
    ${messages.length >= 60 ? `<div class="center"><button class="link" id="older">Xem tin cũ hơn</button></div>` : ""}
    <div id="mlist">${messages.map((m) => bubble(m, r.type)).join("")}</div>
  </main>
  <div id="replybar" class="replybar" hidden></div>
  <div id="panel" class="panel" hidden></div>
  <form class="composer" id="cf">
    <button type="button" class="icon-btn" id="emo" aria-label="Sticker và biểu tượng" ${online ? "" : "disabled"}>😊</button>
    <label class="icon-btn attach" aria-label="Gửi ảnh">🖼<input type="file" accept="image/*" id="pic" hidden multiple ${online ? "" : "disabled"}></label>
    <label class="icon-btn attach" aria-label="Gửi file">📎<input type="file" id="fil" hidden ${online ? "" : "disabled"}></label>
    <textarea id="txt" rows="1" placeholder="Nhập tin nhắn" ${online ? "" : "disabled"}></textarea>
    <button class="icon-btn send" type="submit" aria-label="Gửi">➤</button>
  </form>`;
  scrollBottom();
  loadAccounts().catch(() => {}); // cập nhật số trên icon app sau khi đọc
  navigator.serviceWorker?.ready.then((reg) => reg.getNotifications({ tag: `${r.acc}-${r.type}-${r.tid}` }))
    .then((ns) => ns?.forEach((n) => n.close())).catch(() => {});
  const muteToggle = async () => {
    await api("POST", `${tpath(r)}/mute`, { muted: !t.muted });
    t.muted = t.muted ? 0 : 1; toast(t.muted ? "Đã tắt thông báo hội thoại" : "Đã bật thông báo hội thoại"); renderChat(r);
  };
  document.getElementById("cmenu").onclick = () => sheet([
    [r.type === 1 ? "👥 Thông tin nhóm" : "👤 Xem trang cá nhân", () => go(`#/a/${r.acc}/${r.type}/${encodeURIComponent(r.tid)}/info`)],
    [t.muted ? "🔔 Bật thông báo hội thoại này" : "🔕 Tắt thông báo hội thoại này", muteToggle],
  ]);

  // soạn & gửi
  const txt = document.getElementById("txt");
  let lastTyping = 0;
  txt.oninput = () => {
    txt.style.height = "auto"; txt.style.height = Math.min(txt.scrollHeight, 140) + "px";
    if (txt.value && Date.now() - lastTyping > 4000) { lastTyping = Date.now(); api("POST", `${tpath(r)}/typing`).catch(() => {}); }
  };
  txt.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !isIOS && !/Android/.test(navigator.userAgent)) { e.preventDefault(); document.getElementById("cf").requestSubmit(); } };
  txt.onfocus = () => { document.getElementById("panel").hidden = true; };
  document.getElementById("cf").onsubmit = async (e) => {
    e.preventDefault();
    const text = txt.value.trim();
    if (!text) return;
    const quote = state.reply?.msgId;
    txt.value = ""; txt.oninput(); setReply(null);
    try { await api("POST", `${tpath(r)}/text`, { text, quote }); }
    catch (err) { toast(err.message); txt.value = text; }
  };
  document.getElementById("pic").onchange = async (e) => {
    for (const f of e.target.files) {
      try {
        toast("Đang gửi ảnh…", 10000);
        await api("POST", `${tpath(r)}/image`, await prepareImage(f));
        toast("Đã gửi ảnh");
      } catch (err) { toast(err.message); }
    }
    e.target.value = "";
  };
  document.getElementById("fil").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 20 * 1048576) return toast("File tối đa 20MB");
    try {
      toast("Đang gửi file…", 30000);
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.onerror = rej; fr.readAsDataURL(f); });
      await api("POST", `${tpath(r)}/file`, { data, filename: f.name });
      toast("Đã gửi file");
    } catch (err) { toast(err.message); }
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
  p.innerHTML = `<div class="tabs"><button data-tab="sticker" class="${tab === "sticker" ? "on" : ""}">Sticker</button><button data-tab="emoji" class="${tab === "emoji" ? "on" : ""}">Emoji</button></div><div id="pbody" class="pbody"></div>`;
  p.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { state.panelTab = b.dataset.tab; p.hidden = true; togglePanel(r); });
  const body = p.querySelector("#pbody");
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
    ${state.user.is_admin ? `<a class="btn block" href="#/admin">🛠 Trang quản trị (người dùng, mã mời, tính năng)</a>` : ""}
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
  document.getElementById("logout").onclick = async () => { await disablePush().catch(() => {}); await api("POST", "logout"); state.user = null; go("#/login"); };
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
