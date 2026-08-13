import type { ProviderAccount } from "@prisma/client"
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
} from "@agentclientprotocol/sdk"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { Readable, Writable } from "node:stream"
import type { JsonObject, JsonSerializable } from "../../types/json"
import type { ServerRequestResponseRequest } from "../../types/providers"
import type {
  ProviderChatMessageItem,
  ProviderRuntimeMessageInput,
  ProviderRuntimeMessageResult,
  ProviderRuntimeSteerInput,
  ProviderRuntimeSteerResult,
} from "./types.server"

const require = createRequire(import.meta.url)
const acpPromptTimeoutMs = 30 * 60 * 1000

export type CodexAcpRuntimeConfig = {
  accountId: string
  codexHome: string
  environment: Record<string, string>
  workingDirectory?: string | null
}

type PendingInteraction = {
  decline: () => void
  resolve: (response: ServerRequestResponseRequest) => void
  sessionId: string | null
}

type SessionState = {
  currentStructuredPlanId: string | null
  loaded: boolean
  messages: ProviderChatMessageItem[]
  messagesByItemId: Map<string, number>
  planSequence: number
  toolCalls: Map<string, ToolCall>
}

type LiveHandler = (message: ProviderChatMessageItem) => void

export class CodexAcpRuntime {
  private child?: ChildProcessWithoutNullStreams
  private connection?: ClientSideConnection
  private initializePromise?: Promise<void>
  private readonly liveHandlers = new Map<string, LiveHandler>()
  private readonly pendingInteractions = new Map<string, PendingInteraction>()
  private readonly sessions = new Map<string, SessionState>()
  private stderrTail = ""

  constructor(
    private readonly config: CodexAcpRuntimeConfig,
    private readonly onAuthInvalidated?: (message: string) => void,
  ) {}

  async sendMessage(input: ProviderRuntimeMessageInput): Promise<ProviderRuntimeMessageResult> {
    await this.ensureStarted()
    const sessionId = await this.ensureSession(input.threadId ?? null, input.workingDirectory)
    await input.onThreadReady?.(sessionId)
    await this.configureSession(sessionId, input)
    if (input.goalObjective?.trim()) {
      await this.connection?.extMethod("_session/goal", {
        action: "set",
        objective: input.goalObjective.trim(),
        sessionId,
      })
    }

    if (input.onMessage) {
      this.liveHandlers.set(sessionId, input.onMessage)
    }
    const localTurnId = `acp-${randomUUID()}`
    await input.onTurnStarted?.(localTurnId)
    try {
      const response = await withTimeout(
        this.requiredConnection().prompt({
          sessionId,
          prompt: codexAcpPrompt(input.content, input.attachments ?? []),
        }),
        acpPromptTimeoutMs,
        "Codex ACP prompt timed out.",
      )
      this.finalizeStreamingMessages(sessionId)
      return {
        threadId: sessionId,
        turnId: localTurnId,
        raw: toJson({ protocol: "acp", response }),
      }
    } finally {
      this.liveHandlers.delete(sessionId)
    }
  }

  async loadMessages(sessionId: string, workingDirectory: string): Promise<ProviderChatMessageItem[]> {
    await this.ensureStarted()
    await this.ensureSession(sessionId, workingDirectory)
    return this.sessions.get(sessionId)?.messages.map((message) => ({ ...message })) ?? []
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.ensureStarted()
    await this.requiredConnection().cancel({ sessionId })
  }

  async steer(input: ProviderRuntimeSteerInput): Promise<ProviderRuntimeSteerResult> {
    await this.ensureStarted()
    await this.ensureSession(input.threadId, input.workingDirectory)
    const result = await this.requiredConnection().extMethod("_session/steering", {
      sessionId: input.threadId,
      prompt: codexAcpPrompt(input.content, input.attachments ?? []),
    })
    return {
      turnId: input.turnId,
      raw: toJson(result),
    }
  }

  respondToServerRequest(requestId: string, response: ServerRequestResponseRequest): void {
    const pending = this.pendingInteractions.get(requestId)
    if (!pending) {
      throw new Error(`Codex ACP request ${requestId} is no longer pending.`)
    }
    this.pendingInteractions.delete(requestId)
    pending.resolve(response)
  }

