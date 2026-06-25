import { Prisma, type Chat, type ChatRun, type ProviderAccount } from "@prisma/client"
import type {
  ChatAttachmentRequest,
  ChatContextResponse,
  ChatMessageResponse,
  ChatResponse,
  ChatStatsResponse,
  ChatStatus,
  CreateChatRequest,
  ExecuteChatRequest,
  ExecuteChatResponse,
  InterruptChatRunResponse,
  MessagePageResponse,
  QueuedChatRunResponse,
  ReorderQueuedChatRunsRequest,
  ReorderQueuedChatRunsResponse,
  ServerRequestResponseRequest,
  UpdateQueuedChatRunRequest,
  UpdateChatRequest,
} from "../types/providers"
import { ensureDatabase } from "./database.server"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"
import { publishProviderEvent } from "./socket.server"
import { requireConnectedAccount } from "./accounts.service"
import { getProviderAdapter } from "./providers/registry.server"
import type { ProviderChatListItem, ProviderChatMessageItem } from "./providers/types.server"

type ChatHistoryMessageItem = ProviderChatMessageItem & {
  completedAt?: string | null
  id?: string
  kind?: ChatMessageResponse["kind"]
  runId?: string | null
  status?: ChatMessageResponse["status"]
}

let providerChatsSyncPromise: Promise<Map<string, ChatStatsResponse>> | null = null
const messageSnapshotsByChatId = new Map<string, Map<string, string>>()
const localRunGraceMs = 120_000

export async function createChat(dto: CreateChatRequest): Promise<ChatResponse> {
  await ensureDatabase()
  const account = await requireConnectedAccount(dto.accountId)
  const providerId = dto.providerId ?? account.providerId
  if (providerId !== account.providerId) {
    throw new HttpError(400, "Chat provider must match the selected account provider.")
  }
  const chat = await prisma.chat.create({
    data: {
      providerId,
      accountId: account.id,
      autoRotateAccount: dto.autoRotateAccount ?? false,
      title: normalizeTitle(dto.title) ?? "New chat",
      workingDirectory: dto.workingDirectory,
      model: nullableString(dto.model),
      reasoningEffort: nullableString(dto.reasoningEffort),
      serviceTier: nullableString(dto.serviceTier),
      collaborationMode: nullableString(dto.collaborationMode) ?? "default",
      permissionMode: nullableString(dto.permissionMode) ?? "default",
    },
  })
  publishProviderEvent({ threadId: chat.id, type: "chat.updated", payload: serializeChat(chat) })
  return serializeChat(chat)
}

export async function listChats(workingDirectory?: string | null): Promise<ChatResponse[]> {
  await ensureDatabase()
  const chats = await prisma.chat.findMany({
    orderBy: [{ lastActivityAt: "desc" }, { updatedAt: "desc" }],
    where: {
      status: { not: "ARCHIVED" },
      ...(workingDirectory?.trim() ? { workingDirectory: workingDirectory.trim() } : {}),
    },
  })
  return (await overlayCachedChatStates(dedupeChatList(chats))).map((chat) => serializeChat(chat))
}

export async function getChat(chatId: string): Promise<Chat> {
  await ensureDatabase()
  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!chat) {
    throw new HttpError(404, "Chat not found.")
  }
  return chat
}

export async function updateChat(chatId: string, dto: UpdateChatRequest): Promise<ChatResponse> {
  const chat = await getChat(chatId)
  if (chat.status === "RUNNING" && hasBlockedRunningChatUpdate(dto)) {
    throw new HttpError(400, "Wait for the current run to finish before changing chat runtime settings.")
  }

  const targetAccount = dto.accountId === undefined || dto.accountId === chat.accountId
    ? null
    : dto.accountId === null
      ? null
      : await requireConnectedAccount(dto.accountId)
  if (targetAccount && targetAccount.providerId !== chat.providerId) {
    throw new HttpError(400, "Switching provider types for an existing chat is not supported.")
  }
  if (targetAccount && targetAccount.id !== chat.accountId && chat.externalThreadId) {
    const fromAdapter = getProviderAdapter(chat.providerId)
    const toAdapter = getProviderAdapter(targetAccount.providerId)
    const fromAccount = chat.accountId ? await requireConnectedAccount(chat.accountId).catch(() => null) : null
    const threadId = chat.externalThreadId
    const context = { threadId, fromAccount, toAccount: targetAccount }
    const moved = fromAccount ? await fromAdapter.moveThreadToAccount?.(context) ?? false : false
    if (!moved) {
      await fromAdapter.beforeAccountSwitch?.(context)
      const synced = fromAccount ? await fromAdapter.syncThreadFromAccount(threadId, fromAccount) : true
      const hydrated = await toAdapter.hydrateThreadForAccount(threadId, targetAccount)
      if (!synced || !hydrated) {
        throw new HttpError(500, "Unable to move chat history to the selected provider account.")
      }
      await fromAdapter.afterAccountSwitch?.(context)
      if (fromAdapter !== toAdapter) {
        await toAdapter.afterAccountSwitch?.(context)
      }
    }
  }

  const updated = await prisma.chat.update({
    where: { id: chatId },
    data: {
      accountId: dto.accountId === undefined ? undefined : dto.accountId,
      autoRotateAccount: dto.autoRotateAccount,
      providerId: targetAccount ? targetAccount.providerId : undefined,
      title: dto.title === undefined ? undefined : normalizeTitle(dto.title) ?? "Untitled chat",
      workingDirectory: dto.workingDirectory,
      model: dto.model === undefined ? undefined : nullableString(dto.model),
      reasoningEffort: dto.reasoningEffort === undefined ? undefined : nullableString(dto.reasoningEffort),
      serviceTier: dto.serviceTier === undefined ? undefined : nullableString(dto.serviceTier),
      collaborationMode: dto.collaborationMode === undefined ? undefined : nullableString(dto.collaborationMode) ?? "default",
      permissionMode: dto.permissionMode === undefined ? undefined : nullableString(dto.permissionMode) ?? "default",
    },
  })
  if (targetAccount && updated.externalThreadId) {
    await prisma.chat.updateMany({
      where: {
        externalThreadId: updated.externalThreadId,
        id: { not: updated.id },
        status: { not: "ARCHIVED" },
      },
      data: { status: "ARCHIVED" },
    })
  }
  const response = serializeChat(updated)
  publishProviderEvent({ threadId: updated.id, type: "chat.updated", payload: response })
  if (targetAccount && updated.externalThreadId) {
    await publishMessageDeltas(updated.id)
  }
  return response
}

