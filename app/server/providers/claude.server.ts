import type { ProviderAccount } from "@prisma/client"
import {
  deleteSession,
  forkSession,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  resolveSettings,
} from "@anthropic-ai/claude-agent-sdk"
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  McpServerConfig,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKControlGetUsageResponse,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  UserDialogRequest,
  UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk"
import { chmodSync, mkdirSync } from "node:fs"
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type {
  AccountAuthMode,
  AuthenticateProviderAccountResponse,
  ChatAttachmentRequest,
  CompactChatRequest,
  ProviderLimitsResponse,
  ProviderModelListResponse,
  ReviewChatRequest,
  ServerRequestResponseRequest,
} from "../../types/providers"
import type { JsonObject, JsonSerializable } from "../../types/json"
import { ensureDatabase } from "../database.server"
import { asJsonObject, normalizeJsonObject, readString } from "../json.server"
import { prisma } from "../prisma.server"
import { resolveHomePath, resolveProviderDataHome } from "../runtime-paths.server"
import { claudeMcpConfigForInstallations, jsonFromUnknown } from "./mcp-config.server"
import type {
  ProviderAdapter,
  ProviderChatListItem,
  ProviderChatMessageItem,
  ProviderDefinition,
  ProviderRuntimeMessageInput,
  ProviderRuntimeMessageResult,
  ProviderThreadActionResult,
  ProviderThreadForkResult,
} from "./types.server"

const maxProviderChats = 200
const claudeInstructionsFileName = "CLAUDE.md"
const claudeDefaultModel = "sonnet"
const claudeDefaultReasoningEffort = "medium"
const claudeSupportedEfforts = [
  { description: "Low", reasoningEffort: "low" },
  { description: "Medium", reasoningEffort: "medium" },
  { description: "High", reasoningEffort: "high" },
  { description: "Extra High", reasoningEffort: "xhigh" },
  { description: "Max", reasoningEffort: "max" },
]
const claudeAuthEnvironmentKeys = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "CLOUD_ML_REGION",
]
const claudeMissingEnvironmentAuthMessage =
  "No Claude Code auth environment variables are saved on this account. Add ANTHROPIC_API_KEY or another supported Claude Code API-provider variable under this account's settings.environment before connecting."
const claudeFallbackModels: ProviderModelListResponse["data"] = [
  {
    id: "sonnet",
    model: "sonnet",
    displayName: "Sonnet",
    defaultReasoningEffort: claudeDefaultReasoningEffort,
    supportedReasoningEfforts: claudeSupportedEfforts,
  },
  {
    id: "opus",
    model: "opus",
    displayName: "Opus",
    defaultReasoningEffort: claudeDefaultReasoningEffort,
    supportedReasoningEfforts: claudeSupportedEfforts,
  },
  {
    id: "haiku",
    model: "haiku",
    displayName: "Haiku",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: claudeSupportedEfforts,
  },
]

const definition: ProviderDefinition = {
  id: "claude",
  label: "Claude Code",
  icon: "claude-code",
  authModes: [
    { mode: "environment", label: "Environment", description: "Use this account's environment variables for isolated Claude Code auth." },
  ],
  capabilities: [
    "auth",
    "chat",
    "history",
    "limits",
    "models",
    "accountSwitchHooks",
    "localRuntime",
    "threadLifecycle",
    "fork",
    "archive",
    "review",
    "compact",
    "usage",
    "skills",
    "hooks",
    "plugins",
    "mcp",
    "config",
    "commandExec",
    "shellCommand",
    "providerSwitch",
  ],
  composerFeatures: ["accessMode", "fileAttachment", "folderAttachment", "goal", "imageAttachment", "planMode"],
  defaultSettings: defaultClaudeSettings(),
  settingsFields: [
    { key: "accountsHome", label: "Accounts home", type: "path", required: true },
    { key: "historyHome", label: "History home", type: "path", required: true },
    { key: "pathToClaudeCodeExecutable", label: "Claude executable", type: "path" },
    { key: "defaultEnvironment", label: "Environment", type: "json" },
  ],
  accountFields: [
    { key: "claudeConfigDir", label: "Claude config override", type: "path" },
    { key: "pathToClaudeCodeExecutable", label: "Claude executable override", type: "path" },
    { key: "environment", label: "Environment", type: "json" },
    { key: "settings", label: "SDK settings", type: "json" },
    { key: "allowedTools", label: "Allowed tools", type: "stringArray" },
    { key: "disallowedTools", label: "Disallowed tools", type: "stringArray" },
  ],
  runtimeFields: [
    { key: "model", label: "Model", type: "string" },
    {
      key: "reasoningEffort",
      label: "Reasoning",
      type: "string",
      options: claudeSupportedEfforts.map((entry) => ({
        description: entry.description,
        label: entry.description,
        value: entry.reasoningEffort,
      })),
    },
    {
      key: "permissionMode",
      label: "Permission mode",
      type: "string",
      options: [
        { label: "Ask", value: "askForApproval", description: "Prompt before risky actions." },
        { label: "Full access", value: "fullAccess", description: "Use Claude Code bypass permissions mode." },
      ],
    },
  ],
}

