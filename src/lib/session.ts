import { apiClient, type BrowserDirectoryResponse, type BrowserEntry, type ChatMessageResponse, type ChatResponse, type ProviderAccountResponse, type ProviderComposerFeature, type ProviderDefinitionResponse, type ProviderLimitsResponse, type ProviderModelListResponse, type ServerRequestResponseRequest, type WorkspaceHistoryResponse } from "@/lib/api-client"
import type { ChatComposerAccessMode, ChatComposerAttachment, ChatComposerReasoningEffort, ChatComposerServiceTier, ChatFileLinkTarget, ChatRenderEntry, FileNode, MarkdownBlock, ParsedFileChange, ProviderClientEvent, SessionRouteTarget, UserInputQuestion, VisibleTreeItem, WorkRenderEntry, Workspace } from "@/types/session"

export function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function readRecordString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ""
  }
  const recordValue = (value as Record<string, unknown>)[key]
  return typeof recordValue === "string" ? recordValue : ""
}

export function readCodexPersonalityValue(value: unknown): "friendly" | "pragmatic" {
  return readRecordString(value, "personality") === "friendly" ? "friendly" : "pragmatic"
}

export function readCodexHomeValue(account: ProviderAccountResponse, provider: ProviderDefinitionResponse): string {
  if (readRecordString(account.authState, "codexHomeMode") === "shared") {
    return readSharedCodexHomeValue(provider)
  }
  return readRecordString(account.settings, "codexHome") || readDefaultCodexHomeValue(account, provider)
}

export function readDefaultCodexHomeValue(account: ProviderAccountResponse, provider: ProviderDefinitionResponse): string {
  const accountsHome = readRecordString(provider.defaultSettings, "accountsHome") || "~/.pockcode/providers/codex/accounts"
  return joinDisplayPath(accountsHome, account.id)
}

export function readSharedCodexHomeValue(provider: ProviderDefinitionResponse): string {
  return readRecordString(provider.defaultSettings, "sharedChatHome") || "~/.codex"
}

export function joinDisplayPath(parent: string, child: string): string {
  const trimmed = parent.trim()
  return trimmed.endsWith("/") ? `${trimmed}${child}` : `${trimmed}/${child}`
}

export function withoutRecordKeys(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  const copy = { ...(value as Record<string, unknown>) }
  for (const key of keys) {
    delete copy[key]
  }
  return copy
}

export function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function formatProviderQuota(limits: ProviderLimitsResponse | undefined): string | null {
  const rateLimits = limits?.rateLimits
  if (!rateLimits) {
    return null
  }

  const windows = [
    { fallbackLabel: "5H", window: rateLimits.primary },
    { fallbackLabel: "W", window: rateLimits.secondary },
  ]
    .filter((entry): entry is { fallbackLabel: string; window: NonNullable<typeof entry.window> } => Boolean(entry.window))
    .sort((first, second) => quotaSortMinutes(first) - quotaSortMinutes(second))
    .map(({ fallbackLabel, window }) => {
      const remainingPercent = clampPercent(100 - window.usedPercent)
      return `${quotaWindowLabel(window.windowDurationMins, fallbackLabel)}: ${Math.round(remainingPercent)}%`
    })

  return windows.length ? windows.join(" | ") : null
}

export function quotaWindowLabel(windowDurationMins: number | null | undefined, fallbackLabel: string): string {
  if (!windowDurationMins || !Number.isFinite(windowDurationMins)) {
    return fallbackLabel
  }
  if (windowDurationMins >= 6 * 24 * 60) {
    return "W"
  }
  if (windowDurationMins >= 60) {
    return `${Math.round(windowDurationMins / 60)}H`
  }
  return `${Math.round(windowDurationMins)}M`
}

export function quotaSortMinutes(entry: {
  fallbackLabel: string
  window: NonNullable<NonNullable<ProviderLimitsResponse["rateLimits"]>["primary"]>
}): number {
  if (entry.window.windowDurationMins && Number.isFinite(entry.window.windowDurationMins)) {
    return entry.window.windowDurationMins
  }
  return entry.fallbackLabel === "5H" ? 5 * 60 : 7 * 24 * 60
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))
}

const codexComposerFeatures: ProviderComposerFeature[] = [
  "accessMode",
  "fileAttachment",
  "folderAttachment",
  "goal",
  "imageAttachment",
  "planMode",
]
export const defaultCodexModel = "gpt-5.5"

const codexReasoningEffortOptions = [
  { description: "Low", reasoningEffort: "low" },
  { description: "Medium", reasoningEffort: "medium" },
  { description: "High", reasoningEffort: "high" },
  { description: "Extra High", reasoningEffort: "extra-high" },
]

const codexModelOptions: ProviderModelListResponse["data"] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: codexReasoningEffortOptions,
  },
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: codexReasoningEffortOptions,
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: codexReasoningEffortOptions,
  },
  {
    id: "gpt-5.3-codex-spark",
    model: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3-Codex-Spark",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: codexReasoningEffortOptions,
  },
]

export const composerReasoningEffortOptions: { label: string; value: ChatComposerReasoningEffort }[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra High", value: "extraHigh" },
]

export const composerServiceTierOptions: { description: string; label: string; value: ChatComposerServiceTier }[] = [
  { description: "Default speed", label: "Standard", value: "standard" },
  { description: "1.5x speed, increased usage", label: "Fast", value: "fast" },
]

export function fallbackComposerFeatures(providerId: string | null | undefined): ProviderComposerFeature[] {
  return providerId === "codex" ? codexComposerFeatures : []
}

