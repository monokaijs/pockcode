import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileText,
  Folder,
  GripVertical,
  ListFilter,
  LoaderCircle,
  Plus,
  Search,
  Shield,
  SlidersHorizontal,
  Square,
  Terminal,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { MarkdownContent } from "@/components/session/chat-markdown"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, ReactNode } from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { ModeToggleButton } from "@/components/session/mode-toggle-button"
import { ProviderMark } from "@/components/session/provider-icons"
import { useProviderQuotas } from "@/components/session/provider-quota-context"
import {
  apiClient,
  type ChatMessageResponse,
  type ChatResponse,
  type ProviderAccountResponse,
  type ProviderDefinitionResponse,
  type ProviderModelListResponse,
} from "@/lib/api-client"
import {
  accessModeLabel,
  attachmentOnlyPrompt,
  attachmentsFromFiles,
  chatRenderEntryId,
  composerReasoningEffortLabel,
  composerReasoningEffortOptions,
  composerReasoningEffortValue,
  composerServiceTierLabel,
  composerServiceTierOptions,
  composerServiceTierValue,
  createClientId,
  defaultRuntimeDefaultValue,
  editedFilesTitle,
  fallbackComposerFeatures,
  fileRelativePath,
  findLast,
  firstToolAction,
  formatProviderQuota,
  groupChatRenderEntries,
  groupFileChanges,
  groupWorkMessages,
  isOptimisticMessage,
  isPendingUserInputPrompt,
  isRunningPlaceholderMessage,
  isToolMessage,
  moveItemAround,
  parseFileChangeMessage,
  queuedMessageRunIds,
  readComposerAccessMode,
  readComposerReasoningEffort,
  readComposerServiceTier,
  readRecordString,
  mergeProviderModelOptions,
  readUserInputQuestions,
  selectChatAccount,
  selectableChatAccounts,
  serverRequestResponseFor,
  stripInlineCode,
  workDurationLabel,
  workspaceRelativeDisplayPath,
} from "@/lib/session"
import { cn } from "@/lib/utils"
import type {
  ChatComposerAccessMode,
  ChatComposerAttachment,
  ChatComposerReasoningEffort,
  ChatComposerServiceTier,
  ChatComposerSubmit,
  ParsedFileChange,
  UserInputQuestion,
  Workspace,
} from "@/types/session"

const ChatFileLinkContext = createContext<{ openFileLink: (href: string) => boolean } | null>(null)

type ChatPaneState = ReturnType<typeof useChatPaneState>

const ChatPaneStateContext = createContext<ChatPaneState | null>(null)

function useChatPane(): ChatPaneState {
  const value = useContext(ChatPaneStateContext)
  if (!value) {
    throw new Error("useChatPane must be used within ChatPaneStateContext.")
  }
  return value
}

function hasStreamingMessages(messages: ChatMessageResponse[]): boolean {
  return messages.some((message) => message.status === "STREAMING")
}

type ChatPaneProps = {
  accounts: ProviderAccountResponse[]
  chat: ChatResponse | null
  error: string | null
  isLoading: boolean
  isMessagesLoading: boolean
  isSwitchingAccount: boolean
  messages: ChatMessageResponse[]
  preferredAccountId: string | null
  providerDefinitions: ProviderDefinitionResponse[]
  workspace: Workspace
  onDeleteQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage: (chatId: string, runId: string, content: string) => Promise<void>
  onFileLinkOpen: (href: string) => boolean
  onOpenProviders: () => void
  onToggleMode: () => void
  onReorderQueuedMessages: (chatId: string, runIds: string[]) => Promise<void>
  onPermissionModeChange: (chatId: string, permissionMode: ChatComposerAccessMode) => Promise<void>
  onRuntimeSettingsChange: (chatId: string, settings: { model?: string | null; reasoningEffort?: string | null; serviceTier?: string | null }) => Promise<void>
  onSendMessage: (input: ChatComposerSubmit) => Promise<void>
  onSteerQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onSwitchAccount: (accountId: string) => Promise<void>
  onStopChat: () => Promise<void>
}

export function ChatPane(props: ChatPaneProps) {
  const pane = useChatPaneState(props)

  return (
    <ChatPaneStateContext.Provider value={pane}>
      <ChatFileLinkContext.Provider value={pane.fileLinkContext}>
        <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card">
          <ChatPaneHeader />
          <ChatMessageList />
          <ChatComposer />
        </section>
      </ChatFileLinkContext.Provider>
    </ChatPaneStateContext.Provider>
  )
}

