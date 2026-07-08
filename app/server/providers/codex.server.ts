import type { ProviderAccount } from "@prisma/client"
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { copyFile, cp, mkdir, open as openFile, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import type {
  AccountAuthMode,
  AuthenticateProviderAccountResponse,
  CodexInstructionsResponse,
  MessageRole,
  ProviderLimitsResponse,
  ProviderModelListResponse,
  ServerRequestResponseRequest,
} from "../../types/providers"
import type { JsonObject, JsonSerializable } from "../../types/json"
import { ensureDatabase } from "../database.server"
import { asJsonObject, normalizeJsonObject, readNumber, readString } from "../json.server"
import { prisma } from "../prisma.server"
import { resolveHomePath, resolveProviderDataHome } from "../runtime-paths.server"
import type {
  ProviderAdapter,
  ProviderChatStateSnapshot,
  ProviderChatListItem,
  ProviderChatMessageItem,
  ProviderDefinition,
  ProviderRuntimeMessageInput,
  ProviderRuntimeMessageResult,
} from "./types.server"

const require = createRequire(import.meta.url)
const invalidatedAccountIds = new Set<string>()
const maxProviderChats = 200
const codexLiveStatusReadLimit = 8
const codexLogReadLimit = 5000
const codexSessionSummaryTailBytes = 1024 * 1024
const codexInstructionsFileName = "AGENTS.md"
const codexTurnCompletionTimeoutMs = 30 * 60 * 1000
const codexMessageReadTimeoutMs = 5_000
const codexStoredRunningFreshnessMs = 30 * 60 * 1000
type CodexPersonality = "friendly" | "pragmatic"

const codexDefaultModel = "gpt-5.5"
const codexDefaultReasoningEffort = "medium"
const codexDefaultServiceTier = "standard"
const codexSupportedReasoningEfforts = [
  { description: "None", reasoningEffort: "none" },
  { description: "Minimal", reasoningEffort: "minimal" },
  { description: "Low", reasoningEffort: "low" },
  { description: "Medium", reasoningEffort: "medium" },
  { description: "High", reasoningEffort: "high" },
  { description: "Extra High", reasoningEffort: "xhigh" },
]
const codexDefaultModelOptions: ProviderModelListResponse["data"] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    defaultReasoningEffort: codexDefaultReasoningEffort,
    supportedReasoningEfforts: codexSupportedReasoningEfforts,
  },
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    defaultReasoningEffort: codexDefaultReasoningEffort,
    supportedReasoningEfforts: codexSupportedReasoningEfforts,
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    defaultReasoningEffort: codexDefaultReasoningEffort,
    supportedReasoningEfforts: codexSupportedReasoningEfforts,
  },
  {
    id: "gpt-5.3-codex-spark",
    model: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3-Codex-Spark",
    defaultReasoningEffort: codexDefaultReasoningEffort,
    supportedReasoningEfforts: codexSupportedReasoningEfforts,
  },
]

const definition: ProviderDefinition = {
  id: "codex",
  label: "OpenAI Codex",
  icon: "codex",
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
  defaultSettings: defaultCodexSettings(),
  settingsFields: [
    { key: "accountsHome", label: "Accounts home", type: "path", required: true },
    { key: "historyHome", label: "History home", type: "path", required: true },
    { key: "sharedChatHome", label: "Shared Codex home", type: "path", required: true },
    { key: "defaultCommand", label: "Command", type: "string", required: true },
    { key: "defaultArgs", label: "Arguments", type: "stringArray", required: true },
    { key: "defaultEnvironment", label: "Environment", type: "json" },
  ],
  accountFields: [
    { key: "codexHome", label: "Codex home override", type: "path" },
    { key: "personality", label: "Personality", type: "string" },
    { key: "command", label: "Command override", type: "string" },
    { key: "args", label: "Arguments override", type: "stringArray" },
    { key: "environment", label: "Environment", type: "json" },
  ],
  runtimeFields: [
    { key: "model", label: "Model", type: "string" },
    { key: "reasoningEffort", label: "Reasoning", type: "string" },
    { key: "serviceTier", label: "Service tier", type: "string" },
    { key: "permissionMode", label: "Permission mode", type: "string" },
  ],
}

export const codexProviderAdapter: ProviderAdapter = {
  definition,
  defaultSettings: defaultCodexSettings,
  defaultAccountSettings: () => ({
    personality: "pragmatic",
  }),
  defaultRuntimeDefaults: () => ({
    model: codexDefaultModel,
    permissionMode: "askForApproval",
    reasoningEffort: codexDefaultReasoningEffort,
    serviceTier: codexDefaultServiceTier,
  }),
  async prepareAccount(account) {
    const codexHome = resolveAccountCodexHome(account)
    ensureCodexHome(codexHome)
    await syncCodexInstructionsToHome(codexHome)
  },
  async authenticate(account, mode = "browser") {
    try {
      if (mode === "local") {
        await connectLocalCodexAccount()
        runtimeService.stopRuntime(account.id)
        return connectedAuthResponse(account.id, "Local Codex account is connected.", localCodexAuthState())
      }

      const runtime = runtimeForAccount(account)
      if (hasAccountAuthFile(account)) {
        runtimeService.stopRuntime(account.id)
        return connectedAuthResponse(account.id, "Codex account is connected.")
      }

      const response = await runtime.request(
        "account/login/start",
        mode === "device"
          ? { type: "chatgptDeviceCode" }
          : { type: "chatgpt", codexStreamlinedLogin: true },
        30_000,
      )
      const result = asJsonObject(response.result)
      const responseMode = readString(result?.type) === "chatgptDeviceCode" ? "device" : mode
      const authUrl = readLoginAuthUrl(result, responseMode)
      const loginId = readString(result?.loginId) ?? null
      const userCode = responseMode === "device" ? readString(result?.userCode) ?? readString(result?.user_code) ?? null : null
      return {
        accountId: account.id,
        status: authUrl ? "AUTHENTICATING" : "CONNECTED",
        authMode: authUrl ? responseMode : null,
        authUrl,
        verificationUrl: responseMode === "device" ? authUrl : null,
        userCode,
        loginId,
        message: authUrl
          ? responseMode === "device"
            ? "Open the verification URL and enter the device code to finish Codex authentication."
            : "Complete Codex authentication in the opened browser."
          : "Codex account is connected.",
      }
    } catch (error) {
      return {
        accountId: account.id,
        status: "ERROR",
        authMode: mode,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
        message: readErrorMessage(error),
      }
    }
  },
  async cancelAuthentication(account) {
    runtimeService.stopRuntime(account.id)
  },
  async completeAuthentication(account, redirectUrl) {
    const callbackUrl = parseLoopbackCallbackUrl(redirectUrl)
    const response = await fetch(callbackUrl)
    if (response.status >= 400) {
      throw new Error(`Codex login callback returned HTTP ${response.status}.`)
    }
    if (hasAccountAuthFile(account)) {
      runtimeService.stopRuntime(account.id)
      return connectedAuthResponse(account.id, "Codex account is connected.")
    }
    return {
      accountId: account.id,
      status: "AUTHENTICATING",
      authMode: readAuthMode(account.lastAuthMode),
      authUrl: account.lastAuthUrl,
      verificationUrl: account.lastAuthMode === "device" ? account.lastAuthUrl : null,
      userCode: account.lastAuthUserCode,
      message: "Callback accepted. Codex is still finishing authentication.",
    }
  },
  async listModels(account) {
    try {
      const response = await runtimeForAccount(account).request("model/list", { includeHidden: false, limit: 100 }, 30_000)
      return normalizeModelList(response.result)
    } catch (error) {
      await maybeMarkInvalidated(account.id, error)
      throw error
    }
  },
  async readLimits(account) {
    try {
      const response = await runtimeForAccount(account).request("account/rateLimits/read", undefined, 30_000)
      return normalizeLimits(response.result)
    } catch (error) {
      await maybeMarkInvalidated(account.id, error)
      throw error
    }
  },
  listChats(account) {
    return listCodexChats(account)
  },
  loadChatMessages(account, externalThreadId) {
    return loadCodexChatMessages(account, externalThreadId)
  },
  readChatStatus(account, externalThreadId) {
    return readCodexChatStatus(account, externalThreadId)
  },
  readCachedChatStates(account, externalThreadIds) {
    return readCodexStoredChatStates(account, externalThreadIds)
  },
  async forkThread(account, externalThreadId, request, workingDirectory) {
    const runtime = await prepareCodexThreadForLifecycleAction(account, externalThreadId, workingDirectory)
    const response = await requestCodexRuntime(runtime, "thread/fork", {
      threadId: externalThreadId,
      lastTurnId: request?.lastTurnId ?? null,
      excludeTurns: true,
      threadSource: "appServer",
    }, 60_000)
    const result = asJsonObject(response.result)
    const thread = asJsonObject(result?.thread)
    const nextThreadId = readString(thread?.id) ?? readString(result?.threadId) ?? readString(result?.thread_id)
    if (!nextThreadId) {
      throw new Error("Codex did not return a forked thread id.")
    }
    await syncAccountThreadToCanonical(nextThreadId, account)
    return {
      externalThreadId: nextThreadId,
      title: readString(thread?.name) ?? readString(thread?.preview) ?? null,
      workingDirectory: readString(result?.cwd) ?? readString(thread?.cwd) ?? null,
      raw: jsonFromUnknown(response),
    }
  },
  async archiveThread(account, externalThreadId, workingDirectory) {
    const runtime = await prepareCodexThreadForLifecycleAction(account, externalThreadId, workingDirectory)
    return requestCodexOptional(runtime, "thread/archive", { threadId: externalThreadId }, 30_000)
  },
  async deleteThread(account, externalThreadId) {
    return requestCodexOptional(runtimeForAccount(account), "thread/delete", { threadId: externalThreadId }, 30_000)
  },
  async renameThread(account, externalThreadId, title, workingDirectory) {
    const runtime = await prepareCodexThreadForLifecycleAction(account, externalThreadId, workingDirectory)
    return requestCodexOptional(runtime, "thread/name/set", { threadId: externalThreadId, name: title }, 30_000)
  },
  async compactThread(account, externalThreadId, _request, workingDirectory) {
    const runtime = await prepareCodexThreadForLifecycleAction(account, externalThreadId, workingDirectory)
    const response = await requestCodexRuntime(runtime, "thread/compact/start", { threadId: externalThreadId }, 30_000)
    return {
      externalThreadId,
      raw: jsonFromUnknown(response),
    }
  },
  async reviewThread(account, externalThreadId, request, workingDirectory) {
    const runtime = await prepareCodexThreadForLifecycleAction(account, externalThreadId, workingDirectory)
    const response = await requestCodexRuntime(runtime, "review/start", {
      threadId: externalThreadId,
      delivery: request?.delivery ?? "inline",
      target: codexReviewTargetPayload(request),
    }, 30_000)
    const result = asJsonObject(response.result)
    const turn = asJsonObject(result?.turn)
    return {
      externalThreadId: readString(result?.reviewThreadId) ?? readString(result?.review_thread_id) ?? externalThreadId,
      turnId: readString(turn?.id) ?? readString(result?.turnId) ?? readString(result?.turn_id) ?? null,
      raw: jsonFromUnknown(response),
    }
  },
  async readUsage(account) {
    const response = await requestCodexRuntime(runtimeForAccount(account), "account/usage/read", undefined, 30_000)
    return jsonFromUnknown(response.result)
  },
  async readConfig(account, workingDirectory) {
    const response = await requestCodexRuntime(runtimeForAccount(account, workingDirectory), "config/read", {
      cwd: workingDirectory ?? null,
      includeLayers: true,
    }, 30_000)
    return jsonFromUnknown(response.result)
  },
  async listSkills(account, workingDirectory) {
    const response = await requestCodexRuntime(runtimeForAccount(account, workingDirectory), "skills/list", {
      cwds: workingDirectory ? [workingDirectory] : [],
      forceReload: false,
    }, 30_000)
    return jsonFromUnknown(response.result)
  },
  async listHooks(account, workingDirectory) {
    const response = await requestCodexRuntime(runtimeForAccount(account, workingDirectory), "hooks/list", {
      cwds: workingDirectory ? [workingDirectory] : [],
    }, 30_000)
    return jsonFromUnknown(response.result)
  },
  async listPlugins(account) {
    const response = await requestCodexRuntime(runtimeForAccount(account), "plugin/list", {}, 30_000)
    return jsonFromUnknown(response.result)
  },
  async sendMessage(account, input) {
    if (input.threadId) {
      await hydrateKnownCodexThreadToAccount(input.threadId, account)
    }
    const runtime = runtimeForAccount(account, input.workingDirectory)
    const threadId = await ensureCodexThread(runtime, input.threadId ?? null, input.workingDirectory, input.collaborationMode)
    await input.onThreadReady?.(threadId)
    const settings = await resolveCollaborationSettings(
      runtime,
      input.model ?? null,
      input.reasoningEffort ?? null,
      input.serviceTier ?? null,
    )
    if (input.goalObjective?.trim()) {
      await setCodexThreadGoal(runtime, threadId, input.goalObjective)
    }
    const accessMode = codexAccessMode(input.permissionMode)
    let turnId: string | null = null
    const livePlanContentByItemId = new Map<string, string>()
    const completionAbort = new AbortController()
    const unsubscribeLiveMessages = input.onMessage
      ? runtime.onEvent((message) => {
        const resolvedRequestMessage = readCodexServerRequestResolvedMessage(message, threadId)
        if (resolvedRequestMessage) {
          try {
            input.onMessage?.(resolvedRequestMessage)
          } catch {
            // Live notifications are best-effort; final history sync remains authoritative.
          }
          return
        }
        const serverRequestMessage = readCodexServerRequestMessage(message, threadId, turnId)
        if (serverRequestMessage) {
          try {
            input.onMessage?.(serverRequestMessage)
          } catch {
            // Live notifications are best-effort; final history sync remains authoritative.
          }
          return
        }
        const planUpdateMessage = readCodexPlanUpdateMessage(message, threadId, turnId)
        if (planUpdateMessage) {
          try {
            input.onMessage?.(planUpdateMessage)
          } catch {
            // Live notifications are best-effort; final history sync remains authoritative.
          }
          return
        }
        const liveMessage = readCodexLiveThreadItemMessage(message, threadId, turnId)
        if (liveMessage) {
          try {
            input.onMessage?.(accumulateLivePlanMessage(liveMessage, livePlanContentByItemId))
          } catch {
            // Live notifications are best-effort; final history sync remains authoritative.
          }
        }
      })
      : () => undefined
    const completion = runtime.waitForEvent(
      (message) => isCodexTurnCompletedEvent(message, threadId, turnId),
      codexTurnCompletionTimeoutMs,
      completionAbort.signal,
    )
    let response: CodexJsonRpcResponse | null = null
    try {
      response = await runtime.request(
        "turn/start",
        {
          threadId,
          cwd: input.workingDirectory,
          input: codexInputItems(input.content, input.attachments ?? []),
          approvalPolicy: accessMode.approvalPolicy,
          collaborationMode: collaborationModePayload(input.collaborationMode, settings),
          sandboxPolicy: accessMode.sandboxPolicy,
        },
        30_000,
      )
      const result = asJsonObject(response.result)
      const turn = asJsonObject(result?.turn)
      turnId = readString(turn?.id) ?? readString(result?.turnId) ?? readString(result?.turn_id) ?? null
      if (turnId) {
        await input.onTurnStarted?.(turnId)
      }
      await completion
    } catch (error) {
      completionAbort.abort()
      await completion.catch(() => undefined)
      throw error
    } finally {
      unsubscribeLiveMessages()
    }
    if (!response) {
      throw new Error("Codex did not return a turn response.")
    }
    return {
      threadId,
      turnId,
      raw: jsonFromUnknown(response),
    }
  },
  respondToServerRequest(account, requestId, response) {
    return runtimeForAccount(account).respondToServerRequest(requestId, response.result ?? serverRequestResultFromResponse(response))
  },
  async interrupt(account, threadId, turnId) {
    const runtime = runtimeForAccount(account)
    const activeTurnId = turnId ?? await readCodexActiveTurnId(runtime, threadId).catch(() => null)
    try {
      await runtime.request("turn/interrupt", {
        threadId,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      }, 30_000)
    } catch (error) {
      runtimeService.stopRuntime(account.id)
      if (activeTurnId) {
        throw error
      }
    }
  },
  async steerMessage(account, input) {
    const response = await runtimeForAccount(account, input.workingDirectory).request(
      "turn/steer",
      {
        threadId: input.threadId,
        input: codexInputItems(input.content, input.attachments ?? []),
        expectedTurnId: input.turnId,
      },
      30_000,
    )
    const result = asJsonObject(response.result)
    return {
      turnId: readString(result?.turnId) ?? readString(result?.turn_id) ?? input.turnId,
      raw: jsonFromUnknown(response),
    }
  },
  isAccountConnected(account) {
    return hasAccountAuthFile(account)
  },
  readAccountAlias(account) {
    return readAuthEmailAlias(account)
  },
  async syncThreadFromAccount(threadId, account) {
    return syncAccountThreadToCanonical(threadId, account)
  },
  async hydrateThreadForAccount(threadId, account) {
    return hydrateCanonicalThreadToAccount(threadId, account)
  },
  async moveThreadToAccount(context) {
    if (!context.fromAccount) {
      return hydrateCanonicalThreadToAccount(context.threadId, context.toAccount)
    }
    return moveAccountThreadToAccount(context.threadId, context.fromAccount, context.toAccount)
  },
  async afterAccountSwitch(context) {
    if (
      context.fromAccount &&
      context.fromAccount.id !== context.toAccount.id &&
      !sameFilesystemPath(resolveAccountCodexHome(context.fromAccount), resolveAccountCodexHome(context.toAccount))
    ) {
      await removeAccountThread(context.threadId, context.fromAccount)
    }
  },
  stopAccountRuntime(accountId) {
    runtimeService.stopRuntime(accountId)
  },
}

