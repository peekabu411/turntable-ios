const CACHE = "turntable-ios-v1";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
});
