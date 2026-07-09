import { Prisma, type McpServer, type McpServerInstallation, type ProviderAccount } from "@prisma/client"
import type {
  CreateMcpServerRequest,
  McpAuthStatus,
  McpEnvVarRef,
  McpServerInstallationResponse,
  McpServerOauthLoginRequest,
  McpServerOauthLoginResponse,
  McpServerResponse,
  McpServerStatusItem,
  McpServerStatusResponse,
  McpServerToolPolicy,
  McpServerTransportConfig,
  McpStdioConfig,
  McpStreamableHttpConfig,
  McpToolApprovalMode,
  SyncMcpServerRequest,
  UpdateMcpServerRequest,
} from "../types/mcp"
import type { JsonObject, JsonSerializable } from "../types/json"
import { ensureDatabase } from "./database.server"
import { HttpError } from "./http.server"
import { asJsonObject, readBoolean, readNumber, readString } from "./json.server"
import { prisma } from "./prisma.server"
import { getProviderAdapter } from "./providers/registry.server"
import type { ProviderMcpSyncResult } from "./providers/types.server"

const serverNamePattern = /^[A-Za-z0-9_-]+$/
const maxStatusErrorLength = 2000

type McpServerWithInstallations = McpServer & {
  installations: McpServerInstallation[]
}

type McpInstallationWithServer = McpServerInstallation & {
  server: McpServer
}

export async function listMcpServers(): Promise<McpServerResponse[]> {
  await ensureDatabase()
  const servers = await prisma.mcpServer.findMany({
    include: { installations: true },
    orderBy: { name: "asc" },
  })
  return servers.map(serializeMcpServer)
}

export async function getMcpServer(serverId: string): Promise<McpServerResponse> {
  return serializeMcpServer(await getMcpServerRecord(serverId))
}

export async function createMcpServer(dto: CreateMcpServerRequest): Promise<McpServerResponse> {
  await ensureDatabase()
  const draft = readMcpServerDraft(dto, { requireTransport: true })
  const name = draft.name
  const transport = draft.transport
  if (!name) {
    throw new HttpError(400, "name is required.")
  }
  if (!transport) {
    throw new HttpError(400, "transport is required.")
  }
  const created = await prisma.mcpServer.create({
    data: {
      adapterSettings: draft.adapterSettings as Prisma.InputJsonObject,
      config: (draft.config ?? {}) as Prisma.InputJsonObject,
      displayName: draft.displayName ?? null,
      enabled: draft.enabled,
      name,
      required: draft.required,
      startupTimeoutSec: draft.startupTimeoutSec,
      toolPolicy: draft.toolPolicy as Prisma.InputJsonObject,
      toolTimeoutSec: draft.toolTimeoutSec,
      transport,
    },
    include: { installations: true },
  }).catch((error: unknown) => {
    if (isUniqueConstraintError(error)) {
      throw new HttpError(409, "An MCP server with this name already exists.")
    }
    throw error
  })
  await replaceMcpServerInstallations(created.id, dto.accountIds)
  return getMcpServer(created.id)
}

export async function updateMcpServer(serverId: string, dto: UpdateMcpServerRequest): Promise<McpServerResponse> {
  await ensureDatabase()
  await getMcpServerRecord(serverId)
  const draft = readMcpServerDraft(dto, { requireTransport: false })
  await prisma.mcpServer.update({
    where: { id: serverId },
    data: {
      adapterSettings: draft.adapterSettings === undefined ? undefined : draft.adapterSettings as Prisma.InputJsonObject,
      config: draft.config === undefined ? undefined : draft.config as Prisma.InputJsonObject,
      displayName: draft.displayName,
      enabled: draft.enabled,
      name: draft.name,
      required: draft.required,
      startupTimeoutSec: draft.startupTimeoutSec,
      toolPolicy: draft.toolPolicy === undefined ? undefined : draft.toolPolicy as Prisma.InputJsonObject,
      toolTimeoutSec: draft.toolTimeoutSec,
      transport: draft.transport,
    },
  }).catch((error: unknown) => {
    if (isUniqueConstraintError(error)) {
      throw new HttpError(409, "An MCP server with this name already exists.")
    }
    throw error
  })
  await replaceMcpServerInstallations(serverId, dto.accountIds)
  return getMcpServer(serverId)
}

