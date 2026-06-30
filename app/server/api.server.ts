import type { IncomingMessage, ServerResponse } from "node:http"
import type {
  AccountAuthMode,
  ChatAttachmentRequest,
  CompactChatRequest,
  CreateMessageScheduleRequest,
  CreateChatRequest,
  CreateProviderAccountRequest,
  ExecuteChatRequest,
  ForkChatRequest,
  MessageScheduleRecurrence,
  ReorderQueuedChatRunsRequest,
  ReviewChatRequest,
  ServerRequestResponseRequest,
  UpdateMessageScheduleRequest,
  UpdateQueuedChatRunRequest,
  UpdateChatRequest,
  UpdateCodexInstructionsRequest,
  UpdateProviderAccountRequest,
} from "../types/providers"
import type { PluginSettingsUpdateRequest } from "../types/plugins"
import type {
  CreateMcpServerRequest as CreateMcpServerBody,
  McpServerOauthLoginRequest as McpServerOauthLoginBody,
  SyncMcpServerRequest as SyncMcpServerBody,
  UpdateMcpServerRequest as UpdateMcpServerBody,
} from "../types/mcp"
import {
  authenticateAccount,
  createAccount,
  deleteAccount,
  listAccountModels,
  listAccounts,
  readConnectedAccountLimits,
  updateAccount,
} from "./accounts.service"
import {
  archiveChat,
  compactChat,
  createChat,
  deleteQueuedChatRun,
  executeMessage,
  forkChat,
  interruptChatRun,
  listChats,
  listMessages,
  refreshChat,
  reorderQueuedChatRuns,
  respondToServerRequest,
  reviewChat,
  steerQueuedChatRun,
  updateQueuedChatRun,
  updateChat,
} from "./chats.service"
import {
  deleteNamedCloudflaredTunnel,
  readCloudflaredStatus,
  startTemporaryCloudflaredTunnel,
  stopTemporaryCloudflaredTunnel,
} from "./cloudflared.service"
import {
  commitGitChanges,
  discardGitPaths,
  initGitRepository,
  pullGitRepository,
  pushGitRepository,
  readGitStatus,
  stageGitPaths,
  unstageGitPaths,
} from "./git.service"
import { HttpError, readBooleanField, readRecordField, readStringField } from "./http.server"
import {
  archiveMessageSchedule,
  createMessageSchedule,
  getMessageSchedule,
  listMessageScheduleRuns,
  listMessageSchedules,
  updateMessageSchedule,
} from "./message-schedules.service"
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  listMcpServerStatuses,
  startMcpServerOauthLogin,
  syncMcpServer,
  updateMcpServer,
} from "./mcp.service"
import { readCodexInstructions, updateCodexInstructions } from "./providers/codex.server"
import { listProviders } from "./providers.service"
import { listPlugins, runPluginAction, updatePlugin } from "./plugins.service"
import { deleteWorkspaceHistory, listWorkspaceHistory, saveWorkspaceHistory } from "./workspace-history.service"
import { listWorkspaceDirectory, readWorkspaceResource, readWorkspaceTree } from "./workspaces.server"

type MiddlewareStack = {
  use(handler: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void): void
}

export function installApiServer(middlewares: MiddlewareStack): void {
  middlewares.use((req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (!url.pathname.startsWith("/api/")) {
      next()
      return
    }

    void handleApiRequest(req, res, url).catch((error) => {
      sendRouteError(res, error)
    })
  })
}

