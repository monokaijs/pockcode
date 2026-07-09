import { randomUUID } from "node:crypto"
import { chmodSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import type { IDisposable, IPty } from "node-pty"
import * as pty from "node-pty"
import type { Socket } from "socket.io"
import { resolveWorkspaceDirectoryPath } from "./workspaces.server"

type HostedTerminalStatus = "exited" | "running"

type HostedTerminal = {
  cwd: string
  dataListener: IDisposable | null
  exitCode: number | null
  exitListener: IDisposable | null
  id: string
  name: string
  output: string
  process: IPty | null
  shell: string
  signal: number | null
  status: HostedTerminalStatus
  workspacePath: string
}

type TerminalMetadata = {
  cwd: string
  exitCode: number | null
  id: string
  name: string
  shell: string
  status: HostedTerminalStatus
  workspacePath: string
}

type TerminalSnapshot = TerminalMetadata & {
  output: string
}

type TerminalAck =
  | ((response: { ok: true; terminal: TerminalMetadata } | { error: string; ok: false }) => void)
  | undefined

type TerminalAttachAck =
  | ((response: { ok: true; terminals: TerminalSnapshot[]; workspacePath: string } | { error: string; ok: false }) => void)
  | undefined

const TERMINAL_OUTPUT_LIMIT = 260_000

const terminalSessionsById = new Map<string, HostedTerminal>()
const terminalIdsByWorkspacePath = new Map<string, Set<string>>()
const terminalWorkspaceBySocket = new Map<string, string>()
const require = createRequire(import.meta.url)
let nodePtyHelperChecked = false

export function installTerminalSocketHandlers(socket: Socket): void {
  socket.on("terminal.attach", (payload: unknown, reply?: TerminalAttachAck) => {
    void attachTerminalWorkspace(socket, payload, reply)
  })

  socket.on("terminal.detach", (payload: unknown) => {
    void detachTerminalWorkspace(socket, payload)
  })

  socket.on("terminal.create", (payload: unknown, reply?: TerminalAck) => {
    void createTerminal(socket, payload, reply)
  })

  socket.on("terminal.input", (payload: unknown) => {
    const record = readRecord(payload)
    const terminalId = readString(record.id)
    const data = readString(record.data)
    if (!terminalId || data === undefined) {
      return
    }
    const session = terminalSessionsById.get(terminalId)
    if (session?.status === "running") {
      session.process?.write(data)
    }
  })

  socket.on("terminal.resize", (payload: unknown) => {
    const record = readRecord(payload)
    const terminalId = readString(record.id)
    const cols = readInt(record.cols, 80, 2, 500)
    const rows = readInt(record.rows, 24, 2, 200)
    if (!terminalId) {
      return
    }
    const session = terminalSessionsById.get(terminalId)
    if (session?.status === "running") {
      session.process?.resize(cols, rows)
    }
  })

  socket.on("terminal.close", (payload: unknown) => {
    const terminalId = readString(readRecord(payload).id)
    if (!terminalId) {
      return
    }
    const session = terminalSessionsById.get(terminalId)
    if (!session) {
      return
    }
    removeHostedTerminal(session)
    emitTerminalEvent(socket, session.workspacePath, "terminal.closed", { id: terminalId, workspacePath: session.workspacePath })
  })

  socket.on("disconnect", () => {
    terminalWorkspaceBySocket.delete(socket.id)
  })
}

export function closeAllHostedTerminals(): void {
  for (const session of terminalSessionsById.values()) {
    try {
      closeHostedTerminal(session)
    } catch {
      // Shutdown should continue even if a terminal has already exited.
    }
  }
  terminalSessionsById.clear()
  terminalIdsByWorkspacePath.clear()
  terminalWorkspaceBySocket.clear()
}

async function attachTerminalWorkspace(
  socket: Socket,
  payload: unknown,
  reply: TerminalAttachAck,
) {
  try {
    const workspacePath = await resolveTerminalWorkspacePath(payload)
    joinTerminalWorkspace(socket, workspacePath)
    reply?.({
      ok: true,
      terminals: listTerminalSnapshots(workspacePath),
      workspacePath,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to attach terminal workspace."
    reply?.({ error: message, ok: false })
    socket.emit("terminal.error", { error: message })
  }
}

async function detachTerminalWorkspace(socket: Socket, payload: unknown) {
  const attachedWorkspacePath = terminalWorkspaceBySocket.get(socket.id)
  if (!attachedWorkspacePath) {
    return
  }

  const requestedWorkspacePath = readString(readRecord(payload).workspacePath)
  if (requestedWorkspacePath) {
    try {
      const workspacePath = await resolveWorkspaceDirectoryPath(requestedWorkspacePath)
      if (workspacePath !== attachedWorkspacePath) {
        return
      }
    } catch {
      return
    }
  }

  terminalWorkspaceBySocket.delete(socket.id)
  socket.leave(terminalRoom(attachedWorkspacePath))
}

async function createTerminal(
  socket: Socket,
  payload: unknown,
  reply: TerminalAck,
) {
  try {
    const record = readRecord(payload)
    const cwd = await resolveWorkspaceDirectoryPath(readString(record.workspacePath) ?? null)
    joinTerminalWorkspace(socket, cwd)
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
      dataListener: null,
      exitCode: null,
      exitListener: null,
      id,
      name,
      output: "",
      process: terminal,
      shell,
      signal: null,
      status: "running",
      workspacePath: cwd,
    }

    session.dataListener = terminal.onData((data) => {
      appendTerminalOutput(session, data)
      emitTerminalEvent(socket, session.workspacePath, "terminal.output", { data, id, workspacePath: session.workspacePath })
    })
    session.exitListener = terminal.onExit(({ exitCode, signal }) => {
      session.status = "exited"
      session.exitCode = exitCode
      session.signal = signal ?? null
      session.process = null
      disposeTerminalListeners(session)
      const exitMessage = `\r\n[process exited${exitCode === null ? "" : ` with code ${exitCode}`}]\r\n`
      appendTerminalOutput(session, exitMessage)
      emitTerminalEvent(socket, session.workspacePath, "terminal.output", {
        data: exitMessage,
        id,
        workspacePath: session.workspacePath,
      })
      emitTerminalEvent(socket, session.workspacePath, "terminal.exit", {
        exitCode,
        id,
        signal,
        workspacePath: session.workspacePath,
      })
    })
    addHostedTerminal(session)

    const metadata = terminalMetadata(session)
    reply?.({ ok: true, terminal: metadata })
    emitTerminalEvent(socket, session.workspacePath, "terminal.created", metadata)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start terminal."
    reply?.({ error: message, ok: false })
    socket.emit("terminal.error", { error: message })
  }
}

function closeHostedTerminal(session: HostedTerminal) {
  disposeTerminalListeners(session)
  session.process?.kill()
  session.process = null
}

function addHostedTerminal(session: HostedTerminal) {
  terminalSessionsById.set(session.id, session)
  const workspaceTerminals = terminalIdsByWorkspacePath.get(session.workspacePath) ?? new Set<string>()
  workspaceTerminals.add(session.id)
  terminalIdsByWorkspacePath.set(session.workspacePath, workspaceTerminals)
}

function removeHostedTerminal(session: HostedTerminal) {
  terminalSessionsById.delete(session.id)
  const workspaceTerminals = terminalIdsByWorkspacePath.get(session.workspacePath)
  workspaceTerminals?.delete(session.id)
  if (!workspaceTerminals?.size) {
    terminalIdsByWorkspacePath.delete(session.workspacePath)
  }
  closeHostedTerminal(session)
}

function disposeTerminalListeners(session: HostedTerminal) {
  session.dataListener?.dispose()
  session.exitListener?.dispose()
  session.dataListener = null
  session.exitListener = null
}

function appendTerminalOutput(session: HostedTerminal, data: string) {
  const output = session.output + data
  session.output = output.length > TERMINAL_OUTPUT_LIMIT ? output.slice(-TERMINAL_OUTPUT_LIMIT) : output
}

function emitTerminalEvent(socket: Socket, workspacePath: string, event: string, payload: unknown) {
  socket.nsp.to(terminalRoom(workspacePath)).emit(event, payload)
}

function joinTerminalWorkspace(socket: Socket, workspacePath: string) {
  const previousWorkspacePath = terminalWorkspaceBySocket.get(socket.id)
  if (previousWorkspacePath && previousWorkspacePath !== workspacePath) {
    socket.leave(terminalRoom(previousWorkspacePath))
  }
  terminalWorkspaceBySocket.set(socket.id, workspacePath)
  socket.join(terminalRoom(workspacePath))
}

function listTerminalSnapshots(workspacePath: string): TerminalSnapshot[] {
  return [...(terminalIdsByWorkspacePath.get(workspacePath) ?? [])]
    .map((id) => terminalSessionsById.get(id))
    .filter((session): session is HostedTerminal => Boolean(session))
    .map((session) => ({ ...terminalMetadata(session), output: session.output }))
}

async function resolveTerminalWorkspacePath(payload: unknown) {
  return resolveWorkspaceDirectoryPath(readString(readRecord(payload).workspacePath) ?? null)
}

function terminalRoom(workspacePath: string) {
  return `terminal:${workspacePath}`
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
    exitCode: session.exitCode,
    id: session.id,
    name: session.name,
    shell: session.shell,
    status: session.status,
    workspacePath: session.workspacePath,
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