function hasBlockedRunningChatUpdate(dto: UpdateChatRequest): boolean {
  return dto.accountId !== undefined ||
    dto.autoRotateAccount !== undefined ||
    dto.collaborationMode !== undefined ||
    dto.model !== undefined ||
    dto.reasoningEffort !== undefined ||
    dto.serviceTier !== undefined ||
    dto.title !== undefined ||
    dto.workingDirectory !== undefined
}

export async function archiveChat(chatId: string): Promise<ChatResponse> {
  await getChat(chatId)
  const archived = await prisma.chat.update({ where: { id: chatId }, data: { status: "ARCHIVED" } })
  publishProviderEvent({ threadId: archived.id, type: "chat.updated", payload: serializeChat(archived) })
  return serializeChat(archived)
}

export async function listMessages(chatId: string, limit = 1000): Promise<MessagePageResponse> {
  const page = await readMessagePage(chatId, limit)
  rememberMessageSnapshot(chatId, page.data)
  return page
}

async function readMessagePage(chatId: string, limit = 1000): Promise<MessagePageResponse> {
  const chat = await getChat(chatId)
  const safeLimit = Math.min(Math.max(limit, 1), 1000)
  const providerMessages = await loadProviderMessages(chat)
  const messages = [
    ...providerMessages,
    ...await readRunPreviewMessages(chat, providerMessages),
  ].slice(0, safeLimit)
  return {
    data: messages.map((message, index) => serializeProviderMessage(chat.id, message, index + 1)),
    hasMoreBefore: false,
    nextCursor: messages.length ? messages.length : null,
    previousCursor: messages.length ? 1 : null,
  }
}

export async function publishMessageDeltas(chatId: string): Promise<void> {
  const page = await readMessagePage(chatId)
  const previous = messageSnapshotsByChatId.get(chatId) ?? new Map<string, string>()
  const next = messageSnapshotMap(page.data)
  const removedIds = [...previous.keys()].filter((messageId) => !next.has(messageId))
  const changedMessages = page.data.filter((message) => previous.get(message.id) !== next.get(message.id))

  rememberMessageSnapshot(chatId, page.data)

  for (const messageId of removedIds) {
    publishProviderEvent({
      threadId: chatId,
      type: "message.deleted",
      payload: { chatId, messageId },
    })
  }
  for (const message of changedMessages) {
    publishMessageCreated(chatId, message)
  }
}

function publishMessageCreated(chatId: string, message: ChatMessageResponse): void {
  rememberPublishedMessage(chatId, message)
  publishProviderEvent({ threadId: chatId, type: "message.created", payload: message })
}

function rememberMessageSnapshot(chatId: string, messages: ChatMessageResponse[]): void {
  messageSnapshotsByChatId.set(chatId, messageSnapshotMap(messages))
}

function rememberPublishedMessage(chatId: string, message: ChatMessageResponse): void {
  const snapshot = messageSnapshotsByChatId.get(chatId) ?? new Map<string, string>()
  snapshot.set(message.id, messageSnapshot(message))
  messageSnapshotsByChatId.set(chatId, snapshot)
}

function messageSnapshotMap(messages: ChatMessageResponse[]): Map<string, string> {
  return new Map(messages.map((message) => [message.id, messageSnapshot(message)]))
}

function messageSnapshot(message: ChatMessageResponse): string {
  return [
    message.sequence,
    message.itemId,
    message.role,
    message.kind,
    message.status,
    message.createdAt,
    message.completedAt,
    message.content,
  ].join("\u0000")
}

async function overlayCachedChatStates(chats: Chat[]): Promise<Chat[]> {
  const groups = new Map<string, { accountId: string; chats: Chat[]; providerId: string }>()
  for (const chat of chats) {
    if (!chat.accountId || !chat.externalThreadId) {
      continue
    }
    const key = `${chat.providerId}:${chat.accountId}`
    const group = groups.get(key) ?? { accountId: chat.accountId, chats: [], providerId: chat.providerId }
    group.chats.push(chat)
    groups.set(key, group)
  }
  if (!groups.size) {
    return chats
  }

  const overlays = new Map<string, Chat>()
  for (const group of groups.values()) {
    const account = await requireConnectedAccount(group.accountId).catch(() => null)
    if (!account) {
      continue
    }
    const adapter = getProviderAdapter(group.providerId)
    if (!adapter.readCachedChatStates) {
      continue
    }
    const states = await adapter.readCachedChatStates(
      account,
      group.chats.map((chat) => chat.externalThreadId).filter((id): id is string => Boolean(id)),
    ).catch(() => null)
    if (!states?.size) {
      continue
    }

    for (const chat of group.chats) {
      const state = chat.externalThreadId ? states.get(chat.externalThreadId) : null
      if (!state) {
        continue
      }
      let next = overlays.get(chat.id) ?? chat
      const updatedAt = parseProviderDate(state.updatedAt ?? null)
      if (updatedAt && updatedAt.getTime() > next.lastActivityAt.getTime()) {
        next = { ...next, lastActivityAt: updatedAt }
      }
      if (state.status === "RUNNING" && next.status !== "RUNNING") {
        next = { ...next, status: "RUNNING" }
      }
      if (next !== chat) {
        overlays.set(chat.id, next)
      }
    }
  }

  return chats.map((chat) => overlays.get(chat.id) ?? chat)
}