export const claudeProviderAdapter: ProviderAdapter = {
  definition,
  defaultSettings: defaultClaudeSettings,
  defaultAccountSettings: () => ({
    environment: {},
    settings: {},
  }),
  defaultRuntimeDefaults: () => ({
    model: claudeDefaultModel,
    permissionMode: "askForApproval",
    reasoningEffort: claudeDefaultReasoningEffort,
  }),
  async prepareAccount(account) {
    ensureClaudeConfigDir(resolveClaudeAccountConfigDir(account))
  },
  async authenticate(account, mode = "environment") {
    const authMode = normalizeClaudeAuthMode(mode)
    try {
      if (!hasClaudeEnvironmentAuth(account)) {
        throw new Error(readMissingClaudeEnvironmentAuthMessage())
      }
      const initialization = await readClaudeInitialization(account)
      return connectedAuthResponse(account.id, authMode, "Claude Code environment auth is connected.", {
        account: jsonFromUnknown(initialization.account),
        authMode,
        connectedProvider: "claude",
      })
    } catch (error) {
      return {
        accountId: account.id,
        status: "ERROR",
        authMode,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
        message: readClaudeAuthErrorMessage(error, account),
        authState: {
          ...normalizeJsonObject(account.authState),
          authDiagnostics: await buildClaudeAuthDiagnostics(account, error),
        },
      }
    }
  },
  async cancelAuthentication() {
    // Claude SDK environment auth has no pending browser flow to cancel.
  },
  async completeAuthentication(account) {
    return this.authenticate(account, normalizeClaudeAuthMode(account.lastAuthMode))
  },
  isAccountConnected(account) {
    return hasClaudeEnvironmentAuth(account)
  },
  async listModels(account) {
    try {
      const initialization = await readClaudeInitialization(account)
      return { data: modelOptionsFromClaude(initialization.models) }
    } catch {
      return { data: claudeFallbackModels }
    }
  },
  async readLimits(account) {
    const usage = await readClaudeUsage(account).catch((error) => ({ error: readErrorMessage(error) }))
    return normalizeClaudeLimits(usage)
  },
  listChats(account) {
    return withClaudeConfigDir(resolveClaudeAccountConfigDir(account), async () => {
      const sessions = await listSessions({ includeProgrammatic: true, limit: maxProviderChats })
      return sessions.map(serializeClaudeChat)
    })
  },
  async loadChatMessages(account, externalThreadId) {
    return withClaudeConfigDir(resolveClaudeAccountConfigDir(account), async () => {
      const messages = await getSessionMessages(externalThreadId, { includeSystemMessages: true })
      return mapClaudeSessionMessages(messages)
    })
  },
  async readUsage(account) {
    return jsonFromUnknown(await readClaudeUsage(account))
  },
  async readConfig(account, workingDirectory) {
    const configDir = resolveClaudeAccountConfigDir(account)
    return withClaudeConfigDir(configDir, async () => jsonFromUnknown(await resolveSettings({ cwd: workingDirectory ?? undefined })))
  },
  async listSkills(account, workingDirectory) {
    const runtime = await createClaudeControlRuntime(account, workingDirectory)
    try {
      return jsonFromUnknown(await runtime.query.reloadSkills())
    } finally {
      runtime.query.close()
    }
  },
  async listHooks(account, workingDirectory) {
    return this.readConfig?.(account, workingDirectory) ?? {}
  },
  async listPlugins(account) {
    const runtime = await createClaudeControlRuntime(account)
    try {
      return jsonFromUnknown(await runtime.query.reloadPlugins())
    } finally {
      runtime.query.close()
    }
  },
  async listMcpServerStatuses(account) {
    const runtime = await createClaudeControlRuntime(account)
    try {
      return jsonFromUnknown(await runtime.query.mcpServerStatus()) as unknown[]
    } finally {
      runtime.query.close()
    }
  },
  readHistoryWatchPaths: readClaudeHistoryWatchPaths,
  readInstructions: readClaudeInstructions,
  readThreadIdFromHistoryChange: readClaudeThreadIdFromHistoryChange,
  async sendMessage(account, input) {
    const result = await claudeRuntimeService.sendMessage(account, input)
    await syncClaudeThreadToCanonical(result.threadId, account).catch(() => false)
    return result
  },
  async respondToServerRequest(account, requestId, response) {
    claudeRuntimeService.respondToServerRequest(account.id, requestId, response)
  },
  async interrupt(account, threadId, turnId) {
    claudeRuntimeService.interrupt(account.id, threadId, turnId)
  },
  async forkThread(account, externalThreadId, request, workingDirectory) {
    return withClaudeConfigDir(resolveClaudeAccountConfigDir(account), async () => {
      const result = await forkSession(externalThreadId, {
        dir: workingDirectory ?? undefined,
        title: request?.lastTurnId ? undefined : "Forked conversation",
        upToMessageId: request?.lastTurnId ?? undefined,
      })
      await syncClaudeThreadToCanonical(result.sessionId, account)
      return {
        externalThreadId: result.sessionId,
        raw: jsonFromUnknown(result),
      }
    })
  },
  async archiveThread() {
    return true
  },
  async deleteThread(account, externalThreadId) {
    await withClaudeConfigDir(resolveClaudeAccountConfigDir(account), () => deleteSession(externalThreadId))
    await removeClaudeThread(resolveClaudeCanonicalConfigDir(), externalThreadId).catch(() => false)
    return true
  },
  async renameThread(account, externalThreadId, title, workingDirectory) {
    await withClaudeConfigDir(resolveClaudeAccountConfigDir(account), () =>
      renameSession(externalThreadId, title, { dir: workingDirectory ?? undefined }))
    await syncClaudeThreadToCanonical(externalThreadId, account).catch(() => false)
    return true
  },
  compactThread(account, externalThreadId, request, workingDirectory) {
    return runClaudeThreadAction(account, externalThreadId, compactPrompt(request), workingDirectory)
  },
  reviewThread(account, externalThreadId, request, workingDirectory) {
    return runClaudeReview(account, externalThreadId, request, workingDirectory)
  },
  async syncMcpServers(account) {
    return { accountId: account.id, error: null, status: "SYNCED" }
  },
  syncThreadFromAccount(threadId, account) {
    return syncClaudeThreadToCanonical(threadId, account)
  },
  hydrateThreadForAccount(threadId, account) {
    return hydrateClaudeThreadForAccount(threadId, account)
  },
  async moveThreadToAccount(context) {
    if (!context.fromAccount) {
      return hydrateClaudeThreadForAccount(context.threadId, context.toAccount)
    }
    const copied = await copyClaudeThread(
      resolveClaudeAccountConfigDir(context.fromAccount),
      resolveClaudeAccountConfigDir(context.toAccount),
      context.threadId,
      { preserveExistingTarget: true },
    ) || await hydrateClaudeThreadForAccount(context.threadId, context.toAccount)
    if (copied) {
      await syncClaudeThreadToCanonical(context.threadId, context.toAccount)
    }
    return copied
  },
  updateInstructions(request) {
    return updateClaudeInstructions(request.instructions)
  },
  watchHistoryChange: isClaudeHistoryChange,
  stopAccountRuntime(accountId) {
    claudeRuntimeService.stopAccountRuntime(accountId)
  },
}

function defaultClaudeSettings(): JsonObject {
  return {
    accountsHome: join(resolveProviderDataHome("claude"), "accounts"),
    historyHome: join(resolveProviderDataHome("claude"), "history"),
    pathToClaudeCodeExecutable: "",
    defaultEnvironment: {},
  }
}

function connectedAuthResponse(
  accountId: string,
  mode: AccountAuthMode,
  message: string,
  authState: JsonObject,
): AuthenticateProviderAccountResponse {
  return {
    accountId,
    authMode: mode,
    authState,
    authUrl: null,
    loginId: null,
    message,
    status: "CONNECTED",
    userCode: null,
    verificationUrl: null,
  }
}

function normalizeClaudeAuthMode(_mode: string | null | undefined): AccountAuthMode {
  return "environment"
}

function resolveClaudeAccountConfigDir(account: ProviderAccount): string {
  const settings = normalizeJsonObject(account.settings)
  const explicit = readString(settings.claudeConfigDir)
  if (explicit) {
    return resolveHomePath(explicit)
  }
  return join(resolveHomePath(readString(defaultClaudeSettings().accountsHome) ?? "~/.pockcode/providers/claude/accounts"), account.id)
}