export function readComposerAccessMode(value: string | null | undefined): ChatComposerAccessMode {
  return value === "fullAccess" ? "fullAccess" : "askForApproval"
}

export function accessModeLabel(value: ChatComposerAccessMode): string {
  return value === "fullAccess" ? "Full access" : "Ask for approval"
}

export function defaultModelOptionsForProvider(providerId: string | null | undefined): ProviderModelListResponse["data"] {
  return providerId === "codex" ? codexModelOptions : []
}

export function defaultRuntimeDefaultValue(providerId: string | null | undefined, key: string): string {
  if (providerId !== "codex") {
    return ""
  }
  if (key === "model") {
    return defaultCodexModel
  }
  if (key === "permissionMode") {
    return "askForApproval"
  }
  if (key === "reasoningEffort") {
    return "medium"
  }
  if (key === "serviceTier") {
    return "standard"
  }
  return ""
}

export function mergeProviderModelOptions(
  providerId: string | null | undefined,
  options: ProviderModelListResponse["data"],
): ProviderModelListResponse["data"] {
  const merged = new Map<string, ProviderModelListResponse["data"][number]>()
  const addOption = (option: ProviderModelListResponse["data"][number]) => {
    const key = modelOptionKey(option)
    const existing = merged.get(key)
    merged.set(key, existing ? mergeModelOption(existing, option) : option)
  }
  defaultModelOptionsForProvider(providerId).forEach(addOption)
  options.forEach(addOption)
  return [...merged.values()]
}

export function readComposerReasoningEffort(value: string | null | undefined): ChatComposerReasoningEffort {
  if (value === "low" || value === "fast") {
    return "low"
  }
  if (value === "high" || value === "deep") {
    return "high"
  }
  if (value === "extraHigh" || value === "extra-high" || value === "extra_high" || value === "xhigh") {
    return "extraHigh"
  }
  return "medium"
}

export function composerReasoningEffortValue(value: ChatComposerReasoningEffort): string {
  if (value === "low") {
    return "low"
  }
  if (value === "high") {
    return "high"
  }
  if (value === "extraHigh") {
    return "extra-high"
  }
  return "medium"
}

export function composerReasoningEffortLabel(value: ChatComposerReasoningEffort): string {
  if (value === "low") {
    return "Low"
  }
  if (value === "high") {
    return "High"
  }
  if (value === "extraHigh") {
    return "Extra High"
  }
  return "Medium"
}

export function readComposerServiceTier(value: string | null | undefined): ChatComposerServiceTier {
  return value === "fast" ? "fast" : "standard"
}

export function composerServiceTierValue(value: ChatComposerServiceTier): string {
  return value
}

export function composerServiceTierLabel(value: ChatComposerServiceTier): string {
  if (value === "fast") {
    return "Fast"
  }
  return "Standard"
}

function modelOptionKey(option: ProviderModelListResponse["data"][number]): string {
  return (option.model || option.id).trim().toLowerCase()
}

function mergeModelOption(
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

export function attachmentOnlyPrompt(attachments: ChatComposerAttachment[]): string {
  if (!attachments.length) {
    return ""
  }
  return attachments.some((attachment) => attachment.kind !== "image")
    ? "Attached context."
    : "Attached image."
}

export async function attachmentsFromFiles(files: File[], includeImages: boolean): Promise<ChatComposerAttachment[]> {
  return Promise.all(
    files.map(async (file) => {
      const path = fileRelativePath(file) ?? file.name
      if (includeImages && file.type.startsWith("image/")) {
        return {
          dataUrl: await readFileAsDataUrl(file),
          id: createClientId(),
          kind: "image",
          mimeType: file.type,
          name: file.name,
          path,
          size: file.size,
        }
      }
      return {
        id: createClientId(),
        kind: "file",
        mimeType: file.type || undefined,
        name: file.name,
        path,
        size: file.size,
      }
    }),
  )
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file."))
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.readAsDataURL(file)
  })
}

export function fileRelativePath(file: File): string | null {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return path?.trim() || null
}

export function createClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createOptimisticChatMessage(
  chatId: string,
  content: string,
  messages: ChatMessageResponse[],
): ChatMessageResponse {
  return {
    chatId,
    content,
    createdAt: new Date().toISOString(),
    id: `client:${createClientId()}`,
    kind: "CHAT",
    metadata: { optimistic: true },
    role: "USER",
    sequence: Math.max(0, ...messages.map((message) => message.sequence)) + 1,
    status: "PENDING",
  }
}

export function isToolMessage(message: ChatMessageResponse): boolean {
  return (
    message.role === "TOOL" ||
    message.kind === "APPROVAL" ||
    message.kind === "COMMAND_EXECUTION" ||
    message.kind === "FILE_CHANGE" ||
    message.kind === "PLAN" ||
    message.kind === "USER_INPUT_PROMPT" ||
    message.kind === "TOOL_ACTIVITY"
  )
}

export function serverRequestResponseFor(message: ChatMessageResponse, approved: boolean): ServerRequestResponseRequest {
  const method = readRecordString(readRecord(message.metadata), "serverRequestMethod")
  if (method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      result: {
        permissions: approved ? grantedPermissionsFromRequest(message) : {},
        scope: "turn",
      } as ServerRequestResponseRequest["result"],
    }
  }
  if (method === "item/tool/requestUserInput") {
    return {
      kind: "userInput",
      result: { answers: {} },
    }
  }
  return {
    kind: "approval",
    result: { decision: approved ? "accept" : "decline" },
  }
}

