import type {
  AccountAuthMode,
  AuthenticateProviderAccountResponse,
  ChatResponse,
  CodexInstructionsResponse,
  CreateChatRequest,
  CreateMessageScheduleRequest,
  CreateProviderAccountRequest,
  ExecuteChatRequest,
  ExecuteChatResponse,
  MessageScheduleResponse,
  MessageScheduleRunResponse,
  MessagePageResponse,
  ProviderAccountResponse,
  ProviderAccountLimitsResponse,
  ProviderDefinitionResponse,
  ProviderModelListResponse,
  QueuedChatRunResponse,
  ReorderQueuedChatRunsRequest,
  ReorderQueuedChatRunsResponse,
  ServerRequestResponseRequest,
  UpdateMessageScheduleRequest,
  UpdateQueuedChatRunRequest,
  UpdateChatRequest,
  UpdateCodexInstructionsRequest,
  UpdateProviderAccountRequest,
  WorkspaceHistoryResponse,
} from "../../app/types/providers"
import type {
  CreateMcpServerRequest,
  McpServerOauthLoginRequest,
  McpServerOauthLoginResponse,
  McpServerResponse,
  McpServerStatusResponse,
  SyncMcpServerRequest,
  UpdateMcpServerRequest,
} from "../../app/types/mcp"

export type {
  AccountAuthMode,
  ChatAttachmentRequest,
  ChatMessageResponse,
  ChatResponse,
  CreateMessageScheduleRequest,
  MessageScheduleRecurrence,
  MessageScheduleResponse,
  MessageScheduleRunResponse,
  MessageScheduleRunStatus,
  MessageScheduleStatus,
  ProviderAccountResponse,
  ProviderAccountLimitsResponse,
  ProviderAccountStatus,
  ProviderComposerFeature,
  ProviderDefinitionResponse,
  ProviderLimitsResponse,
  CodexInstructionsResponse,
  ProviderModelListResponse,
  ServerRequestResponseRequest,
  UpdateMessageScheduleRequest,
  WorkspaceHistoryResponse,
} from "../../app/types/providers"
export type {
  CreateMcpServerRequest,
  McpAuthStatus,
  McpServerOauthLoginRequest,
  McpServerOauthLoginResponse,
  McpServerResponse,
  McpServerStatusItem,
  McpServerStatusResponse,
  McpServerToolPolicy,
  McpServerTransportConfig,
  McpToolApprovalMode,
  SyncMcpServerRequest,
  UpdateMcpServerRequest,
} from "../../app/types/mcp"

export type BrowserEntry = {
  children?: BrowserEntry[]
  content?: string
  error?: string
  name: string
  path: string
  type: "directory" | "file" | "symlink"
}

export type BrowserDirectoryResponse = {
  entries: BrowserEntry[]
  parentPath: string | null
  path: string
  root: string
}

export type BrowserResourceResponse = BrowserEntry & {
  content: string
}

export type GitFileChange = {
  indexStatus: string
  originalPath?: string
  path: string
  staged: boolean
  status: "added" | "deleted" | "modified" | "renamed" | "untracked"
  workingTreeStatus: string
}

export type GitCommitEntry = {
  author: string
  hash: string
  refs: string
  subject: string
}

