// Xuất lịch sử chat của một hội thoại ra HTML (xem/in) hoặc CSV (mở bằng Excel)
import { db } from "./db.js";
import { ownAccount } from "./zalo.js";
import { emoticons } from "../public/emoticons.js";

const KIND = { text: "", image: "Ảnh", file: "File", sticker: "Sticker", video: "Video", voice: "Tin thoại", link: "Link", other: "Khác" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const csvCell = (s) => {
  s = String(s ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // chặn công thức khi mở bằng Excel
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// dd/mm/yyyy HH:MM:SS giờ Việt Nam
const fmt = (ts) => { const d = new Date(ts + 7 * 3600e3).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 19)}`; };
const safeUrl = (u) => (/^https:\/\//i.test(u || "") ? u : "");

export function exportThread(user, accountId, type, threadId, { format = "html", from, to } = {}) {
  const row = ownAccount(user, accountId);
  const t = db.prepare("SELECT name FROM threads WHERE account_id = ? AND type = ? AND thread_id = ?").get(row.id, Number(type), String(threadId)) || {};
  const msgs = db.prepare(
    `SELECT ts, is_self, from_name, kind, text, url, title, recalled FROM messages
     WHERE account_id = ? AND type = ? AND thread_id = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 100000`
  ).all(row.id, Number(type), String(threadId), Number(from) || 0, Number(to) || 9e15);
  const who = (m) => (m.is_self ? `${row.name} (mình)` : m.from_name || t.name || "Khách");
  const body = (m) => (m.recalled ? "[Tin đã thu hồi]" : m.kind === "text" ? emoticons(m.text || "") : [m.title, m.text].filter(Boolean).join(" · "));
  const base = `zalo-${(t.name || threadId).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^\w.-]+/g, "-").slice(0, 40)}-${new Date().toISOString().slice(0, 10)}`;

  if (format === "csv") {
    const lines = [["Thời gian", "Người gửi", "Loại", "Nội dung", "Link"].join(",")];
    for (const m of msgs) lines.push([fmt(m.ts), who(m), KIND[m.kind] ?? m.kind, body(m), m.recalled ? "" : safeUrl(m.url)].map(csvCell).join(","));
    return { filename: `${base}.csv`, type: "text/csv; charset=utf-8", data: "﻿" + lines.join("\r\n") + "\r\n" };
  }
  let lastDay = "";
  const rows = msgs.map((m) => {
    const day = new Date(m.ts).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
    const sep = day !== lastDay ? `<div class="day">${esc(day)}</div>` : "";
    lastDay = day;
    const url = m.recalled ? "" : safeUrl(m.url);
    const content = m.kind === "image" && url ? `<a href="${esc(url)}"><img src="${esc(url)}" alt="Ảnh" loading="lazy"></a>${m.text ? `<div>${esc(m.text)}</div>` : ""}`
      : `${KIND[m.kind] && !m.recalled ? `<b>[${KIND[m.kind]}]</b> ` : ""}${esc(body(m)).replace(/\n/g, "<br>")}${url && m.kind !== "image" ? ` <a href="${esc(url)}">mở</a>` : ""}`;
    return `${sep}<div class="m ${m.is_self ? "me" : ""}"><div class="h">${esc(who(m))} · ${esc(fmt(m.ts).split(" ").pop() || "")}</div><div class="b">${content}</div></div>`;
  }).join("\n");
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.name || threadId)} – lịch sử chat Zalo</title>
<style>body{font:15px/1.45 system-ui,sans-serif;background:#eef1f5;margin:0;padding:16px;color:#1a1d21}main{max-width:760px;margin:auto}
h1{font-size:20px;margin:0 0 4px}.meta{color:#6b7280;font-size:13px;margin-bottom:16px}.day{text-align:center;color:#6b7280;font-size:12px;margin:18px 0 8px}
.m{max-width:80%;margin:6px 0;padding:8px 12px;border-radius:14px;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.06)}.m.me{margin-left:auto;background:#d7e9ff}
.h{font-size:12px;color:#6b7280;margin-bottom:2px}.b{white-space:normal;word-wrap:break-word}img{max-width:100%;max-height:320px;border-radius:8px;display:block}
@media print{body{background:#fff}.m{box-shadow:none;border:1px solid #ddd;break-inside:avoid}}</style></head><body><main>
<h1>${esc(t.name || threadId)}</h1>
<div class="meta">Tài khoản Zalo: ${esc(row.name)} · ${msgs.length} tin${msgs.length ? ` · từ ${esc(fmt(msgs[0].ts))} đến ${esc(fmt(msgs[msgs.length - 1].ts))}` : ""} · xuất lúc ${esc(fmt(Date.now()))}<br>
Chỉ gồm tin đã lưu trong Zalo Multi. Ảnh/file là link của Zalo, có thể hết hạn sau một thời gian.</div>
${rows || "<p>Chưa có tin nhắn.</p>"}
</main></body></html>`;
  return { filename: `${base}.html`, type: "text/html; charset=utf-8", data: html };
}
