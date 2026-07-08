import type { ChangeEvent as ReactChangeEvent } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useProviderQuotas } from "@/components/session/provider-quota-context"
import {
  attachmentOnlyPrompt,
  attachmentsFromFiles,
  chatRenderEntryId,
  composerReasoningEffortValue,
  composerServiceTierValue,
  matchingChatSlashCommands,
  createClientId,
  defaultRuntimeDefaultValue,
  fallbackComposerFeatures,
  fileRelativePath,
  formatProviderQuota,
  groupChatRenderEntries,
  isQueuedUserMessage,
  moveItemAround,
  parseChatSlashCommand,
  queuedMessageRunIds,
  readComposerAccessMode,
  readError,
  readRecordString,
  selectChatAccount,
  selectableChatAccounts,
} from "@/lib/session"
import type {
  ChatComposerAccessMode,
  ChatComposerAttachment,
} from "@/types/session"
import { useAppendAnimationIds } from "@/components/session/chat-pane-animation"
import { useChatPaneRuntimeSettings } from "@/components/session/chat-pane-runtime"
import { useTelegramDeepLink } from "@/components/session/chat-pane-telegram"
import { usePendingUserInputState } from "@/components/session/chat-pane-user-input"
import type { ChatPaneProps } from "@/components/session/chat-pane-types"

