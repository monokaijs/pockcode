const CACHE_VERSION = "pockcode-pwa-v5"
const STATIC_CACHE = `${CACHE_VERSION}-static`
const CORE_ASSETS = [
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-16.png",
  "/icons/favicon-32.png",
  "/icons/favicon-48.png",
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

self.addEventListener("push", (event) => {
  event.waitUntil(showPushNotification(event.data))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const targetUrl = notificationTargetUrl(event.notification)
  event.waitUntil(focusOrOpenClient(targetUrl))
})

function shouldBypass(url) {
  return url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/socket.io/")
}

function isStaticAsset(url) {
  return url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/manifest.webmanifest"
}

async function showPushNotification(data) {
  const payload = readPushPayload(data)
  await self.registration.showNotification(payload.title || "PockCode", {
    badge: "/icons/favicon-32.png",
    body: payload.body || "",
    data: payload.data || {},
    icon: "/icons/icon-192.png",
    tag: payload.tag || "pockcode",
  })
}

function readPushPayload(data) {
  if (!data) {
    return {}
  }
  try {
    return data.json()
  } catch {
    try {
      return { body: data.text() }
    } catch {
      return {}
    }
  }
}

function notificationTargetUrl(notification) {
  const url = notification.data && typeof notification.data.url === "string"
    ? notification.data.url
    : "/"
  return new URL(url, self.location.origin).href
}

async function focusOrOpenClient(targetUrl) {
  const windowClients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  })
  const sameOriginClient = windowClients.find((client) => new URL(client.url).origin === self.location.origin)
  if (sameOriginClient) {
    if ("navigate" in sameOriginClient) {
      await sameOriginClient.navigate(targetUrl).catch(() => undefined)
    }
    return sameOriginClient.focus()
  }
  return self.clients.openWindow(targetUrl)
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
    "<!doctype html><title>PockCode offline</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><body style=\"box-sizing:border-box;margin:0;display:grid;min-height:100vh;min-height:100dvh;place-items:center;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);background:#18171c;color:#f4f4f5;font:16px system-ui,sans-serif\"><main style=\"max-width:28rem;padding:24px\"><h1 style=\"margin:0 0 8px;font-size:22px\">PockCode is offline</h1><p style=\"margin:0;color:#b6b5bd;line-height:1.5\">Reconnect to the local PockCode server, then reload this app.</p></main></body>",
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
      status: 503,
      statusText: "Offline",
    },
  )
}