function resolveClaudeCanonicalConfigDir(): string {
  return resolveHomePath(readString(defaultClaudeSettings().historyHome) ?? "~/.pockcode/providers/claude/history")
}

function ensureClaudeConfigDir(configDir: string): void {
  mkdirSync(configDir, { mode: 0o700, recursive: true })
  chmodSync(configDir, 0o700)
}

function runtimeOptionsForAccount(
  account: ProviderAccount,
  options: {
    model?: string | null
    permissionMode?: string | null
    reasoningEffort?: string | null
    resume?: string | null
    workingDirectory?: string | null
    canUseTool?: CanUseTool
    onElicitation?: Options["onElicitation"]
    onUserDialog?: Options["onUserDialog"]
    maxTurns?: number
  } = {},
): Options {
  const settings = normalizeJsonObject(account.settings)
  const providerSettings = defaultClaudeSettings()
  const defaultEnvironment = withoutClaudeAuthEnvironment(readStringRecord(providerSettings.defaultEnvironment))
  const accountEnvironment = readClaudeAccountEnvironment(account)
  const configDir = resolveClaudeAccountConfigDir(account)
  const permissionMode = claudePermissionMode(options.permissionMode)
  const pathToClaudeCodeExecutable =
    readString(settings.pathToClaudeCodeExecutable) ||
    readString(providerSettings.pathToClaudeCodeExecutable) ||
    undefined
  return {
    abortController: new AbortController(),
    allowedTools: readStringArray(settings.allowedTools),
    canUseTool: options.canUseTool,
    cwd: options.workingDirectory ?? undefined,
    disallowedTools: readStringArray(settings.disallowedTools),
    effort: claudeEffort(options.reasoningEffort),
    env: {
      ...sanitizedProcessEnvironment(),
      ...defaultEnvironment,
      ...accountEnvironment,
      CLAUDE_AGENT_SDK_CLIENT_APP: "pockcode",
      CLAUDE_CONFIG_DIR: configDir,
    },
    forwardSubagentText: true,
    includePartialMessages: false,
    maxTurns: options.maxTurns,
    mcpServers: undefined,
    model: options.model?.trim() || undefined,
    onElicitation: options.onElicitation,
    onUserDialog: options.onUserDialog,
    pathToClaudeCodeExecutable,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    persistSession: true,
    resume: options.resume ?? undefined,
    settings: asJsonObject(settings.settings) ?? undefined,
    supportedDialogKinds: options.onUserDialog ? ["refusal_fallback_prompt"] : undefined,
  }
}

async function runtimeOptionsWithMcp(
  account: ProviderAccount,
  options: Parameters<typeof runtimeOptionsForAccount>[1],
): Promise<Options> {
  const base = runtimeOptionsForAccount(account, options)
  const installations = await prisma.mcpServerInstallation.findMany({
    include: { server: true },
    orderBy: { server: { name: "asc" } },
    where: { accountId: account.id, providerId: "claude" },
  })
  return {
    ...base,
    mcpServers: claudeMcpConfigForInstallations(installations) as Record<string, McpServerConfig>,
  }
}

function claudePermissionMode(value: string | null | undefined): PermissionMode {
  if (value === "fullAccess" || value === "bypassPermissions") {
    return "bypassPermissions"
  }
  if (value === "plan") {
    return "plan"
  }
  if (value === "acceptEdits") {
    return "acceptEdits"
  }
  if (value === "dontAsk") {
    return "dontAsk"
  }
  return "default"
}

function claudeEffort(value: string | null | undefined): Options["effort"] {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value
  }
  if (value === "extraHigh" || value === "extra-high" || value === "extra_high") {
    return "xhigh"
  }
  return claudeDefaultReasoningEffort
}

export function hasClaudeEnvironmentAuth(account: ProviderAccount): boolean {
  return claudeAuthKeysPresent(readClaudeAccountEnvironment(account)).length > 0
}

function readClaudeAccountEnvironment(account: ProviderAccount): Record<string, string> {
  return readStringRecord(normalizeJsonObject(account.settings).environment)
}

function claudeAuthKeysPresent(env: Record<string, string | undefined>): string[] {
  return claudeAuthEnvironmentKeys.filter((key) => Boolean(env[key]))
}

function readMissingClaudeEnvironmentAuthMessage(): string {
  const inheritedKeys = claudeAuthKeysPresent(process.env)
  if (inheritedKeys.length) {
    return `${claudeMissingEnvironmentAuthMessage} Claude auth keys were found in PockCode's inherited server environment, but they are ignored for Claude account isolation.`
  }
  return claudeMissingEnvironmentAuthMessage
}

function sanitizedProcessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of claudeAuthEnvironmentKeys) {
    delete env[key]
  }
  return env
}

function withoutClaudeAuthEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !claudeAuthEnvironmentKeys.includes(key)))
}

async function readClaudeInitialization(account: ProviderAccount, workingDirectory?: string | null): Promise<SDKControlInitializeResponse> {
  const runtime = await createClaudeControlRuntime(account, workingDirectory)
  try {
    return runtime.initialization
  } finally {
    runtime.query.close()
  }
}

async function createClaudeControlRuntime(
  account: ProviderAccount,
  workingDirectory?: string | null,
): Promise<{ initialization: SDKControlInitializeResponse; query: Query }> {
  const options = await runtimeOptionsWithMcp(account, {
    maxTurns: 0,
    workingDirectory,
  })
  const q = query({ prompt: "", options })
  const initialization = await q.initializationResult()
  return { initialization, query: q }
}

async function readClaudeUsage(account: ProviderAccount): Promise<SDKControlGetUsageResponse> {
  const runtime = await createClaudeControlRuntime(account)
  try {
    return await runtime.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
  } finally {
    runtime.query.close()
  }
}

function modelOptionsFromClaude(models: ModelInfo[] | undefined): ProviderModelListResponse["data"] {
  const mapped = (models ?? []).map((model) => ({
    id: model.value,
    model: model.value,
    displayName: model.displayName || model.value,
    defaultReasoningEffort: model.supportsEffort ? claudeDefaultReasoningEffort : undefined,
    supportedReasoningEfforts: model.supportedEffortLevels?.map((effort) => ({
      description: effortLabel(effort),
      reasoningEffort: effort,
    })),
    upgradeInfo: model.resolvedModel ? { resolvedModel: model.resolvedModel } : null,
  }))
  return mapped.length ? mapped : claudeFallbackModels
}

