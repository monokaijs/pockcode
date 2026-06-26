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

export function meta() {
  return [{ title: "pockcode" }]
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
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
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <section className="max-w-md rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm">
        <h1 className="text-lg font-semibold">pockcode</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{message}</p>
      </section>
    </main>
  )
}
