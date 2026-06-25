import { access } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { WebSocket } from "ws"
import { HttpError } from "./http.server"
import { resolveWorkspaceDirectoryPath } from "./workspaces.server"

const require = createRequire(import.meta.url)
const runningSessions = new Map<string, number>()

type LanguageServerCommand =
  | { kind: "bundled"; packageName: string; binName: string; args?: string[] }
  | { kind: "external"; command: string; args?: string[] }

type LanguageServerDefinition = {
  command: LanguageServerCommand
  displayName: string
  extensions: string[]
  id: string
  languages: string[]
}

export type LanguageServerInfo = {
  available: boolean
  command: string
  displayName: string
  extensions: string[]
  id: string
  languages: string[]
  message?: string
  running: number
}

type ResolvedLanguageServer = LanguageServerDefinition & {
  resolvedCommand: {
    args: string[]
    command: string
  }
}

type LspSession = {
  close: () => void
}

const languageServers: LanguageServerDefinition[] = [
  {
    command: {
      kind: "bundled",
      packageName: "typescript-language-server",
      binName: "typescript-language-server",
      args: ["--stdio"],
    },
    displayName: "TypeScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    id: "typescript",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  },
  {
    command: {
      kind: "bundled",
      packageName: "vscode-langservers-extracted",
      binName: "vscode-json-language-server",
      args: ["--stdio"],
    },
    displayName: "JSON",
    extensions: [".json", ".jsonc"],
    id: "json",
    languages: ["json"],
  },
  {
    command: {
      kind: "bundled",
      packageName: "vscode-langservers-extracted",
      binName: "vscode-css-language-server",
      args: ["--stdio"],
    },
    displayName: "CSS",
    extensions: [".css", ".scss", ".sass", ".less"],
    id: "css",
    languages: ["css", "scss", "sass", "less"],
  },
  {
    command: {
      kind: "bundled",
      packageName: "vscode-langservers-extracted",
      binName: "vscode-html-language-server",
      args: ["--stdio"],
    },
    displayName: "HTML",
    extensions: [".html", ".htm"],
    id: "html",
    languages: ["html"],
  },
  {
    command: { kind: "external", command: "pyright-langserver", args: ["--stdio"] },
    displayName: "Python",
    extensions: [".py", ".pyi"],
    id: "python",
    languages: ["python"],
  },
  {
    command: { kind: "external", command: "rust-analyzer" },
    displayName: "Rust",
    extensions: [".rs"],
    id: "rust",
    languages: ["rust"],
  },
  {
    command: { kind: "external", command: "gopls" },
    displayName: "Go",
    extensions: [".go"],
    id: "go",
    languages: ["go"],
  },
  {
    command: { kind: "external", command: "clangd" },
    displayName: "C/C++",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
    id: "clangd",
    languages: ["c", "cpp"],
  },
]

export async function listLanguageServers(inputWorkspacePath: string | null): Promise<LanguageServerInfo[]> {
  await resolveWorkspaceDirectoryPath(inputWorkspacePath)
  return Promise.all(languageServers.map(async (server) => {
    const resolved = await resolveLanguageServer(server)
    return {
      available: Boolean(resolved),
      command: resolved ? [resolved.resolvedCommand.command, ...resolved.resolvedCommand.args].join(" ") : commandLabel(server.command),
      displayName: server.displayName,
      extensions: server.extensions,
      id: server.id,
      languages: server.languages,
      message: resolved ? undefined : unavailableMessage(server.command),
      running: runningSessions.get(server.id) ?? 0,
    }
  }))
}

export async function createLanguageServerWebSocketSession({
  serverId,
  socket,
  workspacePath,
}: {
  serverId: string | null
  socket: WebSocket
  workspacePath: string | null
}): Promise<LspSession> {
  const resolvedWorkspacePath = await resolveWorkspaceDirectoryPath(workspacePath)
  const definition = languageServers.find((server) => server.id === serverId)
  if (!definition) {
    throw new HttpError(404, "Language server not found.")
  }

  const server = await resolveLanguageServer(definition)
  if (!server) {
    throw new HttpError(404, unavailableMessage(definition.command))
  }

  const child = spawn(server.resolvedCommand.command, server.resolvedCommand.args, {
    cwd: resolvedWorkspacePath,
    env: process.env,
    stdio: "pipe",
  })
  incrementRunning(definition.id)

  let closed = false
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    decrementRunning(definition.id)
    if (child.exitCode === null && !child.killed) {
      child.kill()
    }
  }

  const parser = createLanguageServerParser((message) => {
    if (socket.readyState === 1) {
      socket.send(message)
    }
  })

  child.stdout.on("data", (chunk: Buffer) => parser.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim()
    if (text && socket.readyState === 1) {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "window/logMessage",
        params: { message: text, type: 3 },
      }))
    }
  })
  child.on("error", () => {
    if (socket.readyState === 1) {
      socket.close(1011, "Language server failed.")
    }
    close()
  })
  child.on("exit", () => {
    if (socket.readyState === 1) {
      socket.close(1000, "Language server exited.")
    }
    close()
  })
  socket.on("message", (data) => {
    if (closed) {
      return
    }
    writeLanguageServerMessage(child, data.toString())
  })
  socket.on("close", close)
  socket.on("error", close)

  return { close }
}

