import { execFile, spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"
import { promisify } from "node:util"
import { HttpError } from "./http.server"

const execFileAsync = promisify(execFile)
const temporaryTunnelReadyTimeoutMs = 35_000
const maxLogLines = 80
const tryCloudflareUrlPattern = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com/iu

export type CloudflaredNamedTunnel = {
  connectionCount: number
  createdAt?: string
  id: string
  name: string
  status: "active" | "inactive" | "unknown"
}

export type CloudflaredTemporaryTunnel = {
  createdAt: string
  exitCode?: number | null
  id: string
  logs: string[]
  originUrl: string
  publicUrl?: string
  signal?: NodeJS.Signals | null
  status: "exited" | "running" | "starting" | "stopped"
  stoppedAt?: string
}

export type CloudflaredStatusResponse = {
  installed: boolean
  message?: string
  namedTunnels: CloudflaredNamedTunnel[]
  namedTunnelsAuthRequired?: boolean
  namedTunnelsError?: string
  temporaryTunnels: CloudflaredTemporaryTunnel[]
  version?: string
}

type TemporaryTunnelRecord = Omit<CloudflaredTemporaryTunnel, "logs"> & {
  child: CloudflaredTunnelProcess | null
  logs: string[]
  stopRequested: boolean
}

type CloudflaredTunnelProcess = ChildProcessByStdio<null, Readable, Readable>

const temporaryTunnels = new Map<string, TemporaryTunnelRecord>()

export async function readCloudflaredStatus(): Promise<CloudflaredStatusResponse> {
  const installation = await readCloudflaredInstallation()
  if (!installation.installed) {
    return {
      installed: false,
      message: installation.message,
      namedTunnels: [],
      temporaryTunnels: listTemporaryTunnels(),
    }
  }

  try {
    return {
      installed: true,
      namedTunnels: await listNamedTunnels(),
      temporaryTunnels: listTemporaryTunnels(),
      version: installation.version,
    }
  } catch (error) {
    const namedTunnelsAuthRequired = isMissingOriginCertError(error)
    return {
      installed: true,
      namedTunnels: [],
      namedTunnelsAuthRequired,
      namedTunnelsError: namedTunnelsAuthRequired
        ? "Named tunnels require a cloudflared origin certificate. Run `cloudflared tunnel login` or set TUNNEL_ORIGIN_CERT, then refresh. Temporary tunnels still work without named-tunnel login."
        : cleanCommandError(error, "Unable to list cloudflared tunnels."),
      temporaryTunnels: listTemporaryTunnels(),
      version: installation.version,
    }
  }
}

export async function startTemporaryCloudflaredTunnel(originUrl: string): Promise<CloudflaredStatusResponse> {
  const normalizedOriginUrl = normalizeOriginUrl(originUrl)
  await ensureCloudflaredInstalled()

  const record: TemporaryTunnelRecord = {
    child: null,
    createdAt: new Date().toISOString(),
    id: randomUUID(),
    logs: [],
    originUrl: normalizedOriginUrl,
    status: "starting",
    stopRequested: false,
  }
  temporaryTunnels.set(record.id, record)

  const child = spawn("cloudflared", ["tunnel", "--url", normalizedOriginUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  record.child = child
  attachTemporaryTunnelListeners(record, child)

  await waitForTemporaryTunnelUrl(record)
  return readCloudflaredStatus()
}

export async function stopTemporaryCloudflaredTunnel(id: string): Promise<CloudflaredStatusResponse> {
  const record = temporaryTunnels.get(id)
  if (!record) {
    throw new HttpError(404, "Temporary tunnel was not found.")
  }

  record.stopRequested = true
  record.stoppedAt = new Date().toISOString()
  record.status = "stopped"
  appendLog(record, "Stopped by Pockcode.")

  if (record.child && !record.child.killed) {
    record.child.kill("SIGTERM")
    setTimeout(() => {
      if (record.child && !record.child.killed) {
        record.child.kill("SIGKILL")
      }
    }, 2_000).unref()
  } else {
    record.status = "stopped"
    record.child = null
  }

  return readCloudflaredStatus()
}

export async function deleteNamedCloudflaredTunnel(identifier: string): Promise<CloudflaredStatusResponse> {
  const tunnelIdentifier = normalizeTunnelIdentifier(identifier)
  await ensureCloudflaredInstalled()
  await runCloudflared(["tunnel", "delete", "-f", tunnelIdentifier], 60_000)
  return readCloudflaredStatus()
}

async function readCloudflaredInstallation() {
  try {
    const result = await runCloudflared(["--version"], 10_000)
    return {
      installed: true as const,
      version: parseCloudflaredVersion(result.stdout),
    }
  } catch (error) {
    return {
      installed: false as const,
      message: cleanCommandError(error, "cloudflared is not installed or not available on PATH."),
    }
  }
}

async function ensureCloudflaredInstalled(): Promise<void> {
  const installation = await readCloudflaredInstallation()
  if (!installation.installed) {
    throw new HttpError(400, installation.message)
  }
}

async function listNamedTunnels(): Promise<CloudflaredNamedTunnel[]> {
  const result = await runCloudflared(["tunnel", "list", "--output", "json"], 30_000)
  const parsed = JSON.parse(result.stdout.trim() || "[]") as unknown
  const tunnels = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { tunnels?: unknown }).tunnels)
      ? (parsed as { tunnels: unknown[] }).tunnels
      : []

  return tunnels
    .map(readNamedTunnel)
    .filter((tunnel): tunnel is CloudflaredNamedTunnel => Boolean(tunnel))
}

function readNamedTunnel(value: unknown): CloudflaredNamedTunnel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = readRecordString(record, "id") ?? readRecordString(record, "uuid")
  if (!id) {
    return null
  }
  const name = readRecordString(record, "name") ?? id
  const createdAt = readRecordString(record, "createdAt") ?? readRecordString(record, "created_at")
  const connections = Array.isArray(record.connections) ? record.connections : []
  const rawStatus = readRecordString(record, "status")
  const status = rawStatus === "active" || rawStatus === "inactive"
    ? rawStatus
    : connections.length
      ? "active"
      : "inactive"

  return {
    connectionCount: connections.length,
    createdAt,
    id,
    name,
    status,
  }
}