export function isCodexAccountInvalidated(accountId: string): boolean {
  return invalidatedAccountIds.has(accountId)
}

export function clearCodexInvalidated(accountId: string): void {
  invalidatedAccountIds.delete(accountId)
}

function defaultCodexSettings(): JsonObject {
  const codexBin = resolveCodexBin()
  return {
    accountsHome: join(resolveProviderDataHome("codex"), "accounts"),
    historyHome: join(resolveProviderDataHome("codex"), "history"),
    sharedChatHome: resolveHomePath("~/.codex"),
    defaultCommand: process.execPath,
    defaultArgs: [codexBin, "app-server", "--enable", "goals", "--enable", "collaboration_modes"],
    defaultEnvironment: {},
  }
}

function runtimeForAccount(account: ProviderAccount, workingDirectory?: string | null): CodexRuntime {
  return runtimeService.getRuntime(runtimeConfigForAccount(account, workingDirectory))
}

function runtimeConfigForAccount(account: ProviderAccount, workingDirectory?: string | null): CodexRuntimeConfig {
  const providerSettings = mergedProviderSettings()
  const settings = normalizeJsonObject(account.settings)
  const runtimeDefaults = normalizeJsonObject(account.runtimeDefaults)
  const defaultEnvironment = readStringRecord(providerSettings.defaultEnvironment)
  const accountEnvironment = readStringRecord(settings.environment)
  const args = readStringArray(settings.args) ?? readStringArray(providerSettings.defaultArgs) ?? [resolveCodexBin(), "app-server"]
  return {
    accountId: account.id,
    args: codexArgsWithPersonality(args, readCodexPersonality(settings.personality)),
    codexHome: resolveAccountCodexHome(account),
    command: readString(settings.command) ?? readString(providerSettings.defaultCommand) ?? process.execPath,
    environment: { ...defaultEnvironment, ...accountEnvironment },
    workingDirectory: workingDirectory ?? readString(runtimeDefaults.workingDirectory) ?? null,
  }
}

function mergedProviderSettings(): JsonObject {
  return defaultCodexSettings()
}

function resolveAccountCodexHome(account: ProviderAccount): string {
  if (usesSharedCodexHome(account)) {
    return resolveSharedCodexHome()
  }
  const settings = normalizeJsonObject(account.settings)
  const explicitHome = readString(settings.codexHome)
  if (explicitHome && !sameFilesystemPath(resolveHomePath(explicitHome), resolveSharedCodexHome())) {
    return resolveHomePath(explicitHome)
  }
  const providerSettings = mergedProviderSettings()
  const accountsHome = resolveHomePath(readString(providerSettings.accountsHome) ?? "~/.pockcode/providers/codex/accounts")
  return join(accountsHome, account.id)
}

export function resolveCodexAccountHome(account: ProviderAccount): string {
  return resolveAccountCodexHome(account)
}

export async function reloadCodexMcpServerConfig(account: ProviderAccount): Promise<void> {
  await runtimeForAccount(account).request("config/mcpServer/reload", undefined, 30_000)
}

export async function listCodexMcpServerStatuses(account: ProviderAccount): Promise<unknown[]> {
  const response = await runtimeForAccount(account).request("mcpServerStatus/list", {
    detail: "toolsAndAuthOnly",
    limit: 200,
  }, 60_000)
  return readCodexMcpServerStatusList(response.result)
}

export async function startCodexMcpOauthLogin(
  account: ProviderAccount,
  serverName: string,
  scopes?: string[],
): Promise<{ authorizationUrl: string }> {
  const params: JsonObject = { name: serverName }
  if (scopes?.length) {
    params.scopes = scopes
  }
  const response = await runtimeForAccount(account).request("mcpServer/oauth/login", params, 120_000)
  const result = asJsonObject(response.result) ?? {}
  const authorizationUrl =
    readString(result.authorizationUrl) ??
    readString(result.authorization_url) ??
    readString(result.authUrl) ??
    readString(result.auth_url)
  if (!authorizationUrl) {
    throw new Error("Codex did not return an MCP authorization URL.")
  }
  return { authorizationUrl }
}

function readCodexMcpServerStatusList(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result
  }
  const record = asJsonObject(result)
  const statuses = record?.mcpServers ?? record?.servers ?? record?.data
  if (Array.isArray(statuses)) {
    return statuses
  }
  if (statuses && typeof statuses === "object" && !Array.isArray(statuses)) {
    return Object.values(statuses as Record<string, unknown>)
  }
  return []
}

export function readCodexHistoryWatchPaths(account?: ProviderAccount): string[] {
  const paths = [resolveSharedCodexHome(), resolveCanonicalHistoryHome()]
  if (account) {
    paths.push(resolveAccountCodexHome(account))
  }
  return [...new Set(paths)]
}

function resolveCanonicalHistoryHome(): string {
  const providerSettings = mergedProviderSettings()
  return resolveHomePath(readString(providerSettings.historyHome) ?? "~/.pockcode/providers/codex/history")
}

function resolveSharedCodexHome(): string {
  const providerSettings = mergedProviderSettings()
  return resolveHomePath(readString(providerSettings.sharedChatHome) ?? "~/.codex")
}

function ensureCodexHome(codexHome: string): void {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  chmodSync(codexHome, 0o700)
}

export async function readCodexInstructions(): Promise<CodexInstructionsResponse> {
  const homes = await readCodexInstructionHomes()
  return {
    instructions: await readLatestExistingCodexInstructions(homes) ?? "",
    paths: homes.map(codexInstructionsPath),
  }
}

export async function updateCodexInstructions(instructions: string): Promise<CodexInstructionsResponse> {
  const homes = await readCodexInstructionHomes()
  const normalized = instructions.trimEnd()
  await Promise.all(homes.map((home) => writeCodexInstructions(home, normalized)))
  return {
    instructions: normalized,
    paths: homes.map(codexInstructionsPath),
  }
}

async function syncCodexInstructionsToHome(codexHome: string): Promise<void> {
  const instructions = await readLatestExistingCodexInstructions([resolveSharedCodexHome(), resolveCanonicalHistoryHome()])
  if (instructions === null) {
    return
  }
  await writeCodexInstructions(codexHome, instructions)
}

async function readCodexInstructionHomes(): Promise<string[]> {
  await ensureDatabase()
  const accounts = await prisma.providerAccount.findMany({ where: { providerId: "codex" } })
  return uniquePaths([
    resolveSharedCodexHome(),
    resolveCanonicalHistoryHome(),
    ...accounts.map(resolveAccountCodexHome),
  ])
}

async function readLatestExistingCodexInstructions(homes: string[]): Promise<string | null> {
  const files = await Promise.all(
    homes.map(async (home, index) => {
      const path = codexInstructionsPath(home)
      const stats = await stat(path).catch(() => null)
      if (!stats?.isFile()) {
        return null
      }
      const content = await readFile(path, "utf8").catch(() => null)
      if (content === null) {
        return null
      }
      return { content: content.trimEnd(), index, mtimeMs: stats.mtimeMs }
    }),
  )
  const latest = files
    .filter((file): file is { content: string; index: number; mtimeMs: number } => Boolean(file))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.index - right.index)[0]
  return latest?.content ?? null
}

async function writeCodexInstructions(codexHome: string, instructions: string): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await writeFile(codexInstructionsPath(codexHome), instructions ? `${instructions}\n` : "", "utf8")
}

function codexInstructionsPath(codexHome: string): string {
  return join(codexHome, codexInstructionsFileName)
}

function codexArgsWithPersonality(args: string[], personality: CodexPersonality): string[] {
  if (args.some((arg) => arg.includes("personality"))) {
    return args
  }
  return [...args, "-c", `personality="${personality}"`]
}

function readCodexPersonality(value: unknown): CodexPersonality {
  return value === "friendly" ? "friendly" : "pragmatic"
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}

async function connectLocalCodexAccount(): Promise<void> {
  const source = resolveSharedCodexHome()
  const authPath = join(source, "auth.json")
  const authStats = await stat(authPath).catch(() => null)
  if (!authStats?.isFile()) {
    throw new Error(`No local Codex auth found at ${authPath}.`)
  }
}

async function syncAccountHistoryToCanonical(account: ProviderAccount): Promise<boolean> {
  const source = resolveAccountCodexHome(account)
  const target = resolveCanonicalHistoryHome()
  return copyCodexHistory(source, target)
}

async function hydrateCanonicalHistoryToAccount(account: ProviderAccount): Promise<boolean> {
  if (usesSharedCodexHome(account)) {
    return true
  }
  const source = resolveCanonicalHistoryHome()
  const target = resolveAccountCodexHome(account)
  ensureCodexHome(target)
  return copyCodexHistory(source, target)
}

async function syncAccountThreadToCanonical(threadId: string, account: ProviderAccount): Promise<boolean> {
  return copyCodexThread(resolveAccountCodexHome(account), resolveCanonicalHistoryHome(), threadId)
}

async function hydrateCanonicalThreadToAccount(threadId: string, account: ProviderAccount): Promise<boolean> {
  if (usesSharedCodexHome(account)) {
    return true
  }
  const target = resolveAccountCodexHome(account)
  ensureCodexHome(target)
  return copyCodexThread(resolveCanonicalHistoryHome(), target, threadId, { preserveExistingTarget: true })
}

async function hydrateKnownCodexThreadToAccount(threadId: string, account: ProviderAccount): Promise<boolean> {
  if (await hydrateCanonicalThreadToAccount(threadId, account)) {
    return true
  }
  if (usesSharedCodexHome(account)) {
    return true
  }
  const target = resolveAccountCodexHome(account)
  ensureCodexHome(target)
  const copied = await copyCodexThread(resolveSharedCodexHome(), target, threadId, { preserveExistingTarget: true })
  if (copied) {
    await copyCodexThread(resolveSharedCodexHome(), resolveCanonicalHistoryHome(), threadId, { preserveExistingTarget: true })
  }
  return copied
}

async function removeAccountThread(threadId: string, account: ProviderAccount): Promise<boolean> {
  if (usesSharedCodexHome(account)) {
    return true
  }
  return removeCodexThread(resolveAccountCodexHome(account), threadId)
}

async function moveAccountThreadToAccount(
  threadId: string,
  fromAccount: ProviderAccount,
  toAccount: ProviderAccount,
): Promise<boolean> {
  const source = resolveAccountCodexHome(fromAccount)
  const target = resolveAccountCodexHome(toAccount)
  if (sameFilesystemPath(source, target)) {
    return true
  }
  const copied =
    await copyCodexThread(source, target, threadId, { preserveExistingTarget: true }) ||
    await hydrateCanonicalThreadToAccount(threadId, toAccount)
  if (copied) {
    await syncAccountThreadToCanonical(threadId, toAccount)
    await removeAccountThread(threadId, fromAccount)
  }
  return copied
}

async function listCodexChats(account: ProviderAccount): Promise<ProviderChatListItem[]> {
  const appServerChats = await listCodexChatsFromAppServer(account).catch(() => null)
  if (appServerChats) {
    await refreshCodexStoredSummaries(account, appServerChats)
    return appServerChats
  }

  const codexHome = resolveAccountCodexHome(account)
  const indexPath = join(codexHome, "session_index.jsonl")
  const text = await readFile(indexPath, "utf8").catch(() => "")
  if (!text.trim()) {
    return []
  }

  const sessionFiles = await listCodexSessionFiles(codexHome)
  const sessionFileById = new Map(sessionFiles.map((file) => [codexSessionIdFromPath(file), file]))
  const rows = text
    .split(/\r?\n/u)
    .map(parseJsonLine)
    .map((row) => asJsonObject(row))
    .filter((row): row is JsonObject => Boolean(row))
    .slice(-maxProviderChats)
    .reverse()

  const chats: ProviderChatListItem[] = []
  for (const row of rows) {
    const externalThreadId = readString(row.threadId) ?? readString(row.thread_id) ?? readString(row.id)
    if (!externalThreadId) {
      continue
    }
    const sessionFile = sessionFileById.get(externalThreadId)
    const meta = sessionFile ? await readCodexSessionMeta(sessionFile) : {}
    const summary = sessionFile ? await readCodexSessionSummary(sessionFile) : emptyCodexSessionSummary()
    chats.push({
      externalThreadId,
      title: readString(row.thread_name) ?? readString(row.title) ?? "Untitled chat",
      updatedAt:
        newestCodexTimestamp(
          summary.updatedAt,
          readIsoString(row.updatedAt) ??
            readIsoString(row.updated_at) ??
            readIsoString(row.lastSentAt) ??
            readIsoString(row.last_sent_at) ??
            null,
        ),
      createdAt: readIsoString(meta.timestamp) ?? null,
      status: summary.status,
      workingDirectory: readString(meta.cwd) ?? null,
    })
  }
  return chats
}

function accumulateLivePlanMessage(
  message: ProviderChatMessageItem,
  contentByItemId: Map<string, string>,
): ProviderChatMessageItem {
  if (message.kind !== "PLAN" || !message.itemId) {
    return message
  }
  if (message.status === "STREAMING") {
    const content = `${contentByItemId.get(message.itemId) ?? ""}${message.content}`
    contentByItemId.set(message.itemId, content)
    return { ...message, content }
  }
  contentByItemId.set(message.itemId, message.content)
  return message
}

async function loadCodexChatMessages(
  account: ProviderAccount,
  externalThreadId: string,
): Promise<ProviderChatMessageItem[]> {
  const appServerResult = await loadCodexChatMessagesFromAppServer(account, externalThreadId, codexMessageReadTimeoutMs).catch(() => null)
  if (appServerResult) {
    const storedStatus = appServerResult.status === "RUNNING"
      ? null
      : await readCodexStoredChatStatus(account, externalThreadId)
    if (appServerResult.status === "RUNNING" || storedStatus === "RUNNING") {
      return mergeCodexMessages(appServerResult.messages, await loadCodexStoredChatMessages(account, externalThreadId))
    }
    return appServerResult.messages
  }

  return loadCodexStoredChatMessages(account, externalThreadId)
}

async function readCodexChatStatus(account: ProviderAccount, externalThreadId: string): Promise<"IDLE" | "RUNNING" | null> {
  const thread = await readCodexAppServerThread(runtimeForAccount(account), externalThreadId).catch(() => null)
  const appServerStatus = readCodexAppServerOpenTurnStatus(thread)
  if (appServerStatus === "RUNNING") {
    return "RUNNING"
  }
  const storedStatus = await readCodexStoredChatStatus(account, externalThreadId)
  return storedStatus === "RUNNING" ? "RUNNING" : appServerStatus ?? storedStatus
}

async function readCodexActiveTurnId(
  runtime: Pick<CodexRuntime, "request">,
  externalThreadId: string,
): Promise<string | null> {
  const thread = await readCodexAppServerThread(runtime, externalThreadId)
  return readCodexAppServerOpenTurnId(thread)
}