export function isPendingUserInputPrompt(message: ChatMessageResponse): boolean {
  return message.kind === "USER_INPUT_PROMPT" && message.status === "PENDING" && Boolean(message.requestId)
}

export function readUserInputQuestions(value: unknown): UserInputQuestion[] {
  const questions = readRecord(value).questions
  if (!Array.isArray(questions)) {
    return []
  }
  return questions.flatMap((questionValue) => {
    const question = readRecord(questionValue)
    const id = readRecordString(question, "id")
    const prompt = readRecordString(question, "question")
    if (!id || !prompt) {
      return []
    }
    return [{
      header: readRecordString(question, "header") ?? "",
      id,
      isSecret: question.isSecret === true,
      options: readUserInputOptions(question.options),
      question: prompt,
    }]
  })
}

export function readUserInputOptions(value: unknown): UserInputQuestion["options"] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((optionValue) => {
    const option = readRecord(optionValue)
    const label = readRecordString(option, "label")
    if (!label) {
      return []
    }
    return [{
      description: readRecordString(option, "description") ?? "",
      label,
    }]
  })
}

export function grantedPermissionsFromRequest(message: ChatMessageResponse): Record<string, unknown> {
  const requested = readRecord(readRecord(message.rawPayload).permissions)
  const granted: Record<string, unknown> = {}
  const network = readRecord(requested.network)
  const fileSystem = readRecord(requested.fileSystem)
  if (Object.keys(network).length) {
    granted.network = network
  }
  if (Object.keys(fileSystem).length) {
    granted.fileSystem = fileSystem
  }
  return granted
}

export function firstToolAction(content: string): string | null {
  return content.match(/^- (.+)$/mu)?.[1]?.trim() ?? null
}