function normalizeClaudeLimits(value: unknown): ProviderLimitsResponse {
  const usage = value as Partial<SDKControlGetUsageResponse>
  const rateLimits = usage.rate_limits
  if (!rateLimits) {
    return { raw: jsonFromUnknown(value) }
  }
  return {
    rateLimits: {
      planType: usage.subscription_type ?? null,
      primary: rateLimitWindow(rateLimits.five_hour, 5 * 60),
      secondary: rateLimitWindow(rateLimits.seven_day ?? rateLimits.seven_day_sonnet ?? rateLimits.seven_day_opus, 7 * 24 * 60),
    },
    raw: jsonFromUnknown(value),
  }
}

function rateLimitWindow(value: { utilization: number | null; resets_at: string | null } | null | undefined, windowDurationMins: number) {
  if (!value) {
    return null
  }
  return {
    resetsAt: value.resets_at ? Date.parse(value.resets_at) : null,
    usedPercent: typeof value.utilization === "number" ? value.utilization : 0,
    windowDurationMins,
  }
}

function serializeClaudeChat(session: SDKSessionInfo): ProviderChatListItem {
  return {
    createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
    externalThreadId: session.sessionId,
    status: "IDLE",
    title: session.customTitle || session.summary || session.firstPrompt || "Untitled chat",
    updatedAt: session.lastModified ? new Date(session.lastModified).toISOString() : null,
    workingDirectory: session.cwd ?? null,
  }
}

class ClaudeRuntimeService {
  private activeRuns = new Map<string, ActiveClaudeRun>()

  async sendMessage(account: ProviderAccount, input: ProviderRuntimeMessageInput): Promise<ProviderRuntimeMessageResult> {
    const abortController = new AbortController()
    const toolNamesById = new Map<string, string>()
    const pendingRequests = new Map<string, PendingClaudeRequest>()
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      return handleClaudePermissionRequest(toolName, toolInput, options, input, pendingRequests)
    }
    const onElicitation: Options["onElicitation"] = async (request, options) => {
      return handleClaudeElicitation(request, options, input, pendingRequests)
    }
    const onUserDialog: Options["onUserDialog"] = async (request, options) => {
      return handleClaudeUserDialog(request, options, input, pendingRequests)
    }
    const options = await runtimeOptionsWithMcp(account, {
      canUseTool,
      model: input.model ?? claudeDefaultModel,
      onElicitation,
      onUserDialog,
      permissionMode: input.collaborationMode === "plan" ? "plan" : input.permissionMode,
      reasoningEffort: input.reasoningEffort,
      resume: input.threadId,
      workingDirectory: input.workingDirectory,
    })
    options.abortController = abortController
    const prompt = promptForInput(input)
    const q = query({ prompt, options })
    let threadId = input.threadId ?? null
    let turnId: string | null = null
    const activeKey = this.activeKey(account.id, threadId ?? "pending")
    const activeRun: ActiveClaudeRun = {
      abortController,
      accountId: account.id,
      pendingRequests,
      query: q,
      threadId,
      toolNamesById,
      turnId,
    }
    this.activeRuns.set(activeKey, activeRun)
    try {
      for await (const message of q) {
        const messageThreadId = readSdkSessionId(message)
        if (messageThreadId && messageThreadId !== threadId) {
          if (!threadId) {
            threadId = messageThreadId
            activeRun.threadId = threadId
            this.activeRuns.delete(activeKey)
            this.activeRuns.set(this.activeKey(account.id, threadId), activeRun)
            await input.onThreadReady?.(threadId)
          }
        }
        const messageTurnId = readSdkUuid(message)
        if (messageTurnId && !turnId) {
          turnId = messageTurnId
          activeRun.turnId = turnId
          await input.onTurnStarted?.(turnId)
        }
        const mapped = mapClaudeSdkMessage(message, { threadId: threadId ?? messageThreadId, toolNamesById, turnId })
        for (const item of mapped) {
          input.onMessage?.(item)
        }
      }
    } finally {
      this.activeRuns.delete(this.activeKey(account.id, threadId ?? "pending"))
      for (const pending of pendingRequests.values()) {
        pending.resolve({ kind: "approval", result: { decision: "decline" } })
      }
      pendingRequests.clear()
    }
    if (!threadId) {
      throw new Error("Claude Code did not return a session id.")
    }
    return { threadId, turnId, raw: { provider: "claude" } }
  }

  respondToServerRequest(accountId: string, requestId: string, response: ServerRequestResponseRequest): void {
    for (const run of this.activeRuns.values()) {
      if (run.accountId !== accountId) {
        continue
      }
      const pending = run.pendingRequests.get(requestId)
      if (pending) {
        run.pendingRequests.delete(requestId)
        pending.resolve(response)
        return
      }
    }
    throw new Error("Claude request is no longer active.")
  }

  interrupt(accountId: string, threadId: string, turnId?: string | null): void {
    for (const run of this.activeRuns.values()) {
      if (run.accountId !== accountId) {
        continue
      }
      if (run.threadId === threadId || (turnId && run.turnId === turnId)) {
        run.abortController.abort()
        run.query.close()
      }
    }
  }

  stopAccountRuntime(accountId: string): void {
    for (const run of this.activeRuns.values()) {
      if (run.accountId === accountId) {
        run.abortController.abort()
        run.query.close()
      }
    }
  }

  private activeKey(accountId: string, threadId: string): string {
    return `${accountId}:${threadId}`
  }
}

type ActiveClaudeRun = {
  abortController: AbortController
  accountId: string
  pendingRequests: Map<string, PendingClaudeRequest>
  query: Query
  threadId: string | null
  toolNamesById: Map<string, string>
  turnId: string | null
}

type PendingClaudeRequest = {
  resolve: (response: ServerRequestResponseRequest) => void
}

const claudeRuntimeService = new ClaudeRuntimeService()

async function handleClaudePermissionRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
  input: ProviderRuntimeMessageInput,
  pendingRequests: Map<string, PendingClaudeRequest>,
): Promise<PermissionResult> {
  if (toolName === "AskUserQuestion") {
    const response = await emitAndWaitForClaudeRequest(
      pendingRequests,
      options.requestId,
      {
        content: options.title ?? "Claude has a question.",
        itemId: `claude-request:${options.requestId}`,
        kind: "USER_INPUT_PROMPT",
        metadata: { provider: "claude", serverRequestMethod: "claude/askUserQuestion", toolName },
        rawPayload: userInputPayloadFromTool(toolInput, options),
        requestId: options.requestId,
        role: "SYSTEM",
        status: "PENDING",
      },
      input,
      options.signal,
    )
    return { behavior: "allow", updatedInput: { ...toolInput, answer: firstUserInputAnswer(response) } }
  }
  const response = await emitAndWaitForClaudeRequest(
    pendingRequests,
    options.requestId,
    {
      content: options.title ?? `Claude wants to use ${toolName}.`,
      itemId: `claude-request:${options.requestId}`,
      kind: "APPROVAL",
      metadata: {
        provider: "claude",
        serverRequestMethod: "claude/canUseTool",
        toolName,
      },
      rawPayload: jsonFromUnknown({
        blockedPath: options.blockedPath,
        description: options.description,
        displayName: options.displayName,
        input: toolInput,
        suggestions: jsonFromUnknown(options.suggestions ?? []),
        title: options.title,
        toolName,
        toolUseID: options.toolUseID,
      }),
      requestId: options.requestId,
      role: "SYSTEM",
      status: "PENDING",
    },
    input,
    options.signal,
  )
  if (isApprovedServerResponse(response)) {
    const result = asJsonObject(response.result) ?? {}
    return {
      behavior: "allow",
      updatedInput: asJsonObject(result.updatedInput) ?? undefined,
      updatedPermissions: Array.isArray(result.updatedPermissions) ? result.updatedPermissions as PermissionResult extends { updatedPermissions?: infer T } ? T : never : undefined,
    }
  }
  return { behavior: "deny", message: "Denied by user." }
}