export async function refreshChatStatusesForWorkspaces(workspacePaths: string[]): Promise<ChatResponse[]> {
  await ensureDatabase()
  const paths = workspacePaths.map((path) => path.trim()).filter(Boolean)
  if (!paths.length) {
    return []
  }
  const chats = await prisma.chat.findMany({
    orderBy: [{ lastActivityAt: "desc" }, { updatedAt: "desc" }],
    where: {
      status: { not: "ARCHIVED" },
      workingDirectory: { in: paths },
      externalThreadId: { not: null },
      accountId: { not: null },
    },
  })
  const updatedChats: ChatResponse[] = []
  for (const chat of chats) {
    if (!chat.accountId || !chat.externalThreadId) {
      continue
    }
    const account = await requireConnectedAccount(chat.accountId).catch(() => null)
    if (!account) {
      continue
    }
    const adapter = getProviderAdapter(chat.providerId)
    const providerStatus = adapter.readChatStatus
      ? await adapter.readChatStatus(account, chat.externalThreadId).catch(() => null)
      : null
    let status: ChatStatus | null = providerStatus
    const hasActiveRun = await hasActiveChatRun(chat.id, status)
    if (status !== "RUNNING" && hasActiveRun) {
      status = "RUNNING"
    }
    if (!status || status === chat.status) {
      continue
    }
    const updated = await prisma.chat.update({ where: { id: chat.id }, data: { status } })
    updatedChats.push(serializeChat(updated))
  }
  return updatedChats
}

async function syncProviderChats(): Promise<Map<string, ChatStatsResponse>> {
  const stats = new Map<string, ChatStatsResponse>()
  const accounts = await prisma.providerAccount.findMany({
    orderBy: { createdAt: "asc" },
    where: { status: "CONNECTED" },
  })
  for (const account of accounts) {
    for (const [key, value] of await syncProviderAccountChats(account)) {
      stats.set(key, value)
    }
  }
  return stats
}

export async function syncProviderChatsOnce(): Promise<Map<string, ChatStatsResponse>> {
  if (!providerChatsSyncPromise) {
    providerChatsSyncPromise = syncProviderChats().finally(() => {
      providerChatsSyncPromise = null
    })
  }
  return providerChatsSyncPromise
}

async function syncProviderAccountChats(account: ProviderAccount): Promise<Map<string, ChatStatsResponse>> {
  const stats = new Map<string, ChatStatsResponse>()
  const adapter = getProviderAdapter(account.providerId)
  let providerChats: ProviderChatListItem[]
  try {
    providerChats = await adapter.listChats(account)
  } catch {
    return stats
  }

  for (const providerChat of dedupeProviderChatList(providerChats)) {
    const externalThreadId = providerChat.externalThreadId.trim()
    if (!externalThreadId) {
      continue
    }
    if (providerChat.stats && (providerChat.stats.additions > 0 || providerChat.stats.deletions > 0)) {
      stats.set(providerChatStatsKey(account.id, externalThreadId), providerChat.stats)
    }
    const existing = await prisma.chat.findFirst({
      where: {
        accountId: account.id,
        externalThreadId,
        providerId: account.providerId,
      },
    })
    const timestamp = parseProviderDate(providerChat.updatedAt) ?? new Date()
    const title = normalizeTitle(providerChat.title) ?? "Untitled chat"
    const workingDirectory = nullableString(providerChat.workingDirectory)
    const data: Prisma.ChatUpdateInput = {
      title,
      workingDirectory,
      lastActivityAt: timestamp,
    }
    if (existing) {
      if (providerChat.status && existing.status !== "ARCHIVED") {
        const hasActiveRun = await hasActiveProviderThreadRun(account, externalThreadId)
        data.status = providerChat.status === "RUNNING" || hasActiveRun ? "RUNNING" : providerChat.status
      }
      await prisma.chat.updateMany({
        where: {
          accountId: account.id,
          externalThreadId,
          providerId: account.providerId,
          status: { not: "ARCHIVED" },
        },
        data,
      })
      continue
    }
    await prisma.chat.create({
      data: {
        title,
        workingDirectory,
        lastActivityAt: timestamp,
        accountId: account.id,
        providerId: account.providerId,
        externalThreadId,
        status: providerChat.status ?? "IDLE",
      },
    })
  }
  return stats
}

function dedupeChatList(chats: Chat[]): Chat[] {
  const visible: Chat[] = []
  const indexByKey = new Map<string, number>()
  for (const chat of chats) {
    const key = chatListDedupeKey(chat)
    if (!key) {
      visible.push(chat)
      continue
    }
    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, visible.length)
      visible.push(chat)
      continue
    }
    const existing = visible[existingIndex]
    if (preferChatListItem(chat, existing)) {
      visible[existingIndex] = chat
    }
  }
  return visible
}

function chatListDedupeKey(chat: Chat): string | null {
  return chat.externalThreadId && chat.accountId
    ? `${chat.providerId}:${chat.accountId}:${chat.externalThreadId}`
    : null
}

function preferChatListItem(candidate: Chat, current: Chat): boolean {
  if (candidate.status !== current.status) {
    return candidate.status === "RUNNING"
  }
  if (candidate.lastActivityAt.getTime() !== current.lastActivityAt.getTime()) {
    return candidate.lastActivityAt.getTime() > current.lastActivityAt.getTime()
  }
  return candidate.updatedAt.getTime() > current.updatedAt.getTime()
}

function dedupeProviderChatList(chats: ProviderChatListItem[]): ProviderChatListItem[] {
  const visible: ProviderChatListItem[] = []
  const indexByThreadId = new Map<string, number>()
  for (const chat of chats) {
    const externalThreadId = chat.externalThreadId.trim()
    if (!externalThreadId) {
      continue
    }
    const existingIndex = indexByThreadId.get(externalThreadId)
    if (existingIndex === undefined) {
      indexByThreadId.set(externalThreadId, visible.length)
      visible.push(chat)
      continue
    }
    const existing = visible[existingIndex]
    if (preferProviderChatListItem(chat, existing)) {
      visible[existingIndex] = chat
    }
  }
  return visible
}