async function handleApiRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET"

  if (url.pathname === "/api/providers") {
    requireMethod(method, ["GET"])
    sendJson(res, await listProviders())
    return
  }

  if (url.pathname === "/api/plugins") {
    requireMethod(method, ["GET"])
    sendJson(res, await listPlugins())
    return
  }

  const pluginActionMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/actions\/([^/]+)$/)
  if (pluginActionMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await runPluginAction(
      decodeURIComponent(pluginActionMatch[1]),
      decodeURIComponent(pluginActionMatch[2]),
    ))
    return
  }

  const pluginMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)$/)
  if (pluginMatch) {
    requireMethod(method, ["PATCH"])
    sendJson(res, await updatePlugin(
      decodeURIComponent(pluginMatch[1]),
      readPluginSettingsUpdateRequest(await readNodeJsonBody(req)),
    ))
    return
  }

  if (url.pathname === "/api/providers/codex/instructions") {
    requireMethod(method, ["GET", "PUT"])
    if (method === "PUT") {
      sendJson(res, await updateCodexInstructions(readCodexInstructionsRequest(await readNodeJsonBody(req)).instructions))
      return
    }
    sendJson(res, await readCodexInstructions())
    return
  }

  if (url.pathname === "/api/mcp-servers") {
    requireMethod(method, ["GET", "POST"])
    if (method === "POST") {
      sendJson(res, await createMcpServer(await readNodeJsonBody(req) as Partial<CreateMcpServerBody> as CreateMcpServerBody), 201)
      return
    }
    sendJson(res, await listMcpServers())
    return
  }

  if (url.pathname === "/api/mcp-servers/status") {
    requireMethod(method, ["GET"])
    sendJson(res, await listMcpServerStatuses(readStringField(url.searchParams.get("accountId"), "accountId", { required: true })))
    return
  }

  const mcpServerSyncMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/sync$/)
  if (mcpServerSyncMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await syncMcpServer(
      decodeURIComponent(mcpServerSyncMatch[1]),
      await readNodeJsonBody(req) as Partial<SyncMcpServerBody> as SyncMcpServerBody,
    ))
    return
  }

  const mcpServerOauthLoginMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/oauth-login$/)
  if (mcpServerOauthLoginMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await startMcpServerOauthLogin(
      decodeURIComponent(mcpServerOauthLoginMatch[1]),
      await readNodeJsonBody(req) as Partial<McpServerOauthLoginBody> as McpServerOauthLoginBody,
    ))
    return
  }

  const mcpServerMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)$/)
  if (mcpServerMatch) {
    const serverId = decodeURIComponent(mcpServerMatch[1])
    requireMethod(method, ["DELETE", "GET", "PATCH"])
    if (method === "DELETE") {
      sendJson(res, await deleteMcpServer(serverId))
      return
    }
    if (method === "PATCH") {
      sendJson(res, await updateMcpServer(serverId, await readNodeJsonBody(req) as Partial<UpdateMcpServerBody> as UpdateMcpServerBody))
      return
    }
    sendJson(res, await getMcpServer(serverId))
    return
  }

  if (url.pathname === "/api/provider-accounts") {
    requireMethod(method, ["GET", "POST"])
    if (method === "POST") {
      sendJson(res, await createAccount(readCreateAccountRequest(await readNodeJsonBody(req))), 201)
      return
    }
    sendJson(res, await listAccounts())
    return
  }

  if (url.pathname === "/api/provider-accounts/limits") {
    requireMethod(method, ["GET"])
    sendJson(res, await readConnectedAccountLimits())
    return
  }

  if (url.pathname === "/api/chats") {
    requireMethod(method, ["GET", "POST"])
    if (method === "POST") {
      sendJson(res, await createChat(readCreateChatRequest(await readNodeJsonBody(req))), 201)
      return
    }
    const workingDirectory = url.searchParams.get("workingDirectory")
    sendJson(res, await listChats(workingDirectory))
    return
  }

  if (url.pathname === "/api/schedules") {
    requireMethod(method, ["GET", "POST"])
    if (method === "POST") {
      sendJson(res, await createMessageSchedule(readCreateMessageScheduleRequest(await readNodeJsonBody(req))), 201)
      return
    }
    sendJson(res, await listMessageSchedules(url.searchParams.get("workingDirectory")))
    return
  }

  const scheduleRunsMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/runs$/)
  if (scheduleRunsMatch) {
    requireMethod(method, ["GET"])
    sendJson(res, await listMessageScheduleRuns(decodeURIComponent(scheduleRunsMatch[1])))
    return
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleMatch) {
    const scheduleId = decodeURIComponent(scheduleMatch[1])
    requireMethod(method, ["DELETE", "GET", "PATCH"])
    if (method === "DELETE") {
      sendJson(res, await archiveMessageSchedule(scheduleId))
      return
    }
    if (method === "PATCH") {
      sendJson(res, await updateMessageSchedule(scheduleId, readUpdateMessageScheduleRequest(await readNodeJsonBody(req))))
      return
    }
    sendJson(res, await getMessageSchedule(scheduleId))
    return
  }

  const chatMessagesMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/)
  if (chatMessagesMatch) {
    const chatId = decodeURIComponent(chatMessagesMatch[1])
    requireMethod(method, ["GET", "POST"])
    if (method === "POST") {
      sendJson(res, await executeMessage(chatId, readExecuteChatRequest(await readNodeJsonBody(req))), 202)
      return
    }
    sendJson(res, await listMessages(chatId, readIntegerParam(url.searchParams.get("limit"), 1000)))
    return
  }

  const chatInterruptMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/interrupt$/)
  if (chatInterruptMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await interruptChatRun(decodeURIComponent(chatInterruptMatch[1])))
    return
  }

  const chatForkMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/fork$/)
  if (chatForkMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await forkChat(
      decodeURIComponent(chatForkMatch[1]),
      readForkChatRequest(await readNodeJsonBody(req)),
    ), 201)
    return
  }

  const chatCompactMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/compact$/)
  if (chatCompactMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await compactChat(
      decodeURIComponent(chatCompactMatch[1]),
      readCompactChatRequest(await readNodeJsonBody(req)),
    ))
    return
  }

  const chatReviewMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/review$/)
  if (chatReviewMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await reviewChat(
      decodeURIComponent(chatReviewMatch[1]),
      readReviewChatRequest(await readNodeJsonBody(req)),
    ))
    return
  }

  const chatRefreshMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/refresh$/)
  if (chatRefreshMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await refreshChat(decodeURIComponent(chatRefreshMatch[1])))
    return
  }

  const serverRequestMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/server-requests\/([^/]+)$/)
  if (serverRequestMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await respondToServerRequest(
      decodeURIComponent(serverRequestMatch[1]),
      decodeURIComponent(serverRequestMatch[2]),
      readServerRequestResponseRequest(await readNodeJsonBody(req)),
    ))
    return
  }

  const queuedRunsReorderMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/runs\/reorder$/)
  if (queuedRunsReorderMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await reorderQueuedChatRuns(
      decodeURIComponent(queuedRunsReorderMatch[1]),
      readReorderQueuedChatRunsRequest(await readNodeJsonBody(req)),
    ))
    return
  }

  const queuedRunSteerMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/runs\/([^/]+)\/steer$/)
  if (queuedRunSteerMatch) {
    requireMethod(method, ["POST"])
    sendJson(res, await steerQueuedChatRun(decodeURIComponent(queuedRunSteerMatch[1]), decodeURIComponent(queuedRunSteerMatch[2])))
    return
  }

  const queuedRunMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/runs\/([^/]+)$/)
  if (queuedRunMatch) {
    const chatId = decodeURIComponent(queuedRunMatch[1])
    const runId = decodeURIComponent(queuedRunMatch[2])
    requireMethod(method, ["DELETE", "PATCH"])
    if (method === "DELETE") {
      sendJson(res, await deleteQueuedChatRun(chatId, runId))
      return
    }
    sendJson(res, await updateQueuedChatRun(chatId, runId, readUpdateQueuedChatRunRequest(await readNodeJsonBody(req))))
    return
  }

  const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/)
  if (chatMatch) {
    const chatId = decodeURIComponent(chatMatch[1])
    requireMethod(method, ["DELETE", "PATCH"])
    if (method === "DELETE") {
      sendJson(res, await archiveChat(chatId))
      return
    }
    sendJson(res, await updateChat(chatId, readUpdateChatRequest(await readNodeJsonBody(req))))
    return
  }

  const accountAuthMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)\/authenticate$/)
  if (accountAuthMatch) {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await authenticateAccount(decodeURIComponent(accountAuthMatch[1]), readAuthMode(body.mode)))
    return
  }

  const accountModelsMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)\/models$/)
  if (accountModelsMatch) {
    requireMethod(method, ["GET"])
    sendJson(res, await listAccountModels(decodeURIComponent(accountModelsMatch[1])))
    return
  }

  const accountMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)$/)
  if (accountMatch) {
    requireMethod(method, ["DELETE", "PATCH"])
    const accountId = decodeURIComponent(accountMatch[1])
    if (method === "DELETE") {
      sendJson(res, await deleteAccount(accountId))
      return
    }
    sendJson(res, await updateAccount(accountId, readUpdateAccountRequest(await readNodeJsonBody(req))))
    return
  }

  if (url.pathname === "/api/workspaces") {
    requireMethod(method, ["DELETE", "GET", "POST"])
    if (method === "POST") {
      const body = await readNodeJsonBody(req)
      sendJson(res, await saveWorkspaceHistory(readStringField(body.path, "path", { required: true })), 201)
      return
    }
    if (method === "DELETE") {
      sendJson(res, await deleteWorkspaceHistory(readStringField(url.searchParams.get("path"), "path", { required: true })))
      return
    }
    sendJson(res, await listWorkspaceHistory())
    return
  }

  if (url.pathname === "/api/workspaces/directories") {
    requireMethod(method, ["GET"])
    sendJson(res, await listWorkspaceDirectory(url.searchParams.get("path"), url.searchParams.get("hidden") === "1"))
    return
  }

  if (url.pathname === "/api/workspaces/tree") {
    requireMethod(method, ["GET"])
    sendJson(res, await readWorkspaceTree(url.searchParams.get("path"), url.searchParams.get("hidden") === "1"))
    return
  }

  if (url.pathname === "/api/workspaces/resource") {
    requireMethod(method, ["GET"])
    sendJson(res, await readWorkspaceResource(url.searchParams.get("path")))
    return
  }

  if (url.pathname === "/api/cloudflared/status") {
    requireMethod(method, ["GET"])
    sendJson(res, await readCloudflaredStatus())
    return
  }

  if (url.pathname === "/api/cloudflared/temporary") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await startTemporaryCloudflaredTunnel(
      readStringField(body.url, "url", { required: true, maxLength: 2_000 }),
    ), 201)
    return
  }

  const cloudflaredTemporaryMatch = url.pathname.match(/^\/api\/cloudflared\/temporary\/([^/]+)$/)
  if (cloudflaredTemporaryMatch) {
    requireMethod(method, ["DELETE"])
    sendJson(res, await stopTemporaryCloudflaredTunnel(decodeURIComponent(cloudflaredTemporaryMatch[1])))
    return
  }

  const cloudflaredTunnelMatch = url.pathname.match(/^\/api\/cloudflared\/tunnels\/([^/]+)$/)
  if (cloudflaredTunnelMatch) {
    requireMethod(method, ["DELETE"])
    sendJson(res, await deleteNamedCloudflaredTunnel(decodeURIComponent(cloudflaredTunnelMatch[1])))
    return
  }

  if (url.pathname === "/api/git/status") {
    requireMethod(method, ["GET"])
    sendJson(res, await readGitStatus(url.searchParams.get("path") ?? undefined))
    return
  }

  if (url.pathname === "/api/git/init") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await initGitRepository(readStringField(body.path, "path", { required: true })), 201)
    return
  }

  if (url.pathname === "/api/git/stage") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await stageGitPaths(
      readStringField(body.path, "path", { required: true }),
      readStringArrayField(body.paths, "paths"),
    ))
    return
  }

  if (url.pathname === "/api/git/unstage") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await unstageGitPaths(
      readStringField(body.path, "path", { required: true }),
      readStringArrayField(body.paths, "paths"),
    ))
    return
  }

  if (url.pathname === "/api/git/discard") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await discardGitPaths(
      readStringField(body.path, "path", { required: true }),
      readStringArrayField(body.paths, "paths"),
    ))
    return
  }

  if (url.pathname === "/api/git/commit") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await commitGitChanges(
      readStringField(body.path, "path", { required: true }),
      readStringField(body.message, "message", { required: true, maxLength: 500 }),
    ))
    return
  }

  if (url.pathname === "/api/git/pull") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await pullGitRepository(readStringField(body.path, "path", { required: true })))
    return
  }

  if (url.pathname === "/api/git/push") {
    requireMethod(method, ["POST"])
    const body = await readNodeJsonBody(req)
    sendJson(res, await pushGitRepository(readStringField(body.path, "path", { required: true })))
    return
  }

  throw new HttpError(404, "API route not found.")
}