export async function deleteMcpServer(serverId: string): Promise<McpServerResponse> {
  await ensureDatabase()
  const server = await getMcpServerRecord(serverId)
  const accountIds = server.installations.map((installation) => installation.accountId)
  const response = serializeMcpServer(server)
  await prisma.mcpServer.delete({ where: { id: serverId } })
  await Promise.allSettled([...new Set(accountIds)].map((accountId) => syncAccountMcpConfig(accountId)))
  return response
}

export async function syncMcpServer(serverId: string, dto: SyncMcpServerRequest = {}): Promise<McpServerResponse> {
  await ensureDatabase()
  const before = await getMcpServerRecord(serverId)
  const previousAccountIds = before.installations.map((installation) => installation.accountId)
  await replaceMcpServerInstallations(serverId, dto.accountIds)
  const server = await getMcpServerRecord(serverId)
  const targetAccountIds = dto.accountIds !== undefined
    ? uniqueStrings([...previousAccountIds, ...dto.accountIds])
    : uniqueStrings(server.installations.map((installation) => installation.accountId))
  const results = await Promise.all(targetAccountIds.map((accountId) => syncAccountMcpConfig(accountId)))
  const failed = results.find((result) => result.error)
  if (failed) {
    throw new HttpError(502, failed.error ?? "Unable to sync MCP server.")
  }
  return getMcpServer(serverId)
}

export async function listMcpServerStatuses(accountId: string): Promise<McpServerStatusResponse> {
  await ensureDatabase()
  const account = await getMcpAccount(accountId)
  const adapter = getProviderAdapter(account.providerId)
  const installations = await prisma.mcpServerInstallation.findMany({
    include: { server: true },
    orderBy: { server: { name: "asc" } },
    where: { accountId, providerId: account.providerId },
  })
  let rawStatuses: unknown[] = []
  try {
    rawStatuses = adapter.listMcpServerStatuses ? await adapter.listMcpServerStatuses(account) : []
  } catch (error) {
    const message = errorMessage(error)
    return {
      accountId,
      data: installations.map((installation) => statusItemFromInstallation(installation, message)),
    }
  }

  const statusByName = new Map<string, unknown>()
  for (const rawStatus of rawStatuses) {
    const name = readString(asJsonObject(rawStatus)?.name)
    if (name) {
      statusByName.set(name, rawStatus)
    }
  }

  const items = installations.map((installation) => {
    const rawStatus = statusByName.get(installation.server.name)
    return rawStatus
      ? statusItemFromRaw(accountId, installation.server.id, rawStatus, installation.lastError)
      : statusItemFromInstallation(installation, installation.lastError)
  })

  for (const rawStatus of rawStatuses) {
    const name = readString(asJsonObject(rawStatus)?.name)
    if (name && !installations.some((installation) => installation.server.name === name)) {
      items.push(statusItemFromRaw(accountId, null, rawStatus, null))
    }
  }

  return { accountId, data: items }
}

export async function startMcpServerOauthLogin(
  serverId: string,
  dto: McpServerOauthLoginRequest,
): Promise<McpServerOauthLoginResponse> {
  await ensureDatabase()
  const server = await getMcpServerRecord(serverId)
  const transport = serializeMcpTransport(server)
  if (transport.type !== "streamable_http") {
    throw new HttpError(400, "OAuth login is only available for HTTP MCP servers.")
  }
  const account = await getMcpAccount(dto.accountId)
  const adapter = getProviderAdapter(account.providerId)
  if (!adapter.definition.capabilities.includes("mcpOauth") || !adapter.startMcpServerOauthLogin) {
    throw new HttpError(400, `${adapter.definition.label} starts MCP OAuth through runtime prompts.`)
  }
  const installation = await prisma.mcpServerInstallation.findFirst({
    where: { accountId: account.id, providerId: account.providerId, serverId },
  })
  if (!installation) {
    throw new HttpError(400, "Install this MCP server to the selected account before starting OAuth login.")
  }
  const sync = await syncAccountMcpConfig(account.id)
  if (sync.error) {
    throw new HttpError(502, sync.error)
  }
  const scopes = dto.scopes?.length ? dto.scopes : transport.scopes
  return adapter.startMcpServerOauthLogin(account, server.name, scopes)
}