async function loadCodexStoredChatMessages(
  account: ProviderAccount,
  externalThreadId: string,
): Promise<ProviderChatMessageItem[]> {
  const codexHome = resolveAccountCodexHome(account)
  const sessionFile = await findCodexSessionFile(codexHome, externalThreadId)
  const sessionMessages = sessionFile ? await readCodexSessionMessages(sessionFile) : []
  const logMessages = await readCodexLogMessages(codexHome, externalThreadId)
  return mergeCodexMessages(sessionMessages, logMessages)
}

async function readCodexStoredChatStatus(
  account: ProviderAccount,
  externalThreadId: string,
): Promise<"IDLE" | "RUNNING" | null> {
  const codexHome = resolveAccountCodexHome(account)
  const sessionFile = await findCodexSessionFile(codexHome, externalThreadId)
  return sessionFile ? (await readCodexSessionSummary(sessionFile)).status : null
}

async function readCodexStoredChatStates(
  account: ProviderAccount,
  externalThreadIds: string[],
): Promise<Map<string, ProviderChatStateSnapshot>> {
  const ids = new Set(externalThreadIds.map((id) => id.trim()).filter(Boolean))
  const states = new Map<string, ProviderChatStateSnapshot>()
  if (!ids.size) {
    return states
  }
  const codexHome = resolveAccountCodexHome(account)
  const sessionFileById = await findCodexSessionFiles(codexHome, [...ids], { fallbackToFullScan: false })

  for (const externalThreadId of ids) {
    const sessionFile = sessionFileById.get(externalThreadId)
    if (!sessionFile) {
      continue
    }
    const sessionStats = await stat(sessionFile).catch(() => null)
    if (!sessionStats?.isFile()) {
      continue
    }
    if (Date.now() - sessionStats.mtimeMs >= codexStoredRunningFreshnessMs) {
      states.set(externalThreadId, {
        updatedAt: sessionStats.mtime.toISOString(),
      })
      continue
    }
    const summary = await readCodexSessionSummary(sessionFile)
    states.set(externalThreadId, {
      status: summary.status,
      updatedAt: summary.updatedAt,
    })
  }
  return states
}

async function refreshCodexStoredSummaries(
  account: ProviderAccount,
  chats: ProviderChatListItem[],
): Promise<void> {
  const candidates = chats
  if (!candidates.length) {
    return
  }
  const codexHome = resolveAccountCodexHome(account)
  const sessionFileById = await findCodexSessionFiles(codexHome, candidates.map((chat) => chat.externalThreadId))

  for (const chat of candidates) {
    const sessionFile = sessionFileById.get(chat.externalThreadId)
    if (!sessionFile) {
      continue
    }
    const summary = await readCodexSessionSummary(sessionFile)
    chat.updatedAt = newestCodexTimestamp(summary.updatedAt, chat.updatedAt ?? null)
    if (summary.status === "RUNNING" || !chat.status) {
      chat.status = summary.status
    }
  }
}

async function listCodexChatsFromAppServer(account: ProviderAccount): Promise<ProviderChatListItem[] | null> {
  const runtime = runtimeForAccount(account)
  const response = await runtime.request(
    "thread/list",
    {
      archived: false,
      limit: maxProviderChats,
      modelProviders: [],
      sortDirection: "desc",
      sortKey: "updated_at",
      sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"],
    },
    30_000,
  )
  const result = asJsonObject(response.result)
  if (!Array.isArray(result?.data)) {
    return null
  }
  const chats = result.data
    .map(readCodexAppServerChat)
    .filter((chat): chat is ProviderChatListItem => Boolean(chat))
  await refreshCodexAppServerLiveStatuses(runtime, chats)
  return chats
}

function readCodexAppServerChat(value: unknown): ProviderChatListItem | null {
  const thread = asJsonObject(value)
  const externalThreadId = readString(thread?.id)
  if (!thread || !externalThreadId) {
    return null
  }
  const title = readString(thread.name) ?? readString(thread.preview) ?? "Untitled chat"
  return {
    externalThreadId,
    stats: null,
    status: readCodexAppServerThreadStatus(thread.status),
    title,
    updatedAt: readCodexAppServerTimestamp(thread.recencyAt) ?? readCodexAppServerTimestamp(thread.updatedAt),
    createdAt: readCodexAppServerTimestamp(thread.createdAt),
    workingDirectory: readString(thread.cwd) ?? null,
  }
}

async function loadCodexChatMessagesFromAppServer(
  account: ProviderAccount,
  externalThreadId: string,
  timeoutMs = 30_000,
): Promise<{ messages: ProviderChatMessageItem[]; status: "IDLE" | "RUNNING" | null } | null> {
  const thread = await readCodexAppServerThread(runtimeForAccount(account), externalThreadId, timeoutMs)
  if (!thread) {
    return null
  }
  return {
    messages: readCodexAppServerThreadMessages(thread),
    status: readCodexAppServerOpenTurnStatus(thread),
  }
}

async function refreshCodexAppServerLiveStatuses(
  runtime: Pick<CodexRuntime, "request">,
  chats: ProviderChatListItem[],
): Promise<void> {
  const candidates = chats
    .slice(0, codexLiveStatusReadLimit)

  for (const chat of candidates) {
    const thread = await readCodexAppServerThread(runtime, chat.externalThreadId).catch(() => null)
    const status = readCodexAppServerOpenTurnStatus(thread)
    if (status) {
      chat.status = status
    }
  }
}

async function readCodexAppServerThread(
  runtime: Pick<CodexRuntime, "request">,
  externalThreadId: string,
  timeoutMs = 30_000,
): Promise<JsonObject | null> {
  const response = await runtime.request(
    "thread/read",
    {
      threadId: externalThreadId,
      includeTurns: true,
    },
    timeoutMs,
  )
  return asJsonObject(asJsonObject(response.result)?.thread) ?? null
}

function readCodexAppServerThreadMessages(thread: JsonObject): ProviderChatMessageItem[] {
  if (!Array.isArray(thread.turns)) {
    return []
  }
  const messages: ProviderChatMessageItem[] = []
  for (const turnValue of thread.turns) {
    const turn = asJsonObject(turnValue)
    if (!turn || !Array.isArray(turn.items)) {
      continue
    }
    const turnId = readString(turn.id) ?? readString(turn.turnId) ?? readString(turn.turn_id) ?? null
    const startedAt = readCodexAppServerTimestamp(turn.startedAt)
    const completedAt = readCodexAppServerTimestamp(turn.completedAt)
    for (const itemValue of turn.items) {
      const message = readCodexAppServerThreadItemMessage(itemValue, startedAt, completedAt)
      if (message) {
        messages.push(turnId && !message.turnId ? { ...message, turnId } : message)
      }
    }
  }
  return mergeCodexMessages(messages, [])
}

