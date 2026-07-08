const CACHE_VERSION = "pockcode-pwa-v1"
const STATIC_CACHE = `${CACHE_VERSION}-static`
const CORE_ASSETS = [
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-icon-192.png",
  "/icons/maskable-icon-512.png",
]

self.addEventListener("install", (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => undefined),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("pockcode-pwa-") && key !== STATIC_CACHE)
        .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") {
    return
  }

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || shouldBypass(url)) {
    return
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => offlineResponse()))
    return
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request))
  }
})

function shouldBypass(url) {
  return url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/socket.io/")
}

function isStaticAsset(url) {
  return url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/manifest.webmanifest"
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE)
  const cached = await cache.match(request)
  const fetched = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone())
    }
    return response
  }).catch(() => cached || Response.error())

  return cached || fetched
}

function offlineResponse() {
  return new Response(
    "<!doctype html><title>pockcode offline</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><body style=\"margin:0;display:grid;min-height:100vh;place-items:center;background:#18171c;color:#f4f4f5;font:16px system-ui,sans-serif\"><main style=\"max-width:28rem;padding:24px\"><h1 style=\"margin:0 0 8px;font-size:22px\">pockcode is offline</h1><p style=\"margin:0;color:#b6b5bd;line-height:1.5\">Reconnect to the local pockcode server, then reload this app.</p></main></body>",
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
      status: 503,
      statusText: "Offline",
    },
  )
}
