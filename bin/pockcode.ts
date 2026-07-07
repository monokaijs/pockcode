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
  const hasPassword = await auth.hasConfiguredPassword()
  if (!hasPassword) {
    if (url.pathname === "/auth/setup" && req.method === "POST") {
      await handlePasswordSetup(req, res, auth)
      return true
    }
    if (req.method === "GET" || req.method === "HEAD") {
      sendSetupPage(res, { returnTo: returnToFor(url) })
      return true
    }
    sendJson(res, 428, { error: "Pockcode password setup is required." })
    return true
  }

  if (url.pathname === "/auth/login" && req.method === "POST") {
    await handlePasswordLogin(req, res, auth)
    return true
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    handlePasswordLogout(req, res, auth)
    return true
  }

  if (await auth.isRequestAuthorized(req)) {
    if (url.pathname === "/auth/login" && (req.method === "GET" || req.method === "HEAD")) {
      redirect(res, safeReturnTo(url.searchParams.get("returnTo")))
      return true
    }
    return false
  }

  if (url.pathname === "/auth/login" && (req.method === "GET" || req.method === "HEAD")) {
    sendLoginPage(res, { returnTo: safeReturnTo(url.searchParams.get("returnTo")) })
    return true
  }
  if (url.pathname.startsWith("/api/") || requestWantsJson(req) || (req.method !== "GET" && req.method !== "HEAD")) {
    sendJson(res, 401, { error: "Authentication required." })
    return true
  }

  sendLoginPage(res, { returnTo: returnToFor(url) }, 401)
  return true
}

async function handlePasswordSetup(
  req: IncomingMessage,
  res: ServerResponse,
  auth: typeof import("../app/server/auth.server"),
) {
  const body = await readRequestBody(req, 32_000)
  const wantsJson = requestWantsJson(req)
  const { confirmPassword, password, returnTo } = readPasswordBody(req, body)
  if (confirmPassword !== undefined && password !== confirmPassword) {
    const message = "Passwords do not match."
    if (wantsJson) {
      sendJson(res, 400, { error: message })
    } else {
      sendSetupPage(res, { error: message, returnTo }, 400)
    }
    return
  }
  try {
    await auth.setupPassword(password)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to configure password."
    if (wantsJson) {
      sendJson(res, 400, { error: message })
    } else {
      sendSetupPage(res, { error: message, returnTo }, 400)
    }
    return
  }

  res.setHeader("Set-Cookie", await auth.createSessionCookie(req))
  if (wantsJson) {
    sendJson(res, 201, { ok: true })
    return
  }
  redirect(res, returnTo)
}

async function handlePasswordLogin(
  req: IncomingMessage,
  res: ServerResponse,
  auth: typeof import("../app/server/auth.server"),
) {
  const body = await readRequestBody(req, 32_000)
  const wantsJson = requestWantsJson(req)
  const { password, returnTo } = readPasswordBody(req, body)

  if (!await auth.verifyPassword(password)) {
    const message = "Password is not correct."
    if (wantsJson) {
      sendJson(res, 401, { error: message })
    } else {
      sendLoginPage(res, { error: message, returnTo }, 401)
    }
    return
  }

  res.setHeader("Set-Cookie", await auth.createSessionCookie(req))
  if (wantsJson) {
    sendJson(res, 200, { ok: true })
    return
  }
  redirect(res, returnTo)
}