function readCodexAppServerThreadItemMessage(
  value: unknown,
  turnStartedAt: string | null,
  turnCompletedAt: string | null,
): ProviderChatMessageItem | null {
  const item = asJsonObject(value)
  const type = readString(item?.type)
  if (!item || !type) {
    return null
  }

  if (type === "userMessage") {
    const content = readCodexAppServerUserMessageText(item.content)
    if (!content || isCodexInjectedContextMessage(content)) {
      return null
    }
    return {
      role: "USER",
      content,
      itemId: readString(item.id) ?? readString(item.clientId) ?? null,
      createdAt: turnStartedAt,
    }
  }

  if (type === "agentMessage") {
    const content = readString(item.text)
    if (!content) {
      return null
    }
    return {
      role: "ASSISTANT",
      content,
      itemId: readString(item.id) ?? null,
      createdAt: turnCompletedAt ?? turnStartedAt,
    }
  }

  if (type === "reasoning") {
    const content = formatCodexReasoning(item)
    if (!content) {
      return null
    }
    return {
      role: "ASSISTANT",
      kind: "THINKING",
      content,
      itemId: readString(item.id) ?? null,
      createdAt: turnStartedAt,
    }
  }

  if (isCodexPlanItemType(type)) {
    return codexPlanItemMessage(item, turnStartedAt)
  }

  if (type === "commandExecution") {
    return codexActionMessage(item, "COMMAND_EXECUTION", formatCodexCommandExecution(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "fileChange") {
    return codexActionMessage(item, "FILE_CHANGE", formatCodexFileChange(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "mcpToolCall") {
    return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexMcpToolCall(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "dynamicToolCall") {
    const userInputMessage = readCodexUserInputPromptFromToolItem(item, turnStartedAt, turnCompletedAt)
    if (userInputMessage) {
      return userInputMessage
    }
    return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexDynamicToolCall(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "webSearch") {
    return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexWebSearch(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "collabAgentToolCall") {
    return codexActionMessage(item, "SUBAGENT_ACTIVITY", formatCodexCollabAgentToolCall(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "subAgentActivity") {
    return codexActionMessage(item, "SUBAGENT_ACTIVITY", formatCodexSubAgentActivity(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return codexActionMessage(item, "REVIEW", formatCodexReviewMode(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "warning") {
    return codexActionMessage(item, "WARNING", formatCodexWarning(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "contextCompaction") {
    return codexActionMessage(item, "COMPACTION", formatCodexSimpleToolItem(item), turnCompletedAt ?? turnStartedAt)
  }

  if (type === "imageView" || type === "imageGeneration" || type === "sleep") {
    return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexSimpleToolItem(item), turnCompletedAt ?? turnStartedAt)
  }

  if (isCodexVisibleFallbackItem(type)) {
    return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexFallbackToolItem(item), turnCompletedAt ?? turnStartedAt)
  }

  return null
}

function codexActionMessage(
  item: JsonObject,
  kind: NonNullable<ProviderChatMessageItem["kind"]>,
  content: string | null,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  if (!content) {
    return null
  }
  return {
    role: "TOOL",
    kind,
    status: codexItemMessageStatus(item.status),
    content,
    itemId: readString(item.id) ?? null,
    createdAt,
  }
}

function readCodexUserInputPromptFromToolItem(
  item: JsonObject,
  turnStartedAt: string | null,
  turnCompletedAt: string | null,
): ProviderChatMessageItem | null {
  const tool = readString(item.tool) ?? readString(item.name)
  if (!tool || !isCodexRequestUserInputName(tool)) {
    return null
  }
  const requestId = readString(item.requestId) ?? readString(item.request_id)
  const payload = asJsonObject(item.arguments) ?? item
  return codexUserInputPromptMessage({
    createdAt: turnStartedAt ?? turnCompletedAt,
    itemId: readString(item.id) ?? requestId ?? null,
    payload,
    requestId: requestId ?? null,
    status: readString(item.status),
  })
}

function codexUserInputPromptMessage({
  createdAt,
  itemId,
  payload,
  requestId,
  status,
}: {
  createdAt: string | null
  itemId: string | null
  payload: JsonObject
  requestId: string | null
  status?: string
}): ProviderChatMessageItem {
  return {
    role: "TOOL",
    kind: "USER_INPUT_PROMPT",
    status: codexUserInputPromptStatus(status),
    content: formatCodexUserInputPrompt(payload),
    itemId,
    createdAt,
    metadata: { serverRequestMethod: "item/tool/requestUserInput" },
    rawPayload: jsonFromUnknown(payload),
    requestId,
  }
}

function formatCodexCommandExecution(item: JsonObject): string | null {
  const parts: string[] = [`Command${codexStatusSuffix(item.status)}`]
  const command = readString(item.command)
  const cwd = readString(item.cwd)
  const actions = formatCodexCommandActions(item.commandActions)
  const output = readString(item.aggregatedOutput)
  const metadata = [
    cwd ? `cwd: \`${cwd}\`` : null,
    readNumber(item.exitCode) !== undefined ? `exit: \`${readNumber(item.exitCode)}\`` : null,
    readNumber(item.durationMs) !== undefined ? `duration: \`${readNumber(item.durationMs)} ms\`` : null,
  ].filter(Boolean)
  const shouldShowCommand = !actions.length || actions.some((action) => action.type === "unknown")

  if (command && shouldShowCommand) {
    parts.push(fencedBlock("sh", command))
  }
  if (metadata.length) {
    parts.push(metadata.join(" | "))
  }
  if (actions.length) {
    parts.push(["Actions", ...actions.map((action) => `- ${action.label}`)].join("\n"))
  }
  if (output) {
    parts.push(["Output", fencedBlock("text", output)].join("\n"))
  }
  return parts.join("\n\n")
}

function formatCodexFileChange(item: JsonObject): string | null {
  const parts: string[] = [`File change${codexStatusSuffix(item.status)}`]
  const changes = Array.isArray(item.changes) ? item.changes : []
  for (const changeValue of changes) {
    const change = asJsonObject(changeValue)
    if (!change) {
      continue
    }
    const path = readString(change.path) ?? "unknown file"
    const kind = readString(change.kind)
    const diff = readString(change.diff)
    const stats = diff ? codexDiffStats(diff) : { additions: 0, deletions: 0 }
    parts.push(`\`${path}\`${kind ? ` ${kind}` : ""} +${stats.additions} -${stats.deletions}`)
  }
  return parts.join("\n\n")
}

function codexDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue
    }
    if (line.startsWith("+")) {
      additions += 1
    } else if (line.startsWith("-")) {
      deletions += 1
    }
  }
  return { additions, deletions }
}

function formatCodexMcpToolCall(item: JsonObject): string | null {
  const server = readString(item.server)
  const tool = readString(item.tool)
  const parts = [`MCP tool ${[server, tool].filter(Boolean).join("/") || "call"}${codexStatusSuffix(item.status)}`]
  const error = asJsonObject(item.error)
  const errorMessage = readString(error?.message)

  addJsonBlock(parts, "Arguments", item.arguments)
  addJsonBlock(parts, "Result", item.result)
  if (errorMessage) {
    parts.push(`Error\n${fencedBlock("text", errorMessage)}`)
  }
  return parts.join("\n\n")
}

function formatCodexDynamicToolCall(item: JsonObject): string | null {
  const namespace = readString(item.namespace)
  const tool = readString(item.tool)
  const parts = [`Tool ${[namespace, tool].filter(Boolean).join("/") || "call"}${codexStatusSuffix(item.status)}`]
  const output = formatCodexDynamicToolOutput(item.contentItems)

  addJsonBlock(parts, "Arguments", item.arguments)
  if (output) {
    parts.push(`Output\n${output}`)
  }
  return parts.join("\n\n")
}

function formatCodexUserInputPrompt(payload: JsonObject): string {
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map((entry) => asJsonObject(entry)).filter((entry): entry is JsonObject => Boolean(entry))
    : []
  const questionText = questions
    .map((question) => readString(question.question) ?? readString(question.prompt) ?? readString(question.header))
    .filter((text): text is string => Boolean(text))
  if (questionText.length) {
    return ["User input requested", ...questionText.map((text) => `- ${text}`)].join("\n")
  }
  return readString(payload.question) ?? readString(payload.prompt) ?? readString(payload.message) ?? "User input requested"
}

function formatCodexWebSearch(item: JsonObject): string | null {
  const query = readString(item.query)
  const parts = [`Web search${codexStatusSuffix(item.status)}`]
  if (query) {
    parts.push(fencedBlock("text", query))
  }
  addJsonBlock(parts, "Action", item.action)
  return parts.join("\n\n")
}

function formatCodexReasoning(item: JsonObject): string | null {
  const summary = readCodexTextLike(item.summary)
  const content = readCodexTextLike(item.content)
  const text = [summary, content].filter(Boolean).join("\n\n").trim()
  return text || (readString(item.status) === "inProgress" ? "Thinking" : null)
}

function formatCodexCollabAgentToolCall(item: JsonObject): string | null {
  const tool = readString(item.tool)
  const receivers = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.map(readString).filter(Boolean)
    : []
  const parts = [`Subagent ${tool ?? "activity"}${codexStatusSuffix(item.status)}`]
  const metadata = [
    readString(item.senderThreadId) ? `from: \`${readString(item.senderThreadId)}\`` : null,
    receivers.length ? `to: ${receivers.map((id) => `\`${id}\``).join(", ")}` : null,
    readString(item.model) ? `model: \`${readString(item.model)}\`` : null,
    readString(item.reasoningEffort) ? `reasoning: \`${readString(item.reasoningEffort)}\`` : null,
  ].filter(Boolean)
  if (metadata.length) {
    parts.push(metadata.join(" | "))
  }
  const prompt = readString(item.prompt)
  if (prompt) {
    parts.push(fencedBlock("text", prompt))
  }
  addJsonBlock(parts, "Agents", item.agentsStates)
  return parts.join("\n\n")
}

function formatCodexSubAgentActivity(item: JsonObject): string | null {
  const kind = readString(item.kind)
  const path = readString(item.agentPath)
  const threadId = readString(item.agentThreadId)
  return [
    `Subagent ${kind ? humanizeCodexItemType(kind).toLowerCase() : "activity"}`,
    path ? `path: \`${path}\`` : null,
    threadId ? `thread: \`${threadId}\`` : null,
  ].filter(Boolean).join("\n\n")
}

function formatCodexReviewMode(item: JsonObject): string | null {
  const type = readString(item.type)
  const review = readString(item.review)
  const label = type === "enteredReviewMode" ? "Review started" : "Review completed"
  return review ? `${label}\n\n${review}` : label
}

function formatCodexWarning(item: JsonObject): string | null {
  return readString(item.message) ?? readString(item.text) ?? readString(item.warning) ?? formatCodexFallbackToolItem(item)
}

function formatCodexSimpleToolItem(item: JsonObject): string | null {
  const type = readString(item.type)
  if (type === "imageView") {
    return `Image viewed\n\n\`${readString(item.path) ?? "unknown path"}\``
  }
  if (type === "imageGeneration") {
    const parts = [`Image generation${codexStatusSuffix(item.status)}`]
    const savedPath = readString(item.savedPath) ?? readString(item.saved_path)
    const revisedPrompt = readString(item.revisedPrompt) ?? readString(item.revised_prompt)
    if (savedPath) {
      parts.push(`saved: \`${savedPath}\``)
    }
    if (revisedPrompt) {
      parts.push(fencedBlock("text", revisedPrompt))
    }
    return parts.join("\n\n")
  }
  if (type === "sleep") {
    return `Waited${readNumber(item.durationMs) !== undefined ? ` \`${readNumber(item.durationMs)} ms\`` : ""}`
  }
  if (type === "contextCompaction") {
    return "Context compacted"
  }
  return null
}

function formatCodexFallbackToolItem(item: JsonObject): string | null {
  const type = readString(item.type) ?? "tool"
  const name = readString(item.tool) ?? readString(item.name)
  const parts = [`${humanizeCodexItemType(type)}${name ? ` ${name}` : ""}${codexStatusSuffix(item.status)}`]
  const metadata = [
    readString(item.id) ? `id: \`${readString(item.id)}\`` : null,
    readString(item.server) ? `server: \`${readString(item.server)}\`` : null,
    readString(item.namespace) ? `namespace: \`${readString(item.namespace)}\`` : null,
  ].filter(Boolean)
  if (metadata.length) {
    parts.push(metadata.join(" | "))
  }
  addJsonBlock(parts, "Details", sanitizeCodexToolDetails(item))
  return parts.join("\n\n")
}

function isCodexVisibleFallbackItem(type: string): boolean {
  return type !== "hookPrompt"
}

function humanizeCodexItemType(type: string): string {
  return type
    .replace(/[_-]+/gu, " ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^./u, (letter) => letter.toUpperCase()) || "Tool"
}

function sanitizeCodexToolDetails(value: unknown, depth = 0): JsonSerializable {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "string") {
    return value.length > 1000 ? `${value.slice(0, 1000)}...` : value
  }
  if (Array.isArray(value)) {
    if (depth >= 3) {
      return `[${value.length} items]`
    }
    const items = value.slice(0, 20).map((item) => sanitizeCodexToolDetails(item, depth + 1))
    return value.length > items.length ? [...items, `... ${value.length - items.length} more`] : items
  }
  const object = asJsonObject(value)
  if (!object) {
    return String(value)
  }
  if (depth >= 3) {
    return "{...}"
  }
  const details: JsonObject = {}
  for (const [key, entry] of Object.entries(object)) {
    details[key] = isCodexHeavyDetailKey(key) ? "[omitted]" : sanitizeCodexToolDetails(entry, depth + 1)
  }
  return details
}

function isCodexHeavyDetailKey(key: string): boolean {
  return [
    "aggregatedOutput",
    "content",
    "diff",
    "encrypted_content",
    "output",
    "replacement_history",
    "result",
    "stderr",
    "stdout",
    "text",
    "unified_diff",
  ].includes(key)
}

type CodexCommandActionSummary = {
  label: string
  type: string
}

function formatCodexCommandActions(value: unknown): CodexCommandActionSummary[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((actionValue) => {
      const action = asJsonObject(actionValue)
      const type = readString(action?.type)
      const command = readString(action?.command)
      if (!action || !type) {
        return null
      }
      if (type === "read") {
        return {
          type,
          label: `read ${readString(action.path) ?? readString(action.name) ?? command ?? "file"}`,
        }
      }
      if (type === "listFiles") {
        return { type, label: `list ${readString(action.path) ?? command ?? "files"}` }
      }
      if (type === "search") {
        const query = readString(action.query)
        const path = readString(action.path)
        return { type, label: `search${query ? ` "${query}"` : ""}${path ? ` in ${path}` : ""}` }
      }
      return { type, label: command ?? type }
    })
    .filter((action): action is CodexCommandActionSummary => Boolean(action))
}

function formatCodexDynamicToolOutput(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null
  }
  const text = value
    .map((entryValue) => {
      const entry = asJsonObject(entryValue)
      if (readString(entry?.type) === "inputText") {
        return readString(entry?.text) ?? ""
      }
      if (readString(entry?.type) === "inputImage") {
        return readString(entry?.imageUrl) ?? readString(entry?.image_url) ?? ""
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
  return text ? fencedBlock("text", text) : null
}

function addJsonBlock(parts: string[], label: string, value: unknown): void {
  if (value === undefined || value === null) {
    return
  }
  const block = formatJsonBlock(value)
  if (block) {
    parts.push(`${label}\n${block}`)
  }
}

function formatJsonBlock(value: unknown): string | null {
  try {
    const json = JSON.stringify(value, null, 2)
    return json && json !== "null" ? fencedBlock("json", json) : null
  } catch {
    return null
  }
}

function fencedBlock(language: string, value: string): string {
  return `~~~${language}\n${value.trim()}\n~~~`
}

function codexStatusSuffix(value: unknown): string {
  const status = readString(value)
  return status ? ` \`${status}\`` : ""
}

function codexItemMessageStatus(value: unknown): NonNullable<ProviderChatMessageItem["status"]> {
  const status = readString(value)
  if (status === "inProgress") {
    return "STREAMING"
  }
  if (status === "failed" || status === "declined") {
    return "FAILED"
  }
  return "COMPLETED"
}

function readCodexAppServerUserMessageText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null
  }
  if (!Array.isArray(value)) {
    return null
  }
  const text = value
    .map((input) => {
      const inputObject = asJsonObject(input)
      if (readString(inputObject?.type) !== "text") {
        return ""
      }
      return readString(inputObject?.text) ?? ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
  return text || null
}

function readCodexTextLike(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null
  }
  if (!Array.isArray(value)) {
    return null
  }
  const text = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry
      }
      const object = asJsonObject(entry)
      return readString(object?.text) ?? readString(object?.content) ?? ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
  return text || null
}

function readCodexAppServerTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString()
  }
  return readIsoString(value)
}

function readCodexAppServerThreadStatus(value: unknown): "IDLE" | "RUNNING" | null {
  const status = asJsonObject(value)
  const type = readString(status?.type) ?? readString(value)
  if (type === "active" || type === "running" || type === "inProgress" || type === "busy") {
    return "RUNNING"
  }
  if (type === "idle" || type === "notLoaded" || type === "systemError" || type === "completed") {
    return "IDLE"
  }
  return null
}

function readCodexAppServerOpenTurnStatus(thread: JsonObject | null): "IDLE" | "RUNNING" | null {
  if (!thread) {
    return null
  }
  const status = readCodexAppServerThreadStatus(thread.status)
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const lastTurn = asJsonObject(turns.at(-1))
  if (!lastTurn) {
    return status
  }
  if (readCodexAppServerTimestamp(lastTurn.completedAt)) {
    return status === "RUNNING" && isFreshCodexThreadActivity(thread, lastTurn) ? "RUNNING" : "IDLE"
  }
  return isFreshCodexThreadActivity(thread, lastTurn) ? "RUNNING" : "IDLE"
}

function readCodexAppServerOpenTurnId(thread: JsonObject | null): string | null {
  if (!thread || readCodexAppServerOpenTurnStatus(thread) !== "RUNNING" || !Array.isArray(thread.turns)) {
    return null
  }
  for (const turnValue of [...thread.turns].reverse()) {
    const turn = asJsonObject(turnValue)
    if (!turn || readCodexAppServerTimestamp(turn.completedAt)) {
      continue
    }
    const turnId = readString(turn.id) ?? readString(turn.turnId) ?? readString(turn.turn_id)
    if (turnId) {
      return turnId
    }
  }
  return null
}

function isFreshCodexThreadActivity(thread: JsonObject, turn: JsonObject): boolean {
  const updatedAt = newestCodexTimestamp(
    readCodexAppServerTimestamp(turn.updatedAt) ??
      readCodexAppServerTimestamp(turn.startedAt) ??
      null,
    readCodexAppServerTimestamp(thread.recencyAt) ??
      readCodexAppServerTimestamp(thread.updatedAt) ??
      null,
  )
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < codexTurnCompletionTimeoutMs
}

function isCodexTurnCompletedEvent(
  message: CodexJsonRpcResponse,
  threadId: string,
  turnId: string | null,
): boolean {
  if (message.method !== "turn/completed") {
    return false
  }
  const params = asJsonObject(message.params)
  if ((readString(params?.threadId) ?? readString(params?.thread_id)) !== threadId) {
    return false
  }
  const turn = asJsonObject(params?.turn)
  const completedTurnId = readString(turn?.id)
  return !turnId || !completedTurnId || completedTurnId === turnId
}

function readCodexLiveThreadItemMessage(
  message: CodexJsonRpcResponse,
  threadId: string,
  turnId: string | null,
): ProviderChatMessageItem | null {
  const planDeltaMessage = readCodexPlanDeltaMessage(message, threadId, turnId)
  if (planDeltaMessage) {
    return planDeltaMessage
  }

  const started = message.method === "item/started"
  const completed = message.method === "item/completed"
  if (!started && !completed) {
    return null
  }

  const params = asJsonObject(message.params)
  if (!params || (readString(params.threadId) ?? readString(params.thread_id)) !== threadId) {
    return null
  }
  const eventTurnId = readString(params.turnId) ?? readString(params.turn_id)
  if (turnId && eventTurnId && eventTurnId !== turnId) {
    return null
  }

  const item = asJsonObject(params.item)
  if (!item) {
    return null
  }
  const timestamp = readCodexAppServerMillisTimestamp(started ? params.startedAtMs : params.completedAtMs)
    ?? new Date().toISOString()
  const liveItem = started && item.status === undefined ? { ...item, status: "inProgress" } : item
  const providerMessage = readCodexAppServerThreadItemMessage(liveItem, timestamp, completed ? timestamp : null)
  if (!providerMessage || !isCodexLiveActionMessage(providerMessage)) {
    return null
  }
  return providerMessage
}

function readCodexPlanUpdateMessage(
  message: CodexJsonRpcResponse,
  threadId: string,
  turnId: string | null,
): ProviderChatMessageItem | null {
  if (message.method !== "turn/plan/updated") {
    return null
  }
  const params = asJsonObject(message.params)
  if (!params || (readString(params.threadId) ?? readString(params.thread_id)) !== threadId) {
    return null
  }
  const eventTurnId = readString(params.turnId) ?? readString(params.turn_id)
  if (turnId && eventTurnId && eventTurnId !== turnId) {
    return null
  }
  return codexPlanUpdateMessage({
    createdAt: new Date().toISOString(),
    explanation: readString(params.explanation) ?? null,
    itemId: eventTurnId ? `plan-update:${eventTurnId}` : `plan-update:${threadId}`,
    status: "STREAMING",
    steps: readCodexPlanSteps(params.plan),
    turnId: eventTurnId ?? null,
  })
}

function readCodexPlanDeltaMessage(
  message: CodexJsonRpcResponse,
  threadId: string,
  turnId: string | null,
): ProviderChatMessageItem | null {
  if (message.method !== "item/plan/delta") {
    return null
  }
  const params = asJsonObject(message.params)
  if (!params || (readString(params.threadId) ?? readString(params.thread_id)) !== threadId) {
    return null
  }
  const eventTurnId = readString(params.turnId) ?? readString(params.turn_id)
  if (turnId && eventTurnId && eventTurnId !== turnId) {
    return null
  }
  const itemId = readString(params.itemId) ?? readString(params.item_id)
  const delta = readString(params.delta)
  if (!itemId || !delta) {
    return null
  }
  return {
    role: "ASSISTANT",
    kind: "PLAN",
    status: "STREAMING",
    content: delta,
    itemId,
    createdAt: new Date().toISOString(),
    turnId: eventTurnId ?? null,
  }
}

function codexPlanUpdateMessage({
  createdAt,
  explanation,
  itemId,
  status,
  steps,
  turnId,
}: {
  createdAt: string | null
  explanation: string | null
  itemId: string | null
  status: NonNullable<ProviderChatMessageItem["status"]>
  steps: CodexPlanStep[]
  turnId?: string | null
}): ProviderChatMessageItem {
  return {
    role: "ASSISTANT",
    kind: "PLAN",
    status,
    content: explanation?.trim() ?? "",
    itemId,
    createdAt,
    turnId: turnId ?? null,
    metadata: {
      planPresentation: "update",
      planSteps: jsonFromUnknown(steps),
    },
  }
}

type CodexPlanStep = {
  status: "completed" | "inProgress" | "pending"
  step: string
}

function readCodexPlanSteps(value: unknown): CodexPlanStep[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => {
      const record = asJsonObject(entry)
      const step = readString(record?.step)
      const status = readCodexPlanStepStatus(record?.status)
      return step ? { step, status } : null
    })
    .filter((step): step is CodexPlanStep => Boolean(step))
}

function readCodexPlanStepStatus(value: unknown): CodexPlanStep["status"] {
  const status = readString(value)
  if (status === "completed" || status === "inProgress" || status === "pending") {
    return status
  }
  if (status === "in_progress") {
    return "inProgress"
  }
  return "pending"
}

function readCodexServerRequestMessage(
  message: CodexJsonRpcResponse,
  threadId: string,
  turnId: string | null,
): ProviderChatMessageItem | null {
  if (message.id === undefined || message.id === null || !message.method || !isCodexServerRequestMethod(message.method)) {
    return null
  }

  const params = asJsonObject(message.params)
  if (!params || (readString(params.threadId) ?? readString(params.thread_id)) !== threadId) {
    return null
  }
  const eventTurnId = readString(params.turnId) ?? readString(params.turn_id)
  if (turnId && eventTurnId && eventTurnId !== turnId) {
    return null
  }

  const requestId = String(message.id)
  const timestamp = readCodexAppServerMillisTimestamp(params.startedAtMs) ?? new Date().toISOString()
  return {
    content: codexServerRequestContent(message.method, params),
    createdAt: timestamp,
    itemId: `request:${requestId}`,
    kind: isCodexRequestUserInputMethod(message.method) ? "USER_INPUT_PROMPT" : "APPROVAL",
    metadata: { serverRequestMethod: message.method },
    rawPayload: jsonFromUnknown(params),
    requestId,
    role: "TOOL",
    status: "PENDING",
    turnId: eventTurnId ?? null,
  }
}

function readCodexServerRequestResolvedMessage(
  message: CodexJsonRpcResponse,
  threadId: string,
): ProviderChatMessageItem | null {
  if (message.method !== "serverRequest/resolved") {
    return null
  }
  const params = asJsonObject(message.params)
  if (!params || (readString(params.threadId) ?? readString(params.thread_id)) !== threadId) {
    return null
  }
  const requestId = readString(params.requestId) ?? readString(params.request_id)
  if (!requestId) {
    return null
  }
  return {
    content: "Request resolved",
    createdAt: new Date().toISOString(),
    itemId: `request:${requestId}`,
    kind: "APPROVAL",
    requestId,
    role: "TOOL",
    status: "COMPLETED",
  }
}

function isCodexServerRequestMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    isCodexRequestUserInputMethod(method) ||
    normalizedCodexName(method).endsWith("requestapproval")
  )
}

function codexServerRequestContent(method: string, params: JsonObject): string {
  const reason = readString(params.reason)
  const normalized = normalizedCodexName(method)
  if (normalized.includes("commandexecutionrequestapproval")) {
    const command = readString(params.command)
    const cwd = readString(params.cwd)
    return [
      "Command approval requested",
      cwd ? `cwd: \`${cwd}\`` : "",
      command ? `\n~~~sh\n${command}\n~~~` : "",
      reason ? `\n${reason}` : "",
    ].filter(Boolean).join("\n")
  }
  if (normalized.includes("filechangerequestapproval")) {
    return ["File change approval requested", reason].filter(Boolean).join("\n\n")
  }
  if (normalized.includes("permissionsrequestapproval")) {
    const cwd = readString(params.cwd)
    return ["Permissions requested", cwd ? `cwd: \`${cwd}\`` : "", reason].filter(Boolean).join("\n")
  }
  return formatCodexUserInputPrompt(params)
}

function serverRequestResultFromResponse(response: ServerRequestResponseRequest): JsonObject {
  if (response.kind === "permissions") {
    return { permissions: {}, scope: "turn" }
  }
  if (response.kind === "userInput") {
    return { answers: {} }
  }
  return { decision: response.decision ?? "decline" }
}

function isCodexLiveActionMessage(message: ProviderChatMessageItem): boolean {
  return (
    message.role === "TOOL" ||
    message.kind === "THINKING" ||
    message.kind === "PLAN" ||
    message.kind === "APPROVAL" ||
    message.kind === "USER_INPUT_PROMPT" ||
    message.kind === "REVIEW" ||
    message.kind === "WARNING" ||
    message.kind === "COMPACTION" ||
    message.kind === "SUBAGENT_ACTIVITY"
  )
}

function readCodexAppServerMillisTimestamp(value: unknown): string | null {
  const timestamp = readNumber(value)
  if (timestamp !== undefined) {
    return new Date(timestamp).toISOString()
  }
  return readIsoString(value)
}

async function listCodexSessionFiles(codexHome: string): Promise<string[]> {
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]
  const files: string[] = []
  for (const root of roots) {
    await collectCodexSessionFiles(root, files)
  }
  return files
}

async function collectCodexSessionFiles(directory: string, files: string[], depth = 0): Promise<void> {
  if (depth > 6) {
    return
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectCodexSessionFiles(entryPath, files, depth + 1)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath)
    }
  }
}