export function stripInlineCode(value: string): string {
  return value.replace(/`([^`]+)`/gu, "$1")
}

export function groupChatRenderEntries(messages: ChatMessageResponse[], chatRunning: boolean): ChatRenderEntry[] {
  const entries: ChatRenderEntry[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    if (!message) {
      break
    }
    if (message.role === "USER") {
      entries.push({ type: "message", message })
      index += 1
      continue
    }

    const previousEntry = entries.at(-1)
    const previousUser = previousEntry?.type === "message" ? previousEntry.message : null
    const segment: ChatMessageResponse[] = []
    while (index < messages.length && messages[index]?.role !== "USER") {
      segment.push(messages[index])
      index += 1
    }
    entries.push(...renderAssistantSegment(segment, previousUser?.role === "USER" ? previousUser : null, chatRunning && index >= messages.length))
  }

  return entries
}

export function renderAssistantSegment(
  messages: ChatMessageResponse[],
  userMessage: ChatMessageResponse | null,
  running: boolean,
): ChatRenderEntry[] {
  const finalAssistantIndex = findLastIndex(messages, isFinalAssistantMessage)
  const finalAssistant = finalAssistantIndex >= 0 ? messages[finalAssistantIndex] : null
  const finished = !running && Boolean(finalAssistant && isFinishedMessage(finalAssistant))
  const workMessages: ChatMessageResponse[] = []
  const fileChangeMessages: ChatMessageResponse[] = []
  const entries: ChatRenderEntry[] = []

  messages.forEach((message, index) => {
    if (finished && index === finalAssistantIndex) {
      return
    }
    if (isRunningPlaceholderMessage(message) && (!running || isStaleRunningPlaceholder(message))) {
      return
    }
    workMessages.push(message)
    if (finished && isFileChangeMessage(message)) {
      fileChangeMessages.push(message)
    }
  })

  if (workMessages.length) {
    entries.push({
      type: "work",
      completedAt: workCompletedAt(messages),
      finished,
      id: `work:${workMessages[0]?.runId ?? workMessages[0]?.id ?? "unknown"}`,
      messages: workMessages,
      startedAt: userMessage?.createdAt ?? workMessages[0]?.createdAt ?? null,
    })
  }
  if (finished && finalAssistant) {
    entries.push({ type: "message", message: finalAssistant })
  }
  if (fileChangeMessages.length) {
    entries.push({
      type: "fileChange",
      id: `file-change:${fileChangeMessages[0]?.runId ?? fileChangeMessages[0]?.id ?? "unknown"}`,
      messages: fileChangeMessages,
    })
  }

  return entries
}

export function chatRenderEntryId(entry: ChatRenderEntry): string {
  return entry.type === "message" ? `message:${entry.message.id}` : entry.id
}

export function queuedMessageRunIds(messages: ChatMessageResponse[]): string[] {
  const runIds: string[] = []
  for (const message of messages) {
    if (message.role === "USER" && message.status === "PENDING" && message.runId && !runIds.includes(message.runId)) {
      runIds.push(message.runId)
    }
  }
  return runIds
}

export function moveItemAround(items: string[], source: string, target: string, placement: "after" | "before"): string[] {
  const next = items.filter((item) => item !== source)
  const targetIndex = next.indexOf(target)
  if (targetIndex < 0) {
    return items
  }
  next.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, source)
  return next
}

export function isFinalAssistantMessage(message: ChatMessageResponse): boolean {
  return message.role === "ASSISTANT" && (message.kind === "CHAT" || message.kind === "ERROR")
}

export function isDisplayAssistantMessage(message: ChatMessageResponse): boolean {
  return isFinalAssistantMessage(message) && !isRunningPlaceholderMessage(message)
}

export function isFinishedMessage(message: ChatMessageResponse): boolean {
  return message.status === "COMPLETED" || message.status === "FAILED"
}

export function isFileChangeMessage(message: ChatMessageResponse): boolean {
  return message.kind === "FILE_CHANGE"
}

export function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index
    }
  }
  return -1
}

export function findLast<T>(items: T[], predicate: (item: T) => boolean): T | null {
  const index = findLastIndex(items, predicate)
  return index >= 0 ? items[index] : null
}

export function workCompletedAt(messages: ChatMessageResponse[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.completedAt || message?.createdAt) {
      return message.completedAt ?? message.createdAt
    }
  }
  return null
}

export function isRunningPlaceholderMessage(message: ChatMessageResponse): boolean {
  return message.role === "ASSISTANT" && message.status === "STREAMING" && message.content.trim() === "Running"
}

export function isStaleRunningPlaceholder(message: ChatMessageResponse | undefined): boolean {
  if (!message || !isRunningPlaceholderMessage(message)) {
    return false
  }
  const createdAt = Date.parse(message.createdAt)
  return Number.isFinite(createdAt) && Date.now() - createdAt > 60_000
}

export function groupWorkMessages(messages: ChatMessageResponse[], finished: boolean): WorkRenderEntry[] {
  const entries: WorkRenderEntry[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    if (!message) {
      break
    }
    if (!isToolMessage(message)) {
      entries.push({ type: "message", message })
      index += 1
      continue
    }

    const actionMessages: ChatMessageResponse[] = []
    while (index < messages.length && messages[index] && isToolMessage(messages[index])) {
      actionMessages.push(messages[index])
      index += 1
    }
    const followedByText = index < messages.length
    const canCompact = actionMessages.length > 1 &&
      actionMessages.every((entry) => entry.status !== "STREAMING") &&
      (finished || followedByText)

    if (canCompact) {
      entries.push({
        type: "actionGroup",
        id: `actions:${actionMessages[0]?.id ?? "unknown"}:${actionMessages.length}`,
        messages: actionMessages,
      })
      continue
    }

    for (const actionMessage of actionMessages) {
      entries.push({ type: "message", message: actionMessage })
    }
  }

  return entries
}

export function editedFilesTitle(changes: ParsedFileChange[], fallbackCount: number): string {
  if (changes.length === 1) {
    return `Edited ${changes[0].path}`
  }
  return `Edited ${changes.length || fallbackCount} files`
}

export function groupFileChanges(changes: ParsedFileChange[]): ParsedFileChange[] {
  const byPath = new Map<string, ParsedFileChange>()
  for (const change of changes) {
    const existing = byPath.get(change.path)
    if (existing) {
      existing.additions += change.additions
      existing.deletions += change.deletions
      continue
    }
    byPath.set(change.path, { ...change })
  }
  return [...byPath.values()]
}

export function parseFileChangeMessage(message: ChatMessageResponse): ParsedFileChange[] {
  const changes: ParsedFileChange[] = []
  const compactPattern = /^`([^`]+)`[^\n]*?\+(\d+)\s+-(\d+)\s*$/gmu
  for (const match of message.content.matchAll(compactPattern)) {
    changes.push({
      path: match[1] ?? "unknown file",
      additions: Number.parseInt(match[2] ?? "0", 10),
      deletions: Number.parseInt(match[3] ?? "0", 10),
    })
  }

  if (changes.length) {
    return changes
  }

  const diffPattern = /^`([^`]+)`[^\n]*\n\n~~~diff\n([\s\S]*?)\n~~~/gmu
  for (const match of message.content.matchAll(diffPattern)) {
    const diff = match[2] ?? ""
    changes.push({
      path: match[1] ?? "unknown file",
      ...diffStats(diff),
    })
  }
  return changes
}

export function workspaceRelativeDisplayPath(path: string, workspacePath: string): string {
  const normalizedPath = trimPathSeparator(normalizeBrowserPath(path.trim()))
  const normalizedWorkspace = trimPathSeparator(normalizeBrowserPath(workspacePath.trim()))
  if (!normalizedPath || !normalizedWorkspace || normalizedPath === normalizedWorkspace) {
    return normalizedPath || path
  }
  if (normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1)
  }
  return path
}

export function parseChatFileLink(href: string, workspace: Workspace): ChatFileLinkTarget | null {
  const parsed = parseLocalFileHref(href)
  if (!parsed) {
    return null
  }
  const normalizedPath = trimPathSeparator(normalizeBrowserPath(parsed.path))
  const normalizedWorkspace = trimPathSeparator(normalizeBrowserPath(workspace.path))
  if (!normalizedPath) {
    return null
  }
  if (normalizedPath.startsWith("/")) {
    if (!normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
      return null
    }
    return {
      ...parsed,
      path: normalizedPath.slice(normalizedWorkspace.length + 1),
    }
  }
  return {
    ...parsed,
    path: normalizedPath.replace(/^\.\//u, ""),
  }
}

export function parseLocalFileHref(href: string): ChatFileLinkTarget | null {
  let value = href.trim().replace(/^<|>$/gu, "")
  if (!value || /^(https?:|mailto:)/iu.test(value)) {
    return null
  }
  if (/^file:/iu.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      return null
    }
  } else {
    try {
      value = decodeURIComponent(value)
    } catch {
      return null
    }
  }

  const hashIndex = value.indexOf("#")
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : ""
  if (hashIndex >= 0) {
    value = value.slice(0, hashIndex)
  }
  const queryIndex = value.indexOf("?")
  if (queryIndex >= 0) {
    value = value.slice(0, queryIndex)
  }

  const hashLine = hash.match(/^#L?(\d+)(?:C(\d+))?$/iu)
  const suffixLine = value.match(/^(.*):(\d+)(?::(\d+))?$/u)
  const path = suffixLine ? suffixLine[1] : value
  const lineNumber = readPositiveInteger(hashLine?.[1] ?? suffixLine?.[2])
  const column = readPositiveInteger(hashLine?.[2] ?? suffixLine?.[3])

  return {
    path,
    ...(lineNumber ? { lineNumber } : {}),
    ...(column ? { column } : {}),
  }
}

export function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function diffStats(diff: string): { additions: number; deletions: number } {
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

export function workDurationLabel(
  messages: ChatMessageResponse[],
  startedAt?: string | null,
  completedAt?: string | null,
  finished = true,
  nowMs = Date.now(),
): string | null {
  const startMs = Date.parse(startedAt ?? messages[0]?.createdAt ?? "")
  if (!Number.isFinite(startMs)) {
    return null
  }
  const completedMs = Date.parse(completedAt ?? "")
  const fallbackEndMs = latestMessageTimeMs(messages)
  const endMs = finished && Number.isFinite(completedMs)
    ? completedMs
    : finished && Number.isFinite(fallbackEndMs)
      ? fallbackEndMs
      : nowMs
  const durationMs = Math.max(0, endMs - startMs)
  return compactDurationLabel(durationMs)
}

export function latestMessageTimeMs(messages: ChatMessageResponse[]): number {
  let latest = Number.NaN
  for (const message of messages) {
    for (const value of [message.completedAt, message.createdAt]) {
      const time = Date.parse(value ?? "")
      if (Number.isFinite(time)) {
        latest = Number.isFinite(latest) ? Math.max(latest, time) : time
      }
    }
  }
  return latest
}

export function compactDurationLabel(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) {
    return `${seconds}s`
  }
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function markdownBlockSignature(block: MarkdownBlock): string {
  if (block.type === "code") {
    return `code:${block.language}:${block.value}`
  }
  if (block.type === "heading") {
    return `heading:${block.level}:${block.text}`
  }
  if (block.type === "list") {
    return `list:${block.ordered}:${block.items.join("\n")}`
  }
  if (block.type === "blockquote") {
    return `blockquote:${block.lines.join("\n")}`
  }
  if (block.type === "table") {
    return `table:${block.headers.join("|")}:${block.rows.map((row) => row.join("|")).join("\n")}`
  }
  if (block.type === "hr") {
    return "hr"
  }
  return `paragraph:${block.lines.join("\n")}`
}

export function hashString(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0
  }
  return (hash >>> 0).toString(36)
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^\s*(```|~~~)\s*([\w.-]+)?\s*$/)
    if (fence) {
      const marker = fence[1]
      const language = fence[2] ?? ""
      const code: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(marker)) {
        code.push(lines[index] ?? "")
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      blocks.push({ type: "code", language, value: code.join("\n") })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() })
      index += 1
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" })
      index += 1
      continue
    }

    if (line.includes("|") && isMarkdownTableSeparator(lines[index + 1] ?? "")) {
      const headers = splitMarkdownTableRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index]?.includes("|")) {
        rows.push(splitMarkdownTableRow(lines[index] ?? ""))
        index += 1
      }
      blocks.push({ type: "table", headers, rows })
      continue
    }

    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/)
    if (list) {
      const ordered = /\d/u.test(list[2][0] ?? "")
      const items: string[] = []
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/)
        if (!item || /\d/u.test(item[2][0] ?? "") !== ordered) {
          break
        }
        items.push(item[3].trim())
        index += 1
      }
      blocks.push({ type: "list", items, ordered })
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""))
        index += 1
      }
      blocks.push({ type: "blockquote", lines: quoteLines })
      continue
    }

    const paragraphLines: string[] = []
    while (index < lines.length && lines[index]?.trim()) {
      const next = lines[index] ?? ""
      if (
        next.match(/^\s*(```|~~~)/) ||
        next.match(/^(#{1,6})\s+/) ||
        next.match(/^(\s*)([-*+]|\d+[.)])\s+/) ||
        next.match(/^\s*>\s?/)
      ) {
        break
      }
      paragraphLines.push(next)
      index += 1
    }
    blocks.push({ type: "paragraph", lines: paragraphLines })
  }

  return blocks.length ? blocks : [{ type: "paragraph", lines: [content] }]
}

export function safeMarkdownHref(href: string): string {
  return /^(https?:|mailto:)/iu.test(href) ? href : "#"
}

export function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line)
}

export function splitMarkdownTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
}

export function flattenVisibleTree(
  nodes: FileNode[],
  expandedFolderIds: Set<string>,
  level = 1,
  parentId?: string,
): VisibleTreeItem[] {
  return nodes.flatMap((node) => {
    const item: VisibleTreeItem = { level, node, parentId }
    if (node.type !== "folder" || !expandedFolderIds.has(node.id)) {
      return [item]
    }
    return [item, ...flattenVisibleTree(node.children ?? [], expandedFolderIds, level + 1, node.id)]
  })
}

export function treeItemElementId(treeId: string, id: string) {
  return `file-tree-item-${treeId}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

export function shouldShowFilesPanelByDefault() {
  return typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches
}

export function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export function directoryResponseToBrowserEntry(directory: BrowserDirectoryResponse): BrowserEntry {
  return {
    name: displayNameForPath(directory.path),
    path: directory.path,
    type: "directory",
    children: directory.entries,
  }
}

export function updateBrowserEntryChildren(entry: BrowserEntry, path: string, children: BrowserEntry[]): BrowserEntry {
  if (samePath(entry.path, path)) {
    return { ...entry, children }
  }

  return {
    ...entry,
    children: entry.children?.map((child) => updateBrowserEntryChildren(child, path, children)),
  }
}

export function parentBrowserPath(path: string) {
  const normalized = trimPathSeparator(normalizeBrowserPath(path))
  const index = normalized.lastIndexOf("/")
  if (index <= 0) {
    return null
  }
  return normalized.slice(0, index)
}

export function pathInputFilter(input: string, rootPath: string) {
  const normalizedInput = trimPathSeparator(normalizeBrowserPath(input.trim()))
  const normalizedRoot = trimPathSeparator(normalizeBrowserPath(rootPath))
  if (!normalizedInput || normalizedInput === normalizedRoot) {
    return ""
  }

  if (normalizedInput.startsWith(`${normalizedRoot}/`)) {
    const relative = normalizedInput.slice(normalizedRoot.length + 1)
    return relative.split("/").filter(Boolean).at(-1) ?? ""
  }

  return normalizedInput.split("/").filter(Boolean).at(-1) ?? normalizedInput
}

export function samePath(left: string, right: string) {
  return normalizePathForCompare(left) === normalizePathForCompare(right)
}

const detachedEditorPreferenceKey = "pockcode.detachedEditor"

export function readDetachedEditorPreference(): boolean {
  if (typeof window === "undefined") {
    return false
  }
  return window.localStorage.getItem(detachedEditorPreferenceKey) === "1"
}

export function writeDetachedEditorPreference(value: boolean): void {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(detachedEditorPreferenceKey, value ? "1" : "0")
}

export function readSessionRouteTarget(): SessionRouteTarget {
  if (typeof window === "undefined") {
    return { chatId: null, workspaceId: null }
  }
  const params = new URLSearchParams(window.location.search)
  return {
    chatId: params.get("chat"),
    workspaceId: params.get("workspace"),
  }
}

export function writeSessionRouteTarget(workspaceId: string, chatId: string | null): void {
  const url = new URL(window.location.href)
  url.searchParams.set("workspace", workspaceId)
  if (chatId) {
    url.searchParams.set("chat", chatId)
  } else {
    url.searchParams.delete("chat")
  }
  const nextUrl = `${url.pathname}${url.search}${url.hash}`
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl)
  }
}

export function clearSessionRouteTarget(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete("workspace")
  url.searchParams.delete("chat")
  const nextUrl = `${url.pathname}${url.search}${url.hash}`
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl)
  }
}