function handlePasswordLogout(
  req: IncomingMessage,
  res: ServerResponse,
  auth: typeof import("../app/server/auth.server"),
): void {
  res.setHeader("Set-Cookie", auth.clearSessionCookie())
  if (requestWantsJson(req)) {
    sendJson(res, 200, { ok: true })
    return
  }
  redirect(res, "/auth/login")
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

function readPasswordBody(req: IncomingMessage, body: string): {
  confirmPassword?: string
  password: string
  returnTo: string
} {
  if (headerIncludes(req.headers["content-type"], "application/json")) {
    return readJsonPasswordBody(body)
  }

  const values = new URLSearchParams(body)
  return {
    confirmPassword: values.get("confirmPassword") ?? undefined,
    password: values.get("password") ?? "",
    returnTo: safeReturnTo(values.get("returnTo")),
  }
}

function readJsonPasswordBody(body: string): {
  confirmPassword?: string
  password: string
  returnTo: string
} {
  try {
    const value = JSON.parse(body) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { password: "", returnTo: "/" }
    }
    const record = value as { confirmPassword?: unknown; password?: unknown; returnTo?: unknown }
    return {
      confirmPassword: typeof record.confirmPassword === "string" ? record.confirmPassword : undefined,
      password: typeof record.password === "string" ? record.password : "",
      returnTo: safeReturnTo(typeof record.returnTo === "string" ? record.returnTo : null),
    }
  } catch {
    return { password: "", returnTo: "/" }
  }
}

function requestWantsJson(req: IncomingMessage): boolean {
  return headerIncludes(req.headers.accept, "application/json") ||
    headerIncludes(req.headers["content-type"], "application/json")
}

function headerIncludes(value: string | string[] | undefined, needle: string): boolean {
  const normalizedNeedle = needle.toLowerCase()
  return (Array.isArray(value) ? value.join(",") : value ?? "").toLowerCase().includes(normalizedNeedle)
}

function redirect(res: ServerResponse, location: string, status = 303): void {
  res.statusCode = status
  res.setHeader("Location", location)
  res.end()
}

function returnToFor(url: URL): string {
  if (url.pathname === "/auth/login" || url.pathname === "/auth/setup" || url.pathname === "/auth/logout") {
    return safeReturnTo(url.searchParams.get("returnTo"))
  }
  return safeReturnTo(`${url.pathname}${url.search}`)
}

function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\0")) {
    return "/"
  }
  return value
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

type AuthPageOptions = {
  error?: string
  returnTo: string
}

function sendSetupPage(res: ServerResponse, options: AuthPageOptions, status = 200): void {
  sendAuthPage(res, {
    ...options,
    action: "/auth/setup",
    confirmPassword: true,
    heading: "Create local password",
    lead: "Choose the password for this pockcode workspace.",
    passwordAutocomplete: "new-password",
    submitLabel: "Save and continue",
    title: "pockcode setup",
  }, status)
}

function sendLoginPage(res: ServerResponse, options: AuthPageOptions, status = 200): void {
  sendAuthPage(res, {
    ...options,
    action: "/auth/login",
    confirmPassword: false,
    heading: "Sign in",
    lead: "Enter the local password for this pockcode workspace.",
    passwordAutocomplete: "current-password",
    submitLabel: "Continue",
    title: "pockcode login",
  }, status)
}

