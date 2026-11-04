import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const env = process.env;

export const PORT = Number(env.PORT || 8788);
export const HOST = env.HOST || "127.0.0.1";
// Đường dẫn gốc của app trên website, ví dụ "/app" (không có dấu / ở cuối)
export const BASE_PATH = (env.BASE_PATH || "/app").replace(/\/+$/, "");
export const DATA_DIR = env.DATA_DIR || path.resolve("data");
// Nơi lưu ảnh/file. Có thể là thư mục Google Drive gắn bằng rclone mount (xem deploy/zalo-media.service)
export const MEDIA_DIR = env.MEDIA_DIR || path.join(DATA_DIR, "media");
export const VAPID_SUBJECT = env.VAPID_SUBJECT || "mailto:admin@example.com";
// Cho phép đăng ký tự do (không cần mã mời). Mặc định: chỉ người đầu tiên, sau đó cần mã mời.
export const OPEN_SIGNUP = env.OPEN_SIGNUP === "1";
// Mã bắt buộc khi tạo tài khoản đầu tiên (quản trị viên), tránh người lạ đăng ký trước bạn
export const SETUP_CODE = env.SETUP_CODE || "";

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// Khoá bí mật dùng mã hoá phiên Zalo + khoá VAPID cho push.
// Tự sinh lần đầu và lưu trong DATA_DIR/secrets.json (chmod 600).
const secretsFile = path.join(DATA_DIR, "secrets.json");
let secrets = {};
if (fs.existsSync(secretsFile)) secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
let changed = false;
if (!secrets.encKey) {
  secrets.encKey = crypto.randomBytes(32).toString("base64");
  changed = true;
}
if (!secrets.vapid) {
  const { default: webpush } = await import("web-push");
  secrets.vapid = webpush.generateVAPIDKeys();
  changed = true;
}
if (changed) fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });

export const ENC_KEY = Buffer.from(env.ENC_KEY || secrets.encKey, "base64");
export const VAPID = {
  publicKey: env.VAPID_PUBLIC_KEY || secrets.vapid.publicKey,
  privateKey: env.VAPID_PRIVATE_KEY || secrets.vapid.privateKey,
};
