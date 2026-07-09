import type { ReactNode } from "react"
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router"
import { AppProviders } from "../src/components/app-providers"
import "../src/index.css"

const themeScript = `
;(() => {
  const storageKey = "pockcode-theme"
  const fallbackTheme = "dark"
  const storedTheme = window.localStorage.getItem(storageKey)
  const theme = storedTheme === "light" || storedTheme === "dark" || storedTheme === "system" ? storedTheme : fallbackTheme
  const resolvedTheme = theme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : theme
  document.documentElement.classList.remove("light", "dark")
  document.documentElement.classList.add(resolvedTheme)
  document.documentElement.style.colorScheme = resolvedTheme
})()
`

const pwaRegistrationScript = `
;(() => {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    return
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.warn("pockcode service worker registration failed", error)
    })
  })
})()
`

export function meta() {
  return [
    { title: "pockcode" },
    { name: "description", content: "A local Codex coding workspace for chat, files, terminals, and providers." },
  ]
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
        <meta name="application-name" content="pockcode" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="pockcode" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="format-detection" content="telephone=no" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#18171c" media="(prefers-color-scheme: dark)" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="icon" href="/icons/favicon-48.png" sizes="48x48" type="image/png" />
        <link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/icons/favicon-16.png" sizes="16x16" type="image/png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
        <script dangerouslySetInnerHTML={{ __html: pwaRegistrationScript }} />
      </body>
    </html>
  )
}

export default function Root() {
  return (
    <AppProviders>
      <Outlet />
    </AppProviders>
  )
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unexpected application error."

  return (
    <main className="app-safe-viewport bg-background text-foreground">
      <div className="flex h-full items-center justify-center p-6">
        <section className="max-w-md rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm">
          <h1 className="text-lg font-semibold">pockcode</h1>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{message}</p>
        </section>
      </div>
    </main>
  )
}