function sendAuthPage(
  res: ServerResponse,
  options: AuthPageOptions & {
    action: string
    confirmPassword: boolean
    heading: string
    lead: string
    passwordAutocomplete: "current-password" | "new-password"
    submitLabel: string
    title: string
  },
  status = 200,
): void {
  res.statusCode = status
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #111314;
      color: #f3f4ef;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background:
        linear-gradient(90deg, rgb(255 255 255 / 0.03) 1px, transparent 1px),
        linear-gradient(180deg, rgb(255 255 255 / 0.03) 1px, transparent 1px),
        #111314;
      background-size: 42px 42px;
      color: #f3f4ef;
    }
    main {
      width: min(880px, calc(100vw - 32px));
      min-height: 520px;
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(340px, 1fr);
      overflow: hidden;
      border: 1px solid #303433;
      border-radius: 8px;
      background: #181b1b;
      box-shadow: 0 28px 90px rgb(0 0 0 / 0.42);
    }
    .brand {
      display: flex;
      min-height: 100%;
      flex-direction: column;
      justify-content: space-between;
      border-right: 1px solid #303433;
      background: #151716;
      padding: 28px;
    }
    .mark {
      display: grid;
      width: 40px;
      height: 40px;
      place-items: center;
      border: 1px solid #3d4641;
      border-radius: 8px;
      background: #d7ff6b;
      color: #111314;
      font-weight: 800;
      letter-spacing: 0;
    }
    .brand h1 {
      margin: 18px 0 6px;
      font-size: 30px;
      line-height: 1;
      letter-spacing: 0;
    }
    .brand p, .panel p {
      margin: 0;
      color: #aeb7b1;
      font-size: 14px;
      line-height: 1.55;
    }
    .console {
      display: grid;
      gap: 10px;
      margin-top: 30px;
      color: #cfd7d1;
      font-family: "SFMono-Regular", "Menlo", "Monaco", "Consolas", monospace;
      font-size: 12px;
    }
    .console div {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      border-bottom: 1px solid #2a2e2c;
      padding-bottom: 10px;
    }
    .console span:last-child { color: #d7ff6b; }
    .panel {
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 44px;
      background: #1c2020;
    }
    .eyebrow {
      margin-bottom: 10px;
      color: #8fd0ff;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 26px;
      line-height: 1.12;
      letter-spacing: 0;
    }
    form {
      display: grid;
      gap: 14px;
      margin-top: 28px;
    }
    label {
      display: grid;
      gap: 8px;
      color: #f3f4ef;
      font-size: 13px;
      font-weight: 650;
    }
    input {
      width: 100%;
      height: 42px;
      border: 1px solid #3a4140;
      border-radius: 6px;
      background: #111314;
      color: #f3f4ef;
      padding: 0 12px;
      font: inherit;
      outline: none;
    }
    input:focus {
      border-color: #8fd0ff;
      box-shadow: 0 0 0 3px rgb(143 208 255 / 0.18);
    }
    button {
      height: 42px;
      border: 0;
      border-radius: 6px;
      background: #d7ff6b;
      color: #111314;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
    }
    button:focus-visible {
      outline: 3px solid rgb(143 208 255 / 0.38);
      outline-offset: 2px;
    }
    .error {
      margin-top: 18px;
      border: 1px solid #8d3d3d;
      border-radius: 6px;
      background: #351c1e;
      color: #ffb9b9;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.45;
    }
    @media (max-width: 760px) {
      body { place-items: stretch; background-size: 34px 34px; }
      main {
        width: 100%;
        min-height: 100vh;
        grid-template-columns: 1fr;
        border: 0;
        border-radius: 0;
      }
      .brand {
        min-height: auto;
        border-right: 0;
        border-bottom: 1px solid #303433;
        padding: 24px;
      }
      .brand h1 { font-size: 26px; }
      .console { display: none; }
      .panel {
        justify-content: start;
        padding: 28px 24px;
      }
    }
  </style>
</head>
<body>
  <main>
    <section class="brand" aria-label="pockcode">
      <div>
        <div class="mark">pc</div>
        <h1>pockcode</h1>
        <p>Local access for your workspace.</p>
      </div>
      <div class="console" aria-hidden="true">
        <div><span>host</span><span>localhost</span></div>
        <div><span>session</span><span>locked</span></div>
        <div><span>auth</span><span>local</span></div>
      </div>
    </section>
    <section class="panel">
      <div class="eyebrow">Workspace auth</div>
      <h2>${escapeHtml(options.heading)}</h2>
      <p>${escapeHtml(options.lead)}</p>
      ${options.error ? `<div class="error" role="alert">${escapeHtml(options.error)}</div>` : ""}
      <form method="post" action="${escapeHtml(options.action)}">
        <input name="returnTo" type="hidden" value="${escapeHtml(options.returnTo)}" />
      <label>
        Password
          <input name="password" type="password" minlength="8" autocomplete="${options.passwordAutocomplete}" autofocus required />
      </label>
        ${options.confirmPassword ? `<label>
          Confirm password
          <input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required />
        </label>` : ""}
        <button type="submit">${escapeHtml(options.submitLabel)}</button>
      </form>
    </section>
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