export function filterBrowserEntries(entries: BrowserEntry[], filter: string) {
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const filtered = normalizedFilter
    ? entries.filter((entry) => browserEntryMatchesFilter(entry, normalizedFilter))
    : entries
  return filtered.slice(0, 400)
}

export function browserEntryMatchesFilter(entry: BrowserEntry, normalizedFilter: string): boolean {
  if (entry.name.toLocaleLowerCase().includes(normalizedFilter)) {
    return true
  }
  return (entry.children ?? []).some((child) => browserEntryMatchesFilter(child, normalizedFilter))
}

export function readError(error: unknown) {
  return error instanceof Error ? error.message : "Failed"
}

export async function workspaceFromHistory(
  history: WorkspaceHistoryResponse,
  existingWorkspaces: Workspace[],
): Promise<Workspace | null> {
  try {
    const entry = await apiClient.workspaces.readTree(history.path)
    return createWorkspaceFromBrowserEntry(entry, existingWorkspaces, history.id)
  } catch {
    return null
  }
}

export function collectInitialFolderIds(workspace: Workspace): string[] {
  const rootFolderId = workspace.fileTree[0]?.id
  return rootFolderId ? [rootFolderId] : []
}

export function initialOpenFileIds(workspace: Workspace): string[] {
  return workspace.selectedFileId ? [workspace.selectedFileId] : []
}