  shutdown(): void {
    for (const pending of this.pendingInteractions.values()) {
      pending.decline()
    }
    this.pendingInteractions.clear()
    this.connection = undefined
    this.child?.kill("SIGTERM")
    this.child = undefined
    this.initializePromise = undefined
    this.sessions.clear()
  }

  private async ensureStarted(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise
    }
    this.initializePromise = this.start()
    try {
      await this.initializePromise
    } catch (error) {
      this.initializePromise = undefined
      this.shutdown()
      throw error
    }
  }

  private async start(): Promise<void> {
    const acpEntry = require.resolve("@agentclientprotocol/codex-acp")
    this.child = spawn(process.execPath, [acpEntry], {
      env: {
        ...process.env,
        ...this.config.environment,
        CODEX_HOME: this.config.codexHome,
        NO_BROWSER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8")
      this.stderrTail = `${this.stderrTail}${message}`.slice(-8_192)
      if (isAuthInvalidatedMessage(message)) {
        this.onAuthInvalidated?.(message)
      }
    })
    this.child.on("error", (error) => {
      this.stderrTail = `${this.stderrTail}\n${error.message}`.slice(-8_192)
    })
    this.child.on("close", () => {
      this.connection = undefined
      this.child = undefined
      this.initializePromise = undefined
    })

    const client: Client = {
      requestPermission: (request) => this.requestPermission(request),
      sessionUpdate: (notification) => this.handleSessionUpdate(notification),
      unstable_createElicitation: (request) => this.requestElicitation(request),
    }
    const output = Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>
    const input = Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    this.connection = new ClientSideConnection(() => client, ndJsonStream(output, input))
    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        elicitation: { form: {} },
        plan: {},
      },
      clientInfo: {
        name: "pockcode",
        title: "PockCode",
        version: "0.0.29",
      },
    })
  }

  private async ensureSession(sessionId: string | null, cwd: string): Promise<string> {
    if (sessionId && this.sessions.get(sessionId)?.loaded) {
      return sessionId
    }
    const connection = this.requiredConnection()
    if (!sessionId) {
      const response = await connection.newSession({ cwd, mcpServers: [] })
      this.sessions.set(response.sessionId, emptySessionState(true))
      return response.sessionId
    }

    const state = this.sessions.get(sessionId) ?? emptySessionState(false)
    this.sessions.set(sessionId, state)
    await connection.loadSession({ cwd, mcpServers: [], sessionId })
    state.loaded = true
    this.finalizeStreamingMessages(sessionId)
    return sessionId
  }

  private async configureSession(sessionId: string, input: ProviderRuntimeMessageInput): Promise<void> {
    const connection = this.requiredConnection()
    await connection.setSessionConfigOption({
      configId: "mode",
      sessionId,
      value: input.permissionMode === "fullAccess" ? "agent-full-access" : "agent",
    })
    if (input.model?.trim()) {
      await connection.setSessionConfigOption({ configId: "model", sessionId, value: input.model.trim() })
    }
    if (input.reasoningEffort?.trim()) {
      await connection.setSessionConfigOption({
        configId: "reasoning_effort",
        sessionId,
        value: normalizeReasoningEffort(input.reasoningEffort),
      })
    }
    await connection.setSessionConfigOption({
      configId: "collaboration_mode",
      sessionId,
      value: input.collaborationMode === "plan" ? "plan" : "default",
    })
    await connection.setSessionConfigOption({
      configId: "fast-mode",
      sessionId,
      value: input.serviceTier === "fast" ? "on" : "off",
    })
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const state = this.sessions.get(notification.sessionId) ?? emptySessionState(false)
    this.sessions.set(notification.sessionId, state)
    const message = applyAcpUpdate(state, notification.update)
    if (!message || notification.update.sessionUpdate === "user_message_chunk") {
      return
    }
    try {
      this.liveHandlers.get(notification.sessionId)?.({ ...message })
    } catch {
      // Socket updates are best-effort; ACP replay remains authoritative.
    }
  }

  private requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = `acp-permission-${randomUUID()}`
    const liveHandler = this.liveHandlers.get(request.sessionId)
    liveHandler?.({
      content: formatPermissionRequest(request),
      createdAt: new Date().toISOString(),
      itemId: `request:${requestId}`,
      kind: "APPROVAL",
      metadata: { serverRequestMethod: "acp/session/request_permission" },
      rawPayload: toJson(request),
      requestId,
      role: "TOOL",
      status: "PENDING",
    })

    return new Promise((resolve) => {
      const finish = (outcome: RequestPermissionResponse["outcome"]) => {
        liveHandler?.({
          content: "Request resolved",
          createdAt: new Date().toISOString(),
          itemId: `request:${requestId}`,
          kind: "APPROVAL",
          requestId,
          role: "TOOL",
          status: "COMPLETED",
        })
        resolve({ outcome })
      }
      this.pendingInteractions.set(requestId, {
        decline: () => finish({ outcome: "cancelled" }),
        resolve: (response) => finish(permissionOutcome(request.options, response)),
        sessionId: request.sessionId,
      })
    })
  }

  private requestElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : null
    const requestId = `acp-elicitation-${randomUUID()}`
    const liveHandler = sessionId ? this.liveHandlers.get(sessionId) : undefined
    liveHandler?.({
      content: request.message || "User input requested",
      createdAt: new Date().toISOString(),
      itemId: `request:${requestId}`,
      kind: "USER_INPUT_PROMPT",
      metadata: { serverRequestMethod: "item/tool/requestUserInput" },
      rawPayload: codexAcpElicitationPayload(request),
      requestId,
      role: "TOOL",
      status: "PENDING",
    })
    return new Promise((resolve) => {
      const finish = (response: CreateElicitationResponse) => {
        liveHandler?.({
          content: "Input received",
          createdAt: new Date().toISOString(),
          itemId: `request:${requestId}`,
          kind: "USER_INPUT_PROMPT",
          requestId,
          role: "TOOL",
          status: "COMPLETED",
        })
        resolve(response)
      }
      this.pendingInteractions.set(requestId, {
        decline: () => finish({ action: "cancel" }),
        resolve: (response) => finish(elicitationOutcome(response, request)),
        sessionId,
      })
    })
  }

  private finalizeStreamingMessages(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return
    }
    for (let index = 0; index < state.messages.length; index += 1) {
      const message = state.messages[index]
      if (!message || message.status !== "STREAMING") {
        continue
      }
      const completed = { ...message, status: "COMPLETED" as const }
      state.messages[index] = completed
      if (message.role !== "USER") {
        this.liveHandlers.get(sessionId)?.(completed)
      }
    }
  }

  private requiredConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error(`Codex ACP runtime is not connected.${this.stderrTail ? `\n${this.stderrTail}` : ""}`)
    }
    return this.connection
  }
}