function attachTemporaryTunnelListeners(record: TemporaryTunnelRecord, child: CloudflaredTunnelProcess): void {
  const handleOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8")
    appendLog(record, text)
    const match = text.match(tryCloudflareUrlPattern) ?? record.logs.join("\n").match(tryCloudflareUrlPattern)
    if (match?.[0] && !record.publicUrl) {
      record.publicUrl = match[0]
      record.status = "running"
    }
  }

  child.stdout.on("data", handleOutput)
  child.stderr.on("data", handleOutput)
  child.once("error", (error) => {
    appendLog(record, cleanCommandError(error, "cloudflared failed to start."))
    record.child = null
    record.exitCode = null
    record.status = "exited"
    record.stoppedAt = new Date().toISOString()
  })
  child.once("exit", (code, signal) => {
    record.child = null
    record.exitCode = code
    record.signal = signal
    record.status = record.stopRequested ? "stopped" : "exited"
    record.stoppedAt = new Date().toISOString()
  })
}

async function waitForTemporaryTunnelUrl(record: TemporaryTunnelRecord): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < temporaryTunnelReadyTimeoutMs) {
    if (record.publicUrl) {
      return
    }
    if (record.status === "exited" || record.status === "stopped") {
      throw new HttpError(400, lastMeaningfulLog(record) ?? "cloudflared exited before creating a temporary tunnel.")
    }
    await delay(100)
  }

  await stopTemporaryCloudflaredTunnel(record.id)
  throw new HttpError(504, "Timed out waiting for cloudflared to publish the temporary tunnel URL.")
}

async function runCloudflared(args: string[], timeout: number) {
  try {
    return await execFileAsync("cloudflared", args, {
      maxBuffer: 2 * 1024 * 1024,
      timeout,
    })
  } catch (error) {
    throw new HttpError(400, cleanCommandError(error, "cloudflared command failed."))
  }
}

function listTemporaryTunnels(): CloudflaredTemporaryTunnel[] {
  return Array.from(temporaryTunnels.values())
    .map(serializeTemporaryTunnel)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}

function serializeTemporaryTunnel(record: TemporaryTunnelRecord): CloudflaredTemporaryTunnel {
  return {
    createdAt: record.createdAt,
    exitCode: record.exitCode,
    id: record.id,
    logs: record.logs.slice(-12),
    originUrl: record.originUrl,
    publicUrl: record.publicUrl,
    signal: record.signal,
    status: record.status,
    stoppedAt: record.stoppedAt,
  }
}

function appendLog(record: TemporaryTunnelRecord, text: string): void {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  record.logs.push(...lines)
  if (record.logs.length > maxLogLines) {
    record.logs.splice(0, record.logs.length - maxLogLines)
  }
}

function lastMeaningfulLog(record: TemporaryTunnelRecord): string | null {
  return record.logs.slice().reverse().find((line) => line.trim()) ?? null
}

function normalizeOriginUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new HttpError(400, "url must be a valid http or https URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "url must use http or https.")
  }
  if (!parsed.hostname) {
    throw new HttpError(400, "url must include a host.")
  }
  return parsed.toString()
}

function normalizeTunnelIdentifier(value: string): string {
  const identifier = value.trim()
  if (!identifier) {
    throw new HttpError(400, "Tunnel id is required.")
  }
  if (identifier.length > 200 || /[\r\n]/u.test(identifier)) {
    throw new HttpError(400, "Tunnel id is invalid.")
  }
  return identifier
}

function parseCloudflaredVersion(output: string): string {
  return output.trim().replace(/^cloudflared\s+version\s+/iu, "") || "cloudflared"
}

function readRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cleanCommandError(error: unknown, fallback: string): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {}
  if (record.code === "ENOENT") {
    return "cloudflared is not installed or not available on PATH."
  }

  const cleaned = commandErrorText(error)
    .replace(/^Command failed: cloudflared[^\n]*\n?/iu, "")
    .trim()
  return formatCommandMessage(cleaned) || fallback
}

function isMissingOriginCertError(error: unknown): boolean {
  const text = commandErrorText(error).toLowerCase()
  return (
    text.includes("origin certificate") ||
    text.includes("origincert") ||
    text.includes("tunnel_origin_cert")
  )
}

function commandErrorText(error: unknown): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const stderr = typeof record.stderr === "string" ? record.stderr : ""
  const stdout = typeof record.stdout === "string" ? record.stdout : ""
  const message = error instanceof Error ? error.message : ""
  return stderr || stdout || message
}

function formatCommandMessage(text: string): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const messages = lines.map((line) => {
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const message = (parsed as { message?: unknown }).message
        if (typeof message === "string" && message.trim()) {
          return message.trim()
        }
      }
    } catch {
      return line
    }
    return line
  })
  return messages.filter((line, index) => messages.indexOf(line) === index).join("\n")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