function readCreateAccountRequest(body: Partial<CreateProviderAccountRequest>): CreateProviderAccountRequest {
  return {
    displayName: readStringField(body.displayName, "displayName", { maxLength: 100 }),
    providerId: readStringField(body.providerId, "providerId", { required: true }),
    runtimeDefaults: readRecordField(body.runtimeDefaults, "runtimeDefaults") as CreateProviderAccountRequest["runtimeDefaults"],
    settings: readRecordField(body.settings, "settings") as CreateProviderAccountRequest["settings"],
  }
}

function readPluginSettingsUpdateRequest(body: Partial<PluginSettingsUpdateRequest>): PluginSettingsUpdateRequest {
  return {
    enabled: readBooleanField(body.enabled, "enabled"),
    secrets: readRecordField(body.secrets, "secrets") as PluginSettingsUpdateRequest["secrets"],
    settings: readRecordField(body.settings, "settings") as PluginSettingsUpdateRequest["settings"],
  }
}

function readCodexInstructionsRequest(body: Partial<UpdateCodexInstructionsRequest>): UpdateCodexInstructionsRequest {
  if (body.instructions === undefined) {
    return { instructions: "" }
  }
  if (typeof body.instructions !== "string") {
    throw new HttpError(400, "instructions must be a string.")
  }
  if (body.instructions.length > 100_000) {
    throw new HttpError(400, "instructions must be 100000 characters or fewer.")
  }
  return { instructions: body.instructions }
}