async function handleClaudeElicitation(
  request: ElicitationRequest,
  options: { signal: AbortSignal },
  input: ProviderRuntimeMessageInput,
  pendingRequests: Map<string, PendingClaudeRequest>,
): Promise<ElicitationResult> {
  const requestId = request.elicitationId ?? `elicitation:${crypto.randomUUID()}`
  const response = await emitAndWaitForClaudeRequest(
    pendingRequests,
    requestId,
    {
      content: request.title ?? request.message,
      itemId: `claude-request:${requestId}`,
      kind: "USER_INPUT_PROMPT",
      metadata: { provider: "claude", serverRequestMethod: "claude/mcpElicitation", serverName: request.serverName },
      rawPayload: jsonFromUnknown({
        mode: request.mode,
        questions: [{
          description: request.description ?? "",
          id: "response",
          options: request.url ? [{ description: request.url, label: "Opened" }] : [],
          question: request.message,
        }],
        requestedSchema: jsonFromUnknown(request.requestedSchema ?? null),
        url: request.url,
      }),
      requestId,
      role: "SYSTEM",
      status: "PENDING",
    },
    input,
    options.signal,
  )
  if (!isApprovedServerResponse(response) && response.kind !== "userInput") {
    return { action: "decline" } as ElicitationResult
  }
  return { action: "accept", content: { response: firstUserInputAnswer(response) } } as ElicitationResult
}

async function handleClaudeUserDialog(
  request: UserDialogRequest,
  options: { signal: AbortSignal },
  input: ProviderRuntimeMessageInput,
  pendingRequests: Map<string, PendingClaudeRequest>,
): Promise<UserDialogResult> {
  const requestId = `dialog:${crypto.randomUUID()}`
  const response = await emitAndWaitForClaudeRequest(
    pendingRequests,
    requestId,
    {
      content: `Claude requests ${request.dialogKind}.`,
      itemId: `claude-request:${requestId}`,
      kind: "USER_INPUT_PROMPT",
      metadata: { provider: "claude", serverRequestMethod: "claude/userDialog", dialogKind: request.dialogKind },
      rawPayload: {
        payload: jsonFromUnknown(request.payload),
        questions: [{ description: "", id: "response", options: [], question: `Respond to ${request.dialogKind}.` }],
      },
      requestId,
      role: "SYSTEM",
      status: "PENDING",
    },
    input,
    options.signal,
  )
  return isApprovedServerResponse(response)
    ? { behavior: "completed", result: firstUserInputAnswer(response) }
    : { behavior: "cancelled" }
}

function emitAndWaitForClaudeRequest(
  pendingRequests: Map<string, PendingClaudeRequest>,
  requestId: string,
  message: ProviderChatMessageItem,
  input: ProviderRuntimeMessageInput,
  signal: AbortSignal,
): Promise<ServerRequestResponseRequest> {
  input.onMessage?.(message)
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Claude request was cancelled."))
      return
    }
    const abort = () => {
      pendingRequests.delete(requestId)
      reject(new Error("Claude request was cancelled."))
    }
    signal.addEventListener("abort", abort, { once: true })
    pendingRequests.set(requestId, {
      resolve: (response) => {
        signal.removeEventListener("abort", abort)
        resolve(response)
      },
    })
  })
}

function userInputPayloadFromTool(toolInput: Record<string, unknown>, options: Parameters<CanUseTool>[2]): JsonObject {
  const question = readString(toolInput.question) ?? readString(toolInput.prompt) ?? options.title ?? "Claude has a question."
  const rawOptions = Array.isArray(toolInput.options) ? toolInput.options : []
  return {
    questions: [{
      description: readString(toolInput.description) ?? options.description ?? "",
      id: "answer",
      options: rawOptions.flatMap((entry) => {
        const label = typeof entry === "string" ? entry : readString(asJsonObject(entry)?.label)
        return label ? [{ description: readString(asJsonObject(entry)?.description) ?? "", label }] : []
      }),
      question,
    }],
  }
}

function isApprovedServerResponse(response: ServerRequestResponseRequest): boolean {
  const result = asJsonObject(response.result) ?? {}
  const decision = response.decision ?? result.decision ?? result.behavior ?? result.action
  return decision === "accept" || decision === "allow" || decision === "approved" || decision === true || response.kind === "permissions"
}

function firstUserInputAnswer(response: ServerRequestResponseRequest): string {
  const answers = asJsonObject(response.result)?.answers
  const answerRecord = asJsonObject(answers)
  if (!answerRecord) {
    return readString(asJsonObject(response.result)?.answer) ?? ""
  }
  for (const value of Object.values(answerRecord)) {
    const nested = asJsonObject(value)
    const rawAnswers = nested?.answers
    if (Array.isArray(rawAnswers) && typeof rawAnswers[0] === "string") {
      return rawAnswers[0]
    }
  }
  return ""
}

function promptForInput(input: ProviderRuntimeMessageInput): string | AsyncIterable<SDKUserMessage> {
  const content = buildPromptText(input)
  const imageBlocks = imageContentBlocks(input.attachments ?? [])
  if (!imageBlocks.length) {
    return content
  }
  return (async function* () {
    yield {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: content }, ...imageBlocks],
      },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage
  })()
}

function buildPromptText(input: ProviderRuntimeMessageInput): string {
  const parts = []
  if (input.goalObjective?.trim()) {
    parts.push(`Goal:\n${input.goalObjective.trim()}`)
  }
  parts.push(input.content)
  const attachments = (input.attachments ?? []).filter((attachment) => attachment.kind !== "image")
  if (attachments.length) {
    parts.push([
      "Attached workspace context:",
      ...attachments.map((attachment) => `- ${attachment.kind}: ${attachment.path || attachment.name}`),
    ].join("\n"))
  }
  return parts.filter((part) => part.trim()).join("\n\n")
}

