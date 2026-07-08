import { randomUUID } from "node:crypto"
import { chmodSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import type { IDisposable, IPty } from "node-pty"
import * as pty from "node-pty"
import type { Socket } from "socket.io"
import { resolveWorkspaceDirectoryPath } from "./workspaces.server"

type HostedTerminal = {
  cwd: string
  dataListener: IDisposable
  exitListener: IDisposable
  id: string
  name: string
  process: IPty
  shell: string
}

type TerminalMetadata = {
  cwd: string
  id: string
  name: string
  shell: string
}

type TerminalAck =
  | ((response: { ok: true; terminal: TerminalMetadata } | { error: string; ok: false }) => void)
  | undefined

const terminalSessionsBySocket = new Map<string, Map<string, HostedTerminal>>()
const require = createRequire(import.meta.url)
let nodePtyHelperChecked = false

export function installTerminalSocketHandlers(socket: Socket): void {
  const sessions = new Map<string, HostedTerminal>()
  terminalSessionsBySocket.set(socket.id, sessions)

  socket.on("terminal.create", (payload: unknown, reply?: TerminalAck) => {
    void createTerminal(socket, sessions, payload, reply)
  })
  socket.on("terminal.input", (payload: unknown) => {
    const record = readRecord(payload)
    const terminalId = readString(record.id)
    const data = readString(record.data)
    if (!terminalId || data === undefined) {
      return
    }
    sessions.get(terminalId)?.process.write(data)
  })
  socket.on("terminal.resize", (payload: unknown) => {
    const record = readRecord(payload)
    const terminalId = readString(record.id)
    const cols = readInt(record.cols, 80, 2, 500)
    const rows = readInt(record.rows, 24, 2, 200)
    if (!terminalId) {
      return
    }
    sessions.get(terminalId)?.process.resize(cols, rows)
  })
  socket.on("terminal.close", (payload: unknown) => {
    const terminalId = readString(readRecord(payload).id)
    if (!terminalId) {
      return
    }
    const session = sessions.get(terminalId)
    if (!session) {
      return
    }
    sessions.delete(terminalId)
    closeHostedTerminal(session)
    socket.emit("terminal.closed", { id: terminalId })
  })
  socket.on("disconnect", () => {
    for (const session of sessions.values()) {
      closeHostedTerminal(session)
    }
    sessions.clear()
    terminalSessionsBySocket.delete(socket.id)
  })
}

export function closeAllHostedTerminals(): void {
  for (const sessions of terminalSessionsBySocket.values()) {
    for (const session of sessions.values()) {
      try {
        closeHostedTerminal(session)
      } catch {
        // Shutdown should continue even if a terminal has already exited.
      }
    }
    sessions.clear()
  }
  terminalSessionsBySocket.clear()
}

async function createTerminal(
  socket: Socket,
  sessions: Map<string, HostedTerminal>,
  payload: unknown,
  reply: TerminalAck,
) {
  try {
    const record = readRecord(payload)
    const workspacePath = readString(record.workspacePath)
    const cwd = await resolveWorkspaceDirectoryPath(workspacePath ?? null)
    const cols = readInt(record.cols, 80, 2, 500)
    const rows = readInt(record.rows, 24, 2, 200)
    const shell = resolveShell()
    const name = path.basename(shell)
    ensureNodePtySpawnHelperExecutable()
    const terminal = pty.spawn(shell, [], {
      cols,
      cwd,
      env: terminalEnv(),
      name: "xterm-256color",
      rows,
    })
    const id = randomUUID()
    const session: HostedTerminal = {
      cwd,
      dataListener: terminal.onData((data) => socket.emit("terminal.output", { data, id })),
      exitListener: terminal.onExit(({ exitCode, signal }) => {
        sessions.delete(id)
        socket.emit("terminal.exit", { exitCode, id, signal })
      }),
      id,
      name,
      process: terminal,
      shell,
    }
    sessions.set(id, session)
    const metadata = terminalMetadata(session)
    reply?.({ ok: true, terminal: metadata })
    socket.emit("terminal.created", metadata)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start terminal."
    reply?.({ error: message, ok: false })
    socket.emit("terminal.error", { error: message })
  }
}

function closeHostedTerminal(session: HostedTerminal) {
  session.dataListener.dispose()
  session.exitListener.dispose()
  session.process.kill()
}

function ensureNodePtySpawnHelperExecutable() {
  if (nodePtyHelperChecked || process.platform === "win32") {
    return
  }
  nodePtyHelperChecked = true
  try {
    const packageJsonPath = require.resolve("node-pty/package.json")
    const helperPath = path.join(path.dirname(packageJsonPath), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
    const stats = statSync(helperPath)
    if ((stats.mode & 0o111) === 0) {
      chmodSync(helperPath, stats.mode | 0o111)
    }
  } catch {
    // node-pty will surface a clearer spawn error if the helper cannot be fixed.
  }
}

function terminalMetadata(session: HostedTerminal): TerminalMetadata {
  return {
    cwd: session.cwd,
    id: session.id,
    name: session.name,
    shell: session.shell,
  }
}

function resolveShell() {
  if (process.platform === "win32") {
    return process.env.ComSpec || "powershell.exe"
  }
  return process.env.SHELL || "/bin/zsh"
}

function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.COLORTERM = env.COLORTERM || "truecolor"
  env.TERM = "xterm-256color"
  env.USER = env.USER || os.userInfo().username
  return env
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}
