import type { McpServer, McpServerInstallation, ProviderAccount } from "@prisma/client"
import type {
  AccountAuthMode,
  AuthenticateProviderAccountResponse,
  CompactChatRequest,
  ChatStatsResponse,
  ChatStatus,
  ChatAttachmentRequest,
  ForkChatRequest,
  MessageKind,
  MessageRole,
  MessageStatus,
  ProviderCapability,
  ProviderDefinitionResponse,
  ProviderFieldDefinition,
  ProviderInstructionsResponse,
  ProviderLimitsResponse,
  ProviderModelListResponse,
  ReviewChatRequest,
  ServerRequestResponseRequest,
  UpdateProviderInstructionsRequest,
} from "../../types/providers"
import type { JsonObject, JsonSerializable } from "../../types/json"

export type ProviderDefinition = {
  accountFields: ProviderFieldDefinition[]
  authModes?: ProviderDefinitionResponse["authModes"]
  capabilities: ProviderCapability[]
  composerFeatures: ProviderDefinitionResponse["composerFeatures"]
  defaultSettings: JsonObject
  icon: string
  id: string
  label: string
  runtimeFields: ProviderFieldDefinition[]
  settingsFields: ProviderFieldDefinition[]
}

export type ProviderRuntimeMessageInput = {
  attachments?: ChatAttachmentRequest[]
  collaborationMode: string
  content: string
  goalObjective?: string | null
  model?: string | null
  onMessage?: (message: ProviderChatMessageItem) => void
  onThreadReady?: (threadId: string) => Promise<void> | void
  onTurnStarted?: (turnId: string) => Promise<void> | void
  permissionMode: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  threadId?: string | null
  workingDirectory: string
}

export type ProviderRuntimeSteerInput = {
  attachments?: ChatAttachmentRequest[]
  content: string
  threadId: string
  turnId: string
  workingDirectory: string
}

export type ProviderRuntimeSteerResult = {
  raw?: JsonSerializable
  turnId: string
}

export type ProviderRuntimeMessageResult = {
  assistantContent?: string
  raw?: JsonSerializable
  threadId: string
  turnId?: string | null
}

export type ProviderChatListItem = {
  createdAt?: string | null
  externalThreadId: string
  stats?: ChatStatsResponse | null
  status?: ChatStatus | null
  title: string
  updatedAt?: string | null
  workingDirectory?: string | null
}

export type ProviderChatStateSnapshot = {
  status?: ChatStatus | null
  updatedAt?: string | null
}

export type ProviderChatMessageItem = {
  content: string
  createdAt?: string | null
  itemId?: string | null
  kind?: MessageKind
  metadata?: JsonSerializable | null
  rawPayload?: JsonSerializable | null
  requestId?: string | null
  role: MessageRole
  status?: MessageStatus
  turnId?: string | null
}

export type ProviderAccountSwitchContext = {
  fromAccount?: ProviderAccount | null
  threadId: string
  toAccount: ProviderAccount
}

export type ProviderThreadForkResult = {
  externalThreadId: string
  raw?: JsonSerializable
  title?: string | null
  workingDirectory?: string | null
}

export type ProviderThreadActionResult = {
  externalThreadId?: string | null
  raw?: JsonSerializable
  turnId?: string | null
}

export type ProviderMcpInstallation = McpServerInstallation & {
  server: McpServer
}

export type ProviderMcpSyncResult = {
  accountId: string
  error?: string | null
  status: string
}

export type ProviderMcpOauthLoginResult = {
  authorizationUrl: string
}