function useChatPaneState({
  accounts,
  chat,
  error,
  isLoading,
  isMessagesLoading,
  isSwitchingAccount,
  messages,
  preferredAccountId,
  providerDefinitions,
  workspace,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onFileLinkOpen,
  onOpenProviders,
  onToggleMode,
  onReorderQueuedMessages,
  onPermissionModeChange,
  onRuntimeSettingsChange,
  onSendMessage,
  onSteerQueuedMessage,
  onSwitchAccount,
  onStopChat,
}: ChatPaneProps) {
  const [draft, setDraft] = useState("")
  const [accessMode, setAccessMode] = useState<ChatComposerAccessMode>("askForApproval")
  const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([])
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [goalObjective, setGoalObjective] = useState<string | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [dismissedServerRequestIds, setDismissedServerRequestIds] = useState<Set<string>>(new Set())
  const [userInputAnswers, setUserInputAnswers] = useState<Record<string, Record<string, string>>>({})
  const [userInputSubmitting, setUserInputSubmitting] = useState(false)
  const [dragOverQueuedRunId, setDragOverQueuedRunId] = useState<string | null>(null)
  const [model, setModel] = useState("")
  const [modelOptions, setModelOptions] = useState<ProviderModelListResponse["data"]>([])
  const [reasoningEffort, setReasoningEffort] = useState<ChatComposerReasoningEffort>("medium")
  const [serviceTier, setServiceTier] = useState<ChatComposerServiceTier>("standard")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const runtimeSettingsRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { accountLimits } = useProviderQuotas()
  const selectableAccounts = selectableChatAccounts(chat, accounts)
  const account = selectChatAccount(chat, selectableAccounts, preferredAccountId)
  const accountQuota = account ? formatProviderQuota(accountLimits[account.id]) : null
  const providerDefinition = providerDefinitions.find((provider) => provider.id === account?.providerId) ?? null
  const providerIconById = useMemo(
    () => new Map(providerDefinitions.map((provider) => [provider.id, provider.icon])),
    [providerDefinitions],
  )
  const composerFeatures = providerDefinition?.composerFeatures ?? fallbackComposerFeatures(account?.providerId)
  const running = chat?.status === "RUNNING" || hasStreamingMessages(messages)
  const renderEntries = useMemo(() => groupChatRenderEntries(messages, running), [messages, running])
  const renderEntryIds = useMemo(() => renderEntries.map(chatRenderEntryId), [renderEntries])
  const queuedRunIds = useMemo(() => queuedMessageRunIds(messages), [messages])
  const pendingUserInputPrompt = useMemo(
    () => findLast(messages, (message) => isPendingUserInputPrompt(message) && !dismissedServerRequestIds.has(message.requestId ?? "")),
    [dismissedServerRequestIds, messages],
  )
  const pendingUserInputQuestions = useMemo(
    () => pendingUserInputPrompt ? readUserInputQuestions(pendingUserInputPrompt.rawPayload) : [],
    [pendingUserInputPrompt],
  )
  const appendedEntryIds = useAppendAnimationIds(renderEntryIds, chat?.id ?? null)
  const fileLinkContext = useMemo(() => ({ openFileLink: onFileLinkOpen }), [onFileLinkOpen])
  const hasComposerContent = Boolean(draft.trim()) || attachments.length > 0
  const canSend = hasComposerContent && !sending && !isSwitchingAccount
  const showStopAction = running && !hasComposerContent
  const supportsAccessMode = composerFeatures.includes("accessMode")
  const supportsFiles = composerFeatures.includes("fileAttachment")
  const supportsFolders = composerFeatures.includes("folderAttachment")
  const supportsGoal = composerFeatures.includes("goal")
  const supportsImages = composerFeatures.includes("imageAttachment")
  const supportsPlanMode = composerFeatures.includes("planMode")
  const supportsModels = Boolean(account && providerDefinition?.capabilities.includes("models"))
  const supportsReasoningEffort = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "reasoningEffort"))
  const supportsServiceTier = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "serviceTier"))
  const pendingUserInputRequestId = pendingUserInputPrompt?.requestId ?? null
  const mergedModelOptions = mergeProviderModelOptions(account?.providerId, modelOptions)
  const visibleModelOptions = (
    model && !mergedModelOptions.some((option) => option.model === model || option.id === model)
      ? [{ id: model, model, displayName: model }, ...mergedModelOptions]
      : mergedModelOptions
  ).filter((option) => !option.hidden)
  const selectedModelOption = visibleModelOptions.find((option) => option.model === model || option.id === model) ?? visibleModelOptions[0] ?? null

  useEffect(() => {
    const defaultPermissionMode = readRecordString(account?.runtimeDefaults, "permissionMode") || defaultRuntimeDefaultValue(account?.providerId, "permissionMode")
    setAccessMode(readComposerAccessMode(chat?.permissionMode ?? defaultPermissionMode))
    setGoalObjective(null)
    setPlanMode(chat?.collaborationMode === "plan")
    const defaultModel = readRecordString(account?.runtimeDefaults, "model") || defaultRuntimeDefaultValue(account?.providerId, "model")
    const defaultReasoningEffort = readRecordString(account?.runtimeDefaults, "reasoningEffort") || defaultRuntimeDefaultValue(account?.providerId, "reasoningEffort")
    const defaultServiceTier = readRecordString(account?.runtimeDefaults, "serviceTier") || defaultRuntimeDefaultValue(account?.providerId, "serviceTier")
    setModel(chat?.model ?? defaultModel)
    setReasoningEffort(readComposerReasoningEffort(
      chat?.reasoningEffort ?? defaultReasoningEffort,
    ))
    setServiceTier(readComposerServiceTier(
      chat?.serviceTier ?? defaultServiceTier,
    ))
  }, [
    account?.id,
    account?.providerId,
    account?.runtimeDefaults,
    chat?.id,
    chat?.permissionMode,
    chat?.collaborationMode,
    chat?.model,
    chat?.reasoningEffort,
    chat?.serviceTier,
  ])

  useEffect(() => {
    let cancelled = false
    setModelOptions([])
    if (!account || !supportsModels) {
      return
    }
    apiClient.providerAccounts.models(account.id)
      .then((response) => {
        if (!cancelled) {
          setModelOptions(response.data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [account?.id, supportsModels])

  useEffect(() => {
    if (!runtimeSettingsOpen) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!runtimeSettingsRef.current?.contains(target)) {
        setRuntimeSettingsOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [runtimeSettingsOpen])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
    })
  }, [chat?.id, messages.length, messages.at(-1)?.id, messages.at(-1)?.content])

  useEffect(() => {
    const element = textareaRef.current
    if (!element) {
      return
    }
    const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight) || 20
    const maxHeight = lineHeight * 12
    element.style.height = "0px"
    element.style.height = String(Math.min(element.scrollHeight, maxHeight)) + "px"
    element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [draft])

  const reorderQueuedMessage = useCallback((sourceRunId: string, targetRunId: string, placement: "after" | "before") => {
    if (!chat || sourceRunId === targetRunId || !queuedRunIds.includes(sourceRunId) || !queuedRunIds.includes(targetRunId)) {
      setDragOverQueuedRunId(null)
      return
    }
    const nextRunIds = moveItemAround(queuedRunIds, sourceRunId, targetRunId, placement)
    setDragOverQueuedRunId(null)
    if (nextRunIds.join("\u0001") === queuedRunIds.join("\u0001")) {
      return
    }
    void onReorderQueuedMessages(chat.id, nextRunIds)
  }, [chat, onReorderQueuedMessages, queuedRunIds])

  const submit = async () => {
    if (!canSend) {
      return
    }
    const content = draft.trim() || attachmentOnlyPrompt(attachments)
    setSending(true)
    try {
      await onSendMessage({
        attachments: attachments.map(({ id: _id, ...attachment }) => attachment),
        collaborationMode: supportsPlanMode ? (planMode ? "plan" : "default") : null,
        content,
        delivery: running ? "queue" : undefined,
        goalObjective,
        model: supportsModels ? model || selectedModelOption?.model || null : null,
        permissionMode: accessMode,
        reasoningEffort: supportsReasoningEffort ? composerReasoningEffortValue(reasoningEffort) : null,
        serviceTier: supportsServiceTier ? composerServiceTierValue(serviceTier) : null,
      })
      setDraft("")
      setAttachments([])
      setGoalObjective(null)
    } finally {
      setSending(false)
    }
  }

  const changeAccessMode = (value: string) => {
    const previousMode = accessMode
    const nextMode = readComposerAccessMode(value)
    setAccessMode(nextMode)
    if (chat && chat.permissionMode !== nextMode) {
      void onPermissionModeChange(chat.id, nextMode).catch(() => setAccessMode(previousMode))
    }
  }

  const changeModel = (value: string) => {
    const previousModel = model
    const nextModel = value
    setModel(nextModel)
    if (chat && (chat.model ?? "") !== nextModel) {
      void onRuntimeSettingsChange(chat.id, { model: nextModel || null }).catch(() => setModel(previousModel))
    }
  }

  const changeReasoningEffort = (value: string) => {
    const previousReasoningEffort = reasoningEffort
    const nextReasoningEffort = readComposerReasoningEffort(value)
    setReasoningEffort(nextReasoningEffort)
    const nextReasoningEffortValue = composerReasoningEffortValue(nextReasoningEffort)
    if (chat && (chat.reasoningEffort ?? "") !== nextReasoningEffortValue) {
      void onRuntimeSettingsChange(chat.id, { reasoningEffort: nextReasoningEffortValue }).catch(() => {
        setReasoningEffort(previousReasoningEffort)
      })
    }
  }

  const changeServiceTier = (value: string) => {
    const previousServiceTier = serviceTier
    const nextServiceTier = readComposerServiceTier(value)
    setServiceTier(nextServiceTier)
    const nextServiceTierValue = composerServiceTierValue(nextServiceTier)
    if (chat && (chat.serviceTier ?? "") !== nextServiceTierValue) {
      void onRuntimeSettingsChange(chat.id, { serviceTier: nextServiceTierValue }).catch(() => {
        setServiceTier(previousServiceTier)
      })
    }
  }

  const attachFiles = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (!files.length) {
      return
    }
    const nextAttachments = await attachmentsFromFiles(files, supportsImages)
    setAttachments((current) => [...current, ...nextAttachments])
  }

  const attachFolder = (event: ReactChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (!files.length) {
      return
    }
    const firstPath = fileRelativePath(files[0]) ?? files[0].name
    const folderName = firstPath.split("/")[0] || "Folder"
    setAttachments((current) => [
      ...current,
      {
        id: createClientId(),
        kind: "folder",
        name: folderName,
        path: folderName + "/ (" + files.length + " files)",
        size: files.reduce((total, file) => total + file.size, 0),
      },
    ])
  }

  const promptForGoal = () => {
    const objective = window.prompt("Goal objective", goalObjective ?? "")
    if (objective === null) {
      return
    }
    setGoalObjective(objective.trim() || null)
    setComposerMenuOpen(false)
  }

  const userInputAnswerValue = (question: UserInputQuestion): string => {
    const requestAnswers = pendingUserInputPrompt ? userInputAnswers[pendingUserInputPrompt.id] : undefined
    return requestAnswers?.[question.id] ?? question.options[0]?.label ?? ""
  }

  const updateUserInputAnswer = (questionId: string, value: string) => {
    if (!pendingUserInputPrompt) {
      return
    }
    setUserInputAnswers((current) => ({
      ...current,
      [pendingUserInputPrompt.id]: {
        ...current[pendingUserInputPrompt.id],
        [questionId]: value,
      },
    }))
  }

  const submitUserInput = async () => {
    if (!chat || !pendingUserInputRequestId || !pendingUserInputQuestions.length) {
      return
    }
    const answers = Object.fromEntries(
      pendingUserInputQuestions.map((question) => [question.id, { answers: [userInputAnswerValue(question)] }]),
    )
    setUserInputSubmitting(true)
    try {
      await apiClient.chats.respondToServerRequest(chat.id, pendingUserInputRequestId, {
        kind: "userInput",
        result: { answers },
      })
      setDismissedServerRequestIds((current) => new Set(current).add(pendingUserInputRequestId))
    } finally {
      setUserInputSubmitting(false)
    }
  }

  const removeAttachment = (attachmentId: string) => {
    setAttachments((current) => current.filter((item) => item.id !== attachmentId))
  }

  return {
    accessMode,
    account,
    accountLimits,
    accountQuota,
    accounts,
    appendedEntryIds,
    attachFiles,
    attachFolder,
    attachments,
    canSend,
    changeAccessMode,
    changeModel,
    changeReasoningEffort,
    changeServiceTier,
    chat,
    composerMenuOpen,
    draft,
    dragOverQueuedRunId,
    error,
    fileInputRef,
    fileLinkContext,
    folderInputRef,
    goalObjective,
    isLoading,
    isMessagesLoading,
    isSwitchingAccount,
    messages,
    model,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onOpenProviders,
    onSteerQueuedMessage,
    onStopChat,
    onSwitchAccount,
    onToggleMode,
    pendingUserInputPrompt,
    pendingUserInputQuestions,
    planMode,
    promptForGoal,
    providerDefinition,
    providerIconById,
    reasoningEffort,
    removeAttachment,
    renderEntries,
    reorderQueuedMessage,
    running,
    runtimeSettingsOpen,
    runtimeSettingsRef,
    scrollRef,
    selectedModelOption,
    selectableAccounts,
    sending,
    serviceTier,
    setAttachments,
    setComposerMenuOpen,
    setDraft,
    setDragOverQueuedRunId,
    setGoalObjective,
    setPlanMode,
    setRuntimeSettingsOpen,
    showStopAction,
    submit,
    submitUserInput,
    supportsAccessMode,
    supportsFiles,
    supportsFolders,
    supportsGoal,
    supportsModels,
    supportsPlanMode,
    supportsReasoningEffort,
    supportsServiceTier,
    textareaRef,
    updateUserInputAnswer,
    userInputAnswerValue,
    userInputSubmitting,
    visibleModelOptions,
    workspace,
  }
}

