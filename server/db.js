import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, ENC_KEY } from "./config.js";

export const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zalo_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zalo_uid TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar TEXT,
  creds_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  status_msg TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  account_id INTEGER NOT NULL REFERENCES zalo_accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  type INTEGER NOT NULL,           -- 0 = cá nhân, 1 = nhóm
  name TEXT,
  avatar TEXT,
  last_ts INTEGER NOT NULL DEFAULT 0,
  last_text TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, thread_id, type)
);
CREATE INDEX IF NOT EXISTS threads_recent ON threads(account_id, last_ts DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES zalo_accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  type INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  from_uid TEXT,
  from_name TEXT,
  ts INTEGER NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,              -- text | image | file | sticker | video | voice | link | other
  text TEXT,
  url TEXT,
  thumb TEXT,
  title TEXT,
  UNIQUE (account_id, msg_id)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id, thread_id, type, ts);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Mã hoá AES-256-GCM cho phiên đăng nhập Zalo lưu trong DB
export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
export function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}

export const now = () => Date.now();
