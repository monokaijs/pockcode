import { watch, type FSWatcher } from "node:fs"
import { stat } from "node:fs/promises"
import { listChats, publishMessageDeltas, refreshChatStatusesForWorkspaces, syncProviderChatsOnce } from "./chats.service"
import { ensureDatabase } from "./database.server"
import { prisma } from "./prisma.server"
import { readCodexHistoryWatchPaths } from "./providers/codex.server"
import { listWatchedWorkspacePaths, onWorkspaceWatchChange, publishProviderEvent } from "./socket.server"

type ChatStatusSnapshot = {
  lastActivityAt: string
  status: string
}

const debounceMs = 250
let initialized = false
let started = false
let syncing = false
let syncAgain = false
let syncTimer: ReturnType<typeof setTimeout> | null = null
let snapshots = new Map<string, ChatStatusSnapshot>()
let pendingAllMessages = false
let pendingExternalThreadIds = new Set<string>()
const watchers = new Map<string, FSWatcher>()

export function startChatStatusMonitor(): void {
  if (started) {
    scheduleProviderSync()
    return
  }
  started = true
  onWorkspaceWatchChange(() => scheduleProviderSync())
  void refreshCodexWatchers().then(() => syncProviderState({ publishExisting: false }))
}

export function stopChatStatusMonitor(): void {
  started = false
  initialized = false
  syncAgain = false
  pendingAllMessages = false
  pendingExternalThreadIds = new Set()
  snapshots = new Map()
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
  for (const watcher of watchers.values()) {
    watcher.close()
  }
  watchers.clear()
}

function scheduleProviderSync(change?: { filename: string | Buffer | null }): void {
  if (change) {
    const threadId = readCodexThreadId(change.filename)
    if (threadId) {
      pendingExternalThreadIds.add(threadId)
    } else {
      pendingAllMessages = true
    }
  }
  if (syncTimer) {
    clearTimeout(syncTimer)
  }
  syncTimer = setTimeout(() => {
    syncTimer = null
    void syncProviderState({ publishExisting: true })
  }, debounceMs)
}

async function syncProviderState({ publishExisting }: { publishExisting: boolean }): Promise<void> {
  if (syncing) {
    syncAgain = true
    return
  }
  syncing = true
  let targetAllMessages = false
  let targetExternalThreadIds = new Set<string>()
  try {
    await refreshCodexWatchers()
    targetAllMessages = pendingAllMessages
    targetExternalThreadIds = pendingExternalThreadIds
    pendingAllMessages = false
    pendingExternalThreadIds = new Set()
    await syncProviderChatsOnce()
    let chats = await listChats()
    const statusUpdates = await refreshChatStatusesForWorkspaces(listWatchedWorkspacePaths())
    if (statusUpdates.length) {
      const statusUpdateById = new Map(statusUpdates.map((chat) => [chat.id, chat]))
      chats = chats.map((chat) => statusUpdateById.get(chat.id) ?? chat)
    }
    const nextSnapshots = new Map<string, ChatStatusSnapshot>()
    for (const chat of chats) {
      const snapshot = { lastActivityAt: chat.lastActivityAt, status: chat.status }
      const previous = snapshots.get(chat.id)
      nextSnapshots.set(chat.id, snapshot)
      const changed = !previous || previous.status !== snapshot.status || previous.lastActivityAt !== snapshot.lastActivityAt
      const targeted = chat.externalThreadId ? targetExternalThreadIds.has(chat.externalThreadId) : false
      if (changed) {
        publishProviderEvent({ threadId: chat.id, type: "chat.updated", payload: chat })
      }
      if (initialized && (publishExisting || previous) && (changed || targeted || targetAllMessages || snapshot.status === "RUNNING")) {
        await publishMessageDeltas(chat.id)
      }
    }
    snapshots = nextSnapshots
    initialized = true
  } catch {
    pendingAllMessages = pendingAllMessages || targetAllMessages
    for (const threadId of targetExternalThreadIds) {
      pendingExternalThreadIds.add(threadId)
    }
    // File watcher sync is best-effort; direct API requests still surface failures.
  } finally {
    syncing = false
    if (syncAgain) {
      syncAgain = false
      scheduleProviderSync()
    }
  }
}

async function refreshCodexWatchers(): Promise<void> {
  await ensureDatabase()
  const accounts = await prisma.providerAccount.findMany({
    orderBy: { createdAt: "asc" },
    where: { providerId: "codex", status: "CONNECTED" },
  })
  const paths = new Set(readCodexHistoryWatchPaths())
  for (const account of accounts) {
    for (const path of readCodexHistoryWatchPaths(account)) {
      paths.add(path)
    }
  }
  for (const path of paths) {
    await watchCodexPath(path)
  }
}

async function watchCodexPath(path: string): Promise<void> {
  if (watchers.has(path)) {
    return
  }
  const pathStats = await stat(path).catch(() => null)
  if (!pathStats?.isDirectory()) {
    return
  }
  try {
    const watcher = watch(path, { persistent: false, recursive: true }, (_eventType, filename) => {
      if (isCodexHistoryChange(filename)) {
        scheduleProviderSync({ filename })
      }
    })
    watcher.on("error", () => {
      watchers.delete(path)
      watcher.close()
    })
    watchers.set(path, watcher)
  } catch {
    const watcher = watch(path, { persistent: false }, (_eventType, filename) => {
      if (isCodexHistoryChange(filename)) {
        scheduleProviderSync({ filename })
      }
    })
    watcher.on("error", () => {
      watchers.delete(path)
      watcher.close()
    })
    watchers.set(path, watcher)
  }
}

function isCodexHistoryChange(filename: string | Buffer | null): boolean {
  if (!filename) {
    return true
  }
  const path = filename.toString()
  return (
    path.endsWith(".jsonl") ||
    path.includes("session_index.jsonl") ||
    path.includes("logs_2.sqlite")
  )
}

function readCodexThreadId(filename: string | Buffer | null): string | null {
  return filename?.toString().match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu)?.[1] ?? null
}