async function getMcpServerRecord(serverId: string): Promise<McpServerWithInstallations> {
  await ensureDatabase()
  const server = await prisma.mcpServer.findUnique({
    include: { installations: true },
    where: { id: serverId },
  })
  if (!server) {
    throw new HttpError(404, "MCP server not found.")
  }
  return server
}

async function getMcpAccount(accountId: string): Promise<ProviderAccount> {
  const account = await prisma.providerAccount.findUnique({ where: { id: accountId } })
  if (!account) {
    throw new HttpError(404, "Provider account not found.")
  }
  const adapter = getProviderAdapter(account.providerId)
  if (!adapter.definition.capabilities.includes("mcp")) {
    throw new HttpError(400, `${adapter.definition.label} does not support MCP servers.`)
  }
  return account
}

async function replaceMcpServerInstallations(serverId: string, accountIds: string[] | undefined): Promise<void> {
  if (accountIds === undefined) {
    return
  }
  const uniqueAccountIds = uniqueStrings(accountIds)
  if (!uniqueAccountIds.length) {
    await prisma.mcpServerInstallation.deleteMany({ where: { serverId } })
    return
  }
  const accounts = await prisma.providerAccount.findMany({
    where: { id: { in: uniqueAccountIds } },
  })
  const foundIds = new Set(accounts.map((account) => account.id))
  const missing = uniqueAccountIds.find((accountId) => !foundIds.has(accountId))
  if (missing) {
    throw new HttpError(400, `Provider account ${missing} was not found.`)
  }
  for (const account of accounts) {
    const adapter = getProviderAdapter(account.providerId)
    if (!adapter.definition.capabilities.includes("mcp")) {
      throw new HttpError(400, `${adapter.definition.label} account ${account.displayName} does not support MCP servers.`)
    }
  }
  await prisma.mcpServerInstallation.deleteMany({
    where: {
      accountId: { notIn: uniqueAccountIds },
      serverId,
    },
  })
  await Promise.all(accounts.map((account) =>
    prisma.mcpServerInstallation.upsert({
      create: {
        accountId: account.id,
        providerId: account.providerId,
        serverId,
      },
      update: { enabled: true },
      where: {
        serverId_providerId_accountId: {
          accountId: account.id,
          providerId: account.providerId,
          serverId,
        },
      },
    }),
  ))
}

async function syncAccountMcpConfig(accountId: string): Promise<ProviderMcpSyncResult> {
  const account = await getMcpAccount(accountId)
  const adapter = getProviderAdapter(account.providerId)
  const installations = await prisma.mcpServerInstallation.findMany({
    include: { server: true },
    orderBy: { server: { name: "asc" } },
    where: { accountId, providerId: account.providerId },
  })
  const startedAt = new Date()
  try {
    const result = adapter.syncMcpServers
      ? await adapter.syncMcpServers(account, installations)
      : { accountId, error: null, status: "SYNCED" }
    await markInstallationsSynced(accountId, account.providerId, startedAt, result.status, result.error ?? null)
    return result
  } catch (error) {
    const message = errorMessage(error)
    await markInstallationsSynced(accountId, account.providerId, startedAt, "ERROR", message)
    return { accountId, error: message, status: "ERROR" }
  }
}

async function markInstallationsSynced(accountId: string, providerId: string, syncedAt: Date, status: string, error: string | null): Promise<void> {
  await prisma.mcpServerInstallation.updateMany({
    data: {
      lastError: error ? truncateError(error) : null,
      lastStatus: status,
      lastSyncAt: syncedAt,
    },
    where: { accountId, providerId },
  })
}