class CodexAcpRuntimeService {
  private readonly runtimes = new Map<string, CodexAcpRuntime>()

  getRuntime(config: CodexAcpRuntimeConfig, onAuthInvalidated?: (message: string) => void): CodexAcpRuntime {
    const existing = this.runtimes.get(config.accountId)
    if (existing) {
      return existing
    }
    const runtime = new CodexAcpRuntime(config, onAuthInvalidated)
    this.runtimes.set(config.accountId, runtime)
    return runtime
  }

  stopRuntime(accountId: string): void {
    this.runtimes.get(accountId)?.shutdown()
    this.runtimes.delete(accountId)
  }

  stopAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.shutdown()
    }
    this.runtimes.clear()
  }
}

export const codexAcpRuntimeService = new CodexAcpRuntimeService()

export function normalizeCodexAcpUpdates(updates: SessionUpdate[]): ProviderChatMessageItem[] {
  const state = emptySessionState(false)
  for (const update of updates) {
    applyAcpUpdate(state, update)
  }
  return state.messages.map((message) => ({
    ...message,
    status: message.status === "STREAMING" ? "COMPLETED" : message.status,
  }))
}

export function codexAcpRuntimeForAccount(
  account: ProviderAccount,
  config: Omit<CodexAcpRuntimeConfig, "accountId">,
  onAuthInvalidated?: (message: string) => void,
): CodexAcpRuntime {
  return codexAcpRuntimeService.getRuntime({ ...config, accountId: account.id }, onAuthInvalidated)
}