function imageContentBlocks(attachments: ChatAttachmentRequest[]): JsonObject[] {
  return attachments.flatMap((attachment) => {
    if (attachment.kind !== "image" || !attachment.dataUrl) {
      return []
    }
    const match = attachment.dataUrl.match(/^data:([^;,]+);base64,(.+)$/u)
    if (!match) {
      return []
    }
    return [{
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType || match[1],
        data: match[2],
      },
    }]
  })
}

export function mapClaudeSdkMessage(
  message: SDKMessage,
  context: { threadId?: string | null; toolNamesById?: Map<string, string>; turnId?: string | null } = {},
): ProviderChatMessageItem[] {
  const raw = jsonFromUnknown(message)
  const createdAt = new Date().toISOString()
  if (message.type === "assistant") {
    const content = Array.isArray(message.message.content) ? message.message.content : []
    return content.flatMap((block, index) => mapClaudeContentBlock(block, {
      createdAt,
      parentToolUseId: message.parent_tool_use_id,
      raw,
      sessionId: message.session_id,
      toolNamesById: context.toolNamesById,
      turnId: context.turnId ?? message.uuid,
      uuid: `${message.uuid}:${index}`,
    }))
  }
  if (message.type === "user") {
    return mapClaudeUserContent(message.message?.content, {
      createdAt,
      raw,
      toolNamesById: context.toolNamesById,
      turnId: context.turnId ?? message.uuid ?? null,
      uuid: message.uuid ?? crypto.randomUUID(),
    })
  }
  if (message.type === "result") {
    if (message.is_error) {
      const resultMessage = message as Extract<SDKMessage, { type: "result"; subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries" }>
      return [{
        content: resultMessage.errors?.join("\n") || message.stop_reason || "Claude Code failed.",
        createdAt,
        itemId: message.uuid,
        kind: "ERROR",
        rawPayload: raw,
        role: "SYSTEM",
        status: "FAILED",
        turnId: context.turnId ?? message.uuid,
      }]
    }
    return []
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [{
      content: "Conversation compacted.",
      createdAt,
      itemId: message.uuid,
      kind: "COMPACTION",
      rawPayload: raw,
      role: "SYSTEM",
      status: "COMPLETED",
      turnId: context.turnId ?? message.uuid,
    }]
  }
  if (message.type === "system" && message.subtype === "permission_denied") {
    return [{
      content: message.message || `Claude was denied permission to use ${message.tool_name}.`,
      createdAt,
      itemId: message.uuid,
      kind: "WARNING",
      rawPayload: raw,
      role: "SYSTEM",
      status: "COMPLETED",
      turnId: context.turnId ?? message.uuid,
    }]
  }
  if (message.type === "system" && (message.subtype === "api_retry" || message.subtype === "status")) {
    return [{
      content: message.subtype === "api_retry"
        ? `Claude API retry ${message.attempt}/${message.max_retries}.`
        : `Claude status: ${message.status ?? "idle"}.`,
      createdAt,
      itemId: message.uuid,
      kind: "WARNING",
      rawPayload: raw,
      role: "SYSTEM",
      status: "COMPLETED",
      turnId: context.turnId ?? message.uuid,
    }]
  }
  if (message.type === "system" && (message.subtype === "task_started" || message.subtype === "task_progress" || message.subtype === "task_updated" || message.subtype === "task_notification")) {
    return [{
      content: readString((message as unknown as Record<string, unknown>).message) ?? "Claude subagent activity.",
      createdAt,
      itemId: readString((message as unknown as Record<string, unknown>).uuid) ?? crypto.randomUUID(),
      kind: "SUBAGENT_ACTIVITY",
      rawPayload: raw,
      role: "ASSISTANT",
      status: "COMPLETED",
      turnId: context.turnId ?? readSdkUuid(message),
    }]
  }
  return []
}

function mapClaudeContentBlock(
  block: unknown,
  context: {
    createdAt: string
    parentToolUseId: string | null
    raw: JsonSerializable
    sessionId: string
    toolNamesById?: Map<string, string>
    turnId: string | null
    uuid: string
  },
): ProviderChatMessageItem[] {
  const record = asJsonObject(block) ?? {}
  const type = readString(record.type)
  if (type === "text") {
    return [{
      content: readString(record.text) ?? "",
      createdAt: context.createdAt,
      itemId: context.uuid,
      kind: context.parentToolUseId ? "SUBAGENT_ACTIVITY" : "CHAT",
      rawPayload: context.raw,
      role: "ASSISTANT",
      status: "COMPLETED",
      turnId: context.turnId,
    }]
  }
  if (type === "thinking") {
    return [{
      content: readString(record.thinking) ?? readString(record.text) ?? "",
      createdAt: context.createdAt,
      itemId: context.uuid,
      kind: "THINKING",
      rawPayload: context.raw,
      role: "ASSISTANT",
      status: "COMPLETED",
      turnId: context.turnId,
    }]
  }
  if (type === "tool_use") {
    const toolName = readString(record.name) ?? "tool"
    const toolUseId = readString(record.id) ?? context.uuid
    context.toolNamesById?.set(toolUseId, toolName)
    return [{
      content: toolStartContent(toolName, asJsonObject(record.input) ?? {}),
      createdAt: context.createdAt,
      itemId: toolUseId,
      kind: kindForClaudeTool(toolName),
      metadata: { provider: "claude", toolName },
      rawPayload: context.raw,
      role: "TOOL",
      status: "STREAMING",
      turnId: context.turnId,
    }]
  }
  return []
}

function mapClaudeUserContent(
  content: unknown,
  context: {
    createdAt: string
    raw: JsonSerializable
    toolNamesById?: Map<string, string>
    turnId: string | null
    uuid: string
  },
): ProviderChatMessageItem[] {
  if (typeof content === "string") {
    return [{
      content,
      createdAt: context.createdAt,
      itemId: context.uuid,
      kind: "CHAT",
      rawPayload: context.raw,
      role: "USER",
      status: "COMPLETED",
      turnId: context.turnId,
    }]
  }
  if (!Array.isArray(content)) {
    return []
  }
  return content.flatMap((block, index) => {
    const record = asJsonObject(block) ?? {}
    if (readString(record.type) !== "tool_result") {
      return []
    }
    const toolUseId = readString(record.tool_use_id) ?? `${context.uuid}:${index}`
    const toolName = context.toolNamesById?.get(toolUseId) ?? "tool"
    return [{
      content: toolResultContent(toolName, record.content, Boolean(record.is_error)),
      createdAt: context.createdAt,
      itemId: toolUseId,
      kind: kindForClaudeTool(toolName),
      metadata: { provider: "claude", toolName },
      rawPayload: context.raw,
      role: "TOOL",
      status: Boolean(record.is_error) ? "FAILED" : "COMPLETED",
      turnId: context.turnId,
    }]
  })
}

function mapClaudeSessionMessages(messages: SessionMessage[]): ProviderChatMessageItem[] {
  const toolNamesById = new Map<string, string>()
  return messages.flatMap((message) => {
    if (message.type === "assistant") {
      return mapClaudeSdkMessage({
        type: "assistant",
        message: message.message as never,
        parent_tool_use_id: message.parent_tool_use_id,
        session_id: message.session_id,
        uuid: message.uuid as never,
      }, { toolNamesById })
    }
    if (message.type === "user") {
      return mapClaudeSdkMessage({
        type: "user",
        message: message.message as never,
        parent_tool_use_id: message.parent_tool_use_id,
        session_id: message.session_id,
        uuid: message.uuid as never,
      }, { toolNamesById })
    }
    return [{
      content: "Claude session event.",
      itemId: message.uuid,
      kind: "WARNING",
      rawPayload: jsonFromUnknown(message),
      role: "SYSTEM",
      status: "COMPLETED",
    } satisfies ProviderChatMessageItem]
  })
}

function kindForClaudeTool(toolName: string): ProviderChatMessageItem["kind"] {
  if (toolName === "Bash") {
    return "COMMAND_EXECUTION"
  }
  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write" || toolName === "NotebookEdit") {
    return "FILE_CHANGE"
  }
  if (toolName === "Task" || toolName === "Agent") {
    return "SUBAGENT_ACTIVITY"
  }
  return "TOOL_ACTIVITY"
}