async function findCodexSessionFile(codexHome: string, externalThreadId: string): Promise<string | null> {
  const files = await findCodexSessionFiles(codexHome, [externalThreadId])
  return files.get(externalThreadId) ?? null
}

function codexSessionIdFromPath(pathname: string): string {
  return pathname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu)?.[1] ?? pathname
}

async function findCodexSessionFiles(
  codexHome: string,
  externalThreadIds: string[],
  options: { fallbackToFullScan?: boolean } = {},
): Promise<Map<string, string>> {
  const remaining = new Set(externalThreadIds.map((id) => id.trim()).filter(Boolean))
  const filesById = new Map<string, string>()
  if (!remaining.size) {
    return filesById
  }

  const directories = new Set<string>()
  for (const externalThreadId of remaining) {
    for (const directory of codexSessionCandidateDirectories(codexHome, externalThreadId)) {
      directories.add(directory)
    }
  }
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue
      }
      const externalThreadId = codexSessionIdFromPath(entry.name)
      if (!remaining.has(externalThreadId)) {
        continue
      }
      filesById.set(externalThreadId, join(directory, entry.name))
      remaining.delete(externalThreadId)
    }
    if (!remaining.size) {
      return filesById
    }
  }

  if (options.fallbackToFullScan === false) {
    return filesById
  }
  for (const file of await listCodexSessionFiles(codexHome)) {
    const externalThreadId = codexSessionIdFromPath(file)
    if (!remaining.has(externalThreadId)) {
      continue
    }
    filesById.set(externalThreadId, file)
    remaining.delete(externalThreadId)
    if (!remaining.size) {
      break
    }
  }
  return filesById
}

function codexSessionCandidateDirectories(codexHome: string, externalThreadId: string): string[] {
  const millis = codexUuidTimestampMillis(externalThreadId)
  if (millis === null) {
    return []
  }

  const days = new Set<string>()
  for (const offsetDays of [-1, 0, 1]) {
    const date = new Date(millis + offsetDays * 24 * 60 * 60 * 1000)
    const year = date.getUTCFullYear().toString().padStart(4, "0")
    const month = (date.getUTCMonth() + 1).toString().padStart(2, "0")
    const day = date.getUTCDate().toString().padStart(2, "0")
    days.add(join(year, month, day))
  }
  return [...days].flatMap((day) => [
    join(codexHome, "sessions", day),
    join(codexHome, "archived_sessions", day),
  ])
}

function codexUuidTimestampMillis(externalThreadId: string): number | null {
  const timestampHex = externalThreadId.replaceAll("-", "").slice(0, 12)
  if (!timestampHex.match(/^[0-9a-f]{12}$/iu)) {
    return null
  }
  const millis = Number.parseInt(timestampHex, 16)
  return Number.isFinite(millis) ? millis : null
}

async function readCodexSessionMeta(sessionFile: string): Promise<JsonObject> {
  const text = await readFile(sessionFile, "utf8").catch(() => "")
  for (const line of text.split(/\r?\n/u)) {
    const record = asJsonObject(parseJsonLine(line))
    if (readString(record?.type) === "session_meta") {
      return asJsonObject(record?.payload) ?? {}
    }
  }
  return {}
}

type CodexSessionSummary = {
  pendingCallIds: Set<string>
  status: "IDLE" | "RUNNING" | null
  updatedAt: string | null
}

type CodexSessionFunctionOutput = {
  durationMs: number | null
  exitCode: number | null
  output: string | null
}

function emptyCodexSessionSummary(): CodexSessionSummary {
  return {
    pendingCallIds: new Set(),
    status: null,
    updatedAt: null,
  }
}

async function readCodexSessionSummary(sessionFile: string): Promise<CodexSessionSummary> {
  const text = await readCodexSessionSummaryText(sessionFile).catch(() => "")
  return readCodexSessionTextSummary(text)
}

async function readCodexSessionSummaryText(sessionFile: string): Promise<string> {
  const sessionStats = await stat(sessionFile).catch(() => null)
  if (!sessionStats?.isFile()) {
    return ""
  }
  if (sessionStats.size <= codexSessionSummaryTailBytes) {
    return readFile(sessionFile, "utf8")
  }

  const length = Math.min(sessionStats.size, codexSessionSummaryTailBytes)
  const buffer = Buffer.alloc(length)
  const file = await openFile(sessionFile, "r")
  try {
    const result = await file.read(buffer, 0, length, sessionStats.size - length)
    return buffer.subarray(0, result.bytesRead).toString("utf8")
  } finally {
    await file.close()
  }
}

function readCodexSessionTextSummary(text: string): CodexSessionSummary {
  const pendingCallIds = new Set<string>()
  let activeTurnFinished = false
  let activeTurnUpdatedAt: string | null = null
  let lastTurnId: string | null = null
  let sawRecord = false
  let updatedAt: string | null = null

  for (const line of text.split(/\r?\n/u)) {
    const record = asJsonObject(parseJsonLine(line))
    if (!record) {
      continue
    }
    sawRecord = true
    updatedAt = newestCodexTimestamp(readIsoString(record.timestamp), updatedAt)

    const payload = asJsonObject(record.payload)
    const payloadType = readString(payload?.type)
    const recordType = readString(record.type)
    const turnId = readCodexSessionRecordTurnId(record, payload)
    if (turnId && turnId !== lastTurnId) {
      lastTurnId = turnId
      pendingCallIds.clear()
      activeTurnFinished = false
      activeTurnUpdatedAt = null
    }
    if (turnId && turnId === lastTurnId) {
      activeTurnUpdatedAt = newestCodexTimestamp(readIsoString(record.timestamp), activeTurnUpdatedAt)
    }

    if (recordType === "event_msg" && payloadType === "turn_aborted") {
      const abortedTurnId = readString(payload?.turn_id) ?? readString(payload?.turnId)
      if (!abortedTurnId || !lastTurnId || abortedTurnId === lastTurnId) {
        pendingCallIds.clear()
        activeTurnFinished = true
      }
      continue
    }

    if (recordType !== "response_item") {
      continue
    }
    if (payloadType === "message" && readString(payload?.phase) === "final_answer") {
      pendingCallIds.clear()
      activeTurnFinished = true
      continue
    }
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const callId = readCodexSessionCallId(payload)
      if (callId) {
        pendingCallIds.add(callId)
        activeTurnFinished = false
      }
      continue
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = readCodexSessionCallId(payload)
      if (callId) {
        if (isCodexSessionRunningToolOutput(payload)) {
          pendingCallIds.add(callId)
          activeTurnFinished = false
        } else {
          pendingCallIds.delete(callId)
        }
      }
    }
  }

  const activeTurnUpdatedAtMs = activeTurnUpdatedAt ? Date.parse(activeTurnUpdatedAt) : Number.NaN
  const activeTurnFresh = Number.isFinite(activeTurnUpdatedAtMs) && Date.now() - activeTurnUpdatedAtMs < codexStoredRunningFreshnessMs
  const freshPendingCallIds = Number.isFinite(activeTurnUpdatedAtMs) && Date.now() - activeTurnUpdatedAtMs < codexTurnCompletionTimeoutMs
    ? pendingCallIds
    : new Set<string>()
  const running = freshPendingCallIds.size > 0 || (!activeTurnFinished && activeTurnFresh)

  return {
    pendingCallIds: freshPendingCallIds,
    status: running ? "RUNNING" : sawRecord ? "IDLE" : null,
    updatedAt,
  }
}

async function readCodexSessionMessages(sessionFile: string): Promise<ProviderChatMessageItem[]> {
  const text = await readFile(sessionFile, "utf8").catch(() => "")
  const summary = readCodexSessionTextSummary(text)
  const outputByCallId = readCodexSessionFunctionOutputs(text)
  const messages: ProviderChatMessageItem[] = []
  for (const line of text.split(/\r?\n/u)) {
    const record = asJsonObject(parseJsonLine(line))
    const payload = asJsonObject(record?.payload)
    const message = readCodexSessionRecordMessage(record, payload, summary.pendingCallIds, outputByCallId)
    if (message) {
      messages.push(message)
    }
  }
  return mergeCodexMessages(messages, [])
}

function readCodexSessionFunctionOutputs(text: string): Map<string, CodexSessionFunctionOutput> {
  const outputs = new Map<string, CodexSessionFunctionOutput>()
  for (const line of text.split(/\r?\n/u)) {
    const record = asJsonObject(parseJsonLine(line))
    const payload = asJsonObject(record?.payload)
    const recordType = readString(record?.type)
    const payloadType = readString(payload?.type)
    if (recordType === "event_msg" && payloadType === "exec_command_end") {
      const callId = readCodexSessionCallId(payload)
      const output = readCodexSessionExecCommandEndOutput(payload)
      if (callId && output) {
        outputs.set(callId, mergeCodexSessionFunctionOutput(outputs.get(callId), output))
      }
      continue
    }
    if (recordType === "event_msg" && payloadType === "mcp_tool_call_end") {
      const callId = readCodexSessionCallId(payload)
      const output = readCodexSessionMcpToolEndOutput(payload)
      if (callId && output) {
        outputs.set(callId, mergeCodexSessionFunctionOutput(outputs.get(callId), output))
      }
      continue
    }
    if (
      recordType !== "response_item" ||
      (payloadType !== "function_call_output" && payloadType !== "custom_tool_call_output")
    ) {
      continue
    }

    const callId = readCodexSessionCallId(payload)
    const output = readCodexSessionFunctionOutput(payload)
    if (!callId || !output) {
      continue
    }
    outputs.set(callId, mergeCodexSessionFunctionOutput(outputs.get(callId), output))
  }
  return outputs
}

function mergeCodexSessionFunctionOutput(
  current: CodexSessionFunctionOutput | undefined,
  next: CodexSessionFunctionOutput,
): CodexSessionFunctionOutput {
  if (!current) {
    return next
  }
  const output = [current.output, next.output].filter(Boolean).join("\n").trim() || null
  return {
    durationMs: next.durationMs ?? current.durationMs,
    exitCode: next.exitCode ?? current.exitCode,
    output,
  }
}

function readCodexSessionFunctionOutput(payload: JsonObject | undefined): CodexSessionFunctionOutput | null {
  const rawOutput = typeof payload?.output === "string" ? payload.output : ""
  if (!rawOutput.trim()) {
    return null
  }

  const exitCodeMatch = rawOutput.match(/\bProcess exited with code (-?\d+)\b/u)
  const exitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1] ?? "", 10) : Number.NaN
  const wallTimeMatch = rawOutput.match(/^Wall time:\s*([0-9.]+)\s*seconds$/mu)
  const wallTimeSeconds = wallTimeMatch ? Number.parseFloat(wallTimeMatch[1] ?? "") : Number.NaN
  const output = readCodexSessionOutputBody(rawOutput)

  return {
    durationMs: Number.isFinite(wallTimeSeconds) ? Math.round(wallTimeSeconds * 1000) : null,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    output: output?.trim() ? output.trim() : null,
  }
}

function readCodexSessionExecCommandEndOutput(payload: JsonObject | undefined): CodexSessionFunctionOutput | null {
  const output = readString(payload?.aggregated_output)
    ?? [readString(payload?.stdout), readString(payload?.stderr)].filter(Boolean).join("\n").trim()
    ?? null
  const exitCode = readNumber(payload?.exit_code) ?? readNumber(payload?.exitCode) ?? null
  const durationMs = readCodexDurationMs(payload?.duration) ?? readNumber(payload?.duration_ms) ?? readNumber(payload?.durationMs) ?? null
  if (!output && exitCode === null && durationMs === null) {
    return null
  }
  return { durationMs, exitCode, output }
}

function readCodexSessionMcpToolEndOutput(payload: JsonObject | undefined): CodexSessionFunctionOutput | null {
  const result = payload?.result === undefined ? null : sanitizeCodexToolDetails(payload.result)
  const output = result === null ? null : JSON.stringify(result, null, 2)
  const durationMs = readCodexDurationMs(payload?.duration)
  if (!output && durationMs === null) {
    return null
  }
  return { durationMs, exitCode: null, output }
}

function readCodexDurationMs(value: unknown): number | null {
  const duration = asJsonObject(value)
  const seconds = readNumber(duration?.secs) ?? readNumber(duration?.seconds)
  const nanos = readNumber(duration?.nanos) ?? readNumber(duration?.nanoseconds)
  if (seconds === undefined && nanos === undefined) {
    return null
  }
  return Math.round((seconds ?? 0) * 1000 + (nanos ?? 0) / 1_000_000)
}

function readCodexSessionOutputBody(rawOutput: string): string | null {
  const marker = "\nOutput:\n"
  const markerIndex = rawOutput.indexOf(marker)
  if (markerIndex >= 0) {
    return rawOutput.slice(markerIndex + marker.length).trimEnd()
  }
  if (rawOutput.startsWith("Output:\n")) {
    return rawOutput.slice("Output:\n".length).trimEnd()
  }
  return rawOutput.trim() || null
}

type CodexLogRow = {
  feedback_log_body?: string | null
  id?: number | string | null
  process_uuid?: string | null
  target?: string | null
  ts?: number | null
  ts_nanos?: number | null
}