function emptySessionState(loaded: boolean): SessionState {
  return {
    currentStructuredPlanId: null,
    loaded,
    messages: [],
    messagesByItemId: new Map(),
    planSequence: 0,
    toolCalls: new Map(),
  }
}

function applyAcpUpdate(state: SessionState, update: SessionUpdate): ProviderChatMessageItem | null {
  const now = new Date().toISOString()
  if (
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk"
  ) {
    const content = contentBlockText(update.content)
    if (!content) {
      return null
    }
    const prefix = update.sessionUpdate === "user_message_chunk"
      ? "user"
      : update.sessionUpdate === "agent_thought_chunk" ? "thought" : "assistant"
    const itemId = update.messageId ?? `${prefix}:${state.messages.length}`
    const existing = messageById(state, itemId)
    if (update.sessionUpdate === "user_message_chunk" && !existing) {
      state.currentStructuredPlanId = null
    }
    return upsertMessage(state, itemId, {
      content: `${existing?.content ?? ""}${content}`,
      createdAt: existing?.createdAt ?? now,
      itemId,
      kind: update.sessionUpdate === "agent_thought_chunk" ? "THINKING" : "CHAT",
      rawPayload: toJson(update),
      role: update.sessionUpdate === "user_message_chunk" ? "USER" : "ASSISTANT",
      status: "STREAMING",
    })
  }

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const previous = state.toolCalls.get(update.toolCallId)
    const toolCall = update.sessionUpdate === "tool_call"
      ? update
      : ({
          ...previous,
          ...update,
          content: update.content ?? previous?.content,
          locations: update.locations ?? previous?.locations,
        } as ToolCall)
    if (!toolCall.title) {
      toolCall.title = previous?.title ?? "Tool call"
    }
    state.toolCalls.set(update.toolCallId, toolCall)
    return upsertMessage(
      state,
      update.toolCallId,
      toolCallMessage(toolCall, messageById(state, update.toolCallId)?.createdAt ?? now),
    )
  }

  if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
    const plan = update.sessionUpdate === "plan"
      ? {
          entries: update.entries,
          planId: state.currentStructuredPlanId ?? `structured-${state.planSequence + 1}`,
          type: "items" as const,
        }
      : update.plan
    if (update.sessionUpdate === "plan" && state.currentStructuredPlanId === null) {
      state.planSequence += 1
      state.currentStructuredPlanId = plan.planId
    }
    const itemId = `plan:${plan.planId}`
    const metadata: JsonObject = { planPresentation: "update" }
    let content = ""
    if (plan.type === "items") {
      metadata.planSteps = toJson(plan.entries.map((entry) => ({
        status: entry.status === "in_progress" ? "inProgress" : entry.status,
        step: entry.content,
      })))
    } else if (plan.type === "markdown") {
      content = plan.content
    } else {
      content = plan.uri
    }
    return upsertMessage(state, itemId, {
      content,
      createdAt: now,
      itemId,
      kind: "PLAN",
      metadata,
      rawPayload: toJson(update),
      role: "ASSISTANT",
      status: "STREAMING",
    })
  }

  if (update.sessionUpdate === "plan_removed") {
    return upsertMessage(state, `plan:${update.planId}`, {
      content: "",
      createdAt: now,
      itemId: `plan:${update.planId}`,
      kind: "PLAN",
      metadata: { planPresentation: "update", planSteps: [] },
      rawPayload: toJson(update),
      role: "ASSISTANT",
      status: "COMPLETED",
    })
  }
  return null
}

function toolCallMessage(toolCall: ToolCall, createdAt: string): ProviderChatMessageItem {
  const kind = toolMessageKind(toolCall)
  return {
    content: formatToolCall(toolCall, kind),
    createdAt,
    itemId: toolCall.toolCallId,
    kind,
    rawPayload: toJson(toolCall),
    role: "TOOL",
    status: toolCall.status === "failed"
      ? "FAILED"
      : toolCall.status === "completed" ? "COMPLETED" : "STREAMING",
  }
}

