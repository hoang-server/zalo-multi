// Lưu ảnh/file/video/tin thoại về server để xem được cả khi link Zalo hết hạn
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MEDIA_DIR as DIR } from "./config.js";
import { db, getSetting } from "./db.js";

export const MEDIA_DIR = path.resolve(DIR);
// Với Google Drive: chỉ lưu khi Drive đang được gắn (có file đánh dấu .drive), tránh ghi nhầm vào ổ server
const external = !!process.env.MEDIA_DIR;
export const mediaReady = () => !external || fs.existsSync(path.join(MEDIA_DIR, ".drive"));
const EXT_BY_TYPE = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "audio/aac": ".aac", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/amr": ".amr",
  "application/pdf": ".pdf",
};
export const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]));
Object.assign(TYPE_BY_EXT, { ".jpeg": "image/jpeg", ".heic": "image/heic", ".txt": "text/plain; charset=utf-8" });
const okExt = (e) => /^\.[a-z0-9]{1,6}$/.test(e) ? e : "";

export async function saveMedia(accountId, msgRowId, p) {
  if (!getSetting("media_store") || !/^https:\/\//i.test(p.url || "") || !mediaReady()) return;
  const max = getSetting("media_max_mb") * 1048576;
  const r = await fetch(p.url, { signal: AbortSignal.timeout(120e3) });
  if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
  const len = Number(r.headers.get("content-length") || 0);
  if (max && len > max) { await r.body.cancel(); return; }
  const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = (p.kind === "file" && okExt(path.extname(p.title || "").toLowerCase()))
    || EXT_BY_TYPE[type] || okExt(path.extname(new URL(p.url).pathname).toLowerCase()) || ".bin";
  const dir = path.join(MEDIA_DIR, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  const rel = `${accountId}/${crypto.randomBytes(12).toString("hex")}${ext}`;
  const file = path.join(MEDIA_DIR, rel);
  let size = 0;
  const limit = new Transform({
    transform(chunk, _, cb) { size += chunk.length; cb(max && size > max ? new Error("quá giới hạn dung lượng") : null, chunk); },
  });
  try {
    await pipeline(Readable.fromWeb(r.body), limit, fs.createWriteStream(file));
  } catch (e) {
    fs.rmSync(file, { force: true });
    if (size > max) return;
    throw e;
  }
  db.prepare("UPDATE messages SET media = ? WHERE id = ?").run(rel, msgRowId);
}

// Gửi file đã lưu (hỗ trợ Range để iPhone phát được video / tin thoại)
export function serveMedia(req, res, row) {
  const file = path.join(MEDIA_DIR, row.media);
  if (!file.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size;
  const ext = path.extname(file);
  const type = TYPE_BY_EXT[ext] || "application/octet-stream";
  const inline = /^(image|video|audio)\//.test(type) || type === "application/pdf";
  const headers = {
    "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.title || "tep" + ext)}`,
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start < 0) start = 0;
    if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  fs.createReadStream(file).pipe(res);
}

export function removeMediaOfAccount(accountId) {
  fs.rmSync(path.join(MEDIA_DIR, String(Number(accountId))), { recursive: true, force: true });
}

let usageCache = null;
export function mediaUsage() {
  if (usageCache && Date.now() - usageCache.at < 600e3) return usageCache.v;
  let bytes = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else { bytes += fs.statSync(f).size; files++; }
    }
  };
  walk(MEDIA_DIR);
  usageCache = { at: Date.now(), v: { bytes, files, drive: external, ready: mediaReady() } };
  return usageCache.v;
}