function readMcpServerDraft(
  dto: Partial<CreateMcpServerRequest>,
  options: { requireTransport: boolean },
): {
  adapterSettings?: JsonObject
  config?: JsonObject
  displayName?: string | null
  enabled?: boolean
  name?: string
  required?: boolean
  startupTimeoutSec?: number | null
  toolPolicy?: McpServerToolPolicy
  toolTimeoutSec?: number | null
  transport?: string
} {
  const transport = readTransportConfig(dto.transport, options.requireTransport)
  const split = transport ? splitTransportConfig(transport) : null
  return {
    adapterSettings: dto.adapterSettings === undefined ? undefined : readJsonObject(dto.adapterSettings, "adapterSettings"),
    config: split?.config,
    displayName: dto.displayName === undefined ? undefined : readOptionalString(dto.displayName, "displayName", 160),
    enabled: dto.enabled === undefined ? undefined : readBooleanValue(dto.enabled, "enabled"),
    name: dto.name === undefined ? undefined : readMcpServerName(dto.name),
    required: dto.required === undefined ? undefined : readBooleanValue(dto.required, "required"),
    startupTimeoutSec: dto.startupTimeoutSec === undefined ? undefined : readOptionalPositiveNumber(dto.startupTimeoutSec, "startupTimeoutSec"),
    toolPolicy: dto.toolPolicy === undefined ? undefined : readToolPolicy(dto.toolPolicy),
    toolTimeoutSec: dto.toolTimeoutSec === undefined ? undefined : readOptionalPositiveNumber(dto.toolTimeoutSec, "toolTimeoutSec"),
    transport: split?.transport,
  }
}

function readTransportConfig(value: unknown, required: boolean): McpServerTransportConfig | undefined {
  if (value === undefined) {
    if (required) {
      throw new HttpError(400, "transport is required.")
    }
    return undefined
  }
  const record = readObject(value, "transport")
  const rawType = readString(record.type)
  const type = rawType === "http" ? "streamable_http" : rawType
  if (type === "stdio") {
    return {
      args: readStringArray(record.args, "transport.args"),
      command: readRequiredString(record.command, "transport.command", 500),
      cwd: readOptionalString(record.cwd, "transport.cwd", 1000),
      env: readStringRecord(record.env, "transport.env"),
      envVars: readEnvVarRefs(record.envVars ?? record.env_vars),
      type,
    }
  }
  if (type === "streamable_http") {
    return {
      bearerTokenEnvVar: readOptionalString(record.bearerTokenEnvVar ?? record.bearer_token_env_var, "transport.bearerTokenEnvVar", 200),
      envHttpHeaders: readStringRecord(record.envHttpHeaders ?? record.env_http_headers, "transport.envHttpHeaders"),
      httpHeaders: readStringRecord(record.httpHeaders ?? record.http_headers, "transport.httpHeaders"),
      oauthClientId: readOptionalString(record.oauthClientId ?? asJsonObject(record.oauth)?.client_id, "transport.oauthClientId", 500),
      oauthResource: readOptionalString(record.oauthResource ?? record.oauth_resource, "transport.oauthResource", 1000),
      scopes: readStringArray(record.scopes, "transport.scopes"),
      type,
      url: readHttpUrl(record.url, "transport.url"),
    }
  }
  throw new HttpError(400, "transport.type must be stdio or streamable_http.")
}

function splitTransportConfig(transport: McpServerTransportConfig): { config: JsonObject; transport: string } {
  const { type, ...config } = transport
  return { config: config as JsonObject, transport: type }
}

function serializeMcpServer(server: McpServerWithInstallations): McpServerResponse {
  return {
    adapterSettings: serializeJsonObject(server.adapterSettings),
    createdAt: server.createdAt.toISOString(),
    displayName: server.displayName,
    enabled: server.enabled,
    id: server.id,
    installations: server.installations.map(serializeMcpInstallation),
    name: server.name,
    required: server.required,
    startupTimeoutSec: server.startupTimeoutSec,
    toolPolicy: serializeToolPolicy(server.toolPolicy),
    toolTimeoutSec: server.toolTimeoutSec,
    transport: serializeMcpTransport(server),
    updatedAt: server.updatedAt.toISOString(),
  }
}