function preferProviderChatListItem(candidate: ProviderChatListItem, current: ProviderChatListItem): boolean {
  if (candidate.status !== current.status) {
    return candidate.status === "RUNNING"
  }
  const candidateUpdatedAt = parseProviderDate(candidate.updatedAt)?.getTime() ?? 0
  const currentUpdatedAt = parseProviderDate(current.updatedAt)?.getTime() ?? 0
  return candidateUpdatedAt > currentUpdatedAt
}

async function loadProviderMessages(chat: Chat): Promise<ProviderChatMessageItem[]> {
  if (!chat.accountId || !chat.externalThreadId) {
    return []
  }
  const account = await requireConnectedAccount(chat.accountId).catch(() => null)
  if (!account) {
    return []
  }
  return getProviderAdapter(chat.providerId).loadChatMessages(account, chat.externalThreadId).catch(() => [])
}

async function hasActiveProviderThreadRun(account: ProviderAccount, externalThreadId: string): Promise<boolean> {
  const run = await prisma.chatRun.findFirst({
    select: { id: true },
    where: {
      status: { in: ["QUEUED", "RUNNING"] },
      chat: {
        accountId: account.id,
        externalThreadId,
        providerId: account.providerId,
      },
    },
  })
  return Boolean(run)
}

async function hasActiveChatRun(chatId: string, providerStatus?: ChatStatus | null): Promise<boolean> {
  const runs = await prisma.chatRun.findMany({
    select: { createdAt: true, externalTurnId: true, id: true, startedAt: true },
    where: { chatId, status: { in: ["QUEUED", "RUNNING"] } },
  })
  if (!runs.length) {
    return false
  }
  if (providerStatus && providerStatus !== "RUNNING") {
    const now = Date.now()
    const freshLocalRuns = runs.filter((run) => !run.externalTurnId && now - (run.startedAt ?? run.createdAt).getTime() < localRunGraceMs)
    const staleRunIds = runs
      .filter((run) => !freshLocalRuns.some((freshRun) => freshRun.id === run.id))
      .map((run) => run.id)
    if (staleRunIds.length) {
      await prisma.chatRun.updateMany({
        where: { id: { in: staleRunIds } },
        data: { endedAt: new Date(), status: "CANCELLED" },
      })
    }
    return freshLocalRuns.length > 0
  }
  return true
}

export async function executeMessage(chatId: string, dto: ExecuteChatRequest): Promise<ExecuteChatResponse> {
  const chat = await getChat(chatId)
  if (!dto.content.trim()) {
    throw new HttpError(400, "Message content is required.")
  }
  const accountId = dto.accountId ?? chat.accountId
  if (!accountId) {
    throw new HttpError(400, "Choose a provider account before sending messages.")
  }
  const account = await requireConnectedAccount(accountId)
  if (account.providerId !== chat.providerId) {
    throw new HttpError(400, "Message account provider must match the chat provider.")
  }
  if (!chat.workingDirectory) {
    throw new HttpError(400, "Select a working directory before sending messages.")
  }

  if (chat.status === "RUNNING") {
    return dto.delivery === "steer"
      ? steerActiveMessage(chat, account, dto)
      : queueMessage(chat, account, dto)
  }

  const now = new Date()
  const run = await prisma.chatRun.create({
    data: {
      chatId: chat.id,
      providerId: chat.providerId,
      accountId: account.id,
      status: "QUEUED",
      request: runRequestFromDto(dto),
    },
  })
  const userMessage = serializeRunMessage(chat.id, run, "USER", dto.content, "COMPLETED", 1)
  const assistantMessage = serializeRunMessage(chat.id, run, "ASSISTANT", "Running", "STREAMING", 2)
  const runningChat = await prisma.chat.update({
    where: { id: chat.id },
    data: {
      status: "RUNNING",
      accountId: account.id,
      collaborationMode: nullableString(dto.collaborationMode) ?? chat.collaborationMode,
      lastActivityAt: now,
      permissionMode: nullableString(dto.permissionMode) ?? chat.permissionMode,
    },
  })
  publishMessageCreated(chat.id, userMessage)
  publishMessageCreated(chat.id, assistantMessage)
  publishProviderEvent({ threadId: chat.id, type: "chat.updated", payload: serializeChat(runningChat) })
  publishProviderEvent({ threadId: chat.id, type: "run.status", payload: { runId: run.id, status: "QUEUED" } })

  void runProviderTurn({
    accountId: account.id,
    attachments: dto.attachments ?? [],
    chatId: chat.id,
    content: dto.content,
    goalObjective: dto.goalObjective ?? null,
    model: readRunMetadataString(dto.metadata, "model"),
    permissionMode: dto.permissionMode ?? null,
    reasoningEffort: readRunMetadataString(dto.metadata, "reasoningEffort"),
    runId: run.id,
    requestedCollaborationMode: dto.collaborationMode ?? null,
    serviceTier: readRunMetadataString(dto.metadata, "serviceTier"),
  }).catch((error) => {
    console.error("Provider run failed.", error)
  })

  return {
    message: userMessage,
    assistantMessage,
    runId: run.id,
    status: "QUEUED",
  }
}

export async function respondToServerRequest(
  chatId: string,
  requestId: string,
  dto: ServerRequestResponseRequest,
): Promise<ChatMessageResponse | null> {
  const chat = await getChat(chatId)
  const accountId = chat.accountId
  if (!accountId) {
    throw new HttpError(400, "Choose a provider account before responding.")
  }
  const account = await requireConnectedAccount(accountId)
  if (account.providerId !== chat.providerId) {
    throw new HttpError(400, "Response account provider must match the chat provider.")
  }
  const responder = getProviderAdapter(chat.providerId).respondToServerRequest
  if (!responder) {
    throw new HttpError(400, "This provider does not support server request responses.")
  }
  await responder(account, requestId, dto)
  return null
}