function toolMessageKind(toolCall: ToolCall): NonNullable<ProviderChatMessageItem["kind"]> {
  const meta = record(toolCall._meta)
  const codex = record(meta.codex)
  if (record(codex.subagent).threadId || record(codex.collaboration).tool) {
    return "SUBAGENT_ACTIVITY"
  }
  if (meta.contextCompaction === true) {
    return "COMPACTION"
  }
  if (toolCall.kind === "edit" || toolCall.kind === "delete" || toolCall.kind === "move") {
    return "FILE_CHANGE"
  }
  if (toolCall.kind === "execute" && stringValue(record(toolCall.rawInput).command)) {
    return "COMMAND_EXECUTION"
  }
  if (toolCall.kind === "switch_mode") {
    return "REVIEW"
  }
  return "TOOL_ACTIVITY"
}

function formatToolCall(toolCall: ToolCall, kind: NonNullable<ProviderChatMessageItem["kind"]>): string {
  if (kind === "FILE_CHANGE") {
    const diffs = (toolCall.content ?? []).filter((entry) => entry.type === "diff")
    if (diffs.length) {
      return [toolCall.title, ...diffs.map((diff) => {
        const stats = changedLineStats(diff.oldText ?? "", diff.newText)
        return `\`${diff.path}\` +${stats.additions} -${stats.deletions}`
      })].join("\n\n")
    }
  }

  const rawInput = record(toolCall.rawInput)
  const rawOutput = record(toolCall.rawOutput)
  const displayStatus = toolCall.status === "in_progress" ? "inProgress" : toolCall.status
  const parts = [`- ${toolCall.title}${displayStatus ? ` ${displayStatus}` : ""}`]
  const command = stringValue(rawInput.command)
  if (command) {
    parts.push(`~~~sh\n${command}\n~~~`)
  } else if (toolCall.rawInput !== undefined) {
    parts.push(`Input\n~~~json\n${prettyJson(toolCall.rawInput)}\n~~~`)
  }
  const formattedOutput = stringValue(rawOutput.formatted_output)
  if (formattedOutput) {
    parts.push(`Output\n~~~text\n${formattedOutput}\n~~~`)
  } else if (toolCall.rawOutput !== undefined) {
    parts.push(`Output\n~~~json\n${prettyJson(toolCall.rawOutput)}\n~~~`)
  }
  for (const entry of toolCall.content ?? []) {
    if (entry.type === "content") {
      const text = contentBlockText(entry.content)
      if (text) {
        parts.push(text)
      }
    }
  }
  return parts.join("\n\n")
}

function messageById(state: SessionState, itemId: string): ProviderChatMessageItem | null {
  const index = state.messagesByItemId.get(itemId)
  return index === undefined ? null : state.messages[index] ?? null
}

function upsertMessage(
  state: SessionState,
  itemId: string,
  message: ProviderChatMessageItem,
): ProviderChatMessageItem {
  const index = state.messagesByItemId.get(itemId)
  if (index === undefined) {
    state.messagesByItemId.set(itemId, state.messages.length)
    state.messages.push(message)
  } else {
    state.messages[index] = message
  }
  return message
}