async function resolveLanguageServer(server: LanguageServerDefinition): Promise<ResolvedLanguageServer | null> {
  const resolvedCommand = await resolveCommand(server.command)
  return resolvedCommand ? { ...server, resolvedCommand } : null
}

async function resolveCommand(command: LanguageServerCommand): Promise<{ command: string; args: string[] } | null> {
  if (command.kind === "external") {
    return await findExecutable(command.command)
      ? { command: command.command, args: command.args ?? [] }
      : null
  }

  const binPath = bundledBinPath(command.packageName, command.binName)
  if (!binPath || !(await canReadFile(binPath))) {
    return null
  }
  return { command: process.execPath, args: [binPath, ...(command.args ?? [])] }
}

function bundledBinPath(packageName: string, binName: string): string | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`)
    const packageJson = require(packageJsonPath) as { bin?: string | Record<string, string> }
    const binEntry = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[binName]
    return binEntry ? path.join(path.dirname(packageJsonPath), binEntry) : null
  } catch {
    return null
  }
}

async function findExecutable(command: string): Promise<boolean> {
  const pathValue = process.env.PATH
  if (!pathValue) {
    return false
  }

  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""]
  for (const directory of pathValue.split(path.delimiter)) {
    for (const extension of extensions) {
      if (await canExecuteFile(path.join(directory, `${command}${extension}`))) {
        return true
      }
    }
  }
  return false
}

async function canReadFile(inputPath: string): Promise<boolean> {
  try {
    await access(inputPath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function canExecuteFile(inputPath: string): Promise<boolean> {
  try {
    await access(inputPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function commandLabel(command: LanguageServerCommand): string {
  if (command.kind === "external") {
    return [command.command, ...(command.args ?? [])].join(" ")
  }
  return [command.binName, ...(command.args ?? [])].join(" ")
}

function unavailableMessage(command: LanguageServerCommand): string {
  return command.kind === "external"
    ? `${command.command} was not found on PATH.`
    : `${command.binName} is not installed.`
}

function incrementRunning(serverId: string): void {
  runningSessions.set(serverId, (runningSessions.get(serverId) ?? 0) + 1)
}

function decrementRunning(serverId: string): void {
  const next = Math.max(0, (runningSessions.get(serverId) ?? 1) - 1)
  if (next) {
    runningSessions.set(serverId, next)
    return
  }
  runningSessions.delete(serverId)
}

function writeLanguageServerMessage(child: ChildProcessWithoutNullStreams, message: string): void {
  const body = message.trim()
  if (!body) {
    return
  }
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`)
}

function createLanguageServerParser(onMessage: (message: string) => void) {
  let buffer = Buffer.alloc(0)

  return {
    push(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length) {
        const headerEnd = buffer.indexOf("\r\n\r\n")
        if (headerEnd === -1) {
          return
        }

        const header = buffer.slice(0, headerEnd).toString("utf8")
        const length = readContentLength(header)
        if (length === null) {
          buffer = buffer.slice(headerEnd + 4)
          continue
        }

        const messageStart = headerEnd + 4
        const messageEnd = messageStart + length
        if (buffer.length < messageEnd) {
          return
        }

        onMessage(buffer.slice(messageStart, messageEnd).toString("utf8"))
        buffer = buffer.slice(messageEnd)
      }
    },
  }
}

function readContentLength(header: string): number | null {
  const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)
  if (!match) {
    return null
  }
  const length = Number.parseInt(match[1], 10)
  return Number.isFinite(length) ? length : null
}
