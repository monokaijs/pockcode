import type { ReactNode } from "react"
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router"
import "../src/index.css"

export function meta() {
  return [{ title: "pockcode" }]
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
  return <Outlet />
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unexpected application error."

  return (
    <main className="flex min-h-svh items-center justify-center bg-[#0f1011] p-6 text-[#d7d7d7]">
      <section className="max-w-md rounded-xl border border-[#2a2c2f] bg-[#171818] p-5 shadow-sm">
        <h1 className="text-lg font-semibold">pockcode</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm text-[#9a9a9a]">{message}</p>
      </section>
    </main>
  )
}