async function queueMessage(chat: Chat, account: ProviderAccount, dto: ExecuteChatRequest): Promise<ExecuteChatResponse> {
  const run = await prisma.chatRun.create({
    data: {
      chatId: chat.id,
      providerId: chat.providerId,
      accountId: account.id,
      status: "QUEUED",
      request: runRequestFromDto(dto),
    },
  })
  const message = serializeRunMessage(chat.id, run, "USER", dto.content, "PENDING", 1)
  const updatedChat = await prisma.chat.update({
    where: { id: chat.id },
    data: {
      accountId: account.id,
      collaborationMode: nullableString(dto.collaborationMode) ?? chat.collaborationMode,
      lastActivityAt: new Date(),
      permissionMode: nullableString(dto.permissionMode) ?? chat.permissionMode,
      status: "RUNNING",
    },
  })
  publishMessageCreated(chat.id, message)
  publishProviderEvent({ threadId: chat.id, type: "chat.updated", payload: serializeChat(updatedChat) })
  publishProviderEvent({ threadId: chat.id, type: "run.status", payload: { runId: run.id, status: "QUEUED" } })
  return { message, assistantMessage: null, runId: run.id, status: "QUEUED" }
}

async function steerActiveMessage(
  chat: Chat,
  account: ProviderAccount,
  dto: ExecuteChatRequest,
): Promise<ExecuteChatResponse> {
  const run = await prisma.chatRun.create({
    data: {
      chatId: chat.id,
      providerId: chat.providerId,
      accountId: account.id,
      status: "QUEUED",
      request: runRequestFromDto(dto),
    },
  })
  let result: QueuedChatRunResponse
  try {
    result = await steerQueuedRun(chat, run)
  } catch (error) {
    await prisma.chatRun.update({ where: { id: run.id }, data: { endedAt: new Date(), status: "CANCELLED" } }).catch(() => undefined)
    throw error
  }
  if (!result.message) {
    throw new HttpError(409, "Unable to steer the active turn.")
  }
  return { message: result.message, assistantMessage: null, runId: run.id, status: "RUNNING" }
}

export async function interruptChatRun(chatId: string): Promise<InterruptChatRunResponse> {
  const chat = await getChat(chatId)
  if (chat.status !== "RUNNING") {
    throw new HttpError(409, "There is no running task to stop.")
  }
  const run = await prisma.chatRun.findFirst({
    orderBy: { createdAt: "desc" },
    where: { chatId, status: "RUNNING" },
  })
  if (!run) {
    const updated = await prisma.chat.update({ where: { id: chatId }, data: { status: "IDLE" } })
    publishProviderEvent({ threadId: chatId, type: "chat.updated", payload: serializeChat(updated) })
    await publishMessageDeltas(chatId)
    return { chatId, runId: null, status: "CANCELLED", message: "Marked stale run as cancelled." }
  }
  const account = run.accountId ? await requireConnectedAccount(run.accountId).catch(() => null) : null
  if (account && chat.externalThreadId && run.externalTurnId) {
    await getProviderAdapter(chat.providerId).interrupt(account, chat.externalThreadId, run.externalTurnId).catch(() => undefined)
  }
  await prisma.chatRun.update({ where: { id: run.id }, data: { status: "CANCELLED", endedAt: new Date(), interruptRequestedAt: new Date() } })
  const updated = await prisma.chat.update({ where: { id: chatId }, data: { status: "IDLE" } })
  publishProviderEvent({ threadId: chatId, type: "chat.updated", payload: serializeChat(updated) })
  await publishMessageDeltas(chatId)
  publishProviderEvent({ threadId: chatId, type: "run.status", payload: { runId: run.id, status: "CANCELLED" } })
  return { chatId, runId: run.id, status: "CANCELLED", message: "Task cancelled." }
}

export async function updateQueuedChatRun(
  chatId: string,
  runId: string,
  dto: UpdateQueuedChatRunRequest,
): Promise<QueuedChatRunResponse> {
  const content = dto.content.trim()
  if (!content) {
    throw new HttpError(400, "Message content is required.")
  }
  const run = await requireQueuedRun(chatId, runId)
  const request = readRunRequestRecord(run)
  const updatedRun = await prisma.chatRun.update({
    where: { id: run.id },
    data: {
      request: {
        ...request,
        content,
      } as Prisma.InputJsonObject,
    },
  })
  const message = serializeRunMessage(chatId, updatedRun, "USER", content, "PENDING", 1)
  publishMessageCreated(chatId, message)
  await publishMessageDeltas(chatId)
  return { chatId, runId, status: "QUEUED", message }
}

export async function reorderQueuedChatRuns(
  chatId: string,
  dto: ReorderQueuedChatRunsRequest,
): Promise<ReorderQueuedChatRunsResponse> {
  await getChat(chatId)
  const queuedRuns = sortQueuedRuns(await prisma.chatRun.findMany({
    orderBy: { createdAt: "asc" },
    where: { chatId, status: "QUEUED" },
  }))
  const queuedRunIds = new Set(queuedRuns.map((run) => run.id))
  const requestedRunIds = dto.runIds.filter((runId, index, runIds) => runIds.indexOf(runId) === index)
  const unknownRunId = requestedRunIds.find((runId) => !queuedRunIds.has(runId))
  if (unknownRunId) {
    throw new HttpError(404, "Queued message not found.")
  }
  const orderedIds = [
    ...requestedRunIds,
    ...queuedRuns.map((run) => run.id).filter((runId) => !requestedRunIds.includes(runId)),
  ]
  const runById = new Map(queuedRuns.map((run) => [run.id, run]))
  await prisma.$transaction(orderedIds.map((orderedRunId, index) => {
    const run = runById.get(orderedRunId)
    if (!run) {
      throw new HttpError(404, "Queued message not found.")
    }
    const request = readRunRequestRecord(run)
    const metadata = readRunRequestMetadata(request.metadata)
    return prisma.chatRun.update({
      where: { id: orderedRunId },
      data: {
        request: {
          ...request,
          metadata: {
            ...metadata,
            queueOrder: index + 1,
          },
        } as Prisma.InputJsonObject,
      },
    })
  }))
  await publishMessageDeltas(chatId)
  return { chatId, runIds: orderedIds }
}