function ChatPaneHeader() {
  const pane = useChatPane()

  return (
    <header className="flex h-10 min-w-0 items-center gap-2 border-b border-border px-3">
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
        {pane.chat?.title ?? pane.workspace.name}
      </div>
      {pane.selectableAccounts.length ? <ChatAccountSelect /> : <ChatProvidersButton />}
      <ModeToggleButton mode="chat" onClick={pane.onToggleMode} />
    </header>
  )
}

function ChatProvidersButton() {
  const pane = useChatPane()

  return (
    <button
      className="h-7 rounded-md border border-border px-2 text-[12px] font-medium text-foreground hover:bg-accent"
      type="button"
      onClick={pane.onOpenProviders}
    >
      Providers
    </button>
  )
}

function ChatAccountSelect() {
  const pane = useChatPane()

  return (
    <>
      {pane.accountQuota ? (
        <span className="hidden shrink-0 text-[11px] font-medium text-muted-foreground sm:inline">
          {pane.accountQuota}
        </span>
      ) : null}
      <Select
        className="min-w-0 shrink-0"
        disabled={pane.running || pane.isSwitchingAccount}
        value={pane.account?.id ?? ""}
        onValueChange={(value) => void pane.onSwitchAccount(value)}
      >
        <SelectTrigger
          aria-label="Provider account"
          className="h-7 w-[min(42vw,11rem)] border-border bg-secondary px-2 text-[12px] font-medium text-foreground hover:bg-accent"
          title={pane.account ? pane.account.displayName + " · " + pane.account.providerId : undefined}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <ProviderMark icon={pane.providerDefinition?.icon} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{pane.account?.displayName ?? "Provider"}</span>
          </span>
        </SelectTrigger>
        <SelectContent align="end" className="border-border bg-popover text-foreground">
          {pane.selectableAccounts.map((entry) => {
            const quota = formatProviderQuota(pane.accountLimits[entry.id])
            return (
              <SelectItem
                className="text-[12px] text-foreground hover:bg-accent focus-visible:bg-accent"
                key={entry.id}
                label={entry.displayName + " · " + (quota ?? entry.providerId)}
                value={entry.id}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderMark icon={pane.providerIconById.get(entry.providerId)} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="min-w-0 truncate">{entry.displayName}</span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {entry.providerId}
                      {quota ? " · " + quota : ""}
                    </span>
                  </span>
                </span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    </>
  )
}

function ChatMessageList() {
  const pane = useChatPane()

  return (
    <div className="min-h-0 overflow-auto px-4 py-4 ide-scrollbar" ref={pane.scrollRef}>
      {pane.error ? (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {pane.error}
        </div>
      ) : null}
      {(pane.isLoading || pane.isMessagesLoading) && !pane.messages.length ? (
        <ChatMessageLoadingIndicator />
      ) : pane.renderEntries.length ? (
        <div className="mx-auto grid max-w-3xl gap-3">
          {pane.renderEntries.map((entry) => <ChatRenderEntryView entry={entry} key={chatRenderEntryId(entry)} />)}
        </div>
      ) : (
        <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
          {pane.accounts.length ? "New chat" : "Connect a provider"}
        </div>
      )}
    </div>
  )
}

function ChatMessageLoadingIndicator() {
  return (
    <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
      <span className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin text-info" />
        Loading
      </span>
    </div>
  )
}

function ChatRenderEntryView({ entry }: { entry: ChatPaneState["renderEntries"][number] }) {
  const pane = useChatPane()
  const entryId = chatRenderEntryId(entry)
  const animateIn = pane.appendedEntryIds.has(entryId)
  if (entry.type === "work") {
    return (
      <ChatWorkBlock
        animateIn={animateIn}
        completedAt={entry.completedAt}
        dragOverQueuedRunId={pane.dragOverQueuedRunId}
        finished={entry.finished}
        messages={entry.messages}
        startedAt={entry.startedAt}
        onDeleteQueuedMessage={pane.onDeleteQueuedMessage}
        onEditQueuedMessage={pane.onEditQueuedMessage}
        onQueuedDragEnd={() => pane.setDragOverQueuedRunId(null)}
        onQueuedDragEnter={pane.setDragOverQueuedRunId}
        onQueuedDrop={pane.reorderQueuedMessage}
        onSteerQueuedMessage={pane.onSteerQueuedMessage}
      />
    )
  }
  if (entry.type === "fileChange") {
    return <ChatFileChangeBlock animateIn={animateIn} messages={entry.messages} workspacePath={pane.workspace.path} />
  }
  return (
    <ChatMessageRow
      animateIn={animateIn}
      dragOverQueuedRunId={pane.dragOverQueuedRunId}
      message={entry.message}
      onDeleteQueuedMessage={pane.onDeleteQueuedMessage}
      onEditQueuedMessage={pane.onEditQueuedMessage}
      onQueuedDragEnd={() => pane.setDragOverQueuedRunId(null)}
      onQueuedDragEnter={pane.setDragOverQueuedRunId}
      onQueuedDrop={pane.reorderQueuedMessage}
      onSteerQueuedMessage={pane.onSteerQueuedMessage}
    />
  )
}

function ChatComposer() {
  const pane = useChatPane()

  return (
    <footer className="px-3 pb-3">
      <div className="mx-auto rounded-lg border border-border bg-secondary p-3 shadow-inner">
        <PendingUserInputPrompt />
        <ChatAttachmentList attachments={pane.attachments} onRemove={pane.removeAttachment} />
        <textarea
          className="min-h-8 w-full resize-none bg-transparent text-[13px] font-medium leading-5 text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Describe the outcome you want"
          ref={pane.textareaRef}
          value={pane.draft}
          onChange={(event) => pane.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void pane.submit()
            }
          }}
        />
        <ComposerControls />
      </div>
    </footer>
  )
}

function PendingUserInputPrompt() {
  const pane = useChatPane()

  if (!pane.pendingUserInputPrompt || !pane.pendingUserInputQuestions.length) {
    return null
  }
  return (
    <div className="mb-3 grid gap-2 rounded-md border border-border bg-card p-2.5 text-[12px] text-foreground">
      {pane.pendingUserInputQuestions.map((question) => (
        <PendingUserInputQuestion key={question.id} question={question} />
      ))}
      <div className="flex justify-end">
        <button
          className="h-7 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={pane.userInputSubmitting}
          type="button"
          onClick={() => void pane.submitUserInput()}
        >
          {pane.userInputSubmitting ? "Sending" : "Submit"}
        </button>
      </div>
    </div>
  )
}

function PendingUserInputQuestion({ question }: { question: UserInputQuestion }) {
  const pane = useChatPane()

  return (
    <div className="grid gap-1.5">
      <div className="font-medium text-foreground">{question.question}</div>
      {question.options.length ? (
        <div className="flex flex-wrap gap-1">
          {question.options.map((option) => {
            const selected = pane.userInputAnswerValue(question) === option.label
            return (
              <button
                className={cn(
                  "h-7 rounded-md border px-2 text-[11px] font-medium",
                  selected
                    ? "border-primary bg-primary/20 text-foreground"
                    : "border-border bg-secondary text-muted-foreground hover:bg-accent",
                )}
                key={option.label}
                title={option.description}
                type="button"
                onClick={() => pane.updateUserInputAnswer(question.id, option.label)}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      ) : (
        <input
          className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:border-primary"
          type={question.isSecret ? "password" : "text"}
          value={pane.userInputAnswerValue(question)}
          onChange={(event) => pane.updateUserInputAnswer(question.id, event.target.value)}
        />
      )}
    </div>
  )
}

function ChatAttachmentList({ attachments, onRemove }: { attachments: ChatComposerAttachment[]; onRemove: (attachmentId: string) => void }) {
  if (!attachments.length) {
    return null
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      {attachments.map((attachment) => (
        <button
          className="flex max-w-[12rem] items-center gap-1 rounded-md border border-border bg-secondary px-1.5 py-1 hover:bg-accent"
          key={attachment.id}
          title={attachment.path ?? attachment.name}
          type="button"
          onClick={() => onRemove(attachment.id)}
        >
          {attachment.kind === "folder" ? <Folder className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate">{attachment.name}</span>
          <X className="size-3 shrink-0" />
        </button>
      ))}
    </div>
  )
}

function ComposerControls() {
  const pane = useChatPane()

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-muted-foreground -mb-2 -mx-2">
      <ComposerContextMenu />
      {pane.supportsAccessMode ? <ComposerAccessModeSelect /> : null}
      <ComposerGoalChip />
      <ComposerPlanChip />
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        {pane.supportsModels || pane.supportsReasoningEffort || pane.supportsServiceTier ? <ComposerRuntimeSettingsMenu /> : null}
        <ComposerSendButton />
      </div>
    </div>
  )
}

function ComposerContextMenu() {
  const pane = useChatPane()

  return (
    <div className="relative">
      <button
        aria-expanded={pane.composerMenuOpen}
        aria-label="Add context"
        className="grid size-7 place-items-center rounded-md text-foreground hover:bg-accent"
        type="button"
        onClick={() => pane.setComposerMenuOpen((current) => !current)}
      >
        <Plus className="size-4" />
      </button>
      {pane.composerMenuOpen ? <ComposerContextMenuItems /> : null}
      <input className="hidden" multiple ref={pane.fileInputRef} type="file" onChange={(event) => void pane.attachFiles(event)} />
      <input
        className="hidden"
        multiple
        ref={pane.folderInputRef}
        type="file"
        onChange={pane.attachFolder}
        {...{ webkitdirectory: "", directory: "" }}
      />
    </div>
  )
}

function ComposerContextMenuItems() {
  const pane = useChatPane()

  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 w-56 rounded-md border border-border bg-popover p-1 text-foreground shadow-lg">
      <ComposerMenuButton disabled={!pane.supportsFiles} icon={<FileText className="size-3.5" />} label="Attach files" onClick={() => {
        pane.setComposerMenuOpen(false)
        pane.fileInputRef.current?.click()
      }} />
      <ComposerMenuButton disabled={!pane.supportsFolders} icon={<Folder className="size-3.5" />} label="Attach folder" onClick={() => {
        pane.setComposerMenuOpen(false)
        pane.folderInputRef.current?.click()
      }} />
      <ComposerMenuButton disabled={!pane.supportsGoal} icon={<Shield className="size-3.5" />} label="Goal" onClick={pane.promptForGoal} />
      <ComposerMenuButton disabled={!pane.supportsPlanMode} icon={<ListFilter className="size-3.5" />} label="Plan mode" suffix={pane.planMode ? "On" : null} onClick={() => {
        pane.setPlanMode((current) => !current)
        pane.setComposerMenuOpen(false)
      }} />
    </div>
  )
}

function ComposerMenuButton({
  disabled,
  icon,
  label,
  suffix,
  onClick,
}: {
  disabled: boolean
  icon: ReactNode
  label: string
  suffix?: string | null
  onClick: () => void
}) {
  return (
    <button
      className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {suffix ? <span className="text-[11px] text-info">{suffix}</span> : null}
    </button>
  )
}

function ComposerAccessModeSelect() {
  const pane = useChatPane()

  return (
    <Select className="min-w-0" disabled={pane.sending || pane.isSwitchingAccount} value={pane.accessMode} onValueChange={pane.changeAccessMode}>
      <SelectTrigger aria-label="Access mode" className="h-7 w-auto border-transparent bg-transparent px-2 text-[12px] font-medium text-foreground shadow-none hover:bg-accent">
        <span className="flex min-w-0 items-center gap-1.5">
          <Shield className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{accessModeLabel(pane.accessMode)}</span>
        </span>
      </SelectTrigger>
      <SelectContent align="start" className="border-border bg-popover text-foreground">
        <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="askForApproval">Ask for approval</SelectItem>
        <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="fullAccess">Full access</SelectItem>
      </SelectContent>
    </Select>
  )
}

function ComposerRuntimeSettingsMenu() {
  const pane = useChatPane()
  const runtimeLabel = [
    pane.supportsModels ? pane.selectedModelOption?.displayName ?? pane.model : null,
    pane.supportsReasoningEffort ? composerReasoningEffortLabel(pane.reasoningEffort) : null,
    pane.supportsServiceTier ? composerServiceTierLabel(pane.serviceTier) : null,
  ].filter(Boolean).join(" / ")
  const disabled = pane.sending || pane.running || pane.isSwitchingAccount

  return (
    <div className="relative min-w-0" ref={pane.runtimeSettingsRef}>
      <button
        aria-expanded={pane.runtimeSettingsOpen}
        aria-label="Runtime settings"
        className="flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55"
        disabled={disabled}
        type="button"
        onClick={() => pane.setRuntimeSettingsOpen((open) => !open)}
      >
        <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{runtimeLabel}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", pane.runtimeSettingsOpen && "rotate-180")} />
      </button>
      {pane.runtimeSettingsOpen ? (
        <div className="absolute bottom-9 right-0 z-40 w-64 overflow-hidden rounded-md border border-border bg-popover py-1 text-foreground shadow-xl">
          {pane.supportsReasoningEffort ? (
            <ComposerRuntimeMenuSection icon={<Brain className="size-3.5 text-muted-foreground" />} label="Reasoning">
              {composerReasoningEffortOptions.map((option) => (
                <ComposerRuntimeMenuItem
                  key={option.value}
                  selected={pane.reasoningEffort === option.value}
                  title={option.label}
                  onClick={() => pane.changeReasoningEffort(option.value)}
                />
              ))}
            </ComposerRuntimeMenuSection>
          ) : null}
          {pane.supportsModels ? (
            <ComposerRuntimeMenuSection icon={<Cpu className="size-3.5 text-muted-foreground" />} label="Model">
              {pane.visibleModelOptions.map((option) => (
                <ComposerRuntimeMenuItem
                  key={option.id}
                  selected={(pane.model || pane.selectedModelOption?.model) === option.model || pane.model === option.id}
                  title={option.displayName}
                  onClick={() => pane.changeModel(option.model)}
                />
              ))}
            </ComposerRuntimeMenuSection>
          ) : null}
          {pane.supportsServiceTier ? (
            <ComposerRuntimeMenuSection icon={<Zap className="size-3.5 text-muted-foreground" />} label="Speed">
              {composerServiceTierOptions.map((option) => (
                <ComposerRuntimeMenuItem
                  description={option.description}
                  key={option.value}
                  selected={pane.serviceTier === option.value}
                  title={option.label}
                  onClick={() => pane.changeServiceTier(option.value)}
                />
              ))}
            </ComposerRuntimeMenuSection>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ComposerRuntimeMenuSection({ children, icon, label }: { children: ReactNode; icon: ReactNode; label: string }) {
  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex h-7 items-center gap-2 px-2 text-[11px] font-medium text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="pb-1">{children}</div>
    </div>
  )
}

function ComposerRuntimeMenuItem({
  description,
  selected,
  title,
  onClick,
}: {
  description?: string
  selected: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      className="flex min-h-8 w-full min-w-0 items-center gap-2 px-2 text-left text-[12px] hover:bg-accent"
      type="button"
      onClick={onClick}
    >
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{title}</span>
        {description ? <span className="truncate text-[11px] font-normal text-muted-foreground">{description}</span> : null}
      </span>
      <Check className={cn("size-3.5 shrink-0 text-info", selected ? "opacity-100" : "opacity-0")} />
    </button>
  )
}

function ComposerGoalChip() {
  const pane = useChatPane()

  if (!pane.goalObjective) {
    return null
  }
  return (
    <button
      className="flex h-7 max-w-[14rem] items-center gap-1 rounded-md border border-border bg-secondary px-2 text-[11px] text-foreground hover:bg-accent"
      title={pane.goalObjective}
      type="button"
      onClick={() => pane.setGoalObjective(null)}
    >
      <Shield className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">Goal: {pane.goalObjective}</span>
      <X className="size-3 shrink-0" />
    </button>
  )
}

function ComposerPlanChip() {
  const pane = useChatPane()

  if (!pane.planMode) {
    return null
  }
  return (
    <button
      className="flex h-7 items-center gap-1 rounded-md border border-primary/20 bg-primary/15 px-2 text-[11px] text-primary hover:bg-primary/20"
      type="button"
      onClick={() => pane.setPlanMode(false)}
    >
      <ListFilter className="size-3.5 shrink-0" />
      <span>Plan mode</span>
      <X className="size-3 shrink-0" />
    </button>
  )
}

function ComposerSendButton() {
  const pane = useChatPane()

  return (
    <button
      className={cn(
        "grid size-7 shrink-0 place-items-center text-lg disabled:cursor-not-allowed disabled:opacity-45",
        pane.showStopAction
          ? "rounded-full bg-foreground text-background hover:bg-foreground/90"
          : "rounded-md text-foreground hover:bg-accent",
      )}
      aria-label={pane.showStopAction ? "Stop chat" : "Send message"}
      disabled={pane.showStopAction ? false : !pane.canSend}
      type="button"
      onClick={() => pane.showStopAction ? void pane.onStopChat() : void pane.submit()}
    >
      {pane.showStopAction ? <Square className="size-3 fill-current" /> : "↵"}
    </button>
  )
}

function ChatMessageRow({
  animateIn,
  dragOverQueuedRunId,
  message,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onQueuedDragEnd,
  onQueuedDragEnter,
  onQueuedDrop,
  onSteerQueuedMessage,
}: {
  animateIn?: boolean
  dragOverQueuedRunId?: string | null
  message: ChatMessageResponse
  onDeleteQueuedMessage?: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage?: (chatId: string, runId: string, content: string) => Promise<void>
  onQueuedDragEnd?: () => void
  onQueuedDragEnter?: (runId: string) => void
  onQueuedDrop?: (sourceRunId: string, targetRunId: string, placement: "after" | "before") => void
  onSteerQueuedMessage?: (chatId: string, runId: string) => Promise<void>
}) {
  const fileLinks = useContext(ChatFileLinkContext)

  if (isToolMessage(message)) {
    return <ToolCallMessageRow animateIn={animateIn} message={message} />
  }

  const user = message.role === "USER"
  const error = message.kind === "ERROR"
  const queued = user && message.status === "PENDING" && Boolean(message.runId)
  const optimistic = isOptimisticMessage(message)
  const content = message.content || (message.status === "STREAMING" ? "Running" : "")
  const queueSortingEnabled = queued && Boolean(onQueuedDrop)
  const draggingOver = queued && message.runId === dragOverQueuedRunId

  return (
    <article
      className={cn(
        "grid gap-1",
        animateIn && "chat-append-enter",
        user && "justify-items-end",
        optimistic && "opacity-60 transition-opacity",
        draggingOver && "rounded-md outline outline-1 outline-primary/70",
      )}
      draggable={queueSortingEnabled}
      onDragEnd={() => onQueuedDragEnd?.()}
      onDragEnter={() => {
        if (queued && message.runId) {
          onQueuedDragEnter?.(message.runId)
        }
      }}
      onDragOver={(event) => {
        if (queued) {
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
        }
      }}
      onDragStart={(event: ReactDragEvent<HTMLElement>) => {
        if (!queued || !message.runId) {
          return
        }
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", message.runId)
      }}
      onDrop={(event) => {
        if (!queued || !message.runId) {
          return
        }
        event.preventDefault()
        const sourceRunId = event.dataTransfer.getData("text/plain")
        if (sourceRunId) {
          const bounds = event.currentTarget.getBoundingClientRect()
          const placement = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before"
          onQueuedDrop?.(sourceRunId, message.runId, placement)
        }
      }}
    >
      <div
        className={cn(
          "min-w-0 text-[13px] leading-6",
          user
            ? "max-w-[min(680px,100%)] rounded-md bg-muted px-3 py-2 text-foreground"
            : error
              ? "w-full text-destructive"
              : "w-full text-foreground",
        )}
      >
        <MarkdownContent
          animateChanges={!user}
          compact={user}
          content={content}
          openFileLink={fileLinks?.openFileLink}
          scopeKey={message.id}
        />
      </div>
      {queued && message.runId ? (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="grid size-5 cursor-grab place-items-center rounded text-muted-foreground" title="Drag to reorder">
            <GripVertical className="size-3.5" />
          </span>
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            type="button"
            onClick={() => void onSteerQueuedMessage?.(message.chatId, message.runId!)}
          >
            Steer
          </button>
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            type="button"
            onClick={() => void onEditQueuedMessage?.(message.chatId, message.runId!, message.content)}
          >
            Edit
          </button>
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-destructive"
            type="button"
            onClick={() => void onDeleteQueuedMessage?.(message.chatId, message.runId!)}
          >
            Delete
          </button>
        </div>
      ) : null}
    </article>
  )
}

function ToolCallMessageRow({ animateIn, message }: { animateIn?: boolean; message: ChatMessageResponse }) {
  const [expanded, setExpanded] = useState(false)
  const [responding, setResponding] = useState<"approve" | "deny" | null>(null)
  const fileLinks = useContext(ChatFileLinkContext)
  const Icon = toolCallIcon(message)
  const title = toolCallTitle(message)
  const fileChanges = message.kind === "FILE_CHANGE" ? parseFileChangeMessage(message) : []
  const detail = toolCallDetail(message)
  const hasDetail = message.kind === "FILE_CHANGE" || Boolean(detail)
  const canRespond = message.status === "PENDING" && Boolean(message.requestId) &&
    message.kind === "APPROVAL"

  const respond = async (approved: boolean) => {
    if (!message.requestId) {
      return
    }
    setResponding(approved ? "approve" : "deny")
    try {
      await apiClient.chats.respondToServerRequest(message.chatId, message.requestId, serverRequestResponseFor(message, approved))
    } finally {
      setResponding(null)
    }
  }

  return (
    <article className={cn("min-w-0 text-[13px] text-muted-foreground", animateIn && "chat-append-enter")}>
      <div className="flex min-h-7 max-w-full items-center gap-2">
        <button
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-left",
            hasDetail && "hover:text-foreground",
            !hasDetail && "cursor-default",
          )}
          disabled={!hasDetail}
          type="button"
          onClick={() => {
            if (hasDetail) {
              setExpanded((current) => !current)
            }
          }}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {hasDetail ? (
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
          ) : null}
        </button>
        {canRespond ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-success hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(responding)}
              type="button"
              onClick={() => void respond(true)}
            >
              {responding === "approve" ? "Approving" : "Approve"}
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(responding)}
              type="button"
              onClick={() => void respond(false)}
            >
              {responding === "deny" ? "Denying" : "Deny"}
            </button>
          </div>
        ) : null}
      </div>
      {expanded && hasDetail ? (
        <div className="ml-5 mt-1 min-w-0 border-l border-border pl-3 text-foreground">
          {message.kind === "FILE_CHANGE" ? (
            <FileChangeStatsList changes={fileChanges} fallbackCount={1} />
          ) : (
            <MarkdownContent compact content={detail || title} openFileLink={fileLinks?.openFileLink} />
          )}
        </div>
      ) : null}
    </article>
  )
}

function toolCallDetail(message: ChatMessageResponse): string | null {
  if (message.kind === "FILE_CHANGE") {
    return null
  }

  if (message.kind === "COMMAND_EXECUTION") {
    const action = firstToolAction(message.content)
    if (action && isSummarizedCommandAction(action)) {
      return null
    }
    return commandOutputDetail(message.content) ?? (message.content.trim() || null)
  }

  return message.content.trim() || null
}

function isSummarizedCommandAction(action: string): boolean {
  return action.startsWith("read ") || action.startsWith("list ") || action.startsWith("search")
}

function commandOutputDetail(content: string): string | null {
  const output = content.match(/(?:^|\n)Output\s*\n~~~([\w.-]*)\n([\s\S]*?)\n~~~/u)
  const language = output?.[1]?.trim() || "text"
  const value = output?.[2]?.trim()
  return value ? `~~~${language}\n${value}\n~~~` : null
}

function toolCallIcon(message: ChatMessageResponse): LucideIcon {
  if (message.kind === "FILE_CHANGE") {
    return FileText
  }
  if (message.kind === "COMMAND_EXECUTION") {
    const action = firstToolAction(message.content)
    if (action?.startsWith("read ") || action?.startsWith("list ")) {
      return FileText
    }
    if (action?.startsWith("search")) {
      return Search
    }
    return Terminal
  }
  if (message.content.toLowerCase().startsWith("web search")) {
    return Search
  }
  return Wrench
}

function toolCallTitle(message: ChatMessageResponse): string {
  if (message.status === "STREAMING") {
    return activeToolCallTitle(message)
  }

  if (message.kind === "FILE_CHANGE") {
    const files = parseFileChangeMessage(message)
    if (files.length === 1) {
      return `Edited ${files[0].path}`
    }
    return files.length ? `Edited ${files.length} files` : "Edited files"
  }

  if (message.kind === "COMMAND_EXECUTION") {
    const action = firstToolAction(message.content)
    if (action?.startsWith("read ")) {
      return `Read ${action.slice("read ".length)}`
    }
    if (action?.startsWith("list ")) {
      return `Listed ${action.slice("list ".length)}`
    }
    if (action?.startsWith("search")) {
      return "Searched code"
    }
    const command = message.content.match(/~~~sh\n([\s\S]*?)\n~~~/u)?.[1]?.split(/\r?\n/u)[0]?.trim()
    return command ? `Ran ${command}` : "Ran command"
  }

  return stripInlineCode(message.content.split(/\r?\n/u)[0]?.trim() || "Used tool")
}

function activeToolCallTitle(message: ChatMessageResponse): string {
  if (message.kind === "FILE_CHANGE") {
    const files = parseFileChangeMessage(message)
    if (files.length === 1) {
      return `Editing ${files[0].path}`
    }
    return files.length ? `Editing ${files.length} files` : "Editing files"
  }

  if (message.kind === "COMMAND_EXECUTION") {
    const action = firstToolAction(message.content)
    if (action?.startsWith("read ")) {
      return `Reading ${action.slice("read ".length)}`
    }
    if (action?.startsWith("list ")) {
      return `Reading ${action.slice("list ".length)}`
    }
    if (action?.startsWith("search")) {
      const detail = action.slice("search".length).trim()
      return detail ? `Searching ${detail}` : "Searching code"
    }
    const command = message.content.match(/~~~sh\n([\s\S]*?)\n~~~/u)?.[1]?.split(/\r?\n/u)[0]?.trim()
    return command ? `Running ${command}` : "Running command"
  }

  const firstLine = stripToolStatusSuffix(stripInlineCode(message.content.split(/\r?\n/u)[0]?.trim() || "tool"))
  const query = message.content.match(/~~~text\n([\s\S]*?)\n~~~/u)?.[1]?.split(/\r?\n/u)[0]?.trim()
  if (firstLine.toLowerCase().startsWith("web search")) {
    return query ? `Searching web for ${query}` : "Searching web"
  }
  if (firstLine.startsWith("MCP tool ")) {
    return `Using ${firstLine.slice("MCP tool ".length)}`
  }
  if (firstLine.startsWith("Tool ")) {
    return `Using ${firstLine.slice("Tool ".length)}`
  }
  if (firstLine.toLowerCase().startsWith("image generation")) {
    return "Generating image"
  }
  return `Using ${firstLine}`
}

function stripToolStatusSuffix(value: string): string {
  return value.replace(/\s+(inProgress|completed|failed|declined)$/u, "").trim()
}

function FileChangeStatsList({
  changes,
  fallbackCount,
}: {
  changes: ParsedFileChange[]
  fallbackCount: number
}) {
  if (!changes.length) {
    return <div className="text-[12px] text-muted-foreground">Edited {fallbackCount} files</div>
  }

  return (
    <div className="grid gap-1.5">
      {changes.map((change, index) => (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px]" key={`${change.path}:${index}`}>
          <span className="truncate text-foreground">{change.path}</span>
          <span className="text-diff-addition-foreground">
            +{change.additions} <span className="text-diff-deletion-foreground">-{change.deletions}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function useAppendAnimationIds(ids: string[], scopeKey: string | null, enabled = true): Set<string> {
  const stateRef = useRef<{ scopeKey: string | null; seenIds: Set<string> }>({
    scopeKey: null,
    seenIds: new Set(),
  })
  const idsKey = ids.join("\u0001")

  return useMemo(() => {
    if (!enabled) {
      return new Set<string>()
    }

    const state = stateRef.current
    if (state.scopeKey !== scopeKey) {
      stateRef.current = { scopeKey, seenIds: new Set(ids) }
      return new Set<string>()
    }

    const appendedIds = new Set(ids.filter((id) => !state.seenIds.has(id)))
    for (const id of ids) {
      state.seenIds.add(id)
    }
    return appendedIds
  }, [enabled, idsKey, scopeKey])
}

function workSummaryIcon(messages: ChatMessageResponse[]): LucideIcon {
  const firstTool = messages.find(isToolMessage)
  return firstTool ? toolCallIcon(firstTool) : Wrench
}

function workSummaryLabel(messages: ChatMessageResponse[]): string {
  const counts = messages.reduce(
    (current, message) => {
      if (message.kind === "FILE_CHANGE") {
        current.edits += Math.max(1, parseFileChangeMessage(message).length)
        return current
      }
      if (message.kind === "COMMAND_EXECUTION") {
        const action = firstToolAction(message.content)
        if (action?.startsWith("read ") || action?.startsWith("list ")) {
          current.reads += 1
          return current
        }
        if (action?.startsWith("search")) {
          current.searches += 1
          return current
        }
        current.commands += 1
        return current
      }
      if (isToolMessage(message)) {
        current.tools += 1
      }
      return current
    },
    { commands: 0, edits: 0, reads: 0, searches: 0, tools: 0 },
  )
  const phrases = [
    counts.reads ? `Read ${counts.reads} ${counts.reads === 1 ? "file" : "files"}` : "",
    counts.searches ? (counts.searches === 1 ? "searched code" : `searched code ${counts.searches} times`) : "",
    counts.commands ? `ran ${counts.commands === 1 ? "a command" : `${counts.commands} commands`}` : "",
    counts.edits ? `edited ${counts.edits === 1 ? "a file" : `${counts.edits} files`}` : "",
    counts.tools ? `used ${counts.tools === 1 ? "a tool" : `${counts.tools} tools`}` : "",
  ].filter(Boolean)

  if (!phrases.length) {
    return "Completed actions"
  }
  if (phrases.length === 1) {
    return phrases[0] ?? "Completed actions"
  }
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
}

function WorkActivityStatus({ messages }: { messages: ChatMessageResponse[] }) {
  const activeAction = findLast(messages, (message) => isToolMessage(message) && message.status === "STREAMING")
  const Icon = activeAction ? toolCallIcon(activeAction) : LoaderCircle
  const label = activeAction ? toolCallTitle(activeAction) : "Thinking"

  return (
    <div className="chat-append-enter flex min-h-7 max-w-full items-center gap-2 text-[13px] text-muted-foreground">
      <Icon className={cn("size-3.5 shrink-0", activeAction ? "" : "animate-spin")} />
      <span className="min-w-0 truncate">
        {label}
        <AnimatedEllipsis />
      </span>
    </div>
  )
}

function AnimatedEllipsis() {
  return (
    <span aria-hidden="true" className="inline-flex w-4">
      <span className="chat-status-dot">.</span>
      <span className="chat-status-dot">.</span>
      <span className="chat-status-dot">.</span>
    </span>
  )
}

function ChatWorkBlock({
  animateIn,
  completedAt,
  dragOverQueuedRunId,
  finished,
  messages,
  startedAt,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onQueuedDragEnd,
  onQueuedDragEnter,
  onQueuedDrop,
  onSteerQueuedMessage,
}: {
  animateIn?: boolean
  completedAt?: string | null
  dragOverQueuedRunId?: string | null
  finished: boolean
  messages: ChatMessageResponse[]
  startedAt?: string | null
  onDeleteQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage: (chatId: string, runId: string, content: string) => Promise<void>
  onQueuedDragEnd?: () => void
  onQueuedDragEnter?: (runId: string) => void
  onQueuedDrop?: (sourceRunId: string, targetRunId: string, placement: "after" | "before") => void
  onSteerQueuedMessage: (chatId: string, runId: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(!finished)
  const visibleMessages = useMemo(() => messages.filter((message) => !isRunningPlaceholderMessage(message)), [messages])
  const workEntries = useMemo(() => groupWorkMessages(visibleMessages, finished), [finished, visibleMessages])
  const messageIds = useMemo(() => visibleMessages.map((message) => message.id), [visibleMessages])
  const appendedMessageIds = useAppendAnimationIds(
    messageIds,
    visibleMessages[0]?.runId ?? visibleMessages[0]?.id ?? messages[0]?.runId ?? messages[0]?.id ?? null,
    !finished && expanded,
  )
  const nowMs = useNowMs(!finished)
  const duration = workDurationLabel(messages, startedAt, completedAt, finished, nowMs)

  useEffect(() => {
    setExpanded(!finished)
  }, [finished])

  return (
    <section className={cn("min-w-0 text-[13px] text-muted-foreground", animateIn && "chat-append-enter")}>
      <button
        className="flex h-6 max-w-full items-center gap-1.5 text-left font-medium hover:text-foreground"
        type="button"
        onClick={() => {
          if (finished) {
            setExpanded((current) => !current)
          }
        }}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <span className="truncate">{duration ? `Worked for ${duration}` : "Worked"}</span>
      </button>
      {expanded ? (
        <div className="mt-2 grid gap-3">
          {workEntries.map((entry) => entry.type === "actionGroup" ? (
            <CompactActionGroup
              animateIn={entry.messages.some((message) => appendedMessageIds.has(message.id))}
              dragOverQueuedRunId={dragOverQueuedRunId}
              key={entry.id}
              messages={entry.messages}
              onDeleteQueuedMessage={onDeleteQueuedMessage}
              onEditQueuedMessage={onEditQueuedMessage}
              onQueuedDragEnd={onQueuedDragEnd}
              onQueuedDragEnter={onQueuedDragEnter}
              onQueuedDrop={onQueuedDrop}
              onSteerQueuedMessage={onSteerQueuedMessage}
            />
          ) : (
            <ChatMessageRow
              animateIn={appendedMessageIds.has(entry.message.id)}
              dragOverQueuedRunId={dragOverQueuedRunId}
              key={entry.message.id}
              message={entry.message}
              onDeleteQueuedMessage={onDeleteQueuedMessage}
              onEditQueuedMessage={onEditQueuedMessage}
              onQueuedDragEnd={onQueuedDragEnd}
              onQueuedDragEnter={onQueuedDragEnter}
              onQueuedDrop={onQueuedDrop}
              onSteerQueuedMessage={onSteerQueuedMessage}
            />
          ))}
          {!finished ? <WorkActivityStatus messages={messages} /> : null}
        </div>
      ) : null}
    </section>
  )
}

function CompactActionGroup({
  animateIn,
  dragOverQueuedRunId,
  messages,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onQueuedDragEnd,
  onQueuedDragEnter,
  onQueuedDrop,
  onSteerQueuedMessage,
}: {
  animateIn?: boolean
  dragOverQueuedRunId?: string | null
  messages: ChatMessageResponse[]
  onDeleteQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage: (chatId: string, runId: string, content: string) => Promise<void>
  onQueuedDragEnd?: () => void
  onQueuedDragEnter?: (runId: string) => void
  onQueuedDrop?: (sourceRunId: string, targetRunId: string, placement: "after" | "before") => void
  onSteerQueuedMessage: (chatId: string, runId: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const Icon = workSummaryIcon(messages)

  return (
    <article className={cn("min-w-0 text-[13px] text-muted-foreground", animateIn && "chat-append-enter")}>
      <button
        className="flex min-h-7 max-w-full items-center gap-2 text-left hover:text-foreground"
        type="button"
        onClick={() => setExpanded((current) => !current)}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{workSummaryLabel(messages)}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
      </button>
      {expanded ? (
        <div className="ml-5 mt-1 grid gap-2 border-l border-border pl-3">
          {messages.map((message) => (
            <ChatMessageRow
              dragOverQueuedRunId={dragOverQueuedRunId}
              key={message.id}
              message={message}
              onDeleteQueuedMessage={onDeleteQueuedMessage}
              onEditQueuedMessage={onEditQueuedMessage}
              onQueuedDragEnd={onQueuedDragEnd}
              onQueuedDragEnter={onQueuedDragEnter}
              onQueuedDrop={onQueuedDrop}
              onSteerQueuedMessage={onSteerQueuedMessage}
            />
          ))}
        </div>
      ) : null}
    </article>
  )
}

function ChatFileChangeBlock({
  animateIn,
  messages,
  workspacePath,
}: {
  animateIn?: boolean
  messages: ChatMessageResponse[]
  workspacePath: string
}) {
  const [expanded, setExpanded] = useState(false)
  const changes = groupFileChanges(messages.flatMap(parseFileChangeMessage).map((change) => ({
    ...change,
    path: workspaceRelativeDisplayPath(change.path, workspacePath),
  })))
  const visibleChanges = expanded ? changes : changes.slice(0, 3)
  const hiddenCount = Math.max(0, changes.length - visibleChanges.length)
  const totals = changes.reduce(
    (current, change) => ({
      additions: current.additions + change.additions,
      deletions: current.deletions + change.deletions,
    }),
    { additions: 0, deletions: 0 },
  )

  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-card p-3 text-[13px]", animateIn && "chat-append-enter")}>
      <div className="flex min-w-0 items-center gap-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">{editedFilesTitle(changes, messages.length)}</div>
          <div className="mt-0.5 text-[12px] text-diff-addition-foreground">
            +{totals.additions} <span className="text-diff-deletion-foreground">-{totals.deletions}</span>
          </div>
        </div>
      </div>
      {changes.length > 1 ? (
        <div className="mt-3 grid gap-2 border-t border-border pt-3">
          {visibleChanges.map((change, index) => (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px]" key={`${change.path}:${index}`}>
              <span className="truncate text-foreground">{change.path}</span>
              <span className="text-diff-addition-foreground">
                +{change.additions} <span className="text-diff-deletion-foreground">-{change.deletions}</span>
              </span>
            </div>
          ))}
          {changes.length > 3 ? (
            <button
              className="mt-1 flex h-6 w-fit items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              type="button"
              onClick={() => setExpanded((current) => !current)}
            >
              <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Collapse files" : `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function useNowMs(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) {
      return
    }
    setNowMs(Date.now())
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [enabled])

  return nowMs
}