async function readCodexLogMessages(codexHome: string, externalThreadId: string): Promise<ProviderChatMessageItem[]> {
  const databasePath = join(codexHome, "logs_2.sqlite")
  const databaseStats = await stat(databasePath).catch(() => null)
  if (!databaseStats?.isFile()) {
    return []
  }

  const submissionRows = await readCodexLogRows(databasePath, `
    select id, ts, ts_nanos, target, feedback_log_body, process_uuid
    from logs
    where thread_id = ${sqlString(externalThreadId)}
      and target = 'codex_core::session::handlers'
      and feedback_log_body like '%Submission sub=Submission%'
    order by ts asc, ts_nanos asc, id asc
    limit ${codexLogReadLimit}
  `)
  if (!submissionRows.length) {
    return []
  }

  const messages: ProviderChatMessageItem[] = []
  const turnIds = new Set<string>()
  const processIds = new Set<string>()
  let minTs = Number.POSITIVE_INFINITY

  for (const row of submissionRows) {
    const body = row.feedback_log_body ?? ""
    for (const turnId of extractCodexTurnIds(body)) {
      turnIds.add(turnId)
    }
    const message = readCodexSubmissionMessage(row)
    if (message) {
      messages.push(message)
    }
    if (row.process_uuid) {
      processIds.add(row.process_uuid)
    }
    if (typeof row.ts === "number" && row.ts < minTs) {
      minTs = row.ts
    }
  }

  if (!turnIds.size || !processIds.size || !Number.isFinite(minTs)) {
    return messages
  }

  const turnPredicates = [...turnIds].map((turnId) => `feedback_log_body like ${sqlString(`%"turn_id":"${turnId}"%`)}`)
  const processPredicate = [...processIds].map(sqlString).join(", ")
  const assistantRows = await readCodexLogRows(databasePath, `
    select id, ts, ts_nanos, target, feedback_log_body, process_uuid
    from logs
    where thread_id is null
      and process_uuid in (${processPredicate})
      and ts >= ${Math.max(0, Math.floor(minTs) - 60)}
      and feedback_log_body like 'Received message {"type":"response.output_item.done"%'
      and (${turnPredicates.join(" or ")})
    order by ts asc, ts_nanos asc, id asc
    limit ${codexLogReadLimit}
  `)
  for (const row of assistantRows) {
    const message = readCodexReceivedMessage(row)
    if (message) {
      messages.push(message)
    }
  }

  return messages.sort(compareCodexMessages)
}

async function readCodexLogRows(databasePath: string, sql: string): Promise<CodexLogRow[]> {
  return new Promise((resolve) => {
    execFile("sqlite3", ["-readonly", "-json", databasePath, sql], { maxBuffer: 16 * 1024 * 1024, timeout: 2000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([])
        return
      }
      const rows = parseJsonLine(stdout)
      resolve(Array.isArray(rows) ? rows.map((row) => asJsonObject(row) ?? {}).filter(isCodexLogRow) : [])
    })
  })
}

function isCodexLogRow(row: JsonObject): row is CodexLogRow {
  return true
}

function readCodexSubmissionMessage(row: CodexLogRow): ProviderChatMessageItem | null {
  const body = row.feedback_log_body ?? ""
  const turnId = body.match(/Submission sub=Submission \{ id: "([0-9a-f-]{36})"/u)?.[1] ?? extractCodexTurnIds(body)[0]
  const inputText = [...body.split("final_output_json_schema:")[0].matchAll(/Text \{ text: "((?:\\.|[^"\\])*)"/gu)]
    .map((match) => unescapeCodexLogString(match[1]))
    .filter(Boolean)
    .join("\n")
    .trim()
  if (!inputText || isCodexInjectedContextMessage(inputText)) {
    return null
  }
  return {
    role: "USER",
    content: inputText,
    itemId: turnId ? `${turnId}:user` : null,
    turnId: turnId ?? null,
    createdAt: codexLogRowDate(row),
  }
}

function readCodexReceivedMessage(row: CodexLogRow): ProviderChatMessageItem | null {
  const body = row.feedback_log_body ?? ""
  if (!body.startsWith("Received message ")) {
    return null
  }
  const event = asJsonObject(parseJsonLine(body.slice("Received message ".length)))
  if (readString(event?.type) !== "response.output_item.done") {
    return null
  }
  const item = asJsonObject(event?.item)
  if (readString(item?.type) !== "message") {
    return null
  }
  const role = codexMessageRole(item?.role)
  const content = readCodexMessageText(item?.content)
  if (!role || !content) {
    return null
  }
  const turnId = readString(event?.turn_id) ??
    readString(event?.turnId) ??
    readString(item?.turn_id) ??
    readString(item?.turnId) ??
    extractCodexTurnIds(body)[0] ??
    null
  return {
    role,
    content,
    itemId: readString(item?.id) ?? null,
    turnId,
    createdAt: codexLogRowDate(row),
  }
}

function extractCodexTurnIds(value: string): string[] {
  const ids = new Set<string>()
  for (const match of value.matchAll(/Submission sub=Submission \{ id: "([0-9a-f-]{36})"/gu)) {
    ids.add(match[1])
  }
  for (const match of value.matchAll(/(?:submission\.id|turn\.id|turn_id)[=:]"?([0-9a-f-]{36})"?/gu)) {
    ids.add(match[1])
  }
  return [...ids]
}

function unescapeCodexLogString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\")
  }
}

function codexLogRowDate(row: CodexLogRow): string | null {
  if (typeof row.ts !== "number") {
    return null
  }
  const milliseconds = row.ts * 1000 + Math.floor((typeof row.ts_nanos === "number" ? row.ts_nanos : 0) / 1_000_000)
  return new Date(milliseconds).toISOString()
}

function mergeCodexMessages(
  sessionMessages: ProviderChatMessageItem[],
  logMessages: ProviderChatMessageItem[],
): ProviderChatMessageItem[] {
  const messages: ProviderChatMessageItem[] = []
  for (const message of [...sessionMessages, ...logMessages]) {
    if (!messages.some((current) => sameCodexMessage(current, message))) {
      messages.push(message)
    }
  }
  return messages.sort(compareCodexMessages)
}

function sameCodexMessage(left: ProviderChatMessageItem, right: ProviderChatMessageItem): boolean {
  if (left.itemId && right.itemId && left.itemId === right.itemId) {
    return true
  }
  if (left.role !== right.role || normalizeCodexMessageText(left.content) !== normalizeCodexMessageText(right.content)) {
    return false
  }
  const leftTime = Date.parse(left.createdAt ?? "")
  const rightTime = Date.parse(right.createdAt ?? "")
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return Math.abs(leftTime - rightTime) < 60_000
  }
  return !left.itemId || !right.itemId
}

function normalizeCodexMessageText(value: string): string {
  return value.trim().replace(/\s+/gu, " ")
}

function compareCodexMessages(left: ProviderChatMessageItem, right: ProviderChatMessageItem): number {
  const leftTime = Date.parse(left.createdAt ?? "")
  const rightTime = Date.parse(right.createdAt ?? "")
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1
  }
  return 0
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function readCodexSessionRecordMessage(
  record: JsonObject | undefined,
  payload: JsonObject | undefined,
  pendingCallIds = new Set<string>(),
  outputByCallId = new Map<string, CodexSessionFunctionOutput>(),
): ProviderChatMessageItem | null {
  const recordType = readString(record?.type)
  const payloadType = readString(payload?.type)
  const createdAt = readIsoString(record?.timestamp) ?? null
  if (recordType === "compacted") {
    return readCodexSessionCompactionMessage(payload, createdAt)
  }

  if (recordType === "response_item" && payloadType === "message") {
    const role = codexMessageRole(payload?.role)
    const content = readCodexMessageText(payload?.content)
    if (!role || !content || (role === "USER" && isCodexInjectedContextMessage(content))) {
      return null
    }
    return {
      role,
      content,
      itemId: readString(payload?.id) ?? null,
      createdAt,
    }
  }

  if (recordType === "response_item" && payloadType === "reasoning") {
    return readCodexSessionReasoningMessage(payload, createdAt)
  }

  if (recordType === "response_item" && payloadType && isCodexPlanItemType(payloadType)) {
    return codexPlanItemMessage(payload ?? {}, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "user_message") {
    const content = readString(payload?.message)
    if (!content || isCodexInjectedContextMessage(content)) {
      return null
    }
    return {
      role: "USER",
      content,
      itemId: readString(payload?.client_id) ?? null,
      createdAt,
    }
  }

  if (recordType === "event_msg" && payloadType === "agent_message") {
    const content = readString(payload?.message)
    if (!content) {
      return null
    }
    return {
      role: "ASSISTANT",
      content,
      itemId: null,
      createdAt,
    }
  }

  if (recordType === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
    if (payloadType === "custom_tool_call" && readString(payload?.name) === "apply_patch") {
      return null
    }
    return readCodexSessionFunctionCallMessage(payload, createdAt, pendingCallIds, outputByCallId)
  }

  if (recordType === "response_item" && payloadType === "web_search_call") {
    return readCodexSessionWebSearchMessage(payload, createdAt)
  }

  if (recordType === "response_item" && payloadType === "image_generation_call") {
    return readCodexSessionImageGenerationMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "patch_apply_end") {
    return readCodexSessionPatchMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "web_search_end") {
    return readCodexSessionWebSearchMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "image_generation_end") {
    return readCodexSessionImageGenerationMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "mcp_tool_call_end") {
    return readCodexSessionMcpToolMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "context_compacted") {
    return readCodexSessionCompactionMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "item_completed") {
    return readCodexSessionCompletedItemMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && payloadType === "error") {
    return readCodexSessionErrorMessage(payload, createdAt)
  }

  if (recordType === "event_msg" && (payloadType === "turn_aborted" || payloadType === "thread_rolled_back")) {
    return readCodexSessionThreadWarningMessage(payload, createdAt)
  }

  if (recordType === "response_item") {
    return readCodexSessionFallbackToolMessage(payload, createdAt)
  }

  return null
}

function readCodexSessionReasoningMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const content = formatCodexReasoning(payload ?? {})
  if (!content) {
    return null
  }
  return {
    role: "ASSISTANT",
    kind: "THINKING",
    content,
    itemId: readString(payload?.id) ?? null,
    createdAt,
  }
}

function readCodexSessionFunctionCallMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
  pendingCallIds = new Set<string>(),
  outputByCallId = new Map<string, CodexSessionFunctionOutput>(),
): ProviderChatMessageItem | null {
  const name = readString(payload?.name)
  const callId = readCodexSessionCallId(payload)
  const argumentsObject = readCodexSessionToolArguments(payload?.arguments)
  const toolOutput = callId ? outputByCallId.get(callId) : undefined
  const status = callId && pendingCallIds.has(callId) ? "inProgress" : "completed"
  if (name === "exec_command") {
    const command = readString(argumentsObject?.cmd) ?? readString(argumentsObject?.command) ?? "command"
    const item: JsonObject = {
      type: "commandExecution",
      id: callId ?? `command:${createdAt ?? command}`,
      command,
      cwd: readString(argumentsObject?.workdir) ?? readString(argumentsObject?.cwd) ?? "",
      processId: null,
      source: "agent",
      status,
      commandActions: inferCodexSessionCommandActions(command),
      aggregatedOutput: toolOutput?.output ?? null,
      exitCode: toolOutput?.exitCode ?? null,
      durationMs: toolOutput?.durationMs ?? null,
    }
    return codexActionMessage(item, "COMMAND_EXECUTION", formatCodexCommandExecution(item), createdAt)
  }

  if (name === "update_plan") {
    return codexPlanUpdateMessage({
      createdAt,
      explanation: readString(argumentsObject?.explanation) ?? null,
      itemId: callId ?? `plan-update:${createdAt ?? name}`,
      status: status === "inProgress" ? "STREAMING" : "COMPLETED",
      steps: readCodexPlanSteps(argumentsObject?.plan),
    })
  }

  if (name && isCodexRequestUserInputName(name)) {
    const payload = argumentsObject ?? {}
    return codexUserInputPromptMessage({
      createdAt,
      itemId: callId ?? `tool:${createdAt ?? name}`,
      payload,
      requestId: null,
      status: "completed",
    })
  }

  if (!name) {
    return null
  }
  const item: JsonObject = {
    type: "dynamicToolCall",
    id: callId ?? `tool:${createdAt ?? name}`,
    namespace: null,
    tool: name,
    arguments: argumentsObject ?? {},
    status,
    contentItems: toolOutput?.output ? [{ type: "inputText", text: toolOutput.output }] : null,
    success: toolOutput?.exitCode === null || toolOutput?.exitCode === undefined ? null : toolOutput.exitCode === 0,
    durationMs: toolOutput?.durationMs ?? null,
  }
  return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexDynamicToolCall(item), createdAt)
}

function readCodexSessionPatchMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const changes = asJsonObject(payload?.changes)
  if (!changes) {
    return null
  }
  const itemChanges = Object.entries(changes)
    .map(([path, changeValue]) => {
      const change = asJsonObject(changeValue)
      return {
        path,
        kind: readString(change?.type) ?? "update",
        diff: readString(change?.unified_diff) ?? "",
      }
    })
    .filter((change) => change.path)
  if (!itemChanges.length) {
    return null
  }
  const item: JsonObject = {
    type: "fileChange",
    id: readString(payload?.call_id) ?? `patch:${createdAt ?? itemChanges[0]?.path ?? "unknown"}`,
    changes: itemChanges,
    status: readString(payload?.status) ?? (payload?.success === false ? "failed" : "completed"),
  }
  return codexActionMessage(item, "FILE_CHANGE", formatCodexFileChange(item), createdAt)
}

function readCodexSessionWebSearchMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const item: JsonObject = {
    type: "webSearch",
    id: readString(payload?.call_id) ?? readString(payload?.id) ?? `web-search:${createdAt ?? "unknown"}`,
    query: readString(payload?.query) ?? null,
    action: payload?.action ?? null,
    status: readString(payload?.status) ?? "completed",
  }
  return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexWebSearch(item), createdAt)
}

function readCodexSessionImageGenerationMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const item: JsonObject = {
    type: "imageGeneration",
    id: readString(payload?.call_id) ?? readString(payload?.id) ?? `image-generation:${createdAt ?? "unknown"}`,
    revisedPrompt: readString(payload?.revised_prompt) ?? readString(payload?.revisedPrompt) ?? null,
    savedPath: readString(payload?.saved_path) ?? readString(payload?.savedPath) ?? null,
    status: readString(payload?.status) ?? "completed",
  }
  return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexSimpleToolItem(item), createdAt)
}

function readCodexSessionMcpToolMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const invocation = asJsonObject(payload?.invocation)
  const item: JsonObject = {
    type: "mcpToolCall",
    id: readString(payload?.call_id) ?? `mcp:${createdAt ?? "unknown"}`,
    server: readString(invocation?.server) ?? null,
    tool: readString(invocation?.tool) ?? null,
    arguments: invocation?.arguments ?? null,
    result: payload?.result ?? null,
    status: readString(payload?.status) ?? "completed",
  }
  return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexMcpToolCall(item), createdAt)
}

function readCodexSessionCompactionMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const item: JsonObject = {
    type: "contextCompaction",
    id: readString(payload?.call_id) ?? readString(payload?.id) ?? `compaction:${createdAt ?? "unknown"}`,
    status: readString(payload?.status) ?? "completed",
  }
  return codexActionMessage(item, "COMPACTION", formatCodexSimpleToolItem(item), createdAt)
}

function readCodexSessionCompletedItemMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const item = asJsonObject(payload?.item)
  const type = readString(item?.type)
  if (!isCodexPlanItemType(type)) {
    return null
  }
  return codexPlanItemMessage(item ?? {}, createdAt, readString(payload?.call_id) ?? null)
}

function isCodexPlanItemType(type: string | null | undefined): boolean {
  const normalized = (type ?? "").toLowerCase().replace(/[-_\s]+/gu, "")
  return normalized === "plan" || normalized === "proposedplan"
}

function codexPlanItemMessage(
  item: JsonObject,
  createdAt: string | null,
  fallbackItemId: string | null = null,
): ProviderChatMessageItem | null {
  const steps = readCodexPlanItemSteps(item)
  const explanation = readCodexPlanItemText(item)
  const itemId = readString(item.id) ?? fallbackItemId

  if (steps.length) {
    return codexPlanUpdateMessage({
      createdAt,
      explanation,
      itemId,
      status: "COMPLETED",
      steps,
    })
  }

  const content = explanation ?? formatCodexFallbackToolItem(item)
  if (!content) {
    return null
  }

  return {
    role: "ASSISTANT",
    kind: "PLAN",
    content,
    itemId,
    createdAt,
  }
}

function readCodexPlanItemText(item: JsonObject): string | null {
  return (
    readString(item.text) ??
    readString(item.message) ??
    readString(item.summary) ??
    readCodexMessageText(item.content) ??
    readString(item.plan) ??
    null
  )
}

function readCodexPlanItemSteps(item: JsonObject): CodexPlanStep[] {
  const directSteps = readCodexPlanSteps(item.plan)
  if (directSteps.length) {
    return directSteps
  }
  const steps = readCodexPlanSteps(item.steps)
  if (steps.length) {
    return steps
  }
  const plan = asJsonObject(item.plan)
  return plan ? readCodexPlanSteps(plan.steps ?? plan.plan) : []
}

function readCodexSessionErrorMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const content = readString(payload?.message) ?? "Codex error"
  return {
    role: "TOOL",
    kind: "ERROR",
    status: "FAILED",
    content,
    itemId: readString(payload?.call_id) ?? readString(payload?.id) ?? `error:${createdAt ?? content}`,
    createdAt,
    metadata: {
      codexErrorInfo: readString(payload?.codex_error_info) ?? null,
    },
  }
}

function readCodexSessionThreadWarningMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const type = readString(payload?.type)
  const label = type === "turn_aborted" ? "Turn aborted" : "Thread rolled back"
  const count = readNumber(payload?.num_turns)
  return {
    role: "TOOL",
    kind: "WARNING",
    content: count === undefined ? label : `${label}\n\nturns: \`${count}\``,
    itemId: readString(payload?.turn_id) ?? readString(payload?.turnId) ?? `warning:${createdAt ?? label}`,
    createdAt,
  }
}

function readCodexSessionFallbackToolMessage(
  payload: JsonObject | undefined,
  createdAt: string | null,
): ProviderChatMessageItem | null {
  const type = readString(payload?.type)
  if (!payload || !type || !isCodexSessionVisibleFallbackItem(type)) {
    return null
  }
  const callId = readString(payload.call_id) ?? readString(payload.id)
  const item: JsonObject = {
    ...payload,
    id: callId ?? `tool:${createdAt ?? type}`,
    status: readString(payload.status) ?? "completed",
  }
  return codexActionMessage(item, "TOOL_ACTIVITY", formatCodexFallbackToolItem(item), createdAt)
}

function isCodexSessionVisibleFallbackItem(type: string): boolean {
  return type !== "reasoning" &&
    type !== "function_call_output" &&
    type !== "custom_tool_call" &&
    type !== "custom_tool_call_output"
}

function readCodexSessionToolArguments(value: unknown): JsonObject | null {
  if (typeof value !== "string") {
    return asJsonObject(value) ?? null
  }
  return asJsonObject(parseJsonLine(value)) ?? null
}

function readCodexSessionCallId(payload: JsonObject | undefined): string | null {
  return readString(payload?.call_id) ?? readString(payload?.callId) ?? readString(payload?.id) ?? null
}

function isCodexSessionRunningToolOutput(payload: JsonObject | undefined): boolean {
  const output = readString(payload?.output)
  return Boolean(output?.match(/\bProcess running with session ID \d+\b/u))
}

function readCodexSessionRecordTurnId(
  record: JsonObject | undefined,
  payload: JsonObject | undefined,
): string | null {
  const metadata = asJsonObject(payload?.internal_chat_message_metadata_passthrough)
  return (
    readString(metadata?.turn_id) ??
    readString(metadata?.turnId) ??
    readString(payload?.turn_id) ??
    readString(payload?.turnId) ??
    readString(record?.turn_id) ??
    readString(record?.turnId) ??
    null
  )
}

function inferCodexSessionCommandActions(command: string): JsonObject[] {
  const trimmed = command.trim()
  if (!trimmed) {
    return []
  }
  const executable = trimmed.match(/^([A-Za-z0-9_.-]+)/u)?.[1] ?? ""
  if (executable === "rg" || executable === "grep") {
    return [{ type: "search", command: trimmed, query: readShellSearchQuery(trimmed), path: readShellPath(trimmed) }]
  }
  if (executable === "find") {
    return [{ type: "search", command: trimmed, path: readShellPath(trimmed) }]
  }
  if (executable === "ls") {
    return [{ type: "listFiles", command: trimmed, path: readShellPath(trimmed) }]
  }
  if (["cat", "head", "tail", "sed", "nl", "wc"].includes(executable)) {
    return [{ type: "read", command: trimmed, path: readShellPath(trimmed) }]
  }
  return [{ type: "unknown", command: trimmed }]
}

function readShellSearchQuery(command: string): string | null {
  return readShellArguments(command).find((token) => !token.startsWith("-")) ?? null
}

function readShellPath(command: string): string | null {
  return readShellArguments(command).filter((token) => !token.startsWith("-")).at(-1) ?? null
}

function readShellArguments(command: string): string[] {
  const firstCommand = command.split(/\s+(?:\||&&|\|\||;)\s+/u)[0] ?? command
  const tokens = firstCommand.match(/"[^"]+"|'[^']+'|[^\s]+/gu) ?? []
  return tokens.slice(1).map((token) => token.replace(/^['"]|['"]$/gu, "")).filter(Boolean)
}

function readCodexMessageText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null
  }
  if (!Array.isArray(value)) {
    return null
  }
  const text = value
    .map((item) => {
      const object = asJsonObject(item)
      return readString(object?.text) ?? readString(object?.content) ?? ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
  return text || null
}

function isCodexInjectedContextMessage(content: string): boolean {
  const trimmed = content.trimStart()
  return (
    content.includes("<environment_context>") ||
    content.includes("# AGENTS.md instructions") ||
    trimmed.startsWith("<turn_aborted>") ||
    trimmed.startsWith("<user_action>")
  )
}

function codexMessageRole(value: unknown): MessageRole | null {
  if (value === "user") {
    return "USER"
  }
  if (value === "assistant") {
    return "ASSISTANT"
  }
  return null
}

function parseJsonLine(line: string): unknown {
  if (!line.trim()) {
    return null
  }
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

function readIsoString(value: unknown): string | null {
  const raw = readString(value)
  if (!raw) {
    return null
  }
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function newestCodexTimestamp(candidate: string | null, current: string | null): string | null {
  if (!candidate) {
    return current
  }
  if (!current) {
    return candidate
  }
  const candidateTime = Date.parse(candidate)
  const currentTime = Date.parse(current)
  if (!Number.isFinite(candidateTime)) {
    return current
  }
  if (!Number.isFinite(currentTime)) {
    return candidate
  }
  return candidateTime > currentTime ? candidate : current
}

async function copyCodexHistory(source: string, target: string): Promise<boolean> {
  try {
    if (sameFilesystemPath(source, target)) {
      return true
    }
    const sourceStats = await stat(source).catch(() => null)
    if (!sourceStats?.isDirectory()) {
      return false
    }
    await mkdir(target, { recursive: true, mode: 0o700 })
    await copyIfExists(join(source, "session_index.jsonl"), join(target, "session_index.jsonl"))
    await copyDirectoryIfExists(join(source, "sessions"), join(target, "sessions"))
    await copyCodexStateFiles(source, target)
    return true
  } catch {
    return false
  }
}

type CopyCodexThreadOptions = {
  preserveExistingTarget?: boolean
}

async function copyCodexThread(
  source: string,
  target: string,
  threadId: string,
  options: CopyCodexThreadOptions = {},
): Promise<boolean> {
  try {
    if (sameFilesystemPath(source, target)) {
      return true
    }
    const sourceStats = await stat(source).catch(() => null)
    if (!sourceStats?.isDirectory()) {
      return false
    }
    await mkdir(target, { recursive: true, mode: 0o700 })
    const copiedIndex = await copyCodexThreadIndex(source, target, threadId, options)
    const copiedSession = await copyCodexThreadSessionFiles(source, target, threadId, options)
    await copyCodexStateFiles(source, target)
    return copiedIndex || copiedSession
  } catch {
    return false
  }
}

async function copyCodexThreadIndex(
  source: string,
  target: string,
  threadId: string,
  options: CopyCodexThreadOptions = {},
): Promise<boolean> {
  const sourceIndex = join(source, "session_index.jsonl")
  const sourceLines = (await readFile(sourceIndex, "utf8").catch(() => ""))
    .split(/\r?\n/u)
    .filter((line) => codexIndexLineThreadId(line) === threadId)
    .slice(-1)
  if (!sourceLines.length) {
    return false
  }

  const targetIndex = join(target, "session_index.jsonl")
  const currentTargetLines = (await readFile(targetIndex, "utf8").catch(() => ""))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
  if (options.preserveExistingTarget && currentTargetLines.some((line) => codexIndexLineThreadId(line) === threadId)) {
    return true
  }
  const targetLines = currentTargetLines
    .filter((line) => line.trim() && codexIndexLineThreadId(line) !== threadId)
  await writeFile(targetIndex, `${[...targetLines, ...sourceLines].join("\n")}\n`)
  return true
}

async function copyCodexThreadSessionFiles(
  source: string,
  target: string,
  threadId: string,
  options: CopyCodexThreadOptions = {},
): Promise<boolean> {
  const sessionFiles = (await listCodexSessionFiles(source)).filter((file) => codexSessionIdFromPath(file) === threadId)
  let copied = false
  for (const sourceFile of sessionFiles) {
    const targetFile = join(target, relative(source, sourceFile))
    const targetStats = options.preserveExistingTarget ? await stat(targetFile).catch(() => null) : null
    if (targetStats?.isFile()) {
      copied = true
      continue
    }
    await mkdir(dirname(targetFile), { recursive: true, mode: 0o700 })
    await copyFile(sourceFile, targetFile)
    copied = true
  }
  return copied
}

async function removeCodexThread(codexHome: string, threadId: string): Promise<boolean> {
  try {
    await removeCodexThreadIndex(codexHome, threadId)
    const sessionFiles = (await listCodexSessionFiles(codexHome)).filter((file) => codexSessionIdFromPath(file) === threadId)
    for (const sessionFile of sessionFiles) {
      await rm(sessionFile, { force: true })
    }
    return true
  } catch {
    return false
  }
}

async function removeCodexThreadIndex(codexHome: string, threadId: string): Promise<void> {
  const indexPath = join(codexHome, "session_index.jsonl")
  const currentLines = (await readFile(indexPath, "utf8").catch(() => ""))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
  const nextLines = currentLines.filter((line) => codexIndexLineThreadId(line) !== threadId)
  if (nextLines.length !== currentLines.length) {
    await writeFile(indexPath, nextLines.length ? `${nextLines.join("\n")}\n` : "")
  }
}

function codexIndexLineThreadId(line: string): string | null {
  const row = asJsonObject(parseJsonLine(line))
  return readString(row?.threadId) ?? readString(row?.thread_id) ?? readString(row?.id) ?? null
}

async function copyCodexStateFiles(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source).catch(() => [])) {
    if (/^state_\d+\.sqlite(?:-(?:wal|shm))?$/u.test(entry)) {
      await copyIfExists(join(source, entry), join(target, entry))
    }
  }
}

async function copyIfExists(source: string, target: string): Promise<void> {
  if (sameFilesystemPath(source, target)) {
    return
  }
  const sourceStats = await stat(source).catch(() => null)
  if (!sourceStats?.isFile()) {
    return
  }
  await mkdir(join(target, ".."), { recursive: true, mode: 0o700 })
  await copyFile(source, target)
}

async function copyDirectoryIfExists(source: string, target: string): Promise<void> {
  if (sameFilesystemPath(source, target)) {
    return
  }
  const sourceStats = await stat(source).catch(() => null)
  if (!sourceStats?.isDirectory()) {
    return
  }
  await rm(target, { force: true, recursive: true })
  await cp(source, target, { force: true, recursive: true })
}

function hasAccountAuthFile(account: ProviderAccount): boolean {
  return Boolean(statSyncSafe(join(resolveAccountCodexHome(account), "auth.json"))?.isFile())
}

function readAuthEmailAlias(account: ProviderAccount): string | null {
  const auth = readAuthJson(account)
  const token = readString(asJsonObject(auth?.tokens)?.id_token)
  if (!token) {
    return null
  }

  const payload = decodeJwtPayload(token)
  const email = readString(payload?.email)
  const alias = email?.split("@")[0]?.trim()
  return alias || null
}

function readAuthJson(account: ProviderAccount): JsonObject | null {
  try {
    return asJsonObject(JSON.parse(require("node:fs").readFileSync(join(resolveAccountCodexHome(account), "auth.json"), "utf8"))) ?? null
  } catch {
    return null
  }
}

function usesSharedCodexHome(account: ProviderAccount): boolean {
  const authState = normalizeJsonObject(account.authState)
  return readString(authState.codexHomeMode) === "shared"
}

function decodeJwtPayload(token: string): JsonObject | null {
  const [, payload] = token.split(".")
  if (!payload) {
    return null
  }

  try {
    return asJsonObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))) ?? null
  } catch {
    return null
  }
}

function statSyncSafe(pathname: string) {
  try {
    return require("node:fs").statSync(pathname) as import("node:fs").Stats
  } catch {
    return null
  }
}

function readLoginAuthUrl(result: JsonObject | undefined, mode: AccountAuthMode): string | null {
  if (!result) {
    return null
  }
  if (mode === "device") {
    return (
      readString(result.verificationUrl) ??
      readString(result.verification_uri) ??
      readString(result.verification_uri_complete) ??
      readString(result.authUrl) ??
      null
    )
  }
  return readString(result.authUrl) ?? readString(result.url) ?? null
}

function parseLoopbackCallbackUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Callback URL must be HTTP or HTTPS.")
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("Callback URL must point at localhost.")
  }
  return url.toString()
}

function readAuthMode(value: string | null): AccountAuthMode | null {
  return value === "browser" || value === "device" || value === "local" ? value : null
}

function sameFilesystemPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

function connectedAuthResponse(
  accountId: string,
  message: string,
  authState?: JsonObject,
): AuthenticateProviderAccountResponse {
  return {
    accountId,
    status: "CONNECTED",
    authMode: null,
    ...(authState === undefined ? {} : { authState }),
    authUrl: null,
    verificationUrl: null,
    userCode: null,
    message,
  }
}

function localCodexAuthState(): JsonObject {
  return {
    codexHome: resolveSharedCodexHome(),
    codexHomeMode: "shared",
  }
}

function normalizeModelList(value: unknown): ProviderModelListResponse {
  const result = asJsonObject(value)
  const rows = Array.isArray(result?.data) ? result.data : []
  const models = rows.map((row) => {
    const object = asJsonObject(row) ?? {}
    const id = readString(object.id) ?? readString(object.model) ?? "unknown"
    const upgrade = readString(object.upgrade)
    return {
      id,
      model: readString(object.model) ?? id,
      displayName: readString(object.displayName) ?? readString(object.display_name) ?? id,
      hidden: Boolean(object.hidden),
      defaultReasoningEffort: readString(object.defaultReasoningEffort) ?? readString(object.default_reasoning_effort) ?? null,
      defaultServiceTier: readString(object.defaultServiceTier) ?? readString(object.default_service_tier) ?? null,
      inputModalities: readStringList(object.inputModalities) ?? readStringList(object.input_modalities) ?? [],
      isDefault: readBooleanValue(object.isDefault) ?? readBooleanValue(object.is_default) ?? false,
      serviceTiers: readModelServiceTiers(object.serviceTiers) ?? readModelServiceTiers(object.service_tiers) ?? [],
      supportsPersonality: readBooleanValue(object.supportsPersonality) ?? readBooleanValue(object.supports_personality) ?? false,
      supportedReasoningEfforts: readSupportedReasoningEfforts(object.supportedReasoningEfforts)
        ?? readSupportedReasoningEfforts(object.supported_reasoning_efforts)
        ?? [],
      upgradeInfo: readModelUpgradeInfo(object.upgradeInfo) ?? readModelUpgradeInfo(object.upgrade_info) ?? (upgrade ? { upgrade } : null),
    }
  })
  return {
    data: mergeCodexModelOptions(models),
    nextCursor: readString(result?.nextCursor) ?? readString(result?.next_cursor) ?? null,
  }
}

function readSupportedReasoningEfforts(value: unknown): ProviderModelListResponse["data"][number]["supportedReasoningEfforts"] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const efforts = value
    .map((entry) => {
      if (typeof entry === "string") {
        return { reasoningEffort: entry }
      }
      const object = asJsonObject(entry)
      const reasoningEffort = readString(object?.reasoningEffort) ?? readString(object?.reasoning_effort)
      return reasoningEffort
        ? { reasoningEffort, description: readString(object?.description) }
        : null
    })
    .filter((entry): entry is { description?: string; reasoningEffort: string } => Boolean(entry))
  return efforts.length ? efforts : null
}

function readModelServiceTiers(value: unknown): ProviderModelListResponse["data"][number]["serviceTiers"] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const tiers = value
    .map((entry) => {
      const object = asJsonObject(entry)
      const id = readString(object?.id)
      if (!id) {
        return null
      }
      return {
        id,
        name: readString(object?.name) ?? id,
        description: readString(object?.description) ?? "",
      }
    })
    .filter((entry): entry is { description: string; id: string; name: string } => Boolean(entry))
  return tiers.length ? tiers : null
}