function readCreateChatRequest(body: Partial<CreateChatRequest>): CreateChatRequest {
  return {
    accountId: readStringField(body.accountId, "accountId", { required: true }),
    autoRotateAccount: readBooleanField(body.autoRotateAccount, "autoRotateAccount"),
    collaborationMode: readStringField(body.collaborationMode, "collaborationMode"),
    model: readStringField(body.model, "model"),
    permissionMode: readStringField(body.permissionMode, "permissionMode"),
    providerId: readStringField(body.providerId, "providerId"),
    reasoningEffort: readStringField(body.reasoningEffort, "reasoningEffort"),
    serviceTier: readStringField(body.serviceTier, "serviceTier"),
    title: readStringField(body.title, "title", { maxLength: 160 }),
    workingDirectory: readStringField(body.workingDirectory, "workingDirectory", { required: true }),
  }
}

function readCreateMessageScheduleRequest(body: Partial<CreateMessageScheduleRequest>): CreateMessageScheduleRequest {
  return {
    accountId: readStringField(body.accountId, "accountId", { required: true }),
    collaborationMode: readNullableStringField(body.collaborationMode, "collaborationMode"),
    firstRunAt: readStringField(body.firstRunAt, "firstRunAt", { required: true }),
    goalObjective: readNullableStringField(body.goalObjective, "goalObjective"),
    message: readStringField(body.message, "message", { required: true, maxLength: 20_000 }),
    model: readNullableStringField(body.model, "model"),
    permissionMode: readNullableStringField(body.permissionMode, "permissionMode"),
    reasoningEffort: readNullableStringField(body.reasoningEffort, "reasoningEffort"),
    recurrence: readScheduleRecurrence(body.recurrence),
    serviceTier: readNullableStringField(body.serviceTier, "serviceTier"),
    status: readCreateScheduleStatus(body.status),
    title: readStringField(body.title, "title", { maxLength: 160 }),
    workingDirectory: readStringField(body.workingDirectory, "workingDirectory", { required: true }),
  }
}

