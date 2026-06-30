import type { McpServerResponse, McpServerTransportConfig, McpToolApprovalMode } from "@/lib/api-client"

export type McpServerDraft = {
  accountIds: string[]
  argsText: string
  bearerTokenEnvVar: string
  command: string
  cwd: string
  defaultToolsApprovalMode: McpToolApprovalMode | ""
  disabledToolsText: string
  displayName: string
  enabled: boolean
  enabledToolsText: string
  envHttpHeadersText: string
  envText: string
  envVarsText: string
  httpHeadersText: string
  name: string
  oauthClientId: string
  oauthResource: string
  required: boolean
  scopesText: string
  startupTimeoutSec: string
  toolOverridesText: string
  toolTimeoutSec: string
  transportType: McpServerTransportConfig["type"]
  url: string
}
export function emptyMcpDraft(): McpServerDraft {
  return {
    accountIds: [],
    argsText: "",
    bearerTokenEnvVar: "",
    command: "",
    cwd: "",
    defaultToolsApprovalMode: "",
    disabledToolsText: "",
    displayName: "",
    enabled: true,
    enabledToolsText: "",
    envHttpHeadersText: "",
    envText: "",
    envVarsText: "",
    httpHeadersText: "",
    name: "",
    oauthClientId: "",
    oauthResource: "",
    required: false,
    scopesText: "",
    startupTimeoutSec: "",
    toolOverridesText: "",
    toolTimeoutSec: "",
    transportType: "stdio",
    url: "",
  }
}

export function mcpDraftFromServer(server: McpServerResponse): McpServerDraft {
  const base = emptyMcpDraft()
  const policy = server.toolPolicy
  const transport = server.transport
  return {
    ...base,
    accountIds: server.installations.map((installation) => installation.accountId),
    defaultToolsApprovalMode: policy.defaultToolsApprovalMode ?? "",
    disabledToolsText: formatLineList(policy.disabledTools ?? []),
    displayName: server.displayName ?? "",
    enabled: server.enabled,
    enabledToolsText: formatLineList(policy.enabledTools ?? []),
    name: server.name,
    required: server.required,
    startupTimeoutSec: server.startupTimeoutSec === null || server.startupTimeoutSec === undefined ? "" : String(server.startupTimeoutSec),
    toolOverridesText: formatToolOverrides(policy.tools),
    toolTimeoutSec: server.toolTimeoutSec === null || server.toolTimeoutSec === undefined ? "" : String(server.toolTimeoutSec),
    transportType: transport.type,
    ...(transport.type === "stdio"
      ? {
          argsText: formatLineList(transport.args),
          command: transport.command,
          cwd: transport.cwd ?? "",
          envText: formatKeyValueRecord(transport.env),
          envVarsText: formatLineList(transport.envVars.map((envVar) => typeof envVar === "string" ? envVar : envVar.name)),
        }
      : {
          bearerTokenEnvVar: transport.bearerTokenEnvVar ?? "",
          envHttpHeadersText: formatKeyValueRecord(transport.envHttpHeaders),
          httpHeadersText: formatKeyValueRecord(transport.httpHeaders),
          oauthClientId: transport.oauthClientId ?? "",
          oauthResource: transport.oauthResource ?? "",
          scopesText: formatLineList(transport.scopes),
          url: transport.url,
        }),
  }
}

export function mcpRequestFromDraft(draft: McpServerDraft) {
  const startupTimeoutSec = parseOptionalNumber(draft.startupTimeoutSec, "Startup timeout")
  const toolTimeoutSec = parseOptionalNumber(draft.toolTimeoutSec, "Tool timeout")
  const transport: McpServerTransportConfig = draft.transportType === "stdio"
    ? {
        args: parseLineList(draft.argsText),
        command: draft.command.trim(),
        cwd: draft.cwd.trim() || null,
        env: parseKeyValueRecord(draft.envText, "Env"),
        envVars: parseLineList(draft.envVarsText),
        type: "stdio",
      }
    : {
        bearerTokenEnvVar: draft.bearerTokenEnvVar.trim() || null,
        envHttpHeaders: parseKeyValueRecord(draft.envHttpHeadersText, "Env headers"),
        httpHeaders: parseKeyValueRecord(draft.httpHeadersText, "Headers"),
        oauthClientId: draft.oauthClientId.trim() || null,
        oauthResource: draft.oauthResource.trim() || null,
        scopes: parseLineList(draft.scopesText),
        type: "streamable_http",
        url: draft.url.trim(),
      }
  return {
    accountIds: draft.accountIds,
    displayName: draft.displayName.trim() || null,
    enabled: draft.enabled,
    name: draft.name.trim(),
    required: draft.required,
    startupTimeoutSec,
    toolPolicy: {
      defaultToolsApprovalMode: draft.defaultToolsApprovalMode || null,
      disabledTools: parseLineList(draft.disabledToolsText),
      enabledTools: parseLineList(draft.enabledToolsText),
      tools: parseToolOverrides(draft.toolOverridesText),
    },
    toolTimeoutSec,
    transport,
  }
}

export function parseLineList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter((line, index, lines) => Boolean(line) && lines.indexOf(line) === index)
}

function formatLineList(values: string[]): string {
  return values.join("\n")
}

function parseKeyValueRecord(value: string, label: string): Record<string, string> {
  const record: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const separatorIndex = trimmed.indexOf("=")
    if (separatorIndex <= 0) {
      throw new Error(`${label} entries must use KEY=VALUE.`)
    }
    record[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim()
  }
  return record
}

function formatKeyValueRecord(record: Record<string, string>): string {
  return Object.entries(record).map(([key, value]) => `${key}=${value}`).join("\n")
}

function parseOptionalNumber(value: string, label: string): number | null {
  if (!value.trim()) {
    return null
  }
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new Error(`${label} must be a positive number.`)
  }
  return numberValue
}

function parseToolOverrides(value: string): Record<string, { approvalMode?: McpToolApprovalMode | null }> {
  const overrides: Record<string, { approvalMode?: McpToolApprovalMode | null }> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const separatorIndex = trimmed.includes("=") ? trimmed.indexOf("=") : trimmed.indexOf(":")
    if (separatorIndex <= 0) {
      throw new Error("Tool approval entries must use tool=mode.")
    }
    const tool = trimmed.slice(0, separatorIndex).trim()
    const approvalMode = trimmed.slice(separatorIndex + 1).trim()
    if (approvalMode !== "auto" && approvalMode !== "prompt" && approvalMode !== "approve") {
      throw new Error("Tool approval modes must be auto, prompt, or approve.")
    }
    overrides[tool] = { approvalMode }
  }
  return overrides
}

function formatToolOverrides(tools: McpServerResponse["toolPolicy"]["tools"]): string {
  if (!tools) {
    return ""
  }
  return Object.entries(tools)
    .filter(([, override]) => override.approvalMode)
    .map(([tool, override]) => `${tool}=${override.approvalMode}`)
    .join("\n")
}