function toolStartContent(toolName: string, input: JsonObject): string {
  if (toolName === "Bash") {
    return `- run \`${readString(input.command) ?? "command"}\``
  }
  if (toolName === "Read") {
    return `- read \`${readString(input.file_path) ?? readString(input.path) ?? "file"}\``
  }
  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write") {
    return `- edit \`${readString(input.file_path) ?? readString(input.path) ?? "file"}\``
  }
  return `- use ${toolName}`
}

function toolResultContent(toolName: string, content: unknown, isError: boolean): string {
  const prefix = isError ? "Error" : "Output"
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "", null, 2)
  if (toolName === "Bash") {
    return `${prefix}\n~~~text\n${text.trim()}\n~~~`
  }
  return text.trim()
}

async function runClaudeThreadAction(
  account: ProviderAccount,
  externalThreadId: string,
  prompt: string,
  workingDirectory?: string | null,
): Promise<ProviderThreadActionResult> {
  const result = await claudeRuntimeService.sendMessage(account, {
    collaborationMode: "default",
    content: prompt,
    permissionMode: "askForApproval",
    threadId: externalThreadId,
    workingDirectory: workingDirectory ?? process.cwd(),
  })
  return { externalThreadId: result.threadId, raw: result.raw, turnId: result.turnId }
}

async function runClaudeReview(
  account: ProviderAccount,
  externalThreadId: string,
  request?: ReviewChatRequest,
  workingDirectory?: string | null,
): Promise<ProviderThreadActionResult> {
  let targetThreadId = externalThreadId
  if (request?.delivery === "detached") {
    const forked = await claudeProviderAdapter.forkThread?.(account, externalThreadId, {}, workingDirectory) as ProviderThreadForkResult
    targetThreadId = forked.externalThreadId
  }
  return runClaudeThreadAction(account, targetThreadId, reviewPrompt(request), workingDirectory)
}

function compactPrompt(_request?: CompactChatRequest): string {
  return "/compact"
}

function reviewPrompt(request?: ReviewChatRequest): string {
  const target = request?.target ?? "uncommittedChanges"
  const details = [
    "Review the requested code changes. Focus on correctness, regressions, security, maintainability, and missing tests.",
    `Target: ${target}.`,
  ]
  if (request?.baseBranch) {
    details.push(`Base branch: ${request.baseBranch}.`)
  }
  if (request?.commitSha) {
    details.push(`Commit: ${request.commitSha}${request.commitTitle ? ` (${request.commitTitle})` : ""}.`)
  }
  if (request?.instructions?.trim()) {
    details.push(`Additional instructions:\n${request.instructions.trim()}`)
  }
  return details.join("\n\n")
}

export function readClaudeHistoryWatchPaths(account?: ProviderAccount): string[] {
  const paths = [resolveClaudeCanonicalConfigDir()]
  if (account) {
    paths.push(resolveClaudeAccountConfigDir(account))
  }
  return [...new Set(paths)]
}

export function isClaudeHistoryChange(filename: string | Buffer | null): boolean {
  if (!filename) {
    return true
  }
  const path = filename.toString()
  return path.endsWith(".jsonl") || path.includes("/memory/") || path.includes("\\memory\\") || basename(path) === claudeInstructionsFileName
}

export function readClaudeThreadIdFromHistoryChange(filename: string | Buffer | null): string | null {
  return filename?.toString().match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu)?.[1] ?? null
}

export async function readClaudeInstructions() {
  const homes = await readClaudeInstructionHomes()
  return {
    instructions: await readLatestExistingClaudeInstructions(homes) ?? "",
    paths: homes.map(claudeInstructionsPath),
  }
}

export async function updateClaudeInstructions(instructions: string) {
  const homes = await readClaudeInstructionHomes()
  const normalized = instructions.trimEnd()
  await Promise.all(homes.map((home) => writeClaudeInstructions(home, normalized)))
  return {
    instructions: normalized,
    paths: homes.map(claudeInstructionsPath),
  }
}

async function readClaudeInstructionHomes(): Promise<string[]> {
  await ensureDatabase()
  const accounts = await prisma.providerAccount.findMany({ where: { providerId: "claude" } })
  return uniquePaths([
    resolveClaudeCanonicalConfigDir(),
    ...accounts.map(resolveClaudeAccountConfigDir),
  ])
}

async function readLatestExistingClaudeInstructions(homes: string[]): Promise<string | null> {
  const files = await Promise.all(homes.map(async (home, index) => {
    const path = claudeInstructionsPath(home)
    const stats = await stat(path).catch(() => null)
    if (!stats?.isFile()) {
      return null
    }
    const content = await readFile(path, "utf8").catch(() => null)
    return content === null ? null : { content: content.trimEnd(), index, mtimeMs: stats.mtimeMs }
  }))
  return files
    .filter((file): file is { content: string; index: number; mtimeMs: number } => Boolean(file))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.index - right.index)[0]?.content ?? null
}

async function writeClaudeInstructions(configDir: string, instructions: string): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await writeFile(claudeInstructionsPath(configDir), instructions ? `${instructions}\n` : "", "utf8")
}

function claudeInstructionsPath(configDir: string): string {
  return join(configDir, claudeInstructionsFileName)
}

