#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { dirname, extname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

type CliOptions = {
  home?: string
  host: string
  port: number
}

const defaultHost = "127.0.0.1"
const defaultPort = 4733

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === "help") {
    console.log(helpText())
    return
  }
  if (parsed === "version") {
    console.log(await readPackageVersion())
    return
  }

  process.env.NODE_ENV ||= "production"
  if (parsed.home) {
    process.env.POCKCODE_HOME = parsed.home
  }

  const [
    api,
    auth,
    socket,
    chatMonitor,
    scheduleMonitor,
    pluginManager,
  ] = await Promise.all([
    import("../app/server/api.server"),
    import("../app/server/auth.server"),
    import("../app/server/socket.server"),
    import("../app/server/chat-status-monitor.server"),
    import("../app/server/message-schedule-monitor.server"),
    import("../app/server/plugins/manager.server"),
  ])
  const clientRoot = await resolveClientRoot()

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
      if (await handleAuthGate(req, res, url, auth)) {
        return
      }
      if (url.pathname.startsWith("/api/")) {
        await api.handleApiRequest(req, res, url).catch((error) => api.sendRouteError(res, error))
        return
      }
      await serveClientAsset(req, res, url, clientRoot)
    })().catch((error) => {
      sendText(res, 500, error instanceof Error ? error.message : "Request failed.")
    })
  })

  socket.installProviderSocketServer(server, {
    authenticateRequest: async (req: IncomingMessage) =>
      await auth.hasConfiguredPassword() && await auth.isRequestAuthorized(req),
  })
  chatMonitor.startChatStatusMonitor()
  scheduleMonitor.startMessageScheduleMonitor()
  pluginManager.startPluginRuntimeManager()

  server.listen(parsed.port, parsed.host, () => {
    console.log(`pockcode listening on http://${displayHost(parsed.host)}:${parsed.port}`)
    console.log("First visit will ask you to set a password if one is not configured.")
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}

async function handleAuthGate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: typeof import("../app/server/auth.server"),
): Promise<boolean> {
  if (!await auth.hasConfiguredPassword()) {
    if (url.pathname === "/auth/setup" && req.method === "POST") {
      await handlePasswordSetup(req, res, auth)
      return true
    }
    if (req.method === "GET" || req.method === "HEAD") {
      sendSetupPage(res)
      return true
    }
    sendJson(res, 428, { error: "Pockcode password setup is required." })
    return true
  }

  if (await auth.isRequestAuthorized(req)) {
    return false
  }
  res.statusCode = 401
  res.setHeader("WWW-Authenticate", `Basic realm="${auth.pockcodeAuthRealm()}", charset="UTF-8"`)
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.end("Authentication required.")
  return true
}

async function handlePasswordSetup(
  req: IncomingMessage,
  res: ServerResponse,
  auth: typeof import("../app/server/auth.server"),
) {
  const body = await readRequestBody(req, 32_000)
  const contentType = req.headers["content-type"] ?? ""
  const wantsJson = req.headers.accept?.includes("application/json") || contentType.includes("application/json")
  const password = contentType.includes("application/json")
    ? readJsonPassword(body)
    : new URLSearchParams(body).get("password") ?? ""
  try {
    await auth.setupPassword(password)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to configure password."
    if (wantsJson) {
      sendJson(res, 400, { error: message })
    } else {
      sendSetupPage(res, message, 400)
    }
    return
  }

  if (wantsJson) {
    sendJson(res, 201, { ok: true })
    return
  }
  res.statusCode = 303
  res.setHeader("Location", "/")
  res.end()
}

async function serveClientAsset(req: IncomingMessage, res: ServerResponse, url: URL, clientRoot: string) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, `${req.method ?? "METHOD"} is not supported.`)
    return
  }

  const filePath = await resolveClientPath(clientRoot, url.pathname)
  if (!filePath) {
    sendText(res, 403, "Forbidden.")
    return
  }

  const stats = await stat(filePath).catch(() => null)
  const targetPath = stats?.isFile() ? filePath : resolve(clientRoot, "index.html")
  const targetStats = stats?.isFile() ? stats : await stat(targetPath).catch(() => null)
  if (!targetStats?.isFile()) {
    sendText(res, 404, "Pockcode client build was not found. Run pnpm build first.")
    return
  }

  res.statusCode = 200
  res.setHeader("Content-Length", String(targetStats.size))
  res.setHeader("Content-Type", contentTypeFor(targetPath))
  if (targetPath.includes(`${sep}assets${sep}`)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
  } else {
    res.setHeader("Cache-Control", "no-store")
  }
  if (req.method === "HEAD") {
    res.end()
    return
  }
  createReadStream(targetPath).pipe(res)
}