function readUpdateMessageScheduleRequest(body: Partial<UpdateMessageScheduleRequest>): UpdateMessageScheduleRequest {
  return {
    accountId: readNullableStringField(body.accountId, "accountId"),
    collaborationMode: readNullableStringField(body.collaborationMode, "collaborationMode"),
    firstRunAt: readNullableStringField(body.firstRunAt, "firstRunAt"),
    goalObjective: readNullableStringField(body.goalObjective, "goalObjective"),
    message: readStringField(body.message, "message", { maxLength: 20_000 }),
    model: readNullableStringField(body.model, "model"),
    permissionMode: readNullableStringField(body.permissionMode, "permissionMode"),
    reasoningEffort: readNullableStringField(body.reasoningEffort, "reasoningEffort"),
    recurrence: readScheduleRecurrence(body.recurrence),
    serviceTier: readNullableStringField(body.serviceTier, "serviceTier"),
    status: readScheduleStatus(body.status),
    title: readStringField(body.title, "title", { maxLength: 160 }),
  }
}

function readUpdateChatRequest(body: Partial<UpdateChatRequest>): UpdateChatRequest {
  return {
    accountId: readNullableStringField(body.accountId, "accountId"),
    autoRotateAccount: readBooleanField(body.autoRotateAccount, "autoRotateAccount"),
    collaborationMode: readNullableStringField(body.collaborationMode, "collaborationMode"),
    model: readNullableStringField(body.model, "model"),
    permissionMode: readNullableStringField(body.permissionMode, "permissionMode"),
    reasoningEffort: readNullableStringField(body.reasoningEffort, "reasoningEffort"),
    serviceTier: readNullableStringField(body.serviceTier, "serviceTier"),
    title: readStringField(body.title, "title", { maxLength: 160 }),
    workingDirectory: readStringField(body.workingDirectory, "workingDirectory"),
  }
}