export async function deleteQueuedChatRun(chatId: string, runId: string): Promise<QueuedChatRunResponse> {
  const run = await requireQueuedRun(chatId, runId)
  await prisma.chatRun.update({ where: { id: run.id }, data: { status: "CANCELLED", endedAt: new Date() } })
  await publishMessageDeltas(chatId)
  publishProviderEvent({ threadId: chatId, type: "run.status", payload: { runId, status: "CANCELLED" } })
  return { chatId, runId, status: "CANCELLED", message: null }
}

export async function steerQueuedChatRun(chatId: string, runId: string): Promise<QueuedChatRunResponse> {
  const chat = await getChat(chatId)
  const run = await requireQueuedRun(chatId, runId)
  return steerQueuedRun(chat, run)
}

export async function readChatContext(chatId: string): Promise<ChatContextResponse> {
  await getChat(chatId)
  return { usage: null }
}

async function requireQueuedRun(chatId: string, runId: string): Promise<ChatRun> {
  const run = await prisma.chatRun.findFirst({ where: { chatId, id: runId, status: "QUEUED" } })
  if (!run) {
    throw new HttpError(404, "Queued message not found.")
  }
  return run
}

async function steerQueuedRun(chat: Chat, queuedRun: ChatRun): Promise<QueuedChatRunResponse> {
  if (!chat.workingDirectory) {
    throw new HttpError(400, "Select a working directory before steering messages.")
  }
  const activeRun = await prisma.chatRun.findFirst({
    orderBy: { startedAt: "desc" },
    where: { chatId: chat.id, status: "RUNNING", externalTurnId: { not: null } },
  })
  if (!activeRun?.externalTurnId || !chat.externalThreadId) {
    throw new HttpError(409, "There is no steerable active turn yet.")
  }
  const accountId = activeRun.accountId ?? queuedRun.accountId ?? chat.accountId
  if (!accountId) {
    throw new HttpError(400, "Choose a provider account before steering messages.")
  }
  const account = await requireConnectedAccount(accountId)
  const adapter = getProviderAdapter(chat.providerId)
  if (!adapter.steerMessage) {
    throw new HttpError(400, "This provider does not support steering.")
  }
  const request = readRunRequest(queuedRun)
  const content = request.content
  await adapter.steerMessage(account, {
    attachments: request.attachments,
    content,
    threadId: chat.externalThreadId,
    turnId: activeRun.externalTurnId,
    workingDirectory: chat.workingDirectory,
  })
  const completedAt = new Date()
  const updatedRun = await prisma.chatRun.update({
    where: { id: queuedRun.id },
    data: {
      endedAt: completedAt,
      externalTurnId: activeRun.externalTurnId,
      startedAt: completedAt,
      status: "COMPLETED",
    },
  })
  const message = serializeRunMessage(chat.id, updatedRun, "USER", content, "COMPLETED", 1)
  publishMessageCreated(chat.id, message)
  await publishMessageDeltas(chat.id)
  publishProviderEvent({ threadId: chat.id, type: "run.status", payload: { runId: queuedRun.id, status: "COMPLETED" } })
  return { chatId: chat.id, runId: queuedRun.id, status: "COMPLETED", message }
}

async function runProviderTurn({
  accountId,
  attachments,
  chatId,
  content,
  goalObjective,
  model,
  permissionMode,
  reasoningEffort,
  requestedCollaborationMode,
  runId,
  serviceTier,
}: {
  accountId: string
  attachments: ChatAttachmentRequest[]
  chatId: string
  content: string
  goalObjective: string | null
  model: string | null
  permissionMode: string | null
  reasoningEffort: string | null
  requestedCollaborationMode: string | null
  runId: string
  serviceTier: string | null
}): Promise<void> {
  const [chat, account] = await Promise.all([getChat(chatId), requireConnectedAccount(accountId)])
  const adapter = getProviderAdapter(chat.providerId)
  const startedAt = new Date()
  await prisma.chatRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt } })
  publishProviderEvent({ threadId: chatId, type: "run.status", payload: { runId, status: "RUNNING" } })
  try {
    const liveMessageSequences = new Map<string, number>()
    let nextLiveMessageSequence = 3
    const result = await adapter.sendMessage(account, {
      attachments,
      collaborationMode: requestedCollaborationMode ?? chat.collaborationMode,
      content,
      goalObjective,
      model: model ?? chat.model,
      onMessage: (message) => {
        const key = message.itemId ?? `${message.role}:${message.kind ?? "CHAT"}:${message.content}`
        let sequence = liveMessageSequences.get(key)
        if (!sequence) {
          sequence = nextLiveMessageSequence
          nextLiveMessageSequence += 1
          liveMessageSequences.set(key, sequence)
        }
        const payload = serializeProviderMessage(chatId, { ...message, runId }, sequence)
        publishMessageCreated(chatId, payload)
      },
      onThreadReady: async (threadId) => {
        const updatedChat = await prisma.chat.update({
          where: { id: chatId },
          data: { externalThreadId: threadId, status: "RUNNING" },
        })
        publishProviderEvent({ threadId: chatId, type: "chat.updated", payload: serializeChat(updatedChat) })
      },
      onTurnStarted: async (turnId) => {
        await prisma.chatRun.update({ where: { id: runId }, data: { externalTurnId: turnId } })
        publishProviderEvent({ threadId: chatId, type: "run.status", payload: { runId, status: "RUNNING", turnId } })
      },
      permissionMode: permissionMode ?? chat.permissionMode,
      reasoningEffort: reasoningEffort ?? chat.reasoningEffort,
      serviceTier: serviceTier ?? chat.serviceTier,
      threadId: chat.externalThreadId,
      workingDirectory: chat.workingDirectory!,
    })
    const completedAt = new Date()
    const currentRun = await prisma.chatRun.findUnique({ where: { id: runId }, select: { status: true } })
    if (!currentRun || currentRun.status !== "RUNNING") {
      const updatedChat = await prisma.chat.update({
        where: { id: chatId },
        data: {
          externalThreadId: result.threadId,
          lastActivityAt: completedAt,
          status: "IDLE",
        },
      })
      await adapter.syncThreadFromAccount(result.threadId, account)
      publishProviderEvent({ threadId: chatId, type: "chat.updated", payload: serializeChat(updatedChat) })
      await publishMessageDeltas(chatId)
      await startNextQueuedRun(chatId)
      return
    }
    const updatedChat = await prisma.chat.update({
      where: { id: chatId },
      data: {
        externalThreadId: result.threadId,
        lastActivityAt: completedAt,
        status: "IDLE",
      },
    })
    await prisma.chatRun.update({
      where: { id: runId },
      data: {
        endedAt: completedAt,
        externalTurnId: result.turnId,
        status: "COMPLETED",
      },
    })
    await adapter.syncThreadFromAccount(result.threadId, account)
    publishProviderEvent({ threadId: chatId, type: "chat.updated", payload: serializeChat(updatedChat) })
    await publishMessageDeltas(chatId)
    publishProviderEvent({ threadId: chatId, type: "run.status", payload: { runId, status: "COMPLETED" } })
    await startNextQueuedRun(chatId)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider run failed."
    const failedAt = new Date()
    const updatedChat = await prisma.chat.update({ where: { id: chatId }, data: { status: "IDLE", lastActivityAt: failedAt } })
    await prisma.chatRun.update({ where: { id: runId }, data: { endedAt: failedAt, error: message, status: "FAILED" } })
    publishProviderEvent({ threadId: chatId, type: "chat.updated", payload: serializeChat(updatedChat) })
    await publishMessageDeltas(chatId)
    publishProviderEvent({ threadId: chatId, type: "run.status", payload: { runId, status: "FAILED", error: message } })
    await startNextQueuedRun(chatId)
  }
}

