const CACHE_VERSION = "stakewars-v3";
const APP_SHELL = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/images/sw-hero.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(async () => (await caches.match("/")) ?? (await caches.match("/offline.html")))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) ?? Response.error())
  );
});

self.addEventListener("push", (event) => {
  const data = event.data?.json?.() ?? {};
  const title = data.title || "StakeWars";
  const tag = typeof data.tag === "string" && data.tag.trim() ? data.tag.trim() : undefined;
  const options = {
    body: data.body || "You have a new StakeWars update.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag,
    renotify: Boolean(data.renotify),
    data: {
      url: data.url || "/",
      tag
    }
  };

  event.waitUntil((async () => {
    if (tag && "getNotifications" in self.registration) {
      const existing = await self.registration.getNotifications({ tag });
      for (const notification of existing) {
        notification.close();
      }
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === targetUrl && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