function readForkChatRequest(body: Partial<ForkChatRequest>): ForkChatRequest {
  return {
    lastTurnId: readNullableStringField(body.lastTurnId, "lastTurnId"),
  }
}

function readCompactChatRequest(_body: Partial<CompactChatRequest>): CompactChatRequest {
  return {}
}

function readReviewChatRequest(body: Partial<ReviewChatRequest>): ReviewChatRequest {
  const target = body.target
  if (
    target !== undefined &&
    target !== null &&
    target !== "uncommittedChanges" &&
    target !== "baseBranch" &&
    target !== "commit" &&
    target !== "custom"
  ) {
    throw new HttpError(400, "target must be uncommittedChanges, baseBranch, commit, or custom.")
  }
  const delivery = body.delivery
  if (delivery !== undefined && delivery !== null && delivery !== "inline" && delivery !== "detached") {
    throw new HttpError(400, "delivery must be inline or detached.")
  }
  return {
    baseBranch: readNullableStringField(body.baseBranch, "baseBranch"),
    commitSha: readNullableStringField(body.commitSha, "commitSha"),
    commitTitle: readNullableStringField(body.commitTitle, "commitTitle"),
    delivery,
    instructions: readNullableStringField(body.instructions, "instructions"),
    target,
  }
}

function readExecuteChatRequest(body: Partial<ExecuteChatRequest>): ExecuteChatRequest {
  return {
    accountId: readStringField(body.accountId, "accountId"),
    attachments: readChatAttachments(body.attachments),
    collaborationMode: readNullableStringField(body.collaborationMode, "collaborationMode"),
    content: readStringField(body.content, "content", { required: true }),
    delivery: body.delivery === "queue" || body.delivery === "steer" ? body.delivery : undefined,
    goalObjective: readNullableStringField(body.goalObjective, "goalObjective"),
    metadata: readRecordField(body.metadata, "metadata") as ExecuteChatRequest["metadata"],
    permissionMode: readNullableStringField(body.permissionMode, "permissionMode"),
  }
}

function readUpdateQueuedChatRunRequest(body: Partial<UpdateQueuedChatRunRequest>): UpdateQueuedChatRunRequest {
  return {
    content: readStringField(body.content, "content", { required: true }),
  }
}

function readReorderQueuedChatRunsRequest(body: Partial<ReorderQueuedChatRunsRequest>): ReorderQueuedChatRunsRequest {
  if (!Array.isArray(body.runIds)) {
    throw new HttpError(400, "runIds must be an array.")
  }
  return {
    runIds: body.runIds
      .map((runId) => readStringField(runId, "runIds[]", { required: true }))
      .filter((runId, index, runIds) => runIds.indexOf(runId) === index),
  }
}

function readServerRequestResponseRequest(body: Partial<ServerRequestResponseRequest>): ServerRequestResponseRequest {
  const kind = body.kind
  if (kind !== "approval" && kind !== "permissions" && kind !== "userInput") {
    throw new HttpError(400, "kind must be approval, permissions, or userInput.")
  }
  return {
    decision: body.decision,
    kind,
    result: body.result,
  }
}