async function resolveClientPath(clientRoot: string, pathname: string): Promise<string | null> {
  let decoded = "/"
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes("\0")) {
    return null
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "")
  const filePath = resolve(clientRoot, relativePath)
  return filePath === clientRoot || filePath.startsWith(`${clientRoot}${sep}`) ? filePath : null
}

async function resolveClientRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.POCKCODE_CLIENT_DIR,
    resolve(here, "../build/client"),
    resolve(process.cwd(), "build/client"),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    const root = resolve(candidate)
    if (await stat(resolve(root, "index.html")).then((stats) => stats.isFile()).catch(() => false)) {
      return root
    }
  }
  return resolve(candidates[0] ?? "build/client")
}

async function readRequestBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      throw new Error("Request body is too large.")
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function readJsonPassword(body: string): string {
  try {
    const value = JSON.parse(body) as unknown
    return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { password?: unknown }).password === "string"
      ? (value as { password: string }).password
      : ""
  } catch {
    return ""
  }
}

function parseArgs(argv: string[]): CliOptions | "help" | "version" {
  const options: CliOptions = { host: defaultHost, port: readPort(process.env.PORT) ?? defaultPort }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      return "help"
    }
    if (arg === "--version" || arg === "-v") {
      return "version"
    }
    if (arg === "--host" || arg === "--bind" || arg === "-H") {
      options.host = readValue(argv, ++index, arg)
      continue
    }
    if (arg.startsWith("--host=") || arg.startsWith("--bind=")) {
      options.host = arg.slice(arg.indexOf("=") + 1)
      continue
    }
    if (arg === "--port" || arg === "-p") {
      options.port = readPort(readValue(argv, ++index, arg)) ?? invalidPort(arg)
      continue
    }
    if (arg.startsWith("--port=")) {
      options.port = readPort(arg.slice("--port=".length)) ?? invalidPort("--port")
      continue
    }
    if (arg === "--home") {
      options.home = readValue(argv, ++index, arg)
      continue
    }
    if (arg.startsWith("--home=")) {
      options.home = arg.slice("--home=".length)
      continue
    }
    throw new Error(`Unknown option: ${arg}\n\n${helpText()}`)
  }
  return options
}

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index]
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`)
  }
  return value
}

function readPort(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const port = Number.parseInt(value, 10)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
}

function invalidPort(option: string): never {
  throw new Error(`${option} requires a port between 1 and 65535.`)
}

function sendSetupPage(res: ServerResponse, error?: string, status = 200): void {
  res.statusCode = status
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>pockcode setup</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0f1115; color: #f6f7fb; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #2a2f3a; border-radius: 10px; background: #161922; padding: 24px; box-shadow: 0 24px 80px rgb(0 0 0 / 0.35); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 18px; color: #aeb6c5; font-size: 14px; line-height: 1.5; }
    label { display: grid; gap: 8px; font-size: 13px; font-weight: 600; }
    input { height: 38px; border-radius: 8px; border: 1px solid #343b49; background: #0f1115; color: #f6f7fb; padding: 0 12px; font: inherit; }
    button { margin-top: 16px; height: 38px; width: 100%; border: 0; border-radius: 8px; background: #f6f7fb; color: #111318; font-weight: 700; cursor: pointer; }
    .error { margin-bottom: 14px; color: #ff9a9a; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>Set up pockcode</h1>
    <p>Create the password used for HTTP Basic authentication.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/auth/setup">
      <label>
        Password
        <input name="password" type="password" minlength="8" autocomplete="new-password" autofocus required />
      </label>
      <button type="submit">Save password</button>
    </form>
  </main>
</body>
</html>`)
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.writableEnded) {
    return
  }
  res.statusCode = status
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.end(text)
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath)
  if (extension === ".html") return "text/html; charset=utf-8"
  if (extension === ".css") return "text/css; charset=utf-8"
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8"
  if (extension === ".json") return "application/json; charset=utf-8"
  if (extension === ".svg") return "image/svg+xml"
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".webp") return "image/webp"
  if (extension === ".woff2") return "font/woff2"
  return "application/octet-stream"
}

function displayHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host
}

async function readPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const packagePath = resolve(here, "../package.json")
  const value = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string }
  return value.version ?? "0.0.0"
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function helpText(): string {
  return `Usage: pockcode [options]

Options:
  -H, --host, --bind <host>  Host/interface to bind (default: ${defaultHost})
  -p, --port <port>          Port to listen on (default: ${defaultPort})
      --home <path>          Pockcode data directory (default: ~/.pockcode)
  -v, --version              Print version
  -h, --help                 Print help
`
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