async function startNextQueuedRun(chatId: string): Promise<boolean> {
  const queuedRun = sortQueuedRuns(await prisma.chatRun.findMany({
    orderBy: { createdAt: "asc" },
    where: { chatId, status: "QUEUED" },
  }))[0]
  if (!queuedRun) {
    return false
  }
  const chat = await getChat(chatId)
  const accountId = queuedRun.accountId ?? chat.accountId
  if (!accountId) {
    await prisma.chatRun.update({
      where: { id: queuedRun.id },
      data: { endedAt: new Date(), error: "Queued message has no provider account.", status: "FAILED" },
    })
    await publishMessageDeltas(chatId)
    return startNextQueuedRun(chatId)
  }
  const request = readRunRequest(queuedRun)
  const updatedChat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      accountId,
      collaborationMode: nullableString(request.collaborationMode) ?? chat.collaborationMode,
      lastActivityAt: new Date(),
      permissionMode: nullableString(request.permissionMode) ?? chat.permissionMode,
      status: "RUNNING",
    },
  })
  publishProviderEvent({ threadId: chatId, type: "chat.updated", payload: serializeChat(updatedChat) })
  void runProviderTurn({
    accountId,
    attachments: request.attachments,
    chatId,
    content: request.content,
    goalObjective: request.goalObjective,
    model: readRunMetadataString(request.metadata, "model"),
    permissionMode: request.permissionMode,
    reasoningEffort: readRunMetadataString(request.metadata, "reasoningEffort"),
    requestedCollaborationMode: request.collaborationMode,
    runId: queuedRun.id,
    serviceTier: readRunMetadataString(request.metadata, "serviceTier"),
  }).catch((error) => {
    console.error("Queued provider run failed.", error)
  })
  return true
}

async function readRunPreviewMessages(
  chat: Chat,
  providerMessages: ProviderChatMessageItem[],
): Promise<ChatHistoryMessageItem[]> {
  const runs = await prisma.chatRun.findMany({
    orderBy: { createdAt: "asc" },
    where: { chatId: chat.id, status: { in: ["QUEUED", "RUNNING", "FAILED"] } },
  })
  const messages: ChatHistoryMessageItem[] = []
  for (const run of sortRunPreviewRuns(runs)) {
    const content = readRunRequestContent(run)
    if (!content) {
      continue
    }
    const runUserIndex = findLastIndex(
      providerMessages,
      (message) => message.role === "USER" && message.content.trim() === content.trim(),
    )
    const assistantAfterRunUser = runUserIndex >= 0
      ? providerMessages.slice(runUserIndex + 1).some((message) => message.role === "ASSISTANT")
      : false
    if (runUserIndex < 0) {
      messages.push({
        id: `run:${run.id}:user`,
        runId: run.id,
        role: "USER",
        content,
        createdAt: run.createdAt.toISOString(),
        status: run.status === "QUEUED" ? "PENDING" : "COMPLETED",
      })
    }
    if (run.status !== "QUEUED" && !assistantAfterRunUser) {
      const failed = run.status === "FAILED"
      const timestamp = (run.endedAt ?? run.startedAt ?? run.createdAt).toISOString()
      messages.push({
        id: `run:${run.id}:assistant`,
        runId: run.id,
        role: "ASSISTANT",
        content: failed ? run.error ?? "Provider run failed." : "Running",
        createdAt: timestamp,
        completedAt: failed ? timestamp : null,
        kind: failed ? "ERROR" : "CHAT",
        status: failed ? "FAILED" : "STREAMING",
      })
    }
  }
  return messages
}

function readRunRequestContent(run: ChatRun): string | null {
  return readRunRequest(run).content || null
}

function sortQueuedRuns(runs: ChatRun[]): ChatRun[] {
  return [...runs].sort(compareQueuedRuns)
}