export type ProviderAdapter = {
  definition: ProviderDefinition
  authenticate(account: ProviderAccount, mode: AccountAuthMode): Promise<AuthenticateProviderAccountResponse>
  cancelAuthentication(account: ProviderAccount): Promise<void>
  completeAuthentication(account: ProviderAccount, redirectUrl: string): Promise<AuthenticateProviderAccountResponse>
  defaultAccountSettings(): JsonObject
  defaultRuntimeDefaults(): JsonObject
  defaultSettings(): JsonObject
  archiveThread?(account: ProviderAccount, externalThreadId: string, workingDirectory?: string | null): Promise<boolean>
  compactThread?(account: ProviderAccount, externalThreadId: string, request?: CompactChatRequest, workingDirectory?: string | null): Promise<ProviderThreadActionResult>
  deleteThread?(account: ProviderAccount, externalThreadId: string): Promise<boolean>
  forkThread?(account: ProviderAccount, externalThreadId: string, request?: ForkChatRequest, workingDirectory?: string | null): Promise<ProviderThreadForkResult>
  hydrateThreadForAccount(threadId: string, account: ProviderAccount): Promise<boolean>
  interrupt(account: ProviderAccount, threadId: string, turnId?: string | null): Promise<void>
  isAccountConnected?(account: ProviderAccount): Promise<boolean> | boolean
  listChats(account: ProviderAccount): Promise<ProviderChatListItem[]>
  loadChatMessages(account: ProviderAccount, externalThreadId: string): Promise<ProviderChatMessageItem[]>
  listModels(account: ProviderAccount): Promise<ProviderModelListResponse>
  moveThreadToAccount?(context: ProviderAccountSwitchContext): Promise<boolean>
  prepareAccount(account: ProviderAccount): Promise<void>
  readAccountAlias?(account: ProviderAccount): Promise<string | null> | string | null
  readCachedChatStates?(account: ProviderAccount, externalThreadIds: string[]): Promise<Map<string, ProviderChatStateSnapshot>>
  readChatStatus?(account: ProviderAccount, externalThreadId: string): Promise<ChatStatus | null>
  readConfig?(account: ProviderAccount, workingDirectory?: string | null): Promise<JsonSerializable>
  readLimits(account: ProviderAccount): Promise<ProviderLimitsResponse>
  readUsage?(account: ProviderAccount): Promise<JsonSerializable>
  listHooks?(account: ProviderAccount, workingDirectory?: string | null): Promise<JsonSerializable>
  listPlugins?(account: ProviderAccount): Promise<JsonSerializable>
  listSkills?(account: ProviderAccount, workingDirectory?: string | null): Promise<JsonSerializable>
  listMcpServerStatuses?(account: ProviderAccount): Promise<unknown[]>
  readHistoryWatchPaths?(account?: ProviderAccount): string[]
  readInstructions?(): Promise<ProviderInstructionsResponse>
  readThreadIdFromHistoryChange?(filename: string | Buffer | null): string | null
  renameThread?(account: ProviderAccount, externalThreadId: string, title: string, workingDirectory?: string | null): Promise<boolean>
  respondToServerRequest?(account: ProviderAccount, requestId: string, response: ServerRequestResponseRequest): Promise<void>
  reviewThread?(account: ProviderAccount, externalThreadId: string, request?: ReviewChatRequest, workingDirectory?: string | null): Promise<ProviderThreadActionResult>
  sendMessage(account: ProviderAccount, input: ProviderRuntimeMessageInput): Promise<ProviderRuntimeMessageResult>
  startMcpServerOauthLogin?(account: ProviderAccount, serverName: string, scopes?: string[]): Promise<ProviderMcpOauthLoginResult>
  steerMessage?(account: ProviderAccount, input: ProviderRuntimeSteerInput): Promise<ProviderRuntimeSteerResult>
  stopAccountRuntime(accountId: string): void
  syncMcpServers?(account: ProviderAccount, installations: ProviderMcpInstallation[]): Promise<ProviderMcpSyncResult>
  syncThreadFromAccount(threadId: string, account: ProviderAccount): Promise<boolean>
  updateInstructions?(request: UpdateProviderInstructionsRequest): Promise<ProviderInstructionsResponse>
  watchHistoryChange?(filename: string | Buffer | null): boolean
  beforeAccountSwitch?(context: ProviderAccountSwitchContext): Promise<void>
  afterAccountSwitch?(context: ProviderAccountSwitchContext): Promise<void>
}

export function serializeProviderDefinition(definition: ProviderDefinition): ProviderDefinitionResponse {
  return definition
}