async function syncClaudeThreadToCanonical(threadId: string, account: ProviderAccount): Promise<boolean> {
  return copyClaudeThread(resolveClaudeAccountConfigDir(account), resolveClaudeCanonicalConfigDir(), threadId, { preserveExistingTarget: true })
}

async function hydrateClaudeThreadForAccount(threadId: string, account: ProviderAccount): Promise<boolean> {
  const target = resolveClaudeAccountConfigDir(account)
  ensureClaudeConfigDir(target)
  return copyClaudeThread(resolveClaudeCanonicalConfigDir(), target, threadId, { preserveExistingTarget: true })
}

async function copyClaudeThread(
  sourceConfigDir: string,
  targetConfigDir: string,
  threadId: string,
  options: { preserveExistingTarget?: boolean } = {},
): Promise<boolean> {
  if (sameFilesystemPath(sourceConfigDir, targetConfigDir)) {
    return true
  }
  const source = await findClaudeThreadFile(sourceConfigDir, threadId)
  if (!source) {
    return false
  }
  const relativePath = source.slice(resolve(sourceConfigDir).length + 1)
  const target = join(targetConfigDir, relativePath)
  const targetStats = await stat(target).catch(() => null)
  if (targetStats?.isFile() && options.preserveExistingTarget) {
    return true
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(source, target)
  const sourceDir = join(dirname(source), threadId)
  const sourceDirStats = await stat(sourceDir).catch(() => null)
  if (sourceDirStats?.isDirectory()) {
    await cp(sourceDir, join(dirname(target), threadId), { recursive: true, force: true })
  }
  return true
}

async function removeClaudeThread(configDir: string, threadId: string): Promise<boolean> {
  const source = await findClaudeThreadFile(configDir, threadId)
  if (!source) {
    return false
  }
  await rm(source, { force: true })
  await rm(join(dirname(source), threadId), { force: true, recursive: true })
  return true
}

async function findClaudeThreadFile(configDir: string, threadId: string): Promise<string | null> {
  const projectsDir = join(configDir, "projects")
  const projectsStats = await stat(projectsDir).catch(() => null)
  if (!projectsStats?.isDirectory()) {
    return null
  }
  return findFileRecursive(projectsDir, `${threadId}.jsonl`)
}

async function findFileRecursive(dir: string, filename: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === filename) {
      return path
    }
    if (entry.isDirectory()) {
      const found = await findFileRecursive(path, filename)
      if (found) {
        return found
      }
    }
  }
  return null
}

let configDirQueue: Promise<void> = Promise.resolve()

function withClaudeConfigDir<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      return await fn()
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous
      }
    }
  }
  const result = configDirQueue.then(run, run)
  configDirQueue = result.then(() => undefined, () => undefined)
  return result
}

function readSdkSessionId(message: SDKMessage): string | null {
  return readString((message as unknown as Record<string, unknown>).session_id) ?? null
}

function readSdkUuid(message: SDKMessage): string | null {
  return readString((message as unknown as Record<string, unknown>).uuid) ?? null
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = asJsonObject(value)
  if (!record) {
    return {}
  }
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function effortLabel(value: string): string {
  if (value === "xhigh") {
    return "Extra High"
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}

function sameFilesystemPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

async function buildClaudeAuthDiagnostics(account: ProviderAccount, error: unknown): Promise<JsonObject> {
  const settings = normalizeJsonObject(account.settings)
  const accountEnvironment = readClaudeAccountEnvironment(account)
  const providerSettings = defaultClaudeSettings()
  const executable =
    readString(settings.pathToClaudeCodeExecutable) ||
    readString(providerSettings.pathToClaudeCodeExecutable) ||
    "claude"
  const configDir = resolveClaudeAccountConfigDir(account)
  const authEnvironmentKeysPresent = claudeAuthKeysPresent(accountEnvironment)
  const inheritedAuthEnvironmentKeysPresent = claudeAuthKeysPresent(process.env)
  const configDirStats = await stat(configDir).catch(() => null)
  const mcpServerCount = await prisma.mcpServerInstallation.count({
    where: { accountId: account.id, providerId: "claude" },
  }).catch(() => null)

  return {
    provider: "claude",
    authMode: "environment",
    message: readClaudeAuthErrorMessage(error, account),
    errorName: readErrorName(error),
    errorCode: readErrorScalar(error, "code"),
    errorStatus: readErrorScalar(error, "status") ?? readErrorScalar(error, "statusCode"),
    stack: readClaudeAuthStack(error, account),
    claudeConfigDir: configDir,
    claudeConfigDirExists: Boolean(configDirStats?.isDirectory()),
    pathToClaudeCodeExecutable: executable,
    authEnvironmentKeysPresent,
    accountAuthEnvironmentKeysPresent: authEnvironmentKeysPresent,
    inheritedAuthEnvironmentKeysPresent,
    inheritedAuthEnvironmentKeysIgnored: inheritedAuthEnvironmentKeysPresent.length > 0,
    supportedAuthEnvironmentKeys: claudeAuthEnvironmentKeys,
    expectedSettingsShape: { environment: { ANTHROPIC_API_KEY: "<key>" } },
    environmentKeysPresent: Object.keys(accountEnvironment).sort(),
    sdkSettingsKeysPresent: Object.keys(normalizeJsonObject(settings.settings)).sort(),
    allowedToolsCount: readStringArray(settings.allowedTools)?.length ?? 0,
    disallowedToolsCount: readStringArray(settings.disallowedTools)?.length ?? 0,
    mcpServerCount,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }
}

function readClaudeAuthErrorMessage(error: unknown, account: ProviderAccount): string {
  return redactClaudeAuthText(readErrorMessage(error), account)
}

function readClaudeAuthStack(error: unknown, account: ProviderAccount): string | null {
  if (!(error instanceof Error) || !error.stack) {
    return null
  }
  return redactClaudeAuthText(error.stack.split("\n").slice(0, 8).join("\n"), account)
}

function readErrorName(error: unknown): string | null {
  return error instanceof Error && error.name ? error.name : null
}

function readErrorScalar(error: unknown, key: string): string | number | boolean | null {
  if (!error || typeof error !== "object") {
    return null
  }
  const value = (error as Record<string, unknown>)[key]
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null
}

function redactClaudeAuthText(value: string, account: ProviderAccount): string {
  const accountEnvironment = readStringRecord(normalizeJsonObject(account.settings).environment)
  let redacted = value
  for (const secret of Object.values(accountEnvironment)) {
    if (secret.length >= 6) {
      redacted = redacted.replaceAll(secret, "[redacted]")
    }
  }
  return redacted
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key\s*[:=]\s*)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\b(token\s*[:=]\s*)[^\s"',}]+/gi, "$1[redacted]")
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}