function serializeMcpInstallation(installation: McpServerInstallation): McpServerInstallationResponse {
  return {
    accountId: installation.accountId,
    createdAt: installation.createdAt.toISOString(),
    enabled: installation.enabled,
    id: installation.id,
    lastError: installation.lastError,
    lastStatus: installation.lastStatus,
    lastSyncAt: installation.lastSyncAt?.toISOString() ?? null,
    providerId: installation.providerId,
    serverId: installation.serverId,
    updatedAt: installation.updatedAt.toISOString(),
  }
}

function serializeMcpTransport(server: McpServer): McpServerTransportConfig {
  const config = serializeJsonObject(server.config)
  if (server.transport === "stdio") {
    return readTransportConfig({ ...config, type: "stdio" }, true) as McpStdioConfig
  }
  return readTransportConfig({ ...config, type: "streamable_http" }, true) as McpStreamableHttpConfig
}

function readToolPolicy(value: unknown): McpServerToolPolicy {
  const record = readJsonObject(value, "toolPolicy")
  const defaultToolsApprovalMode = readApprovalMode(record.defaultToolsApprovalMode ?? record.default_tools_approval_mode, "toolPolicy.defaultToolsApprovalMode")
  return {
    defaultToolsApprovalMode,
    disabledTools: record.disabledTools === undefined && record.disabled_tools === undefined
      ? undefined
      : readStringArray(record.disabledTools ?? record.disabled_tools, "toolPolicy.disabledTools"),
    enabledTools: record.enabledTools === undefined && record.enabled_tools === undefined
      ? undefined
      : readStringArray(record.enabledTools ?? record.enabled_tools, "toolPolicy.enabledTools"),
    tools: readToolOverrides(record.tools),
  }
}

function serializeToolPolicy(value: unknown): McpServerToolPolicy {
  return readToolPolicy(serializeJsonObject(value))
}

function readToolOverrides(value: unknown): McpServerToolPolicy["tools"] {
  if (value === undefined) {
    return undefined
  }
  const record = readObject(value, "toolPolicy.tools")
  const tools: NonNullable<McpServerToolPolicy["tools"]> = {}
  for (const [toolName, override] of Object.entries(record)) {
    if (!toolName.trim()) {
      throw new HttpError(400, "Tool override names cannot be empty.")
    }
    const overrideRecord = readObject(override, `toolPolicy.tools.${toolName}`)
    const approvalMode = readApprovalMode(overrideRecord.approvalMode ?? overrideRecord.approval_mode, `toolPolicy.tools.${toolName}.approvalMode`)
    tools[toolName] = { approvalMode }
  }
  return tools
}

function statusItemFromInstallation(installation: McpInstallationWithServer, error?: string | null): McpServerStatusItem {
  return {
    accountId: installation.accountId,
    authStatus: "unknown",
    error: error ?? null,
    lastError: installation.lastError,
    name: installation.server.name,
    resourceCount: 0,
    resourceTemplateCount: 0,
    serverId: installation.serverId,
    serverInfo: null,
    toolCount: 0,
    tools: [],
  }
}

function statusItemFromRaw(
  accountId: string,
  serverId: string | null,
  rawStatus: unknown,
  lastError?: string | null,
): McpServerStatusItem {
  const record = asJsonObject(rawStatus) ?? {}
  const tools = readStatusNames(record.tools)
  const resources = readStatusNames(record.resources)
  const resourceTemplates = readStatusNames(record.resourceTemplates ?? record.resource_templates)
  return {
    accountId,
    authStatus: readAuthStatus(record.authStatus ?? record.auth_status),
    error: readString(record.error ?? record.startupError ?? record.startup_error) ?? null,
    lastError: lastError ?? null,
    name: readString(record.name) ?? "unknown",
    raw: isJsonSerializable(rawStatus) ? rawStatus : undefined,
    resourceCount: resources.length,
    resourceTemplateCount: resourceTemplates.length,
    serverId,
    serverInfo: asJsonObject(record.serverInfo ?? record.server_info) ?? null,
    toolCount: tools.length,
    tools,
  }
}

function readStatusNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item : readString(asJsonObject(item)?.name)).filter((name): name is string => Boolean(name))
  }
  const record = asJsonObject(value)
  return record ? Object.keys(record) : []
}

function readAuthStatus(value: unknown): McpAuthStatus {
  if (value === "unsupported" || value === "notLoggedIn" || value === "bearerToken" || value === "oAuth") {
    return value
  }
  if (value === "not_logged_in") {
    return "notLoggedIn"
  }
  if (value === "bearer_token") {
    return "bearerToken"
  }
  if (value === "oauth" || value === "o_auth") {
    return "oAuth"
  }
  return "unknown"
}

function readMcpServerName(value: unknown): string {
  const name = readRequiredString(value, "name", 80)
  if (!serverNamePattern.test(name)) {
    throw new HttpError(400, "MCP server names can only contain letters, numbers, -, and _.")
  }
  return name
}

function readHttpUrl(value: unknown, field: string): string {
  const url = readRequiredString(value, field, 2000)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HttpError(400, `${field} must be a valid URL.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `${field} must use http or https.`)
  }
  return url
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an object.`)
  }
  return value as Record<string, unknown>
}

function readJsonObject(value: unknown, field: string): JsonObject {
  return readObject(value, field) as JsonObject
}

function readRequiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required.`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`)
  }
  return trimmed
}

function readOptionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") {
    return null
  }
  const trimmed = readRequiredString(value, field, maxLength)
  return trimmed || null
}

function readBooleanValue(value: unknown, field: string): boolean {
  const booleanValue = readBoolean(value)
  if (booleanValue === undefined) {
    throw new HttpError(400, `${field} must be a boolean.`)
  }
  return booleanValue
}

function readOptionalPositiveNumber(value: unknown, field: string): number | null {
  if (value === null || value === "") {
    return null
  }
  const numberValue = readNumber(value)
  if (numberValue === undefined || numberValue < 0) {
    throw new HttpError(400, `${field} must be a positive number.`)
  }
  return numberValue
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array.`)
  }
  return value.map((item, index) => readRequiredString(item, `${field}[${index}]`, 500)).filter((item, index, values) => values.indexOf(item) === index)
}

function readStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {}
  }
  const record = readObject(value, field)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    readRequiredString(key, `${field} key`, 200),
    readRequiredString(item, `${field}.${key}`, 2000),
  ]))
}

function readEnvVarRefs(value: unknown): McpEnvVarRef[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "transport.envVars must be an array.")
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return readRequiredString(item, `transport.envVars[${index}]`, 200)
    }
    const record = readObject(item, `transport.envVars[${index}]`)
    const name = readRequiredString(record.name, `transport.envVars[${index}].name`, 200)
    const source = record.source === "local" || record.source === "remote" ? record.source : undefined
    return source ? { name, source } : { name }
  })
}

function readApprovalMode(value: unknown, field: string): McpToolApprovalMode | null {
  if (value === undefined || value === null || value === "") {
    return null
  }
  if (value === "auto" || value === "prompt" || value === "approve") {
    return value
  }
  throw new HttpError(400, `${field} must be auto, prompt, or approve.`)
}

function serializeJsonObject(value: unknown): JsonObject {
  return asJsonObject(value) ?? {}
}

function uniqueStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value, index, next) => Boolean(value) && next.indexOf(value) === index)
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed."
}

function truncateError(error: string): string {
  return error.length > maxStatusErrorLength ? `${error.slice(0, maxStatusErrorLength - 3)}...` : error
}

function isJsonSerializable(value: unknown): value is JsonSerializable {
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}