export function readProviderSocketEvent(value: unknown): ProviderClientEvent | null {
  const event = readRecord(value)
  const type = readRecordString(event, "type")
  if (!type) {
    return null
  }
  return {
    payload: event.payload,
    threadId: readRecordString(event, "threadId"),
    type,
  }
}

export function readChatResponse(value: unknown): ChatResponse | null {
  const chat = readRecord(value)
  const status = readChatStatus(chat.status)
  if (!readRecordString(chat, "id") || !status) {
    return null
  }
  return chat as ChatResponse
}

export function readChatMessageResponse(value: unknown): ChatMessageResponse | null {
  const message = readRecord(value)
  if (
    !readRecordString(message, "id") ||
    !readRecordString(message, "chatId") ||
    !readMessageRole(message.role) ||
    !readMessageKind(message.kind) ||
    !readMessageStatus(message.status) ||
    typeof message.content !== "string"
  ) {
    return null
  }
  return message as ChatMessageResponse
}

export function readRunStatus(value: unknown): ChatResponse["status"] | null {
  const status = readRecordString(readRecord(value), "status")
  if (status === "QUEUED" || status === "RUNNING") {
    return "RUNNING"
  }
  if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
    return "IDLE"
  }
  return null
}

export function readChatStatus(value: unknown): ChatResponse["status"] | null {
  return value === "IDLE" || value === "RUNNING" || value === "ARCHIVED" ? value : null
}

