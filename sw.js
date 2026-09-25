"use strict";

/* ============================================================
 * dataknows.me — service worker: lets the app open offline.
 * Only caches the app's own files; user data (localStorage) is never
 * touched here. Network-first, so updates arrive on the next load.
 * ============================================================ */

const CACHE = "dataknowsme-shell-v1";
const SHELL = [
  "./", "index.html", "analysis.html",
  "common.js", "app.js", "analysis.js", "styles.css",
  "manifest.webmanifest", "icon_128.png", "icon_192.png", "icon_512.png", "apple-touch-icon.png",
];
const NETWORK_TIMEOUT_MS = 3000; // then fall back to the cached copy

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {}); // handled below; avoid unhandled-rejection noise

  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS)),
    ]);
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === "navigate" ? await cache.match("index.html") : undefined);
    return hit || network; // nothing cached: keep waiting for the network
  }
}