function readModelUpgradeInfo(value: unknown): JsonSerializable | null {
  if (value === undefined || value === null) {
    return null
  }
  const object = asJsonObject(value)
  return object ? jsonFromUnknown(object) : null
}

function mergeCodexModelOptions(options: ProviderModelListResponse["data"]): ProviderModelListResponse["data"] {
  const merged = new Map<string, ProviderModelListResponse["data"][number]>()
  for (const option of [...codexDefaultModelOptions, ...options]) {
    const key = (option.model || option.id).trim().toLowerCase()
    const existing = merged.get(key)
    merged.set(key, existing ? mergeCodexModelOption(existing, option) : option)
  }
  return [...merged.values()]
}

function mergeCodexModelOption(
  fallback: ProviderModelListResponse["data"][number],
  option: ProviderModelListResponse["data"][number],
): ProviderModelListResponse["data"][number] {
  return {
    ...fallback,
    ...option,
    defaultReasoningEffort: option.defaultReasoningEffort ?? fallback.defaultReasoningEffort,
    supportedReasoningEfforts: option.supportedReasoningEfforts?.length
      ? option.supportedReasoningEfforts
      : fallback.supportedReasoningEfforts,
  }
}

function normalizeLimits(value: unknown): ProviderLimitsResponse {
  const result = asJsonObject(value)
  const snapshot = asJsonObject(result?.rateLimits) ?? asJsonObject(result?.rate_limits) ?? asJsonObject(result)
  return {
    rateLimits: snapshot
      ? {
          limitId: readString(snapshot.limitId) ?? readString(snapshot.limit_id) ?? null,
          limitName: readString(snapshot.limitName) ?? readString(snapshot.limit_name) ?? null,
          planType: readString(snapshot.planType) ?? readString(snapshot.plan_type) ?? null,
          primary: normalizeLimitWindow(snapshot.primary),
          secondary: normalizeLimitWindow(snapshot.secondary),
          rateLimitReachedType: readString(snapshot.rateLimitReachedType) ?? readString(snapshot.rate_limit_reached_type) ?? null,
        }
      : undefined,
    raw: jsonFromUnknown(value),
  }
}

function normalizeLimitWindow(value: unknown) {
  const object = asJsonObject(value)
  if (!object) {
    return undefined
  }
  return {
    usedPercent: readNumberLike(object.usedPercent) ?? readNumberLike(object.used_percent) ?? 0,
    windowDurationMins: readNumberLike(object.windowDurationMins) ?? readNumberLike(object.window_duration_mins) ?? null,
    resetsAt: readNumberLike(object.resetsAt) ?? readNumberLike(object.resets_at) ?? null,
  }
}

function readNumberLike(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

async function ensureCodexThread(
  runtime: Pick<CodexRuntime, "request">,
  threadId: string | null,
  workingDirectory: string | null,
  collaborationMode: string,
): Promise<string> {
  const response = await runtime.request(
    threadId ? "thread/resume" : "thread/start",
    {
      ...(threadId ? { threadId } : {}),
      cwd: workingDirectory,
      collaborationMode: collaborationModePayload(collaborationMode, null),
    },
    30_000,
  )
  const result = asJsonObject(response.result)
  const thread = asJsonObject(result?.thread)
  const nextThreadId = readString(thread?.id) ?? readString(result?.threadId) ?? readString(result?.thread_id) ?? threadId
  if (!nextThreadId) {
    throw new Error("Codex did not return a thread id.")
  }
  return nextThreadId
}

async function prepareCodexThreadForLifecycleAction(
  account: ProviderAccount,
  externalThreadId: string,
  workingDirectory?: string | null,
): Promise<Pick<CodexRuntime, "request">> {
  const runtime = runtimeForAccount(account, workingDirectory)
  try {
    const hydrated = await hydrateKnownCodexThreadToAccount(externalThreadId, account)
    if (!hydrated) {
      throw new Error(codexThreadNotFoundMessage(externalThreadId))
    }
    await ensureCodexThread(runtime, externalThreadId, workingDirectory ?? null, "default")
    return runtime
  } catch (error) {
    if (isCodexThreadNotFoundError(error)) {
      throw new Error(codexThreadNotFoundMessage(externalThreadId))
    }
    throw error
  }
}

async function setCodexThreadGoal(
  runtime: Pick<CodexRuntime, "request">,
  threadId: string,
  objective: string,
): Promise<void> {
  await runtime.request(
    "thread/goal/set",
    {
      threadId,
      objective: objective.trim(),
      status: "active",
    },
    30_000,
  )
}

async function requestCodexRuntime(
  runtime: Pick<CodexRuntime, "request">,
  method: string,
  params?: JsonObject,
  timeoutMs = 30_000,
): Promise<CodexJsonRpcResponse> {
  try {
    return await runtime.request(method, params, timeoutMs)
  } catch (error) {
    if (isUnsupportedCodexMethodError(error)) {
      throw new Error(`Codex method ${method} is not supported by this Codex binary.`)
    }
    throw error
  }
}

async function requestCodexOptional(
  runtime: Pick<CodexRuntime, "request">,
  method: string,
  params?: JsonObject,
  timeoutMs = 30_000,
): Promise<boolean> {
  try {
    await runtime.request(method, params, timeoutMs)
    return true
  } catch (error) {
    if (isUnsupportedCodexMethodError(error)) {
      return false
    }
    throw error
  }
}

function isUnsupportedCodexMethodError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase()
  return (
    message.includes("method not found") ||
    message.includes("unknown method") ||
    message.includes("unsupported method") ||
    message.includes("-32601")
  )
}

function isCodexRequestUserInputMethod(method: string): boolean {
  const normalized = normalizedCodexName(method)
  return normalized === "itemtoolrequestuserinput" || normalized.endsWith("requestuserinput")
}

function isCodexRequestUserInputName(name: string): boolean {
  return normalizedCodexName(name) === "requestuserinput"
}

function normalizedCodexName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "")
}

function codexUserInputPromptStatus(value: string | null | undefined): NonNullable<ProviderChatMessageItem["status"]> {
  if (value === "completed") {
    return "COMPLETED"
  }
  if (value === "failed" || value === "declined") {
    return "FAILED"
  }
  return "PENDING"
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase()
  return message.includes("thread not found") || (message.includes("thread") && message.includes("not found"))
}

function codexThreadNotFoundMessage(threadId: string): string {
  return `Codex could not find thread ${threadId} in the selected account home. The local chat points at a Codex thread that is missing from that account's history; switch back to the account that owns it or refresh/sync the chat history, then try again.`
}

function codexReviewTargetPayload(request: Parameters<NonNullable<ProviderAdapter["reviewThread"]>>[2]): JsonObject {
  const target = request?.target
  const instructions = request?.instructions?.trim()
  if (target === "custom" || instructions) {
    return { type: "custom", instructions: instructions || "Review the current changes." }
  }
  const commitSha = request?.commitSha?.trim()
  if (target === "commit" || commitSha) {
    return {
      type: "commit",
      sha: commitSha || "HEAD",
      title: request?.commitTitle?.trim() || null,
    }
  }
  const branch = request?.baseBranch?.trim()
  if (target === "baseBranch" || branch) {
    return { type: "baseBranch", branch: branch || "main" }
  }
  return { type: "uncommittedChanges" }
}

function codexAccessMode(permissionMode: string): { approvalPolicy: string | null; sandboxPolicy: JsonObject | null } {
  if (permissionMode === "fullAccess") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    }
  }
  if (permissionMode === "askForApproval") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: null,
    }
  }
  return {
    approvalPolicy: null,
    sandboxPolicy: null,
  }
}

function codexInputItems(
  content: string,
  attachments: NonNullable<ProviderRuntimeMessageInput["attachments"]>,
): JsonObject[] {
  const attachmentText = codexAttachmentSummaryText(attachments)
  const text = [content.trim(), attachmentText].filter(Boolean).join("\n\n") || "Attached context"
  const items: JsonObject[] = [{ type: "text", text, text_elements: [] }]

  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      continue
    }
    if (attachment.dataUrl) {
      items.push({ type: "image", url: attachment.dataUrl })
    } else if (attachment.path) {
      items.push({ type: "localImage", path: attachment.path })
    }
  }

  return items
}

function codexAttachmentSummaryText(
  attachments: NonNullable<ProviderRuntimeMessageInput["attachments"]>,
): string | null {
  const lines = attachments
    .filter((attachment) => attachment.kind !== "image" || !attachment.dataUrl)
    .map((attachment) => {
      const path = attachment.path && attachment.path !== attachment.name ? ` (${attachment.path})` : ""
      return `- ${attachment.kind}: ${attachment.name}${path}`
    })

  return lines.length ? `Attached context:\n${lines.join("\n")}` : null
}

async function resolveCollaborationSettings(
  runtime: Pick<CodexRuntime, "request">,
  model: string | null,
  reasoningEffort: string | null,
  serviceTier: string | null,
): Promise<{ model?: string | null; reasoningEffort?: string | null; serviceTier?: string | null } | null> {
  const normalizedReasoningEffort = normalizeCodexReasoningEffort(reasoningEffort)
  if (model) {
    return { model, reasoningEffort: normalizedReasoningEffort, serviceTier }
  }
  try {
    const response = await runtime.request("config/read", {}, 30_000)
    const config = asJsonObject(asJsonObject(response.result)?.config)
    const configuredModel = readString(config?.model)
    if (configuredModel) {
      return { model: configuredModel, reasoningEffort: normalizedReasoningEffort, serviceTier }
    }
  } catch {
    return null
  }
  return null
}

function collaborationModePayload(
  collaborationMode: string,
  settings: { model?: string | null; reasoningEffort?: string | null; serviceTier?: string | null } | null,
): JsonObject {
  const reasoningEffort = normalizeCodexReasoningEffort(settings?.reasoningEffort)
  return {
    mode: collaborationMode || "default",
    ...(settings?.model
      ? {
          settings: {
            model: settings.model,
            reasoning_effort: reasoningEffort,
            service_tier: settings.serviceTier ?? null,
          },
        }
      : {}),
  }
}

function normalizeCodexReasoningEffort(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) {
    return null
  }
  if (normalized === "extraHigh" || normalized === "extra-high" || normalized === "extra_high") {
    return "xhigh"
  }
  if (normalized === "fast") {
    return "low"
  }
  if (normalized === "deep") {
    return "high"
  }
  return normalized
}

async function maybeMarkInvalidated(accountId: string, error: unknown): Promise<void> {
  if (!isAuthInvalidatedError(error)) {
    return
  }
  invalidatedAccountIds.add(accountId)
  runtimeService.stopRuntime(accountId)
}

export function stopAllCodexRuntimes(): void {
  runtimeService.stopAllRuntimes()
}

function isAuthInvalidatedError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase()
  return (
    message.includes("token_invalidated") ||
    message.includes("authentication token has been invalidated") ||
    (message.includes("401") && message.includes("unauthorized") && message.includes("invalidated"))
  )
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined
}

function readStringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null
}

function readBooleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function readStringRecord(value: unknown): Record<string, string> {
  const object = asJsonObject(value)
  if (!object) {
    return {}
  }
  return Object.fromEntries(Object.entries(object).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function jsonFromUnknown(value: unknown): JsonSerializable {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonSerializable
}

function resolveCodexBin(): string {
  try {
    return require.resolve("@openai/codex/bin/codex.js")
  } catch {
    return "codex"
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}

type CodexRuntimeConfig = {
  accountId: string
  args: string[]
  codexHome: string
  command: string
  environment: Record<string, string>
  workingDirectory?: string | null
}

type CodexJsonRpcResponse = {
  error?: { code?: number; message?: string }
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
}

type CodexPendingRequest = {
  method: string
  reject: (error: Error) => void
  resolve: (response: CodexJsonRpcResponse) => void
  startedAt: number
  timeout: ReturnType<typeof setTimeout>
}

class CodexRuntime {
  private child?: ChildProcessWithoutNullStreams
  private initializePromise?: Promise<void>
  private stdoutBuffer = ""
  private readonly pending = new Map<string, CodexPendingRequest>()
  private readonly eventHandlers = new Set<(message: CodexJsonRpcResponse) => void>()

  constructor(private readonly config: CodexRuntimeConfig) {}

  request(method: string, params?: JsonObject, timeoutMs = 30_000): Promise<CodexJsonRpcResponse> {
    return this.ensureStarted().then(() => this.requestStarted(method, params, timeoutMs))
  }

  respondToServerRequest(requestId: string, result: JsonSerializable): Promise<void> {
    return this.ensureStarted().then(() => {
      this.child?.stdin.write(`${JSON.stringify({ id: requestId, result })}\n`)
    })
  }

  waitForEvent(
    predicate: (message: CodexJsonRpcResponse) => boolean,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<CodexJsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Codex event wait cancelled."))
        return
      }
      let unsubscribe: () => void = () => undefined
      const cleanup = () => {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", abort)
        unsubscribe()
      }
      const abort = () => {
        cleanup()
        reject(new Error("Codex event wait cancelled."))
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error("Timed out waiting for Codex event."))
      }, timeoutMs)
      signal?.addEventListener("abort", abort, { once: true })
      unsubscribe = this.onEvent((message) => {
        if (!predicate(message)) {
          return
        }
        cleanup()
        resolve(message)
      })
    })
  }

  onEvent(handler: (message: CodexJsonRpcResponse) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  shutdown(): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error("Codex runtime stopped."))
    }
    this.pending.clear()
    this.child?.kill("SIGTERM")
    this.child = undefined
    this.initializePromise = undefined
  }

  private async ensureStarted(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise
    }
    ensureCodexHome(this.config.codexHome)
    this.child = spawn(this.config.command, this.config.args, {
      cwd: this.config.workingDirectory ?? undefined,
      env: {
        ...process.env,
        ...this.config.environment,
        CODEX_HOME: this.config.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk))
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim()
      if (message && isAuthInvalidatedError(message)) {
        invalidatedAccountIds.add(this.config.accountId)
      }
    })
    this.child.on("error", (error) => this.failAll(error))
    this.child.on("close", (code) => {
      this.failAll(new Error(`Codex runtime exited with code ${code ?? "unknown"}.`))
      this.child = undefined
      this.initializePromise = undefined
    })
    this.initializePromise = this.initialize()
    return this.initializePromise
  }

  private async initialize(): Promise<void> {
    await this.requestStarted("initialize", {
      clientInfo: {
        name: "pockcode",
        title: "pockcode",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    this.child?.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
  }

  private requestStarted(method: string, params?: JsonObject, timeoutMs = 30_000): Promise<CodexJsonRpcResponse> {
    const id = `pockcode-${randomUUID()}`
    const payload = JSON.stringify(params === undefined ? { id, method } : { id, method, params })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { method, reject, resolve, startedAt: Date.now(), timeout })
      this.child?.stdin.write(`${payload}\n`)
    })
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8")
    const lines = this.stdoutBuffer.split("\n")
    this.stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) {
        this.handleLine(trimmed)
      }
    }
  }

  private handleLine(line: string): void {
    let message: CodexJsonRpcResponse
    try {
      message = JSON.parse(line) as CodexJsonRpcResponse
    } catch {
      return
    }
    if (message.id === undefined || message.id === null) {
      for (const handler of this.eventHandlers) {
        handler(message)
      }
      return
    }
    const waiter = this.pending.get(String(message.id))
    if (!waiter) {
      if (message.method) {
        for (const handler of this.eventHandlers) {
          handler(message)
        }
      }
      return
    }
    clearTimeout(waiter.timeout)
    this.pending.delete(String(message.id))
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? "Codex request failed."))
      return
    }
    waiter.resolve(message)
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

class CodexRuntimeService {
  private readonly runtimes = new Map<string, CodexRuntime>()

  getRuntime(config: CodexRuntimeConfig): CodexRuntime {
    const existing = this.runtimes.get(config.accountId)
    if (existing) {
      return existing
    }
    const runtime = new CodexRuntime(config)
    this.runtimes.set(config.accountId, runtime)
    return runtime
  }

  stopRuntime(accountId: string): void {
    this.runtimes.get(accountId)?.shutdown()
    this.runtimes.delete(accountId)
  }

  stopAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      try {
        runtime.shutdown()
      } catch {
        // Keep shutting down other runtimes.
      }
    }
    this.runtimes.clear()
  }
}

const runtimeService = new CodexRuntimeService()
