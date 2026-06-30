import type { Server as HttpServer } from "node:http"
import { Server } from "socket.io"
import { installTerminalSocketHandlers } from "./terminal.server"

export type ProviderSocketEvent = {
  payload: unknown
  threadId?: string
  type: string
}

const installedServers = new WeakSet<HttpServer>()
const providerEventListeners = new Set<(event: ProviderSocketEvent) => Promise<void> | void>()
const workspaceWatchListeners = new Set<() => void>()
const workspacePathsBySocket = new Map<string, Set<string>>()
let io: Server | null = null

export function installProviderSocketServer(server: HttpServer): void {
  if (installedServers.has(server)) {
    return
  }
  installedServers.add(server)
  io = new Server(server, {
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  })
  io.on("connection", (socket) => {
    installTerminalSocketHandlers(socket)
    socket.on("chat.join", (threadId: string) => {
      if (threadId) {
        socket.join(chatRoom(threadId))
      }
    })
    socket.on("workspace.join", (workspacePath: string) => {
      const path = normalizeWorkspacePath(workspacePath)
      if (!path) {
        return
      }
      const paths = workspacePathsBySocket.get(socket.id) ?? new Set<string>()
      paths.add(path)
      workspacePathsBySocket.set(socket.id, paths)
      notifyWorkspaceWatchListeners()
    })
    socket.on("workspace.leave", (workspacePath: string) => {
      const path = normalizeWorkspacePath(workspacePath)
      if (!path) {
        return
      }
      const paths = workspacePathsBySocket.get(socket.id)
      paths?.delete(path)
      if (!paths?.size) {
        workspacePathsBySocket.delete(socket.id)
      }
      notifyWorkspaceWatchListeners()
    })
    socket.on("chat.leave", (threadId: string) => {
      if (threadId) {
        socket.leave(chatRoom(threadId))
      }
    })
    socket.on("disconnect", () => {
      if (workspacePathsBySocket.delete(socket.id)) {
        notifyWorkspaceWatchListeners()
      }
    })
  })
}

export function listWatchedWorkspacePaths(): string[] {
  const paths = new Set<string>()
  for (const socketPaths of workspacePathsBySocket.values()) {
    for (const path of socketPaths) {
      paths.add(path)
    }
  }
  return [...paths]
}

export function onWorkspaceWatchChange(listener: () => void): void {
  workspaceWatchListeners.add(listener)
}

export function onProviderEvent(listener: (event: ProviderSocketEvent) => Promise<void> | void): () => void {
  providerEventListeners.add(listener)
  return () => {
    providerEventListeners.delete(listener)
  }
}

export function publishProviderEvent(event: ProviderSocketEvent): void {
  for (const listener of providerEventListeners) {
    Promise.resolve(listener(event)).catch(() => undefined)
  }
  if (!io) {
    return
  }
  if (event.threadId) {
    io.to(chatRoom(event.threadId)).emit(event.type, event.payload)
  }
  if (isChatDeltaEvent(event.type)) {
    return
  }
  io.emit("provider.event", event)
}

function chatRoom(threadId: string): string {
  return `chat:${threadId}`
}

function isChatDeltaEvent(type: string): boolean {
  return type === "message.created" || type === "message.deleted" || type === "messages.replaced"
}

function normalizeWorkspacePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function notifyWorkspaceWatchListeners(): void {
  for (const listener of workspaceWatchListeners) {
    listener()
  }
}