export function readMessageRole(value: unknown): ChatMessageResponse["role"] | null {
  return value === "USER" || value === "ASSISTANT" || value === "SYSTEM" || value === "TOOL" ? value : null
}

export function readMessageKind(value: unknown): ChatMessageResponse["kind"] | null {
  return (
    value === "CHAT" ||
    value === "THINKING" ||
    value === "TOOL_ACTIVITY" ||
    value === "COMMAND_EXECUTION" ||
    value === "FILE_CHANGE" ||
    value === "PLAN" ||
    value === "APPROVAL" ||
    value === "USER_INPUT_PROMPT" ||
    value === "ERROR"
  )
    ? value
    : null
}

export function readMessageStatus(value: unknown): ChatMessageResponse["status"] | null {
  return value === "PENDING" || value === "STREAMING" || value === "COMPLETED" || value === "FAILED" ? value : null
}

export function selectChatAccount(
  chat: ChatResponse | null,
  accounts: ProviderAccountResponse[],
  preferredAccountId?: string | null,
): ProviderAccountResponse | null {
  if (chat?.accountId) {
    return accounts.find((account) => account.id === chat.accountId) ?? null
  }
  if (preferredAccountId) {
    const preferred = accounts.find((account) => account.id === preferredAccountId)
    if (preferred) {
      return preferred
    }
  }
  if (chat?.providerId) {
    return accounts.find((account) => account.providerId === chat.providerId) ?? null
  }
  return accounts[0] ?? null
}

export function selectableChatAccounts(
  chat: ChatResponse | null,
  accounts: ProviderAccountResponse[],
): ProviderAccountResponse[] {
  return chat?.providerId ? accounts.filter((account) => account.providerId === chat.providerId) : accounts
}

export function upsertChat(chats: ChatResponse[], chat: ChatResponse): ChatResponse[] {
  const existingById = chats.find((entry) => entry.id === chat.id)
  if (existingById) {
    const nextChat = { ...chat, stats: chat.stats ?? existingById.stats ?? null }
    const rest = chats.filter((entry) => entry.id !== chat.id && !sameProviderThread(entry, chat))
    return [nextChat, ...rest]
  }

  const existing = chats.find((entry) => sameProviderThread(entry, chat))
  const nextChat = existing && !preferChatListItem(chat, existing)
    ? existing
    : { ...chat, stats: chat.stats ?? existing?.stats ?? null }
  const rest = chats.filter((entry) => entry.id !== nextChat.id && entry.id !== chat.id && !sameProviderThread(entry, chat))
  return [nextChat, ...rest]
}

export function sameProviderThread(left: ChatResponse, right: ChatResponse): boolean {
  return Boolean(
    left.externalThreadId &&
    right.externalThreadId &&
    left.providerId === right.providerId &&
    left.accountId === right.accountId &&
    left.externalThreadId === right.externalThreadId,
  )
}

export function preferChatListItem(candidate: ChatResponse, current: ChatResponse): boolean {
  if (candidate.status !== current.status) {
    return candidate.status === "RUNNING"
  }
  const candidateLastActivity = Date.parse(candidate.lastActivityAt)
  const currentLastActivity = Date.parse(current.lastActivityAt)
  if (candidateLastActivity !== currentLastActivity) {
    return candidateLastActivity > currentLastActivity
  }
  return Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt)
}

export function compareChatsByUpdatedTime(left: ChatResponse, right: ChatResponse): number {
  return Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

export function upsertMessage(messages: ChatMessageResponse[], message: ChatMessageResponse): ChatMessageResponse[] {
  const nextMessages = isOptimisticMessage(message) ? messages : removeOptimisticMessages(messages, message)
  const index = nextMessages.findIndex((entry) => entry.id === message.id)
  if (index === -1) {
    return [...nextMessages, message].sort((left, right) => left.sequence - right.sequence)
  }
  return nextMessages
    .map((entry) => (entry.id === message.id ? message : entry))
    .sort((left, right) => left.sequence - right.sequence)
}

export function removeOptimisticMessages(
  messages: ChatMessageResponse[],
  confirmed: Pick<ChatMessageResponse, "content" | "role">,
): ChatMessageResponse[] {
  if (confirmed.role !== "USER") {
    return messages
  }
  return messages.filter(
    (message) => !(isOptimisticMessage(message) && message.content.trim() === confirmed.content.trim()),
  )
}

export function isOptimisticMessage(message: ChatMessageResponse): boolean {
  const metadata = message.metadata
  return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.optimistic === true)
}

export function hasChatStats(stats: ChatResponse["stats"]): stats is NonNullable<ChatResponse["stats"]> {
  return Boolean(stats && (stats.additions > 0 || stats.deletions > 0))
}

export function titleFromPrompt(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, 80) || "New chat"
}

