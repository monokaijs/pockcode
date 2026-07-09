import type { McpServer, McpServerInstallation } from "@prisma/client"
import type { JsonObject, JsonSerializable } from "../../types/json"
import { asJsonObject, readNumber, readString } from "../json.server"

export type McpInstallationWithServer = McpServerInstallation & {
  server: McpServer
}

export type NormalizedMcpTransport =
  | {
    args: string[]
    command: string
    cwd?: string | null
    env: Record<string, string>
    envVars: string[]
    type: "stdio"
  }
  | {
    bearerTokenEnvVar?: string | null
    envHttpHeaders: Record<string, string>
    httpHeaders: Record<string, string>
    oauthClientId?: string | null
    oauthResource?: string | null
    scopes: string[]
    type: "streamable_http"
    url: string
  }

export type NormalizedMcpToolPolicy = {
  defaultToolsApprovalMode?: "auto" | "prompt" | "approve" | null
  disabledTools?: string[] | null
  enabledTools?: string[] | null
  tools?: Record<string, { approvalMode?: "auto" | "prompt" | "approve" | null }>
}

export function codexMcpConfigForInstallation(installation: McpInstallationWithServer): JsonObject {
  const server = installation.server
  const transport = readMcpTransport(server)
  const toolPolicy = readMcpToolPolicy(server.toolPolicy)
  const entry: JsonObject = {
    enabled: server.enabled && installation.enabled,
    required: server.required,
  }
  if (transport.type === "stdio") {
    entry.command = transport.command
    if (transport.args.length) {
      entry.args = transport.args
    }
    if (Object.keys(transport.env).length) {
      entry.env = transport.env
    }
    if (transport.envVars.length) {
      entry.env_vars = transport.envVars
    }
    if (transport.cwd) {
      entry.cwd = transport.cwd
    }
  } else {
    entry.url = transport.url
    if (transport.bearerTokenEnvVar) {
      entry.bearer_token_env_var = transport.bearerTokenEnvVar
    }
    if (Object.keys(transport.httpHeaders).length) {
      entry.http_headers = transport.httpHeaders
    }
    if (Object.keys(transport.envHttpHeaders).length) {
      entry.env_http_headers = transport.envHttpHeaders
    }
    if (transport.oauthClientId) {
      entry.oauth = { client_id: transport.oauthClientId }
    }
    if (transport.oauthResource) {
      entry.oauth_resource = transport.oauthResource
    }
    if (transport.scopes.length) {
      entry.scopes = transport.scopes
    }
  }
  if (server.startupTimeoutSec !== null) {
    entry.startup_timeout_sec = server.startupTimeoutSec
  }
  if (server.toolTimeoutSec !== null) {
    entry.tool_timeout_sec = server.toolTimeoutSec
  }
  if (toolPolicy.defaultToolsApprovalMode) {
    entry.default_tools_approval_mode = toolPolicy.defaultToolsApprovalMode
  }
  if (toolPolicy.enabledTools?.length) {
    entry.enabled_tools = toolPolicy.enabledTools
  }
  if (toolPolicy.disabledTools?.length) {
    entry.disabled_tools = toolPolicy.disabledTools
  }
  if (toolPolicy.tools && Object.keys(toolPolicy.tools).length) {
    const tools: JsonObject = {}
    for (const [toolName, override] of Object.entries(toolPolicy.tools)) {
      tools[toolName] = override.approvalMode ? { approval_mode: override.approvalMode } : {}
    }
    entry.tools = tools
  }
  return entry
}

export function claudeMcpConfigForInstallations(installations: McpInstallationWithServer[]): Record<string, JsonObject> {
  const servers: Record<string, JsonObject> = {}
  for (const installation of installations) {
    if (!installation.enabled || !installation.server.enabled) {
      continue
    }
    const transport = readMcpTransport(installation.server)
    const timeout = timeoutMs(installation.server.toolTimeoutSec)
    if (transport.type === "stdio") {
      servers[installation.server.name] = {
        type: "stdio",
        command: transport.command,
        ...(transport.args.length ? { args: transport.args } : {}),
        ...(Object.keys(transport.env).length ? { env: transport.env } : {}),
        ...(timeout ? { timeout } : {}),
      }
      continue
    }
    servers[installation.server.name] = {
      type: "http",
      url: transport.url,
      ...(Object.keys(transport.httpHeaders).length ? { headers: transport.httpHeaders } : {}),
      ...(timeout ? { timeout } : {}),
    }
  }
  return servers
}

export function readMcpTransport(server: McpServer): NormalizedMcpTransport {
  const config = asJsonObject(server.config) ?? {}
  if (server.transport === "stdio") {
    return {
      args: readStringArray(config.args),
      command: readString(config.command) ?? "",
      cwd: readString(config.cwd),
      env: readStringRecord(config.env),
      envVars: readEnvVarNames(config.envVars ?? config.env_vars),
      type: "stdio",
    }
  }
  return {
    bearerTokenEnvVar: readString(config.bearerTokenEnvVar ?? config.bearer_token_env_var),
    envHttpHeaders: readStringRecord(config.envHttpHeaders ?? config.env_http_headers),
    httpHeaders: readStringRecord(config.httpHeaders ?? config.http_headers),
    oauthClientId: readString(config.oauthClientId ?? asJsonObject(config.oauth)?.client_id),
    oauthResource: readString(config.oauthResource ?? config.oauth_resource),
    scopes: readStringArray(config.scopes),
    type: "streamable_http",
    url: readString(config.url) ?? "",
  }
}

export function readMcpToolPolicy(value: unknown): NormalizedMcpToolPolicy {
  const record = asJsonObject(value) ?? {}
  return {
    defaultToolsApprovalMode: readApprovalMode(record.defaultToolsApprovalMode ?? record.default_tools_approval_mode),
    disabledTools: readStringArrayOrNull(record.disabledTools ?? record.disabled_tools),
    enabledTools: readStringArrayOrNull(record.enabledTools ?? record.enabled_tools),
    tools: readToolOverrides(record.tools),
  }
}

function readToolOverrides(value: unknown): NormalizedMcpToolPolicy["tools"] {
  const record = asJsonObject(value)
  if (!record) {
    return undefined
  }
  const tools: NonNullable<NormalizedMcpToolPolicy["tools"]> = {}
  for (const [toolName, override] of Object.entries(record)) {
    const overrideRecord = asJsonObject(override) ?? {}
    tools[toolName] = {
      approvalMode: readApprovalMode(overrideRecord.approvalMode ?? overrideRecord.approval_mode),
    }
  }
  return tools
}

function readApprovalMode(value: unknown): "auto" | "prompt" | "approve" | null {
  return value === "auto" || value === "prompt" || value === "approve" ? value : null
}

function timeoutMs(value: number | null): number | null {
  return value && Number.isFinite(value) ? Math.max(1000, Math.round(value * 1000)) : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function readStringArrayOrNull(value: unknown): string[] | null {
  return value === undefined ? null : readStringArray(value)
}

function readEnvVarNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return entry
    }
    const name = readString(asJsonObject(entry)?.name)
    return name ? [name] : []
  })
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = asJsonObject(value)
  if (!record) {
    return {}
  }
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

export function jsonFromUnknown(value: unknown): JsonSerializable {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonSerializable
}