function codexAcpPrompt(
  content: string,
  attachments: NonNullable<ProviderRuntimeMessageInput["attachments"]>,
): ContentBlock[] {
  const summary = attachments
    .filter((attachment) => attachment.kind !== "image" || !attachment.dataUrl)
    .map((attachment) => `- ${attachment.kind}: ${attachment.name}${attachment.path ? ` (${attachment.path})` : ""}`)
  const text = [content.trim(), summary.length ? `Attached context:\n${summary.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n") || "Attached context"
  const blocks: ContentBlock[] = [{ type: "text", text }]
  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      continue
    }
    const image = attachment.dataUrl ? parseDataUrl(attachment.dataUrl) : null
    if (image) {
      blocks.push({ type: "image", data: image.data, mimeType: image.mimeType })
    } else if (attachment.path) {
      blocks.push({ type: "resource_link", name: attachment.name, uri: attachment.path })
    }
  }
  return blocks
}

function contentBlockText(block: ContentBlock): string {
  if (block.type === "text") {
    return block.text
  }
  if (block.type === "resource_link") {
    return `[${block.name}](${block.uri})`
  }
  if (block.type === "resource" && "text" in block.resource) {
    return block.resource.text
  }
  if (block.type === "image") {
    return block.uri ? `![image](${block.uri})` : `[Image: ${block.mimeType}]`
  }
  return ""
}

function permissionOutcome(
  options: PermissionOption[],
  response: ServerRequestResponseRequest,
): RequestPermissionResponse["outcome"] {
  const result = record(response.result)
  const decision = stringValue(result.decision) ?? stringValue(response.decision)
  const approved = decision === "accept" || decision === "approved" || decision === "allow"
  const option = options.find((entry) => approved ? entry.kind.startsWith("allow") : entry.kind.startsWith("reject"))
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" }
}

function elicitationOutcome(
  response: ServerRequestResponseRequest,
  request: CreateElicitationRequest,
): CreateElicitationResponse {
  const result = record(response.result)
  const answers = record(result.answers)
  const properties = request.mode === "form" ? record(record(request).requestedSchema).properties : {}
  const propertyRecords = record(properties)
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [id, answerValue] of Object.entries(answers)) {
    const answer = record(answerValue)
    const values = Array.isArray(answer.answers) ? answer.answers : []
    const first = values.find((value): value is string => typeof value === "string")
    if (first !== undefined) {
      const property = record(propertyRecords[id])
      const oneOf = Array.isArray(property.oneOf) ? property.oneOf.map(record) : []
      const selected = oneOf.find((option) => option.title === first || option.const === first)
      const selectedValue = stringValue(selected?.const)
      const propertyType = stringValue(property.type)
      if (selectedValue) {
        content[id] = selectedValue
      } else if (propertyType === "boolean") {
        content[id] = first.toLowerCase() === "true" || first.toLowerCase() === "yes"
      } else if (propertyType === "number" || propertyType === "integer") {
        const numeric = Number(first)
        content[id] = Number.isFinite(numeric) ? numeric : first
      } else {
        content[id] = first
      }
    }
  }
  return { action: "accept", content }
}

export function codexAcpElicitationPayload(request: CreateElicitationRequest): JsonSerializable {
  if (request.mode !== "form") {
    return toJson(request)
  }
  const requestedSchema = record(record(request).requestedSchema)
  const questions = Object.entries(record(requestedSchema.properties)).map(([id, propertyValue]) => {
    const property = record(propertyValue)
    const oneOf = Array.isArray(property.oneOf) ? property.oneOf.map(record) : []
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((value): value is string => typeof value === "string")
      : []
    const options = oneOf.length
      ? oneOf.map((option) => ({
          description: stringValue(option.description) ?? "",
          label: stringValue(option.title) ?? stringValue(option.const) ?? "Option",
          value: stringValue(option.const) ?? stringValue(option.title) ?? "option",
        }))
      : enumValues.map((value) => ({ description: "", label: value, value }))
    if (property.type === "boolean" && options.length === 0) {
      options.push(
        { description: "", label: "Yes", value: "true" },
        { description: "", label: "No", value: "false" },
      )
    }
    return {
      header: stringValue(property.title) ?? "",
      id,
      options,
      question: stringValue(property.description) ?? stringValue(property.title) ?? request.message,
    }
  })
  return toJson({ ...request, questions })
}

function formatPermissionRequest(request: RequestPermissionRequest): string {
  const input = record(request.toolCall.rawInput)
  const command = stringValue(input.command)
  return [
    `${request.toolCall.title || "Permission"} requires approval`,
    command ? `~~~sh\n${command}\n~~~` : "",
    request.options.length ? `Options: ${request.options.map((option) => option.name).join(", ")}` : "",
  ].filter(Boolean).join("\n\n")
}

function changedLineStats(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText.split(/\r?\n/u)
  const newLines = newText.split(/\r?\n/u)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    additions: Math.max(0, newLines.length - prefix - suffix),
    deletions: Math.max(0, oldLines.length - prefix - suffix),
  }
}

function parseDataUrl(value: string): { data: string; mimeType: string } | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/su)
  return match?.[1] && match[2] ? { mimeType: match[1], data: match[2] } : null
}

function normalizeReasoningEffort(value: string): string {
  if (value === "extraHigh" || value === "extra-high" || value === "extra_high") {
    return "xhigh"
  }
  if (value === "fast") {
    return "low"
  }
  if (value === "deep") {
    return "high"
  }
  return value
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toJson(value: unknown): JsonSerializable {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonSerializable
}

function isAuthInvalidatedMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes("token_invalidated") || normalized.includes("authentication token has been invalidated")
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