export function relativeTimeLabel(value: string): string {
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) {
    return ""
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) {
    return "just now"
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function createWorkspaceFromBrowserEntry(entry: BrowserEntry, existingWorkspaces: Workspace[], workspaceId?: string): Workspace {
  const id = workspaceId || uniqueWorkspaceId(entry, existingWorkspaces)
  const fileTree = [browserEntryToFileNode(entry, `${id}:root`)]
  const firstFile = findFirstFile(fileTree)

  return {
    id,
    name: displayNameForPath(entry.path),
    branch: "main",
    path: entry.path,
    selectedFileId: firstFile?.id ?? "",
    fileTree,
  }
}

export function uniqueWorkspaceId(entry: BrowserEntry, existingWorkspaces: Workspace[]) {
  const base = slugifyWorkspaceId(entry.path)
  let id = base
  let index = 2
  while (existingWorkspaces.some((workspace) => workspace.id === id)) {
    id = `${base}-${index}`
    index += 1
  }
  return id
}

export function slugifyWorkspaceId(path: string) {
  return displayNameForPath(path).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"
}

export function browserEntryToFileNode(entry: BrowserEntry, id: string): FileNode {
  if (entry.type !== "directory") {
    return {
      content: entry.content,
      id,
      icon: fileIconForName(entry.name),
      name: entry.name,
      path: entry.path,
      type: "file",
    }
  }

  return {
    id,
    name: entry.name,
    path: entry.path,
    type: "folder",
    children: entry.children?.map((child, index) =>
      browserEntryToFileNode(child, `${id}/${index}-${slugifyWorkspaceId(child.name)}`),
    ),
  }
}

export function updateFileNodeChildren(nodes: FileNode[], id: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.id === id && node.type === "folder") {
      return { ...node, children }
    }
    if (!node.children) {
      return node
    }
    return { ...node, children: updateFileNodeChildren(node.children, id, children) }
  })
}

export function findFirstFile(nodes: FileNode[]): FileNode | null {
  for (const node of nodes) {
    if (node.type === "file") {
      return node
    }
    const child = node.children ? findFirstFile(node.children) : null
    if (child) {
      return child
    }
  }
  return null
}

export function displayNameForPath(path: string) {
  const normalized = trimPathSeparator(normalizeBrowserPath(path))
  return normalized.split("/").filter(Boolean).at(-1) || normalized || path
}

export function normalizeBrowserPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/")
}

export function trimPathSeparator(path: string) {
  if (path === "/") {
    return path
  }
  return path.replace(/\/+$/, "")
}

export function normalizePathForCompare(path: string) {
  return trimPathSeparator(normalizeBrowserPath(path)).toLocaleLowerCase()
}

export function findFile(nodes: FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id && node.type === "file") {
      return node
    }
    const child = node.children ? findFile(node.children, id) : null
    if (child) {
      return child
    }
  }
  return null
}

export function findNode(nodes: FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node
    }
    const child = node.children ? findNode(node.children, id) : null
    if (child) {
      return child
    }
  }
  return null
}

export function findFileByWorkspacePath(nodes: FileNode[], path: string): FileNode | null {
  const target = normalizePathForCompare(path)
  if (!target) {
    return null
  }
  return findFileByWorkspacePathRecursive(nodes, target)
}

export function findFileByWorkspacePathRecursive(nodes: FileNode[], target: string, path: string[] = []): FileNode | null {
  for (const node of nodes) {
    const nextPath = [...path, node.name]
    if (node.type === "file") {
      const candidates = [
        nextPath.join("/"),
        nextPath.slice(1).join("/"),
        node.name,
      ].filter(Boolean)
      if (candidates.some((candidate) => normalizePathForCompare(candidate) === target)) {
        return node
      }
    }
    const child = node.children ? findFileByWorkspacePathRecursive(node.children, target, nextPath) : null
    if (child) {
      return child
    }
  }
  return null
}

export function findFilePath(nodes: FileNode[], id: string, path: string[] = []): string[] | null {
  for (const node of nodes) {
    const nextPath = [...path, node.name]
    if (node.id === id) {
      return nextPath
    }
    const childPath = node.children ? findFilePath(node.children, id, nextPath) : null
    if (childPath) {
      return childPath
    }
  }
  return null
}

export function fileIconForName(name: string): FileNode["icon"] {
  if (name.endsWith(".sh")) return "shell"
  if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".js") || name.endsWith(".jsx")) return "js"
  if (name.endsWith(".json")) return "json"
  if (name.endsWith(".md")) return "info"
  if (name.endsWith(".yml") || name.endsWith(".yaml") || name.includes("docker")) return "docker"
  if (name === "Makefile") return "make"
  if (name.endsWith(".rs") || name === "Cargo.toml" || name === "Cargo.lock") return "rust"
  if (name.startsWith(".env")) return "env"
  if (name.includes("git")) return "git"
  return "text"
}

export function fileLanguage(name: string) {
  if (name.endsWith(".tsx")) return "TypeScript React"
  if (name.endsWith(".ts")) return "TypeScript"
  if (name.endsWith(".js")) return "JavaScript"
  if (name.endsWith(".json")) return "JSON"
  if (name.endsWith(".md")) return "Markdown"
  if (name.endsWith(".sh")) return "Shell"
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return "YAML"
  if (name.endsWith(".toml")) return "TOML"
  if (name === "Makefile") return "Makefile"
  return "Plain Text"
}

export function monacoLanguageFor(name: string) {
  if (name.endsWith(".tsx") || name.endsWith(".ts")) return "typescript"
  if (name.endsWith(".jsx") || name.endsWith(".js")) return "javascript"
  if (name.endsWith(".json")) return "json"
  if (name.endsWith(".md")) return "markdown"
  if (name.endsWith(".sh")) return "shell"
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return "yaml"
  if (name.endsWith(".toml")) return "toml"
  if (name.endsWith(".rs")) return "rust"
  if (name.endsWith(".css")) return "css"
  if (name.endsWith(".html")) return "html"
  if (name === "Makefile") return "makefile"
  if (name === ".env.example") return "ini"
  if (name === "Dockerfile") return "dockerfile"
  return "plaintext"
}

export function fileContentFor(file: FileNode) {
  if (file.content) {
    return file.content
  }

  return ""
}
