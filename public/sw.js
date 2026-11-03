// Service worker: nhận thông báo push và mở đúng cuộc trò chuyện khi bấm vào
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Zalo Multi", body: event.data?.text() }; }
  event.waitUntil(
    self.registration.showNotification(d.title || "Tin nhắn mới", {
      body: d.body || "",
      icon: d.icon || "icons/icon-192.png",
      badge: "icons/badge-96.png",
      tag: d.tag,
      renotify: !!d.tag,
      data: { url: d.url || "#/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hash = event.notification.data?.url || "#/";
  const target = new URL(self.registration.scope + hash, self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ type: "open", hash });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