function sortRunPreviewRuns(runs: ChatRun[]): ChatRun[] {
  return [...runs].sort((left, right) => {
    if (left.status === "QUEUED" && right.status === "QUEUED") {
      return compareQueuedRuns(left, right)
    }
    if (left.status === "QUEUED" || right.status === "QUEUED") {
      return left.status === "QUEUED" ? 1 : -1
    }
    return left.createdAt.getTime() - right.createdAt.getTime()
  })
}

function compareQueuedRuns(left: ChatRun, right: ChatRun): number {
  const leftOrder = readQueuedRunOrder(left)
  const rightOrder = readQueuedRunOrder(right)
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }
  return left.createdAt.getTime() - right.createdAt.getTime()
}

function readQueuedRunOrder(run: ChatRun): number {
  const metadata = readRunRequestMetadata(readRunRequestRecord(run).metadata)
  const order = metadata.queueOrder
  return typeof order === "number" && Number.isFinite(order)
    ? order
    : run.createdAt.getTime()
}

function runRequestFromDto(dto: ExecuteChatRequest): Prisma.InputJsonObject {
  return {
    attachments: runRequestAttachments(dto.attachments),
    collaborationMode: dto.collaborationMode ?? null,
    content: dto.content,
    goalObjective: dto.goalObjective ?? null,
    metadata: dto.metadata ?? {},
    permissionMode: dto.permissionMode ?? null,
  } as Prisma.InputJsonObject
}

function runRequestAttachments(attachments: ChatAttachmentRequest[] | undefined): Prisma.InputJsonValue[] {
  return (attachments ?? []).map((attachment) => ({
    ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
    kind: attachment.kind,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    name: attachment.name,
    ...(attachment.path ? { path: attachment.path } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  }))
}

function readRunRequestRecord(run: ChatRun): Record<string, unknown> {
  return run.request && typeof run.request === "object" && !Array.isArray(run.request)
    ? run.request as Record<string, unknown>
    : {}
}

function readRunRequest(run: ChatRun): {
  attachments: ChatAttachmentRequest[]
  collaborationMode: string | null
  content: string
  goalObjective: string | null
  metadata: Record<string, unknown>
  permissionMode: string | null
} {
  const request = readRunRequestRecord(run)
  return {
    attachments: readRunRequestAttachments(request.attachments),
    collaborationMode: readRequestString(request.collaborationMode),
    content: readRequestString(request.content) ?? "",
    goalObjective: readRequestString(request.goalObjective),
    metadata: readRunRequestMetadata(request.metadata),
    permissionMode: readRequestString(request.permissionMode),
  }
}

function readRunRequestMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readRunMetadataString(value: unknown, key: string): string | null {
  const metadata = readRunRequestMetadata(value)
  const field = metadata[key]
  return typeof field === "string" && field.trim() ? field.trim() : null
}

function readRunRequestAttachments(value: unknown): ChatAttachmentRequest[] {
  if (!Array.isArray(value)) {
    return []
  }
  const attachments: ChatAttachmentRequest[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue
    }
    const record = entry as Record<string, unknown>
    const kind = record.kind
    if (kind !== "file" && kind !== "folder" && kind !== "image") {
      continue
    }
    attachments.push({
      dataUrl: readRequestString(record.dataUrl) ?? undefined,
      kind,
      mimeType: readRequestString(record.mimeType) ?? undefined,
      name: readRequestString(record.name) ?? "attachment",
      path: readRequestString(record.path) ?? undefined,
      size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined,
    })
  }
  return attachments
}

function readRequestString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index
    }
  }
  return -1
}

function serializeRunMessage(
  chatId: string,
  run: ChatRun,
  role: "USER" | "ASSISTANT",
  content: string,
  status: ChatMessageResponse["status"],
  sequence: number,
): ChatMessageResponse {
  return serializeProviderMessage(chatId, {
    id: `run:${run.id}:${role.toLowerCase()}`,
    runId: run.id,
    role,
    content,
    createdAt: run.createdAt.toISOString(),
    completedAt: status === "COMPLETED" ? run.createdAt.toISOString() : null,
    status,
  }, sequence)
}

export function serializeChat(chat: Chat, stats?: ChatStatsResponse | null): ChatResponse {
  return {
    id: chat.id,
    providerId: chat.providerId,
    accountId: chat.accountId,
    autoRotateAccount: chat.autoRotateAccount,
    title: chat.title,
    workingDirectory: chat.workingDirectory,
    model: chat.model,
    reasoningEffort: chat.reasoningEffort,
    serviceTier: chat.serviceTier,
    stats: stats ?? null,
    collaborationMode: chat.collaborationMode,
    permissionMode: chat.permissionMode,
    status: chat.status,
    externalThreadId: chat.externalThreadId,
    lastActivityAt: chat.lastActivityAt.toISOString(),
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  }
}

function providerChatStatsKey(accountId: string, externalThreadId: string): string {
  return `${accountId}:${externalThreadId}`
}

function serializeProviderMessage(
  chatId: string,
  message: ChatHistoryMessageItem,
  sequence: number,
): ChatMessageResponse {
  const createdAt = parseProviderDate(message.createdAt) ?? new Date()
  const status = message.status ?? "COMPLETED"
  return {
    id: message.id ?? `provider:${chatId}:${message.itemId ?? sequence}`,
    chatId,
    runId: message.runId,
    sequence,
    role: message.role,
    kind: message.kind ?? "CHAT",
    status,
    turnId: null,
    itemId: message.itemId,
    requestId: message.requestId ?? null,
    content: message.content,
    metadata: message.metadata ?? null,
    rawPayload: message.rawPayload ?? null,
    createdAt: createdAt.toISOString(),
    completedAt: message.completedAt ?? (status === "COMPLETED" || status === "FAILED" ? createdAt.toISOString() : null),
  }
}

function nullableString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  return value?.trim() || null
}

function normalizeTitle(value: string | null | undefined): string | null {
  const title = value?.trim()
  return title || null
}

function parseProviderDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