export type GitStatusResponse = {
  ahead: number
  behind: number
  branch: string
  changes: GitFileChange[]
  commits: GitCommitEntry[]
  isRepository: boolean
  message?: string
  upstream?: string
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

export const apiClient = {
  chats: {
    create(body: CreateChatRequest) {
      return requestJson<ChatResponse>("/api/chats", {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to create chat.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    delete(chatId: string) {
      return requestJson<ChatResponse>(`/api/chats/${chatId}`, {
        fallbackMessage: "Unable to archive chat.",
        method: "DELETE",
      })
    },
    execute(chatId: string, body: ExecuteChatRequest) {
      return requestJson<ExecuteChatResponse>(`/api/chats/${chatId}/messages`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to send message.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    interrupt(chatId: string) {
      return requestJson(`/api/chats/${chatId}/interrupt`, {
        fallbackMessage: "Unable to stop chat.",
        method: "POST",
      })
    },
    respondToServerRequest(chatId: string, requestId: string, body: ServerRequestResponseRequest) {
      return requestJson(`/api/chats/${chatId}/server-requests/${encodeURIComponent(requestId)}`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to respond to approval request.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    deleteQueuedRun(chatId: string, runId: string) {
      return requestJson<QueuedChatRunResponse>(`/api/chats/${chatId}/runs/${runId}`, {
        fallbackMessage: "Unable to delete queued message.",
        method: "DELETE",
      })
    },
    list(workingDirectory?: string) {
      return requestJson<ChatResponse[]>(`/api/chats${workingDirectory ? `?workingDirectory=${encodeURIComponent(workingDirectory)}` : ""}`, {
        fallbackMessage: "Unable to load chats.",
      })
    },
    listMessages(chatId: string) {
      return requestJson<MessagePageResponse>(`/api/chats/${chatId}/messages`, {
        fallbackMessage: "Unable to load messages.",
      })
    },
    reorderQueuedRuns(chatId: string, body: ReorderQueuedChatRunsRequest) {
      return requestJson<ReorderQueuedChatRunsResponse>(`/api/chats/${chatId}/runs/reorder`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to reorder queued messages.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    steerQueuedRun(chatId: string, runId: string) {
      return requestJson<QueuedChatRunResponse>(`/api/chats/${chatId}/runs/${runId}/steer`, {
        fallbackMessage: "Unable to steer queued message.",
        method: "POST",
      })
    },
    update(chatId: string, body: UpdateChatRequest) {
      return requestJson<ChatResponse>(`/api/chats/${chatId}`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to update chat.",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      })
    },
    updateQueuedRun(chatId: string, runId: string, body: UpdateQueuedChatRunRequest) {
      return requestJson<QueuedChatRunResponse>(`/api/chats/${chatId}/runs/${runId}`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to update queued message.",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      })
    },
  },
  schedules: {
    create(body: CreateMessageScheduleRequest) {
      return requestJson<MessageScheduleResponse>("/api/schedules", {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to create schedule.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    delete(scheduleId: string) {
      return requestJson<MessageScheduleResponse>(`/api/schedules/${scheduleId}`, {
        fallbackMessage: "Unable to delete schedule.",
        method: "DELETE",
      })
    },
    get(scheduleId: string) {
      return requestJson<MessageScheduleResponse>(`/api/schedules/${scheduleId}`, {
        fallbackMessage: "Unable to load schedule.",
      })
    },
    list(workingDirectory?: string) {
      return requestJson<MessageScheduleResponse[]>(`/api/schedules${workingDirectory ? `?workingDirectory=${encodeURIComponent(workingDirectory)}` : ""}`, {
        fallbackMessage: "Unable to load schedules.",
      })
    },
    listRuns(scheduleId: string) {
      return requestJson<MessageScheduleRunResponse[]>(`/api/schedules/${scheduleId}/runs`, {
        fallbackMessage: "Unable to load schedule history.",
      })
    },
    update(scheduleId: string, body: UpdateMessageScheduleRequest) {
      return requestJson<MessageScheduleResponse>(`/api/schedules/${scheduleId}`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to update schedule.",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      })
    },
  },
  providerAccounts: {
    authenticate(accountId: string, mode: AccountAuthMode = "browser") {
      return requestJson<AuthenticateProviderAccountResponse>(`/api/provider-accounts/${accountId}/authenticate`, {
        body: JSON.stringify({ mode }),
        fallbackMessage: "Unable to authenticate provider account.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    create(body: CreateProviderAccountRequest) {
      return requestJson<ProviderAccountResponse>("/api/provider-accounts", {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to add provider account.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    delete(accountId: string) {
      return requestJson<ProviderAccountResponse>(`/api/provider-accounts/${accountId}`, {
        fallbackMessage: "Unable to delete provider account.",
        method: "DELETE",
      })
    },
    list() {
      return requestJson<ProviderAccountResponse[]>("/api/provider-accounts", {
        fallbackMessage: "Unable to load provider accounts.",
      })
    },
    limits() {
      return requestJson<ProviderAccountLimitsResponse>("/api/provider-accounts/limits", {
        fallbackMessage: "Unable to load provider limits.",
      })
    },
    models(accountId: string) {
      return requestJson<ProviderModelListResponse>(`/api/provider-accounts/${accountId}/models`, {
        fallbackMessage: "Unable to load provider models.",
      })
    },
    update(accountId: string, body: UpdateProviderAccountRequest) {
      return requestJson<ProviderAccountResponse>(`/api/provider-accounts/${accountId}`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to update provider account.",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      })
    },
  },
  providers: {
    codexInstructions() {
      return requestJson<CodexInstructionsResponse>("/api/providers/codex/instructions", {
        fallbackMessage: "Unable to load Codex instructions.",
      })
    },
    list() {
      return requestJson<ProviderDefinitionResponse[]>("/api/providers", {
        fallbackMessage: "Unable to load providers.",
      })
    },
    updateCodexInstructions(body: UpdateCodexInstructionsRequest) {
      return requestJson<CodexInstructionsResponse>("/api/providers/codex/instructions", {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to save Codex instructions.",
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      })
    },
  },
  mcpServers: {
    create(body: CreateMcpServerRequest) {
      return requestJson<McpServerResponse>("/api/mcp-servers", {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to add MCP server.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    delete(serverId: string) {
      return requestJson<McpServerResponse>(`/api/mcp-servers/${serverId}`, {
        fallbackMessage: "Unable to delete MCP server.",
        method: "DELETE",
      })
    },
    get(serverId: string) {
      return requestJson<McpServerResponse>(`/api/mcp-servers/${serverId}`, {
        fallbackMessage: "Unable to load MCP server.",
      })
    },
    list() {
      return requestJson<McpServerResponse[]>("/api/mcp-servers", {
        fallbackMessage: "Unable to load MCP servers.",
      })
    },
    oauthLogin(serverId: string, body: McpServerOauthLoginRequest) {
      return requestJson<McpServerOauthLoginResponse>(`/api/mcp-servers/${serverId}/oauth-login`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to start MCP OAuth login.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    status(accountId: string) {
      return requestJson<McpServerStatusResponse>(`/api/mcp-servers/status?accountId=${encodeURIComponent(accountId)}`, {
        fallbackMessage: "Unable to refresh MCP status.",
      })
    },
    sync(serverId: string, body: SyncMcpServerRequest = {}) {
      return requestJson<McpServerResponse>(`/api/mcp-servers/${serverId}/sync`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to sync MCP server.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
    update(serverId: string, body: UpdateMcpServerRequest) {
      return requestJson<McpServerResponse>(`/api/mcp-servers/${serverId}`, {
        body: JSON.stringify(body),
        fallbackMessage: "Unable to update MCP server.",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      })
    },
  },
  git: {
    commit(path: string, message: string) {
      return postGitAction("/api/git/commit", { message, path }, "Unable to commit changes.")
    },
    discard(path: string, paths: string[]) {
      return postGitAction("/api/git/discard", { path, paths }, "Unable to discard changes.")
    },
    init(path: string) {
      return postGitAction("/api/git/init", { path }, "Unable to initialize repository.")
    },
    pull(path: string) {
      return postGitAction("/api/git/pull", { path }, "Unable to pull changes.")
    },
    push(path: string) {
      return postGitAction("/api/git/push", { path }, "Unable to push changes.")
    },
    stage(path: string, paths: string[]) {
      return postGitAction("/api/git/stage", { path, paths }, "Unable to stage changes.")
    },
    status(path: string) {
      return requestJson<GitStatusResponse>(`/api/git/status?path=${encodeURIComponent(path)}`, {
        fallbackMessage: "Unable to load Git status.",
      })
    },
    unstage(path: string, paths: string[]) {
      return postGitAction("/api/git/unstage", { path, paths }, "Unable to unstage changes.")
    },
  },
  lsp: {
    listServers(workspacePath: string) {
      return requestJson<LanguageServerInfo[]>(`/api/lsp/servers?workspacePath=${encodeURIComponent(workspacePath)}`, {
        fallbackMessage: "Unable to load language servers.",
      })
    },
  },
  workspaces: {
    deleteHistory(path: string) {
      return requestJson<{ path: string }>(`/api/workspaces?path=${encodeURIComponent(path)}`, {
        fallbackMessage: "Unable to remove workspace history.",
        method: "DELETE",
      })
    },
    listHistory() {
      return requestJson<WorkspaceHistoryResponse[]>("/api/workspaces", {
        fallbackMessage: "Unable to load workspace history.",
      })
    },
    listDirectory(path?: string, includeHidden = false) {
      return requestJson<BrowserDirectoryResponse>(`/api/workspaces/directories${workspaceQuery(path, includeHidden)}`, {
        fallbackMessage: "Unable to list folder.",
      })
    },
    readTree(path: string, includeHidden = false) {
      return requestJson<BrowserEntry>(`/api/workspaces/tree${workspaceQuery(path, includeHidden)}`, {
        fallbackMessage: "Unable to open folder.",
      })
    },
    readResource(path: string) {
      return requestJson<BrowserResourceResponse>(`/api/workspaces/resource?path=${encodeURIComponent(path)}`, {
        fallbackMessage: "Unable to open file.",
      })
    },
    saveHistory(path: string) {
      return requestJson<WorkspaceHistoryResponse>("/api/workspaces", {
        body: JSON.stringify({ path }),
        fallbackMessage: "Unable to save workspace history.",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    },
  },
}

function postGitAction(path: string, body: Record<string, unknown>, fallbackMessage: string) {
  return requestJson<GitStatusResponse>(path, {
    body: JSON.stringify(body),
    fallbackMessage,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  })
}

async function requestJson<T>(path: string, options: RequestInit & { fallbackMessage: string }): Promise<T> {
  const { fallbackMessage, ...init } = options
  const response = await fetch(path, init)
  const text = await response.text()
  let body: unknown = null

  if (text.trim()) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      throw new Error(fallbackMessage)
    }
  }

  if (!response.ok) {
    throw new Error(readApiError(body) ?? fallbackMessage)
  }

  return body as T
}

function readApiError(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null
  }
  const error = (body as { error?: unknown }).error
  return typeof error === "string" && error.trim() ? error : null
}

function workspaceQuery(path: string | undefined, includeHidden: boolean) {
  const params = new URLSearchParams()
  if (path) {
    params.set("path", path)
  }
  if (includeHidden) {
    params.set("hidden", "1")
  }
  const query = params.toString()
  return query ? `?${query}` : ""
}