function readChatAttachments(value: unknown): ChatAttachmentRequest[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "attachments must be an array.")
  }
  return value.slice(0, 20).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, `attachments[${index}] must be an object.`)
    }
    const record = item as Record<string, unknown>
    const kind = record.kind
    if (kind !== "file" && kind !== "folder" && kind !== "image") {
      throw new HttpError(400, `attachments[${index}].kind is invalid.`)
    }
    const size = record.size
    return {
      dataUrl: readStringField(record.dataUrl, `attachments[${index}].dataUrl`),
      kind,
      mimeType: readStringField(record.mimeType, `attachments[${index}].mimeType`),
      name: readStringField(record.name, `attachments[${index}].name`, { required: true, maxLength: 240 }),
      path: readStringField(record.path, `attachments[${index}].path`, { maxLength: 1000 }),
      size: typeof size === "number" && Number.isFinite(size) ? size : undefined,
    }
  })
}

function readUpdateAccountRequest(body: Partial<UpdateProviderAccountRequest>): UpdateProviderAccountRequest {
  return {
    displayName: readStringField(body.displayName, "displayName", { maxLength: 100 }),
    runtimeDefaults: readRecordField(body.runtimeDefaults, "runtimeDefaults") as UpdateProviderAccountRequest["runtimeDefaults"],
    settings: readRecordField(body.settings, "settings") as UpdateProviderAccountRequest["settings"],
  }
}

function readScheduleRecurrence(value: unknown): Partial<MessageScheduleRecurrence> | undefined {
  if (value === undefined) {
    return undefined
  }
  const record = readRecordField(value, "recurrence") ?? {}
  const frequency = record.frequency
  if (
    frequency !== undefined &&
    frequency !== "none" &&
    frequency !== "daily" &&
    frequency !== "weekly" &&
    frequency !== "monthly"
  ) {
    throw new HttpError(400, "recurrence.frequency must be none, daily, weekly, or monthly.")
  }
  return {
    anchorDay: readOptionalNumber(record.anchorDay, "recurrence.anchorDay") ?? undefined,
    endAt: readNullableStringField(record.endAt, "recurrence.endAt"),
    frequency,
    interval: readOptionalNumber(record.interval, "recurrence.interval") ?? undefined,
    maxRuns: readOptionalNumber(record.maxRuns, "recurrence.maxRuns"),
  }
}

function readCreateScheduleStatus(value: unknown): CreateMessageScheduleRequest["status"] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === "ACTIVE" || value === "PAUSED") {
    return value
  }
  throw new HttpError(400, "status must be ACTIVE or PAUSED.")
}

function readScheduleStatus(value: unknown): UpdateMessageScheduleRequest["status"] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === "ACTIVE" || value === "PAUSED" || value === "COMPLETED" || value === "ARCHIVED") {
    return value
  }
  throw new HttpError(400, "status must be ACTIVE, PAUSED, COMPLETED, or ARCHIVED.")
}

function readOptionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null || value === "") {
    return null
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `${field} must be a number.`)
  }
  return value
}

function readNullableStringField(value: unknown, field: string): string | null | undefined {
  if (value === null) {
    return null
  }
  return readStringField(value, field)
}

function readStringArrayField(value: unknown, field: string): string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array.`)
  }
  return value.map((item, index) => readStringField(item, `${field}[${index}]`, { required: true }))
}

function readAuthMode(value: unknown): AccountAuthMode {
  if (value === undefined || value === null) {
    return "browser"
  }
  if (value === "browser" || value === "device" || value === "local") {
    return value
  }
  throw new HttpError(400, "mode must be browser, device, or local.")
}

function readIntegerParam(value: string | null, fallback: number): number {
  if (!value) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function readNodeJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) {
    return {}
  }

  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "JSON body must be an object.")
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }
    throw new HttpError(400, "Request body must be valid JSON.")
  }
}

function requireMethod(method: string, allowed: string[]): void {
  if (!allowed.includes(method)) {
    throw new HttpError(405, `${method} is not supported for this route.`)
  }
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

function sendRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, { error: error.message }, error.status)
    return
  }

  sendJson(res, { error: error instanceof Error ? error.message : "Request failed." }, 500)
}
