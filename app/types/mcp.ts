import type { JsonObject, JsonSerializable } from "./json"

export type McpTransportType = "stdio" | "streamable_http"
export type McpToolApprovalMode = "auto" | "prompt" | "approve"
export type McpAuthStatus = "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" | "unknown"

export type McpEnvVarRef = string | {
  name: string
  source?: "local" | "remote"
}

export type McpStdioConfig = {
  args: string[]
  command: string
  cwd?: string | null
  env: Record<string, string>
  envVars: McpEnvVarRef[]
  type: "stdio"
}

export type McpStreamableHttpConfig = {
  bearerTokenEnvVar?: string | null
  envHttpHeaders: Record<string, string>
  httpHeaders: Record<string, string>
  oauthClientId?: string | null
  oauthResource?: string | null
  scopes: string[]
  type: "streamable_http"
  url: string
}

export type McpServerTransportConfig = McpStdioConfig | McpStreamableHttpConfig

export type McpToolApprovalOverride = {
  approvalMode?: McpToolApprovalMode | null
}

export type McpServerToolPolicy = {
  defaultToolsApprovalMode?: McpToolApprovalMode | null
  disabledTools?: string[] | null
  enabledTools?: string[] | null
  tools?: Record<string, McpToolApprovalOverride>
}

export type McpServerInstallationResponse = {
  accountId: string
  createdAt: string
  enabled: boolean
  id: string
  lastError?: string | null
  lastStatus?: string | null
  lastSyncAt?: string | null
  providerId: string
  serverId: string
  updatedAt: string
}

export type McpServerResponse = {
  adapterSettings: JsonObject
  createdAt: string
  displayName?: string | null
  enabled: boolean
  id: string
  installations: McpServerInstallationResponse[]
  name: string
  required: boolean
  startupTimeoutSec?: number | null
  toolPolicy: McpServerToolPolicy
  toolTimeoutSec?: number | null
  transport: McpServerTransportConfig
  updatedAt: string
}

export type CreateMcpServerRequest = {
  accountIds?: string[]
  adapterSettings?: JsonObject
  displayName?: string | null
  enabled?: boolean
  name: string
  required?: boolean
  startupTimeoutSec?: number | null
  toolPolicy?: McpServerToolPolicy
  toolTimeoutSec?: number | null
  transport: McpServerTransportConfig
}

export type UpdateMcpServerRequest = Partial<Omit<CreateMcpServerRequest, "name">> & {
  accountIds?: string[]
  name?: string
}

export type SyncMcpServerRequest = {
  accountIds?: string[]
}

export type McpServerStatusItem = {
  accountId: string
  authStatus: McpAuthStatus
  error?: string | null
  lastError?: string | null
  name: string
  raw?: JsonSerializable
  resourceCount: number
  resourceTemplateCount: number
  serverId?: string | null
  serverInfo?: JsonObject | null
  toolCount: number
  tools: string[]
}

export type McpServerStatusResponse = {
  accountId: string
  data: McpServerStatusItem[]
}

export type McpServerOauthLoginRequest = {
  accountId: string
  scopes?: string[]
}

export type McpServerOauthLoginResponse = {
  authorizationUrl: string
}
