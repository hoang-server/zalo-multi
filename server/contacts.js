// Danh bạ (bạn bè, tìm theo số, lời mời kết bạn, tên gợi nhớ) và tạo / quản lý nhóm Zalo
import { db } from "./db.js";
import { httpError } from "./auth.js";
import { liveApi, ownAccount } from "./zalo.js";

// Danh sách bạn bè lấy từ Zalo, giữ tạm 3 phút cho đỡ gọi nhiều
const friendCache = new Map(); // accountId -> { ts, list }
const FRIEND_TTL = 3 * 60e3;
const forget = (accountId) => friendCache.delete(Number(accountId));

const upsertThread = db.prepare(
  `INSERT INTO threads (account_id, thread_id, type, name, avatar) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(account_id, thread_id, type) DO UPDATE SET name = COALESCE(excluded.name, name), avatar = COALESCE(excluded.avatar, avatar)`
);

// Số VN: bỏ khoảng trắng/dấu, +84 / 84 / 0 → 0xxxxxxxxx
export function normPhone(s) {
  let p = String(s || "").replace(/[^\d+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("84") && p.length >= 11) p = "0" + p.slice(2);
  if (!/^0\d{9,10}$/.test(p)) return null;
  return p;
}
const to84 = (p) => "84" + p.slice(1);

const basic = (u) => u && ({
  uid: String(u.uid || u.userId || ""), name: u.display_name || u.displayName || u.zalo_name || u.zaloName || "",
  zaloName: u.zalo_name || u.zaloName || "", avatar: u.avatar || null, status: u.status || "",
});

export async function friends(user, accountId, { refresh } = {}) {
  const row = ownAccount(user, accountId, "view");
  const c = friendCache.get(row.id);
  if (c && !refresh && Date.now() - c.ts < FRIEND_TTL) return c.list;
  const api = liveApi(user, accountId, "view");
  const [list, aliases] = await Promise.all([
    api.getAllFriends(),
    api.getAliasList(2000).then((r) => r.items || []).catch(() => []),
  ]);
  const alias = new Map(aliases.map((a) => [String(a.userId), a.alias]));
  const out = list.map((f) => ({
    uid: String(f.userId), name: alias.get(String(f.userId)) || f.displayName || f.zaloName, zaloName: f.zaloName || "",
    alias: alias.get(String(f.userId)) || "", avatar: f.avatar || null, phone: f.phoneNumber || "",
    online: !!f.isActive, blocked: !!f.isBlocked,
  })).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  // cập nhật tên/ảnh trong danh sách hội thoại (chỉ những người đã có hội thoại)
  const upd = db.prepare("UPDATE threads SET name = ?, avatar = COALESCE(?, avatar) WHERE account_id = ? AND thread_id = ? AND type = 0");
  for (const f of out) upd.run(f.name, f.avatar, row.id, f.uid);
  friendCache.set(row.id, { ts: Date.now(), list: out });
  return out;
}

// Tìm một người theo số điện thoại
export async function findByPhone(user, accountId, phone) {
  const p = normPhone(phone);
  if (!p) throw httpError(400, "Số điện thoại không hợp lệ");
  const api = liveApi(user, accountId, "view");
  let u;
  try { u = basic(await api.findUser(to84(p))); } catch (e) { u = null; }
  if (!u?.uid) throw httpError(404, "Số này chưa đăng ký Zalo hoặc đã chặn tìm kiếm qua số điện thoại");
  const st = await api.getFriendRequestStatus(u.uid).catch(() => null);
  return { ...u, phone: p, isFriend: !!st?.is_friend, requested: !!st?.is_requested, requesting: !!st?.is_requesting };
}

// Kiểm tra cả danh sách số (dán vào hoặc nhập từ Excel/CSV): chỉ tra cứu, không tự kết bạn
export async function checkPhones(user, accountId, phones) {
  const api = liveApi(user, accountId, "view");
  const seen = new Set(), list = [], bad = [];
  for (const raw of (Array.isArray(phones) ? phones : String(phones || "").split(/[\s,;]+/)).slice(0, 1000)) {
    if (!String(raw).trim()) continue;
    const p = normPhone(raw);
    if (!p) { bad.push(String(raw).slice(0, 30)); continue; }
    if (!seen.has(p)) { seen.add(p); list.push(p); }
  }
  if (list.length > 200) throw httpError(400, "Mỗi lần kiểm tra tối đa 200 số (Zalo giới hạn tra cứu)");
  const fr = new Set((await friends(user, accountId).catch(() => [])).map((f) => f.uid));
  const results = [];
  for (let i = 0; i < list.length; i += 20) {
    const part = list.slice(i, i + 20);
    let r = {};
    try { r = await api.getMultiUsersByPhones(part.map(to84)); } catch (e) { console.error("getMultiUsersByPhones", e?.message); }
    const byPhone = new Map();
    for (const [k, v] of Object.entries(r || {})) { const n = normPhone(k); if (n) byPhone.set(n, basic(v)); }
    for (const p of part) {
      const u = byPhone.get(p);
      results.push(u?.uid ? { phone: p, ...u, isFriend: fr.has(u.uid) } : { phone: p, uid: null });
    }
    if (i + 20 < list.length) await new Promise((res) => setTimeout(res, 800));
  }
  return { results, invalid: bad };
}

// Mở hội thoại với một người (kể cả chưa là bạn): tạo dòng hội thoại để hiện trong danh sách
export function openChat(user, accountId, { uid, name, avatar }) {
  const row = ownAccount(user, accountId, "view");
  if (!/^\d{3,25}$/.test(String(uid || ""))) throw httpError(400, "Thiếu người nhận");
  upsertThread.run(row.id, String(uid), 0, name ? String(name).slice(0, 100) : null, avatar || null);
  return { ok: true };
}

// ---------- lời mời kết bạn ----------
export async function friendRequests(user, accountId) {
  const api = liveApi(user, accountId, "view");
  const [rec, sent] = await Promise.all([
    api.getFriendRecommendations().catch(() => ({ recommItems: [] })),
    api.getSentFriendRequest().catch(() => ({})),
  ]);
  const incoming = (rec.recommItems || []).map((x) => x.dataInfo).filter((d) => d && d.recommType === 2).map((d) => ({
    uid: String(d.userId), name: d.displayName || d.zaloName, avatar: d.avatar || null,
    message: d.recommInfo?.message || "", time: d.recommTime ? Number(d.recommTime) : null,
  }));
  const outgoing = Object.values(sent || {}).map((d) => ({
    uid: String(d.userId), name: d.displayName || d.zaloName, avatar: d.avatar || null,
    message: d.fReqInfo?.message || "", time: d.fReqInfo?.time ? Number(d.fReqInfo.time) * (d.fReqInfo.time < 1e12 ? 1000 : 1) : null,
  }));
  return { incoming, outgoing };
}

const uidOk = (uid) => { if (!/^\d{3,25}$/.test(String(uid || ""))) throw httpError(400, "Người dùng không hợp lệ"); return String(uid); };

export async function friendAction(user, accountId, uid, action, body = {}) {
  uid = uidOk(uid);
  const owner = ["remove", "block", "unblock"].includes(action);
  const api = liveApi(user, accountId, owner ? "owner" : "reply");
  switch (action) {
    case "request": {
      const msg = String(body.message || "Xin chào, mình kết bạn nhé!").slice(0, 150);
      await api.sendFriendRequest(msg, uid); break;
    }
    case "accept": await api.acceptFriendRequest(uid); break;
    case "reject": await api.rejectFriendRequest(uid); break;
    case "undo": await api.undoFriendRequest(uid); break;
    case "alias": {
      const alias = String(body.alias || "").trim().slice(0, 50);
      if (alias) await api.changeFriendAlias(alias, uid); else await api.removeFriendAlias(uid);
      if (alias) db.prepare("UPDATE threads SET name = ? WHERE account_id = ? AND thread_id = ? AND type = 0").run(alias, Number(accountId), uid);
      break;
    }
    case "remove": await api.removeFriend(uid); break;
    case "block": await api.blockUser(uid); break;
    case "unblock": await api.unblockUser(uid); break;
    default: throw httpError(400, "Thao tác không hợp lệ");
  }
  forget(accountId);
  return { ok: true };
}

// ---------- nhóm ----------
const gidOk = (gid) => { if (!/^\d{3,25}$/.test(String(gid || ""))) throw httpError(400, "Nhóm không hợp lệ"); return String(gid); };
const uids = (list) => [...new Set((Array.isArray(list) ? list : [list]).map(String))].filter((u) => /^\d{3,25}$/.test(u));

function imageAttachment(img) {
  if (!img?.data) return null;
  const buf = Buffer.from(String(img.data), "base64");
  if (!buf.length || buf.length > 10 * 1048576) throw httpError(400, "Ảnh nhóm không hợp lệ (tối đa 10MB)");
  return { data: buf, filename: "group.jpg", metadata: { totalSize: buf.length, width: Number(img.width) || 0, height: Number(img.height) || 0 } };
}

export async function createGroup(user, accountId, { name, members, avatar }) {
  const row = ownAccount(user, accountId, "reply");
  const api = liveApi(user, accountId, "reply");
  const m = uids(members);
  if (m.length < 2) throw httpError(400, "Chọn ít nhất 2 người để tạo nhóm");
  if (m.length > 100) throw httpError(400, "Mỗi lần thêm tối đa 100 người");
  const nm = String(name || "").trim().slice(0, 100);
  const r = await api.createGroup({ name: nm || undefined, members: m });
  if (!r?.groupId) throw httpError(502, "Zalo không tạo được nhóm");
  const av = imageAttachment(avatar);
  if (av) await api.changeGroupAvatar(av, String(r.groupId)).catch((e) => console.error("changeGroupAvatar", e?.message));
  upsertThread.run(row.id, String(r.groupId), 1, nm || "Nhóm mới", null);
  return { groupId: String(r.groupId), added: (r.sucessMembers || []).length, failed: (r.errorMembers || []).length };
}

export async function groupAction(user, accountId, gid, action, body = {}) {
  gid = gidOk(gid);
  const owner = ["leave", "disperse"].includes(action);
  const row = ownAccount(user, accountId, owner ? "owner" : "reply");
  const api = liveApi(user, accountId, owner ? "owner" : "reply");
  let out = { ok: true };
  switch (action) {
    case "rename": {
      const nm = String(body.name || "").trim().slice(0, 100);
      if (!nm) throw httpError(400, "Nhập tên nhóm");
      await api.changeGroupName(nm, gid);
      db.prepare("UPDATE threads SET name = ? WHERE account_id = ? AND thread_id = ? AND type = 1").run(nm, row.id, gid);
      break;
    }
    case "avatar": {
      const av = imageAttachment(body.avatar);
      if (!av) throw httpError(400, "Chọn ảnh");
      await api.changeGroupAvatar(av, gid); break;
    }
    case "add": {
      const m = uids(body.members);
      if (!m.length) throw httpError(400, "Chọn người cần thêm");
      const r = await api.addUserToGroup(m, gid);
      out = { ok: true, failed: (r?.errorMembers || []).length }; break;
    }
    case "remove": await api.removeUserFromGroup(uids(body.members), gid); break;
    case "deputy": await api.addGroupDeputy(uids(body.members), gid); break;
    case "undeputy": await api.removeGroupDeputy(uids(body.members), gid); break;
    case "link-on": { const r = await api.enableGroupLink(gid); out = { link: r?.link || null }; break; }
    case "link-off": await api.disableGroupLink(gid); out = { link: null }; break;
    case "leave":
    case "disperse":
      if (action === "leave") await api.leaveGroup(gid); else await api.disperseGroup(gid);
      db.prepare("DELETE FROM threads WHERE account_id = ? AND thread_id = ? AND type = 1").run(row.id, gid);
      break;
    default: throw httpError(400, "Thao tác không hợp lệ");
  }
  return out;
}

export async function groupLink(user, accountId, gid) {
  const api = liveApi(user, accountId, "view");
  const r = await api.getGroupLinkDetail(gidOk(gid)).catch(() => null);
  return { link: r?.enabled ? r.link || null : null };
}
