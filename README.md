# Zalo Multi

Web app (PWA) giúp **dùng nhiều tài khoản Zalo trên một điện thoại**: chuyển qua lại giữa các tài khoản trong một màn hình, nhận **thông báo push** khi có tin mới, và cài ra màn hình chính như một ứng dụng thật (không cần App Store / CH Play).

Bản chạy thử: <https://nguyenhuyhoang.website/app/>

> ⚠️ Dự án dùng [zca-js](https://github.com/RFS-ADRENO/zca-js) – API Zalo **không chính thức**. Zalo có thể cảnh báo hoặc khoá tài khoản dùng ứng dụng bên thứ ba. Hãy thử trước với tài khoản phụ. Dự án không liên kết với Zalo / VNG.

## Tính năng

- Nhiều người dùng, mỗi người quản lý các tài khoản Zalo của mình (đăng ký bằng mã mời)
- Thêm tài khoản Zalo bằng cách quét mã QR
- Danh sách hội thoại cá nhân và nhóm, tìm kiếm, tải danh bạ & nhóm
- Đọc / trả lời tin nhắn chữ, xem ảnh, file, video, tin thoại, liên kết
- Gửi ảnh từ điện thoại (tự thu nhỏ trước khi gửi)
- Thông báo push (Android, máy tính; iPhone từ iOS 16.4 khi đã thêm vào màn hình chính)
- Realtime qua Server-Sent Events, tự kết nối lại

## Cách hoạt động

```
Điện thoại (PWA) ──HTTPS──▶ nginx ──▶ server Node.js ──zca-js──▶ Zalo
      ▲                                     │
      └────────── Web Push ◀────────────────┘
```

Server giữ phiên đăng nhập Zalo Web của từng tài khoản (mã hoá AES-256-GCM trong SQLite), lắng nghe tin nhắn, lưu lại và đẩy thông báo tới thiết bị của chủ tài khoản. Lịch sử chỉ có từ lúc tài khoản được thêm vào app (cộng một ít tin gần đây Zalo trả về khi kết nối).

**Giới hạn:** Zalo chỉ cho **một phiên Zalo Web** mỗi tài khoản. Mở chat.zalo.me ở nơi khác sẽ đá phiên trong app ra (app sẽ báo và có nút *Kết nối lại*). Zalo PC và app điện thoại không bị ảnh hưởng.

## Cài đặt

Yêu cầu: Node.js ≥ 22.13 (dùng `node:sqlite` có sẵn), HTTPS (bắt buộc cho push và PWA).

```bash
git clone https://github.com/hoang-server/zalo-multi.git /srv/zalo-multi
cd /srv/zalo-multi && npm ci --omit=dev
```

Chạy thử:

```bash
SETUP_CODE=ma-bi-mat DATA_DIR=./data node server/index.js
# mở http://127.0.0.1:8788/app/
```

Chạy thật với systemd + nginx:

```bash
cp deploy/zalo-multi.service /etc/systemd/system/
printf 'VAPID_SUBJECT=mailto:ban@example.com\nSETUP_CODE=%s\n' "$(openssl rand -hex 4)" > /etc/zalo-multi.env
chmod 600 /etc/zalo-multi.env
systemctl daemon-reload && systemctl enable --now zalo-multi
# thêm deploy/nginx-app.conf vào server {} của website, rồi: nginx -t && systemctl reload nginx
```

Mở `https://<domain>/app/`, tạo tài khoản đầu tiên bằng `SETUP_CODE` (tài khoản này là quản trị viên). Người dùng khác đăng ký bằng **mã mời** tạo trong *Cài đặt*.

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` / `HOST` | `8788` / `127.0.0.1` | Địa chỉ server lắng nghe |
| `BASE_PATH` | `/app` | Đường dẫn của app trên website |
| `DATA_DIR` | `./data` | DB SQLite, khoá mã hoá, khoá VAPID (tự sinh lần đầu) |
| `SETUP_CODE` | – | Mã bắt buộc để tạo tài khoản quản trị đầu tiên |
| `OPEN_SIGNUP` | `0` | `1` = cho đăng ký tự do không cần mã mời |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Email liên hệ gửi kèm push |

Sao lưu: chỉ cần thư mục `DATA_DIR` (với systemd: `/var/lib/private/zalo-multi`). Mất `secrets.json` thì các phiên Zalo không giải mã được nữa (phải quét QR lại) và các máy phải bật lại thông báo.

## Dùng trên điện thoại

- **iPhone (Safari):** mở trang → nút *Chia sẻ* → *Thêm vào MH chính* → mở app từ màn hình chính → *Cài đặt* → *Bật thông báo*.
- **Android (Chrome):** mở trang → menu ⋮ → *Cài đặt ứng dụng* / *Thêm vào màn hình chính* → bật thông báo.

## Bảo mật

- Mật khẩu băm bằng scrypt, cookie phiên `HttpOnly; Secure; SameSite=Lax`, chặn dò mật khẩu theo IP.
- Request ghi phải có header `X-Requested-With: zalo-multi` (chống CSRF), CSP chặt (xem `deploy/nginx-app.conf`).
- Phiên Zalo lưu mã hoá; không ghi log nội dung tin nhắn.

## Giấy phép

MIT