// ChatPane is rendered from chat-pane.tsx; this file owns the pane state hook.
export function useChatPaneState({
  accounts,
  chat,
  error,
  isLoading,
  isMessagesLoading,
  isSwitchingAccount,
  accountSwitchPhase,
  messages,
  preferredAccountId,
  providerDefinitions,
  workspace,
  onArchiveChat,
  onCompactChat,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onFileLinkOpen,
  onForkChat,
  onNewChat,
  onOpenMcpServers,
  onOpenProviders,
  onOpenPlugins,
  onRefreshChat,
  onRenameChat,
  onReviewChat,
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
  const [threadAction, setThreadAction] = useState<"archive" | "compact" | "fork" | "refresh" | "rename" | "review" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dragOverQueuedRunId, setDragOverQueuedRunId] = useState<string | null>(null)
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
  const running = chat?.status === "RUNNING" || messages.some((message) => message.status === "STREAMING")
  const queuedMessages = useMemo(() => messages.filter(isQueuedUserMessage), [messages])
  const transcriptMessages = useMemo(() => messages.filter((message) => !isQueuedUserMessage(message)), [messages])
  const renderEntries = useMemo(() => groupChatRenderEntries(transcriptMessages, running), [running, transcriptMessages])
  const renderEntryIds = useMemo(() => renderEntries.map(chatRenderEntryId), [renderEntries])
  const queuedRunIds = useMemo(() => queuedMessageRunIds(queuedMessages), [queuedMessages])
  const appendedEntryIds = useAppendAnimationIds(renderEntryIds, chat?.id ?? null)
  const fileLinkContext = useMemo(() => ({ openFileLink: onFileLinkOpen }), [onFileLinkOpen])
  const hasComposerContent = Boolean(draft.trim()) || attachments.length > 0
  const canSend = hasComposerContent && !sending && !threadAction && !isSwitchingAccount
  const showStopAction = running && !hasComposerContent
  const supportsAccessMode = composerFeatures.includes("accessMode")
  const supportsFiles = composerFeatures.includes("fileAttachment")
  const supportsFolders = composerFeatures.includes("folderAttachment")
  const supportsGoal = composerFeatures.includes("goal")
  const supportsImages = composerFeatures.includes("imageAttachment")
  const supportsPlanMode = composerFeatures.includes("planMode")
  const telegramDeepLink = useTelegramDeepLink(chat?.id)
  const {
    changeModel,
    changeReasoningEffort,
    changeServiceTier,
    model,
    reasoningEffort,
    selectedModelOption,
    serviceTier,
    supportsModels,
    supportsReasoningEffort,
    supportsServiceTier,
    visibleModelOptions,
  } = useChatPaneRuntimeSettings({
    account,
    chat,
    providerDefinition,
    onRuntimeSettingsChange,
  })
  const {
    activeUserInputQuestion,
    canContinueUserInput,
    chooseUserInputFreeform,
    chooseUserInputOption,
    goToNextUserInputStage,
    goToPreviousUserInputStage,
    pendingUserInputPrompt,
    pendingUserInputQuestions,
    submitUserInput,
    updateUserInputAnswer,
    userInputAnswerValue,
    userInputIsLastStage,
    userInputStageIndex,
    userInputSubmitting,
    userInputUsesFreeform,
  } = usePendingUserInputState({ chat, messages, setActionError })
  const slashMatches = useMemo(() => matchingChatSlashCommands(draft), [draft])

  useEffect(() => {
    const defaultPermissionMode = readRecordString(account?.runtimeDefaults, "permissionMode") || defaultRuntimeDefaultValue(account?.providerId, "permissionMode")
    setAccessMode(readComposerAccessMode(chat?.permissionMode ?? defaultPermissionMode))
    setGoalObjective(null)
    setPlanMode(chat?.collaborationMode === "plan")
  }, [
    account?.id,
    account?.providerId,
    account?.runtimeDefaults,
    chat?.id,
    chat?.permissionMode,
    chat?.collaborationMode,
  ])

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
  }, [actionError, chat?.id, messages.length, messages.at(-1)?.id, messages.at(-1)?.content])

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

  const sendComposerMessage = async (
    content: string,
    overrides: {
      attachments?: ChatComposerAttachment[]
      collaborationMode?: string | null
      goalObjective?: string | null
      serviceTier?: string | null
    } = {},
  ) => {
    setSending(true)
    setActionError(null)
    try {
      await onSendMessage({
        attachments: (overrides.attachments ?? attachments).map(({ id: _id, ...attachment }) => attachment),
        collaborationMode: overrides.collaborationMode ?? (supportsPlanMode ? (planMode ? "plan" : "default") : null),
        content,
        delivery: running ? "queue" : undefined,
        goalObjective: "goalObjective" in overrides ? overrides.goalObjective ?? null : goalObjective,
        model: supportsModels ? model || selectedModelOption?.model || null : null,
        permissionMode: accessMode,
        reasoningEffort: supportsReasoningEffort ? composerReasoningEffortValue(reasoningEffort) : null,
        serviceTier: overrides.serviceTier ?? (supportsServiceTier ? composerServiceTierValue(serviceTier) : null),
      })
      setDraft("")
      setAttachments([])
      setGoalObjective(null)
    } finally {
      setSending(false)
    }
  }

  const acceptPlan = async () => {
    try {
      await sendComposerMessage("Implement the plan.", {
        attachments: [],
        collaborationMode: "default",
        goalObjective: null,
      })
      setPlanMode(false)
    } catch (error) {
      setActionError(readError(error))
      window.requestAnimationFrame(() => {
        textareaRef.current?.scrollIntoView({ block: "end" })
        textareaRef.current?.focus()
      })
      throw error
    }
  }

  const keepPlanning = () => {
    if (supportsPlanMode) {
      setPlanMode(true)
    }
    setActionError(null)
    window.requestAnimationFrame(() => {
      textareaRef.current?.scrollIntoView({ block: "end" })
      textareaRef.current?.focus()
    })
  }

  const runThreadAction = async (
    action: NonNullable<typeof threadAction>,
    callback: () => Promise<void>,
  ) => {
    if (threadAction) {
      return
    }
    setThreadAction(action)
    setActionError(null)
    try {
      await callback()
    } catch (error) {
      setActionError(readError(error))
      window.requestAnimationFrame(() => {
        textareaRef.current?.scrollIntoView({ block: "end" })
        textareaRef.current?.focus()
      })
    } finally {
      setThreadAction(null)
    }
  }

  const runSlashCommand = async (parsed: NonNullable<ReturnType<typeof parseChatSlashCommand>>): Promise<boolean> => {
    const argument = parsed.argument
    switch (parsed.command.id) {
      case "model":
        if (argument) {
          changeModel(argument)
        } else {
          setRuntimeSettingsOpen(true)
        }
        setDraft("")
        return true
      case "fast":
        changeServiceTier("fast")
        setDraft("")
        return true
      case "permissions":
        changeAccessMode(argument.toLowerCase().includes("full") ? "fullAccess" : "askForApproval")
        setDraft("")
        return true
      case "plan":
        if (argument) {
          await sendComposerMessage(argument, { collaborationMode: "plan" })
        } else {
          setPlanMode((current) => !current)
          setDraft("")
        }
        return true
      case "goal":
        if (argument) {
          setGoalObjective(argument)
        } else {
          promptForGoal()
        }
        setDraft("")
        return true
      case "review":
        if (chat) {
          await runThreadAction("review", () => onReviewChat(chat.id, argument || null))
        }
        setDraft("")
        return true
      case "compact":
        if (chat) {
          await runThreadAction("compact", () => onCompactChat(chat.id))
        }
        setDraft("")
        return true
      case "fork":
        if (chat) {
          await runThreadAction("fork", () => onForkChat(chat.id))
        }
        setDraft("")
        return true
      case "new":
        onNewChat()
        setDraft("")
        setAttachments([])
        setGoalObjective(null)
        return true
      case "status":
        if (chat) {
          await runThreadAction("refresh", () => onRefreshChat(chat.id))
        }
        setDraft("")
        return true
      case "usage":
        onOpenProviders()
        setDraft("")
        return true
      case "mcp":
        onOpenMcpServers()
        setDraft("")
        return true
      case "plugins":
        onOpenPlugins()
        setDraft("")
        return true
      case "skills":
        await sendComposerMessage("List the available Codex skills for this workspace.")
        return true
      case "hooks":
        await sendComposerMessage("List the active Codex hooks for this workspace.")
        return true
      case "diff":
        await sendComposerMessage(argument || "Show the current diff.")
        return true
      case "clear":
        setDraft("")
        setAttachments([])
        return true
    }
  }

  const submit = async () => {
    if (!canSend) {
      return
    }
    const parsedSlashCommand = parseChatSlashCommand(draft)
    if (parsedSlashCommand && await runSlashCommand(parsedSlashCommand)) {
      return
    }
    const content = draft.trim() || attachmentOnlyPrompt(attachments)
    await sendComposerMessage(content)
  }

  const changeAccessMode = (value: string) => {
    const previousMode = accessMode
    const nextMode = readComposerAccessMode(value)
    setAccessMode(nextMode)
    if (chat && chat.permissionMode !== nextMode) {
      void onPermissionModeChange(chat.id, nextMode).catch(() => setAccessMode(previousMode))
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

  const removeAttachment = (attachmentId: string) => {
    setAttachments((current) => current.filter((item) => item.id !== attachmentId))
  }

  const archiveChat = async () => {
    if (chat) {
      await runThreadAction("archive", () => onArchiveChat(chat.id))
    }
  }

  const compactChat = async () => {
    if (chat) {
      await runThreadAction("compact", () => onCompactChat(chat.id))
    }
  }

  const forkChat = async (lastTurnId?: string | null) => {
    if (chat) {
      await runThreadAction("fork", () => onForkChat(chat.id, lastTurnId))
    }
  }

  const refreshChat = async () => {
    if (chat) {
      await runThreadAction("refresh", () => onRefreshChat(chat.id))
    }
  }

  const renameChat = async () => {
    if (!chat) {
      return
    }
    const nextTitle = window.prompt("Rename chat", chat.title)
    if (nextTitle === null || !nextTitle.trim() || nextTitle.trim() === chat.title) {
      return
    }
    await runThreadAction("rename", () => onRenameChat(chat.id, nextTitle.trim()))
  }

  const reviewChat = async () => {
    if (chat) {
      await runThreadAction("review", () => onReviewChat(chat.id, null))
    }
  }

  return {
    accessMode,
    acceptPlan,
    account,
    accountSwitchPhase,
    accountLimits,
    accountQuota,
    accounts,
    actionError,
    activeUserInputQuestion,
    appendedEntryIds,
    archiveChat,
    attachFiles,
    attachFolder,
    attachments,
    canSend,
    changeAccessMode,
    changeModel,
    changeReasoningEffort,
    changeServiceTier,
    chat,
    canContinueUserInput,
    chooseUserInputFreeform,
    chooseUserInputOption,
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
    keepPlanning,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onOpenProviders,
    onSteerQueuedMessage,
    onStopChat,
    onSwitchAccount,
    onToggleMode,
    pendingUserInputPrompt,
    pendingUserInputQuestions,
    goToNextUserInputStage,
    goToPreviousUserInputStage,
    planMode,
    promptForGoal,
    providerDefinition,
    providerIconById,
    queuedMessages,
    reasoningEffort,
    removeAttachment,
    renderEntries,
    reorderQueuedMessage,
    compactChat,
    forkChat,
    refreshChat,
    renameChat,
    reviewChat,
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
    slashMatches,
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
    telegramDeepLink,
    textareaRef,
    threadAction,
    updateUserInputAnswer,
    userInputAnswerValue,
    userInputIsLastStage,
    userInputSubmitting,
    userInputStageIndex,
    userInputUsesFreeform,
    visibleModelOptions,
    workspace,
  }
}


export type ChatPaneState = ReturnType<typeof useChatPaneState>
