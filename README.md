# Zalo Multi

Web app (PWA) giúp **dùng nhiều tài khoản Zalo trên một điện thoại**: chuyển qua lại giữa các tài khoản trong một màn hình, nhận **thông báo push** khi có tin mới, và cài ra màn hình chính như một ứng dụng thật (không cần App Store / CH Play).

Bản chạy thử: <https://nguyenhuyhoang.website/app/>

> ⚠️ Dự án dùng [zca-js](https://github.com/RFS-ADRENO/zca-js) – API Zalo **không chính thức**. Zalo có thể cảnh báo hoặc khoá tài khoản dùng ứng dụng bên thứ ba. Hãy thử trước với tài khoản phụ. Dự án không liên kết với Zalo / VNG.

## Tính năng

- Nhiều người dùng, mỗi người quản lý các tài khoản Zalo của mình (đăng ký bằng mã mời)
- Thêm tài khoản Zalo bằng cách quét mã QR
- Danh sách hội thoại cá nhân và nhóm, lọc *Chưa đọc / Cá nhân / Nhóm*, ghim hội thoại lên đầu (giữ lâu hoặc chuột phải), tải danh bạ & nhóm
- **Hộp thư chung**: tin của mọi tài khoản Zalo trong một danh sách
- Tìm trong nội dung tin nhắn (gõ không dấu cũng được) ở từng tài khoản, mọi tài khoản hoặc một hội thoại, bấm kết quả để nhảy tới đúng tin
- **Tin mẫu**: lưu câu hay gửi, khi chat gõ `/` + tên tắt hoặc chọn ở 😊 → *Tin mẫu*
- Xem ảnh/video, file, link đã gửi trong từng hội thoại
- Đọc / trả lời tin nhắn chữ, xem ảnh, sticker, icon cảm xúc Zalo, file, video, tin thoại, liên kết
- Gửi nhiều ảnh một lần (xem trước, bỏ bớt), dán ảnh bằng Ctrl+V, kéo thả ảnh/file vào khung chat; gửi file (≤ 20MB), sticker (tìm theo từ khoá, sticker dùng gần đây), emoji
- Thả cảm xúc (giữ lâu vào tin hoặc bấm ⋯), trả lời trích dẫn, thu hồi, xoá phía mình, sao chép
- Hiện "đang soạn tin…", báo đã xem cho người gửi
- Xem trang cá nhân (ảnh bìa, giới thiệu, ngày sinh…), thông tin nhóm & danh sách thành viên, thông tin tài khoản của mình
- Lưu ảnh, file, video, tin thoại về server hoặc thẳng lên **Google Drive** (xem lại được khi link Zalo hết hạn)
- Số tin chưa đọc trên avatar và trên icon app (iOS 16.4+/Android/máy tính)
- Cài đặt thông báo: theo tài khoản Zalo, tin nhóm, từng hội thoại; ẩn nội dung tin trong thông báo
- **Chăm sóc khách**: nhãn (Khách mới, Đã chốt, Cần gọi lại…) gắn cho hội thoại và lọc theo nhãn, lọc *Chưa trả lời*, ghi chú nội bộ theo từng khách (ghi rõ ai viết)
- **Hẹn giờ gửi tin** (server tự gửi đúng giờ, không cần mở app) và **nhắc việc** qua thông báo push; trang *Lịch hẹn & nhắc việc* tổng hợp
- **Giao tài khoản Zalo cho nhân viên**: chủ tài khoản giao cho người dùng app khác với quyền *chỉ xem* hoặc *được trả lời*; nhân viên cũng nhận thông báo tin mới
- **Thống kê** theo tài khoản: tin đến/gửi mỗi ngày, thời gian trả lời trung bình, khách chưa được trả lời, số khách theo nhãn
- **Cảnh báo khi Zalo bị ngắt / hết phiên**: thông báo push và **Telegram** (quản trị viên cài token bot, mỗi người tự bấm *Kết nối Telegram*)
- **Xuất lịch sử chat** một hội thoại ra trang HTML (xem, in PDF) hoặc CSV (mở bằng Excel)
- **Đăng nhập 2 lớp** (mã 6 số từ Google Authenticator/Authy, kèm 8 mã dự phòng); quản trị viên tắt được 2 lớp cho người mất điện thoại
- **Nhật ký hoạt động** (`#/activity`): đăng nhập, gửi tin, xoá tài khoản, thao tác quản trị… (không ghi nội dung tin, lưu 180 ngày); chủ tài khoản Zalo xem được việc nhân viên làm
- **Danh bạ** (`#/a/<id>/contacts`): bạn bè A–Z có tìm không dấu, tên gợi nhớ (đồng bộ Zalo), **tìm theo số điện thoại** để nhắn tin / kết bạn, lời mời kết bạn đã nhận / đã gửi, chặn, xoá bạn; **kiểm tra nhiều số** (dán hoặc file CSV/TXT, tối đa 200 số) xem số nào có Zalo, tải kết quả CSV – chỉ tra cứu, không tự kết bạn hàng loạt
- **Nhóm**: tạo nhóm (tên, ảnh, chọn thành viên từ danh bạ), đổi tên/ảnh, thêm/xoá thành viên, bổ nhiệm phó nhóm, bật/tắt link mời, rời nhóm, giải tán (trưởng nhóm)
- **Bố cục máy tính kiểu Zalo PC** (màn hình ≥ 900px): cột tài khoản · danh sách hội thoại · khung chat cạnh nhau
- Trang quản trị (`#/admin`): người dùng (khoá, cấp quyền, đặt lại mật khẩu, xoá), mã mời, bật/tắt tính năng, thống kê
- Thông báo push (Android, máy tính; iPhone từ iOS 16.4 khi đã thêm vào màn hình chính)
- Realtime qua Server-Sent Events, tự kết nối lại

## Cách hoạt động

```
Điện thoại (PWA) ──HTTPS──▶ nginx ──▶ server Node.js ──zca-js──▶ Zalo
      ▲                                     │
      └────────── Web Push ◀────────────────┘
```

Server giữ phiên đăng nhập Zalo Web của từng tài khoản (mã hoá AES-256-GCM trong SQLite), lắng nghe tin nhắn, lưu lại và đẩy thông báo tới thiết bị của chủ tài khoản. Tin cũ: mỗi lần kết nối, app lấy hết phần tin gần đây mà Zalo còn giữ cho phiên web. Khi mở một **nhóm**, app tải thêm tối đa 100 tin gần nhất từ lịch sử nhóm. Với chat **cá nhân**, Zalo không có API lịch sử cho phiên web (Zalo Web phải đồng bộ từ điện thoại), nên tin cũ hơn lúc thêm tài khoản sẽ không có.

**Giới hạn:** Nhật ký (tường) không xem được vì Zalo không mở chức năng này cho Zalo Web. Zalo chỉ cho **một phiên Zalo Web** mỗi tài khoản. Mở chat.zalo.me ở nơi khác sẽ đá phiên trong app ra (app sẽ báo và có nút *Kết nối lại*). Zalo PC và app điện thoại không bị ảnh hưởng.

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
useradd --system --no-create-home --shell /usr/sbin/nologin zalo-multi
cp deploy/zalo-multi.service /etc/systemd/system/
printf 'VAPID_SUBJECT=mailto:ban@example.com\nSETUP_CODE=%s\n' "$(openssl rand -hex 4)" > /etc/zalo-multi.env
chmod 600 /etc/zalo-multi.env
systemctl daemon-reload && systemctl enable --now zalo-multi
# thêm deploy/nginx-app.conf vào server {} của website, rồi: nginx -t && systemctl reload nginx
```

Mở `https://<domain>/app/`, tạo tài khoản đầu tiên bằng `SETUP_CODE` (tài khoản này là quản trị viên). Người dùng khác đăng ký bằng **mã mời** tạo trong *Cài đặt → Trang quản trị*.

Thêm tính năng có thể bật/tắt: thêm khoá vào `SETTING_DEFAULTS` trong `server/db.js` (và mô tả trong `SETTING_INFO` ở `public/app.js`), trang quản trị sẽ tự hiện.

### Lưu ảnh/file trên Google Drive

DB (tin nhắn chữ, vài MB) nằm trên server; ảnh/file có thể để thẳng trên Google Drive bằng `rclone mount`:

```bash
rclone config                      # tạo remote tên "gdrive" (Google Drive)
rclone mkdir gdrive:zalo-multi-media
useradd --system --no-create-home --shell /usr/sbin/nologin zalo-multi
sed "s/ZALO_UID/$(id -u zalo-multi)/;s/ZALO_GID/$(id -g zalo-multi)/" deploy/zalo-media.service > /etc/systemd/system/zalo-media.service
mkdir -p /mnt/zalo-media && systemctl daemon-reload && systemctl enable --now zalo-media
echo ok | sudo -u zalo-multi tee /mnt/zalo-media/.drive   # file đánh dấu: app chỉ lưu khi Drive đang gắn
```

Service mẫu đã đặt `MEDIA_DIR=/mnt/zalo-media`. rclone giữ bộ đệm tối đa 2GB cho file hay xem, còn lại chỉ nằm trên Drive.

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` / `HOST` | `8788` / `127.0.0.1` | Địa chỉ server lắng nghe |
| `BASE_PATH` | `/app` | Đường dẫn của app trên website |
| `DATA_DIR` | `./data` | DB SQLite, khoá mã hoá, khoá VAPID (tự sinh lần đầu) |
| `MEDIA_DIR` | `DATA_DIR/media` | Nơi lưu ảnh/file (vd. thư mục Google Drive gắn bằng rclone) |
| `SETUP_CODE` | – | Mã bắt buộc để tạo tài khoản quản trị đầu tiên |
| `OPEN_SIGNUP` | `0` | Giá trị ban đầu của *Cho đăng ký tự do* (đổi được trong trang quản trị) |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Email liên hệ gửi kèm push |

Sao lưu: thư mục `DATA_DIR` (với systemd: `/var/lib/zalo-multi`) và `MEDIA_DIR` nếu lưu trên ổ server. Mất `secrets.json` thì các phiên Zalo không giải mã được nữa (phải quét QR lại) và các máy phải bật lại thông báo.

## Dùng trên điện thoại

- **iPhone (Safari):** mở trang → nút *Chia sẻ* → *Thêm vào MH chính* → mở app từ màn hình chính → *Cài đặt* → *Bật thông báo*.
- **Android (Chrome):** mở trang → menu ⋮ → *Cài đặt ứng dụng* / *Thêm vào màn hình chính* → bật thông báo.

## Bảo mật

- Mật khẩu băm bằng scrypt, cookie phiên `HttpOnly; Secure; SameSite=Lax`, chặn dò mật khẩu theo IP.
- Request ghi phải có header `X-Requested-With: zalo-multi` (chống CSRF), CSP chặt (xem `deploy/nginx-app.conf`).
- Phiên Zalo lưu mã hoá; không ghi log nội dung tin nhắn.

## Giấy phép

MIT
