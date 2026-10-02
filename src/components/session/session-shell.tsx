import {
  Folder,
  FolderOpen,
  LoaderCircle,
} from "lucide-react"
import { io } from "socket.io-client"
import { ChatPane } from "@/components/session/chat-pane"
import { ChatListProvider } from "@/components/session/chat-list-context"
import { FileDialog, FileEditorPane } from "@/components/session/file-editor-pane"
import { SessionSidebar } from "@/components/session/session-sidebar"
import { SessionNavigation } from "@/components/session/session-navigation"
import { ProjectsPage, ScheduledEmptyPage, SettingsPage, TasksBoardPage, UsagePage } from "@/components/session/session-pages"
import {
  readMessageScheduleResponse,
  readMessageScheduleRunResponse,
  upsertSchedule,
  upsertScheduleRun,
} from "@/components/session/schedule-utils"
import { MobilePanelDrawer, SessionTitleBar } from "@/components/session/session-chrome"
import { SessionTitlebarActionsContext } from "@/components/session/session-chrome-context"
import { ProviderQuotaProvider } from "@/components/session/provider-quota-context"
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react"
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { AssistantSummary, CreateAssistantRequest } from "../../../app/types/assistant"
import {
  apiClient,
  type BrowserEntry,
  type ChatAccountSwitchPhase,
  type ChatMessageResponse,
  type ChatResponse,
  type MessageScheduleResponse,
  type MessageScheduleRunResponse,
  type ProviderAccountResponse,
  type ProviderDefinitionResponse,
  type WorkspaceHistoryResponse,
} from "@/lib/api-client"
import { cn } from "@/lib/utils"
import type {
  ChatComposerAccessMode,
  ChatComposerSubmit,
  FileNode,
  FileRevealTarget,
  FileSelectOptions,
  MainMode,
  ManagementView,
  MobileDrawer,
  NavigationView,
  Workspace,
} from "@/types/session"
import {
  browserEntryToFileNode,
  clearSessionRouteTarget,
  createOptimisticChatMessage,
  createWorkspaceFromBrowserEntry,
  fileContentFor,
  findFile,
  initialOpenFileIds,
  omitRecordKey,
  parseChatFileLink,
  readChatAccountSwitchEvent,
  readChatMessageResponse,
  readChatResponse,
  readDetachedEditorPreference,
  readError,
  readProviderSocketEvent,
  readRecord,
  readRecordString,
  readRunStatus,
  readSessionRouteTarget,
  readAgentRouteTarget,
  samePath,
  selectChatAccount,
  slugifyWorkspaceId,
  titleFromPrompt,
  upsertChat,
  upsertMessage,
  removeOptimisticMessages,
  workspaceFromHistory,
  writeDetachedEditorPreference,
  writeSessionRouteTarget,
  writeAgentRouteTarget,
} from "@/lib/session"
import { startHorizontalResize } from "@/lib/resize"

export type SessionShellState = ReturnType<typeof useSessionShellController>

const McpServersManagementDialog = lazy(() => import("@/components/session/mcp-servers-management-dialog").then((module) => ({ default: module.McpServersManagementDialog })))
const ProvidersManagementDialog = lazy(() => import("@/components/session/providers-management-dialog").then((module) => ({ default: module.ProvidersManagementDialog })))
const CodexInstructionsDialog = lazy(() => import("@/components/session/codex-instructions-dialog").then((module) => ({ default: module.CodexInstructionsDialog })))
const WorkspaceFolderBrowserDialog = lazy(() => import("@/components/session/workspace-folder-browser-dialog").then((module) => ({ default: module.WorkspaceFolderBrowserDialog })))
const ScheduleDetailPane = lazy(() => import("@/components/session/schedule-detail-pane").then((module) => ({ default: module.ScheduleDetailPane })))
const AssistantPage = lazy(() => import("@/components/session/assistant-page").then((module) => ({ default: module.AssistantPage })))

const SessionShellContext = createContext<SessionShellState | null>(null)

function useSessionShellState(): SessionShellState {
  const value = useContext(SessionShellContext)
  if (!value) {
    throw new Error("useSessionShellState must be used within SessionShellContext.")
  }
  return value
}

export function SessionShell() {
  const shell = useSessionShellController()

  return (
    <ChatListProvider chats={shell.chats} isLoading={shell.isChatsLoading} messagesByChatId={shell.messagesByChatId}>
      <ProviderQuotaProvider>
        <SessionShellContext.Provider value={shell}>
          <SessionShellView />
        </SessionShellContext.Provider>
      </ProviderQuotaProvider>
    </ChatListProvider>
  )
}

function useSessionShellController() {
  const [routeTarget] = useState(() => readSessionRouteTarget())
  const [routeTargetPending, setRouteTargetPending] = useState(() => Boolean(routeTarget.workspaceId))
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [activeAgentId, setActiveAgentId] = useState<string | null>(readAgentRouteTarget)
  const [agents, setAgents] = useState<AssistantSummary[]>([])
  const [agentError, setAgentError] = useState<string | null>(null)
  const [isAgentsLoading, setIsAgentsLoading] = useState(true)
  const updateAgent = useCallback(({ id, profile, status, accountId, createdAt, updatedAt }: AssistantSummary) => {
    const summary = { id, profile, status, accountId, createdAt, updatedAt }
    setAgents((current) => current.some((agent) => agent.id === id) ? current.map((agent) => agent.id === id ? summary : agent) : [...current, summary])
  }, [])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatResponse[]>([])
  const [sidebarChatRevision, setSidebarChatRevision] = useState(0)
  const [archivedChatIds, setArchivedChatIds] = useState<Record<string, true>>({})
  const archivingChatIds = useRef(new Set<string>())
  const [sidebarChatError, setSidebarChatError] = useState<string | null>(null)
  const [chatAccounts, setChatAccounts] = useState<ProviderAccountResponse[]>([])
  const [providerDefinitions, setProviderDefinitions] = useState<ProviderDefinitionResponse[]>([])
  const [preferredAccountId, setPreferredAccountId] = useState<string | null>(null)
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false)
  const [accountSwitchByChatId, setAccountSwitchByChatId] = useState<Record<string, ChatAccountSwitchPhase>>({})
  const [isChatsLoading, setIsChatsLoading] = useState(false)
  const [activeScheduleId, setActiveScheduleId] = useState<string | null>(null)
  const [isSchedulesLoading, setIsSchedulesLoading] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [scheduleRunsByScheduleId, setScheduleRunsByScheduleId] = useState<Record<string, MessageScheduleRunResponse[]>>({})
  const [schedules, setSchedules] = useState<MessageScheduleResponse[]>([])
  const [navigationView, setNavigationView] = useState<NavigationView>(readNavigationView)
  const [userName, setUserName] = useState(() => typeof window === "undefined" ? "Local user" : window.localStorage.getItem("pockcode-user-name") || "Local user")
  const [isWorkspaceHistoryLoading, setIsWorkspaceHistoryLoading] = useState(true)
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceHistoryResponse[]>([])
  const [editorRevealTarget, setEditorRevealTarget] = useState<FileRevealTarget | null>(null)
  const [fileContentById, setFileContentById] = useState<Record<string, string>>({})
  const [mainMode, setMainMode] = useState<MainMode>("chat")
  const [messagesByChatId, setMessagesByChatId] = useState<Record<string, ChatMessageResponse[]>>({})
  const [mobileDrawer, setMobileDrawer] = useState<MobileDrawer>(null)
  const [openFileIdsByWorkspace, setOpenFileIdsByWorkspace] = useState<Record<string, string[]>>({})
  const [sidebarWidth, setSidebarWidth] = useState(324)
  const [selectedFileByWorkspace, setSelectedFileByWorkspace] = useState<Record<string, string>>({})
  const [providersDialogOpen, setProvidersDialogOpen] = useState(false)
  const [instructionsDialogOpen, setInstructionsDialogOpen] = useState(false)
  const [mcpServersDialogOpen, setMcpServersDialogOpen] = useState(false)
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null)
  const [workspaceBrowserOpen, setWorkspaceBrowserOpen] = useState(false)
  const [workspaceStartOpen, setWorkspaceStartOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const activeChatIdRef = useRef<string | null>(null)
  const activeScheduleIdRef = useRef<string | null>(null)
  const activeWorkspaceRef = useRef<Workspace | null>(null)
  const workspaceChatRequestRef = useRef(0)
  const connectionRecoveryPendingRef = useRef(false)
  const connectionRecoveryPromiseRef = useRef<Promise<void> | null>(null)
  const providerSocketRef = useRef<ReturnType<typeof io> | null>(null)
  const requestConnectionRecoveryRef = useRef<(() => void) | null>(null)

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0] ?? null,
    [activeWorkspaceId, workspaces],
  )
  const visibleChats = useMemo(() => chats.filter((chat) => !archivedChatIds[chat.id]), [chats, archivedChatIds])
  const activeChat = useMemo(
    () => visibleChats.find((chat) => chat.id === activeChatId) ?? null,
    [activeChatId, visibleChats],
  )
  const activeSchedule = useMemo(
    () => schedules.find((schedule) => schedule.id === activeScheduleId) ?? null,
    [activeScheduleId, schedules],
  )
  const selectedFileId = activeWorkspace ? selectedFileByWorkspace[activeWorkspace.id] ?? activeWorkspace.selectedFileId : ""
  const selectedFile = useMemo(
    () => (activeWorkspace ? findFile(activeWorkspace.fileTree, selectedFileId) : null),
    [activeWorkspace, selectedFileId],
  )
  const openFiles = useMemo(
    () =>
      activeWorkspace
        ? (openFileIdsByWorkspace[activeWorkspace.id] ?? [])
          .map((id) => findFile(activeWorkspace.fileTree, id))
          .filter((file): file is FileNode => Boolean(file))
        : [],
    [activeWorkspace, openFileIdsByWorkspace],
  )
  const selectedFileContent = selectedFile
    ? fileContentById[selectedFile.id] ?? fileContentFor(selectedFile)
    : ""
  const activeMessages = activeChat ? messagesByChatId[activeChat.id] ?? [] : []
  const activeMessagesLoaded = activeChat ? Object.prototype.hasOwnProperty.call(messagesByChatId, activeChat.id) : true
  const updateProviderData = (nextProviders: ProviderDefinitionResponse[], nextAccounts: ProviderAccountResponse[]) => {
    setProviderDefinitions(nextProviders)
    setChatAccounts(nextAccounts.filter((account) => account.status === "CONNECTED"))
  }

  const loadSavedWorkspaces = async () => {
    setIsWorkspaceHistoryLoading(true)
    setWorkspaceLoadError(null)
    try {
      const history = await apiClient.workspaces.listHistory()
      setRecentWorkspaces(history)
      const nextWorkspaces: Workspace[] = []
      const openHistory = history.filter((item) => item.isOpen)
      const targetHistory = history.find((item) => item.id === routeTarget.workspaceId)
      const historiesToOpen = targetHistory && !openHistory.some((item) => item.id === targetHistory.id || samePath(item.path, targetHistory.path))
        ? [targetHistory, ...openHistory]
        : openHistory
      for (const historyItem of historiesToOpen) {
        const workspace = await workspaceFromHistory(historyItem, nextWorkspaces)
        if (workspace) {
          nextWorkspaces.push(workspace)
        }
      }
      if (targetHistory && !targetHistory.isOpen) {
        void apiClient.workspaces.saveHistory(targetHistory.path)
          .then((saved) => setRecentWorkspaces((current) => upsertRecentWorkspace(current, saved)))
          .catch(() => undefined)
      }
      setWorkspaces(nextWorkspaces)
      setOpenFileIdsByWorkspace(Object.fromEntries(nextWorkspaces.map((workspace) => [workspace.id, initialOpenFileIds(workspace)])))
      setSelectedFileByWorkspace(Object.fromEntries(nextWorkspaces.map((workspace) => [workspace.id, workspace.selectedFileId])))
      setActiveWorkspaceId((current) =>
        nextWorkspaces.find((workspace) => workspace.id === current)?.id ??
        nextWorkspaces.find((workspace) => workspace.id === routeTarget.workspaceId)?.id ??
        nextWorkspaces[0]?.id ??
        null,
      )
    } catch (error) {
      setWorkspaceLoadError(readError(error))
      setWorkspaces([])
      setActiveWorkspaceId(null)
    } finally {
      setIsWorkspaceHistoryLoading(false)
    }
  }

  const loadChatsForWorkspace = async (
    workspacePath: string,
    workspaceId?: string,
    options?: { silent?: boolean },
  ) => {
    const requestId = ++workspaceChatRequestRef.current
    if (!options?.silent) {
      setIsChatsLoading(true)
      setIsSchedulesLoading(true)
    }
    setChatError(null)
    setScheduleError(null)
    try {
      const [nextChats, nextAccounts, nextProviders, nextSchedules] = await Promise.all([
        apiClient.chats.list(workspacePath),
        apiClient.providerAccounts.list(),
        apiClient.providers.list(),
        apiClient.schedules.list(workspacePath),
      ])
      if (requestId !== workspaceChatRequestRef.current || !activeWorkspaceRef.current || !samePath(activeWorkspaceRef.current.path, workspacePath)) return
      setChats(nextChats)
      setSchedules(nextSchedules)
      updateProviderData(nextProviders, nextAccounts)
      const routeChatId = routeTargetPending && workspaceId && routeTarget.workspaceId === workspaceId ? routeTarget.chatId : null
      setActiveChatId((current) => nextChats.find((chat) => chat.id === current)?.id ?? nextChats.find((chat) => chat.id === routeChatId)?.id ?? null)
      if (workspaceId && routeTarget.workspaceId === workspaceId) {
        setRouteTargetPending(false)
      }
    } catch (error) {
      if (requestId !== workspaceChatRequestRef.current || !activeWorkspaceRef.current || !samePath(activeWorkspaceRef.current.path, workspacePath)) return
      setChatError(readError(error))
      if (!options?.silent) {
        setChats([])
        setSchedules([])
        setActiveChatId(null)
      }
    } finally {
      if (requestId === workspaceChatRequestRef.current && !options?.silent) {
        setIsChatsLoading(false)
        setIsSchedulesLoading(false)
      }
    }
  }

  const loadMessagesForChat = async (chatId: string) => {
    try {
      const page = await apiClient.chats.listMessages(chatId)
      setMessagesByChatId((current) => ({ ...current, [chatId]: page.data }))
    } catch (error) {
      setChatError(readError(error))
      setMessagesByChatId((current) => Object.prototype.hasOwnProperty.call(current, chatId) ? current : { ...current, [chatId]: [] })
    }
  }

  const loadScheduleRuns = async (scheduleId: string) => {
    setScheduleError(null)
    try {
      const runs = await apiClient.schedules.listRuns(scheduleId)
      setScheduleRunsByScheduleId((current) => ({ ...current, [scheduleId]: runs }))
    } catch (error) {
      setScheduleError(readError(error))
    }
  }

  const syncSessionAfterConnectionRecovery = async () => {
    if (navigator.onLine === false) {
      return
    }

    const workspace = activeWorkspaceRef.current
    if (!workspace) {
      const history = await apiClient.workspaces.listHistory()
      setRecentWorkspaces(history)
      return
    }

    const [history, nextChats, nextAccounts, nextProviders, nextSchedules] = await Promise.all([
      apiClient.workspaces.listHistory(),
      apiClient.chats.sync(workspace.path),
      apiClient.providerAccounts.list(),
      apiClient.providers.list(),
      apiClient.schedules.list(workspace.path),
    ])

    setRecentWorkspaces(history)
    updateProviderData(nextProviders, nextAccounts)

    const currentWorkspace = activeWorkspaceRef.current
    if (!currentWorkspace || !samePath(currentWorkspace.path, workspace.path)) {
      return
    }

    setChatError(null)
    setScheduleError(null)
    setChats(nextChats)
    setSchedules(nextSchedules)

    const currentChatId = activeChatIdRef.current
    const nextActiveChatId = currentChatId
      ? nextChats.find((chat) => chat.id === currentChatId)?.id ?? nextChats[0]?.id ?? null
      : null
    if (nextActiveChatId !== currentChatId) {
      setActiveChatId((current) => current === currentChatId ? nextActiveChatId : current)
    }

    const currentScheduleId = activeScheduleIdRef.current
    const nextActiveSchedule = currentScheduleId
      ? nextSchedules.find((schedule) => schedule.id === currentScheduleId) ?? null
      : null
    if (currentScheduleId && !nextActiveSchedule) {
      setActiveScheduleId(null)
      setScheduleRunsByScheduleId((current) => omitRecordKey(current, currentScheduleId))
      setMainMode((current) => current === "schedule" ? "chat" : current)
    }

    await Promise.all([
      nextActiveChatId
        ? apiClient.chats.refresh(nextActiveChatId).then((response) => {
          const latestWorkspace = activeWorkspaceRef.current
          if (!latestWorkspace || !samePath(latestWorkspace.path, workspace.path)) {
            return
          }
          setChats((current) => upsertChat(current, response.chat))
          setMessagesByChatId((current) => ({ ...current, [nextActiveChatId]: response.messages.data }))
        })
        : Promise.resolve(),
      nextActiveSchedule
        ? apiClient.schedules.listRuns(nextActiveSchedule.id).then((runs) => {
          const latestWorkspace = activeWorkspaceRef.current
          if (!latestWorkspace || !samePath(latestWorkspace.path, workspace.path)) {
            return
          }
          setScheduleRunsByScheduleId((current) => ({ ...current, [nextActiveSchedule.id]: runs }))
        })
        : Promise.resolve(),
    ])
  }

  const requestConnectionRecovery = () => {
    if (navigator.onLine === false) {
      return
    }
    connectionRecoveryPendingRef.current = true
    if (connectionRecoveryPromiseRef.current) {
      return
    }

    const runRecovery = async () => {
      while (connectionRecoveryPendingRef.current) {
        connectionRecoveryPendingRef.current = false
        await syncSessionAfterConnectionRecovery()
      }
    }

    const promise = runRecovery()
      .catch(() => undefined)
      .finally(() => {
        if (connectionRecoveryPromiseRef.current === promise) {
          connectionRecoveryPromiseRef.current = null
        }
        if (connectionRecoveryPendingRef.current) {
          requestConnectionRecovery()
        }
      })
    connectionRecoveryPromiseRef.current = promise
  }

  useEffect(() => {
    void loadSavedWorkspaces()
    void Promise.all([apiClient.providers.list(), apiClient.providerAccounts.list()])
      .then(([providers, accounts]) => updateProviderData(providers, accounts))
      .catch(() => undefined)
  }, [])


  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const items = await apiClient.assistant.list()
        if (!disposed) { setAgents(items); setAgentError(null) }
      } catch (error) {
        if (!disposed) setAgentError(readError(error))
      } finally {
        if (!disposed) { setIsAgentsLoading(false); timer = setTimeout(() => void load(), 5000) }
      }
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const onHashChange = () => setNavigationView(readNavigationView())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  useEffect(() => {
    const url = new URL(window.location.href)
    url.hash = navigationView === "home" ? "" : navigationView
    window.history.replaceState(null, "", url)
  }, [navigationView])

  useEffect(() => {
    if (!activeWorkspace) {
      setChats([])
      setSchedules([])
      setActiveChatId(null)
      setActiveScheduleId(null)
      return
    }
    void loadChatsForWorkspace(activeWorkspace.path, activeWorkspace.id)
  }, [activeWorkspace?.path])

  useEffect(() => {
    if (!activeScheduleId) {
      return
    }
    void loadScheduleRuns(activeScheduleId)
  }, [activeScheduleId])

  useEffect(() => {
    if (!activeChatId) {
      return
    }
    void loadMessagesForChat(activeChatId)
  }, [activeChatId])

  useEffect(() => {
    if (activeAgentId) {
      if (navigationView === "home") writeAgentRouteTarget(activeAgentId)
      return
    }
    writeAgentRouteTarget(null)
    if (!activeWorkspace) {
      return
    }
    const pendingChatId = routeTargetPending && routeTarget.workspaceId === activeWorkspace.id ? routeTarget.chatId : null
    writeSessionRouteTarget(activeWorkspace.id, activeChatId ?? pendingChatId)
  }, [activeAgentId, navigationView, activeChatId, activeWorkspace?.id, routeTarget.chatId, routeTarget.workspaceId, routeTargetPending])

  useEffect(() => {
    activeChatIdRef.current = activeChatId
  }, [activeChatId])

  useEffect(() => {
    activeScheduleIdRef.current = activeScheduleId
  }, [activeScheduleId])

  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace
  }, [activeWorkspace])

  useEffect(() => {
    requestConnectionRecoveryRef.current = requestConnectionRecovery
  })

  useEffect(() => {
    const recoverVisibleConnection = () => {
      if (document.visibilityState === "hidden") {
        return
      }
      const socket = providerSocketRef.current
      if (socket?.disconnected) {
        socket.connect()
      }
      requestConnectionRecoveryRef.current?.()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        recoverVisibleConnection()
      }
    }

    window.addEventListener("focus", recoverVisibleConnection)
    window.addEventListener("online", recoverVisibleConnection)
    window.addEventListener("pageshow", recoverVisibleConnection)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      window.removeEventListener("focus", recoverVisibleConnection)
      window.removeEventListener("online", recoverVisibleConnection)
      window.removeEventListener("pageshow", recoverVisibleConnection)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!activeWorkspace) {
      return
    }
    const socket = io({
      autoConnect: false,
      path: "/socket.io",
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    })
    providerSocketRef.current = socket
    const joinSocketRooms = () => {
      socket.emit("workspace.join", activeWorkspace.path)
      if (activeChatIdRef.current) {
        socket.emit("chat.join", activeChatIdRef.current)
      }
    }
    const handleConnect = () => {
      joinSocketRooms()
      requestConnectionRecovery()
    }
    const handleProviderEvent = (value: unknown) => {
      const event = readProviderSocketEvent(value)
      if (!event) {
        return
      }
      if (event.type === "chat.accountSwitch") {
        const switchEvent = readChatAccountSwitchEvent(event.payload)
        if (!switchEvent) {
          return
        }
        setAccountSwitchByChatId((current) => {
          if (switchEvent.phase === "completed" || switchEvent.phase === "failed") {
            return omitRecordKey(current, switchEvent.chatId)
          }
          return { ...current, [switchEvent.chatId]: switchEvent.phase }
        })
        if (switchEvent.phase === "failed") {
          setPreferredAccountId(switchEvent.fromAccountId ?? null)
          setIsSwitchingAccount(false)
          setChatError(switchEvent.error ?? "Unable to switch provider account.")
        }
        if (switchEvent.phase === "completed") {
          setIsSwitchingAccount(false)
        }
        return
      }
      if (event.type === "chat.updated") {
        const chat = readChatResponse(event.payload)
        if (!chat || (chat.workingDirectory && !samePath(chat.workingDirectory, activeWorkspace.path))) {
          return
        }
        setChats((current) =>
          chat.status === "ARCHIVED" ? current.filter((entry) => entry.id !== chat.id) : upsertChat(current, chat),
        )
        return
      }
      if (event.type === "run.status" && event.threadId) {
        const status = readRunStatus(event.payload)
        if (!status) {
          return
        }
        setChats((current) =>
          current.map((chat) => chat.id === event.threadId ? { ...chat, status } : chat),
        )
        return
      }
      if (event.type === "schedule.updated") {
        const schedule = readMessageScheduleResponse(event.payload)
        if (!schedule || !samePath(schedule.workingDirectory, activeWorkspace.path)) {
          return
        }
        setSchedules((current) =>
          schedule.status === "ARCHIVED"
            ? current.filter((entry) => entry.id !== schedule.id)
            : upsertSchedule(current, schedule),
        )
        if (schedule.status === "ARCHIVED" && activeScheduleIdRef.current === schedule.id) {
          setActiveScheduleId(null)
          setMainMode("chat")
        }
        return
      }
      if (event.type === "schedule.run.updated") {
        const run = readMessageScheduleRunResponse(event.payload)
        if (!run) {
          return
        }
        setScheduleRunsByScheduleId((current) => ({
          ...current,
          [run.scheduleId]: upsertScheduleRun(current[run.scheduleId] ?? [], run),
        }))
      }
    }
    const handleMessageCreated = (value: unknown) => {
      const message = readChatMessageResponse(value)
      if (!message) {
        return
      }
      setMessagesByChatId((current) => ({
        ...current,
        [message.chatId]: upsertMessage(current[message.chatId] ?? [], message),
      }))
    }
    const handleMessageDeleted = (value: unknown) => {
      const payload = readRecord(value)
      const chatId = readRecordString(payload, "chatId")
      const messageId = readRecordString(payload, "messageId")
      if (!chatId || !messageId) {
        return
      }
      setMessagesByChatId((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).filter((message) => message.id !== messageId),
      }))
    }

    socket.on("connect", handleConnect)
    socket.on("provider.event", handleProviderEvent)
    socket.on("message.created", handleMessageCreated)
    socket.on("message.deleted", handleMessageDeleted)
    socket.connect()
    return () => {
      socket.emit("workspace.leave", activeWorkspace.path)
      socket.off("connect", handleConnect)
      socket.off("provider.event", handleProviderEvent)
      socket.off("message.created", handleMessageCreated)
      socket.off("message.deleted", handleMessageDeleted)
      providerSocketRef.current = null
      socket.disconnect()
    }
  }, [activeWorkspace?.path])

  useEffect(() => {
    const socket = providerSocketRef.current
    if (!socket || !activeChatId) {
      return
    }
    socket.emit("chat.join", activeChatId)
    return () => {
      socket.emit("chat.leave", activeChatId)
    }
  }, [activeChatId, activeWorkspace?.path])

  const openWorkspaceFromFolder = async (directory: BrowserEntry) => {
    setActiveAgentId(null)
    if (directory.type !== "directory" || directory.error) {
      return
    }

    const existingWorkspace = workspaces.find((workspace) => samePath(workspace.path, directory.path))
    if (existingWorkspace) {
      setActiveWorkspaceId(existingWorkspace.id)
      const saved = await apiClient.workspaces.saveHistory(existingWorkspace.path).catch(() => null)
      if (saved) {
        setRecentWorkspaces((current) => upsertRecentWorkspace(current, saved))
      }
      setRouteTargetPending(false)
      setWorkspaceBrowserOpen(false)
      setWorkspaceStartOpen(false)
      setMobileDrawer(null)
      return
    }

    const savedWorkspace = await apiClient.workspaces.saveHistory(directory.path).catch((error) => {
      setWorkspaceLoadError(readError(error))
      return null
    })
    if (savedWorkspace) {
      setRecentWorkspaces((current) => upsertRecentWorkspace(current, savedWorkspace))
    }
    const workspace = createWorkspaceFromBrowserEntry(directory, workspaces, savedWorkspace?.id)
    setWorkspaces((current) => [...current, workspace])
    setOpenFileIdsByWorkspace((current) => ({
      ...current,
      [workspace.id]: initialOpenFileIds(workspace),
    }))
    setSelectedFileByWorkspace((current) => ({ ...current, [workspace.id]: workspace.selectedFileId }))
    setActiveWorkspaceId(workspace.id)
    setProvidersDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMainMode("chat")
    setMobileDrawer(null)
    setWorkspaceBrowserOpen(false)
    setWorkspaceStartOpen(false)
    setNavigationView("home")
    setRouteTargetPending(false)
  }

  const openRecentWorkspace = async (recent: WorkspaceHistoryResponse) => {
    setActiveAgentId(null)
    const existingWorkspace = workspaces.find((workspace) => workspace.id === recent.id || samePath(workspace.path, recent.path))
    if (existingWorkspace) {
      setActiveWorkspaceId(existingWorkspace.id)
      const saved = await apiClient.workspaces.saveHistory(existingWorkspace.path).catch(() => null)
      if (saved) {
        setRecentWorkspaces((current) => upsertRecentWorkspace(current, saved))
      }
      setWorkspaceBrowserOpen(false)
      setWorkspaceStartOpen(false)
      setNavigationView("home")
      setActiveChatId(null)
      setMainMode("chat")
      setMobileDrawer(null)
      setRouteTargetPending(false)
      return existingWorkspace
    }
    setWorkspaceLoadError(null)
    try {
      const workspace = await workspaceFromHistory(recent, workspaces)
      if (!workspace) {
        setWorkspaceLoadError("Unable to open workspace.")
        return null
      }
      setWorkspaces((current) => [...current, workspace])
      setOpenFileIdsByWorkspace((current) => ({ ...current, [workspace.id]: initialOpenFileIds(workspace) }))
      setSelectedFileByWorkspace((current) => ({ ...current, [workspace.id]: workspace.selectedFileId }))
      setActiveWorkspaceId(workspace.id)
      setProvidersDialogOpen(false)
      setMcpServersDialogOpen(false)
      setMainMode("chat")
      setMobileDrawer(null)
      setWorkspaceStartOpen(false)
      setNavigationView("home")
      setRouteTargetPending(false)
      const saved = await apiClient.workspaces.saveHistory(workspace.path).catch(() => null)
      if (saved) {
        setRecentWorkspaces((current) => upsertRecentWorkspace(current, saved))
      }
      return workspace
    } catch (error) {
      setWorkspaceLoadError(readError(error))
      return null
    }
  }

  const openSidebarChat = async (chat: ChatResponse) => {
    const path = chat.workingDirectory
    if (!path) { setWorkspaceLoadError("This chat has no project folder."); return }
    try {
      const workspace = workspaces.find((item) => samePath(item.path, path))
      if (workspace) {
        selectWorkspace(workspace.id)
      } else {
        const recent = recentWorkspaces.find((item) => samePath(item.path, path)) ?? await apiClient.workspaces.saveHistory(path)
        if (!await openRecentWorkspace(recent)) return
      }
      setChats((current) => upsertChat(current.filter((item) => item.workingDirectory && samePath(item.workingDirectory, path)), chat))
      setActiveChatId(chat.id)
      switchToChat()
    } catch (error) { setWorkspaceLoadError(readError(error)) }
  }

  const selectWorkspace = (workspaceId: string) => {
    setActiveAgentId(null)
    const workspace = workspaces.find((item) => item.id === workspaceId)
    setActiveWorkspaceId(workspaceId)
    setWorkspaceStartOpen(false)
    if (!workspace) {
      return
    }
    void apiClient.workspaces.saveHistory(workspace.path)
      .then((saved) => setRecentWorkspaces((current) => upsertRecentWorkspace(current, saved)))
      .catch(() => undefined)
  }

  const closeWorkspace = (workspaceId: string) => {
    const closingWorkspace = workspaces.find((workspace) => workspace.id === workspaceId)
    if (!closingWorkspace) {
      return
    }
    setWorkspaces((current) => {
      const closedIndex = current.findIndex((workspace) => workspace.id === workspaceId)
      const next = current.filter((workspace) => workspace.id !== workspaceId)
      if (workspaceId === activeWorkspaceId) {
        const nextActive = next[Math.max(0, closedIndex - 1)] ?? next[0]
        setActiveWorkspaceId(nextActive?.id ?? null)
        if (!nextActive) {
          clearSessionRouteTarget()
          setActiveChatId(null)
          setMainMode("chat")
          setMobileDrawer(null)
        }
      }
      return next
    })
    setOpenFileIdsByWorkspace((current) => omitRecordKey(current, workspaceId))
    setSelectedFileByWorkspace((current) => omitRecordKey(current, workspaceId))
    setRecentWorkspaces((current) => updateRecentWorkspaceOpenState(current, closingWorkspace.path, false))
    void apiClient.workspaces.closeHistory(closingWorkspace.path).catch(() => undefined)
  }

  const loadFileContent = async (file: FileNode) => {
    if (!file.path || fileContentById[file.id] !== undefined) {
      return
    }

    try {
      const resource = await apiClient.workspaces.readResource(file.path)
      setFileContentById((current) => current[file.id] !== undefined ? current : { ...current, [file.id]: resource.content })
    } catch (error) {
      setFileContentById((current) => current[file.id] !== undefined ? current : { ...current, [file.id]: readError(error) })
    }
  }

  const selectFile = (id: string, options?: FileSelectOptions) => {
    if (!activeWorkspace) {
      return
    }
    const file = findFile(activeWorkspace.fileTree, id)
    if (file) {
      void loadFileContent(file)
    }
    setOpenFileIdsByWorkspace((current) => {
      const openIds = current[activeWorkspace.id] ?? []
      return openIds.includes(id) ? current : { ...current, [activeWorkspace.id]: [...openIds, id] }
    })
    setSelectedFileByWorkspace((current) => ({ ...current, [activeWorkspace.id]: id }))
    setProvidersDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMobileDrawer(null)
    setMainMode(readDetachedEditorPreference() ? "dialog" : "editor")
    setEditorRevealTarget(
      options?.lineNumber
        ? {
            fileId: id,
            lineNumber: options.lineNumber,
            column: options.column,
            nonce: Date.now(),
          }
        : null,
    )
  }

  const openChatFileLink = (href: string): boolean => {
    if (!activeWorkspace) {
      return false
    }
    const target = parseChatFileLink(href, activeWorkspace)
    if (!target) {
      return false
    }
    void openWorkspaceFilePath(`${activeWorkspace.path}/${target.path}`, target.lineNumber ?? 1, target.column ?? 1)
      .then((opened) => {
        if (!opened) setChatError("Unable to open the linked file.")
      })
    return true
  }

  const closeFile = (id: string) => {
    if (!activeWorkspace) {
      return
    }
    const openIds = openFileIdsByWorkspace[activeWorkspace.id] ?? []
    const nextOpenIds = openIds.filter((openId) => openId !== id)
    setOpenFileIdsByWorkspace((current) => ({ ...current, [activeWorkspace.id]: nextOpenIds }))

    if (selectedFileId !== id) {
      return
    }

    const closedIndex = openIds.indexOf(id)
    const nextSelectedId = nextOpenIds[Math.max(0, closedIndex - 1)] ?? nextOpenIds[0]
    if (nextSelectedId) {
      setSelectedFileByWorkspace((current) => ({ ...current, [activeWorkspace.id]: nextSelectedId }))
      return
    }

    setMainMode("chat")
  }

  const openWorkspaceFilePath = async (targetPath: string, lineNumber: number, column: number): Promise<boolean> => {
    if (!activeWorkspace) {
      return false
    }

    let target = findFileByAbsolutePath(activeWorkspace.fileTree, targetPath)
    if (!target) {
      const loaded = await loadFilePathIntoWorkspaceTree(activeWorkspace, targetPath).catch(() => null)
      if (!loaded) {
        return false
      }
      target = loaded.file
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === activeWorkspace.id ? { ...workspace, fileTree: loaded.fileTree } : workspace,
        ),
      )
    }

    void loadFileContent(target)
    setOpenFileIdsByWorkspace((current) => {
      const openIds = current[activeWorkspace.id] ?? []
      return openIds.includes(target.id) ? current : { ...current, [activeWorkspace.id]: [...openIds, target.id] }
    })
    setSelectedFileByWorkspace((current) => ({ ...current, [activeWorkspace.id]: target.id }))
    setMainMode(readDetachedEditorPreference() ? "dialog" : "editor")
    setEditorRevealTarget({ column, fileId: target.id, lineNumber, nonce: Date.now() })
    return true
  }

  const updateFileContent = (id: string, value: string) => {
    setFileContentById((current) => ({ ...current, [id]: value }))
  }

  const openSelectedFileDialog = () => {
    if (!selectedFile) {
      return
    }
    void loadFileContent(selectedFile)
    writeDetachedEditorPreference(true)
    setMainMode("dialog")
  }

  const sendChatMessageToTarget = async (
    input: ChatComposerSubmit,
    options: { forceNewChat?: boolean } = {},
  ) => {
    const message = input.content.trim()
    if (!message || !activeWorkspace) {
      throw new Error("Select a workspace and enter a message before sending.")
    }
    setChatError(null)
    let optimisticChatId: string | null = null
    try {
      const targetChat = options.forceNewChat ? null : activeChat
      const targetAccount = selectChatAccount(targetChat, chatAccounts, preferredAccountId)
      if (!targetAccount) {
        setProvidersDialogOpen(true)
        throw new Error("Connect a provider account before sending a message.")
      }
      const chat = targetChat ?? await apiClient.chats.create({
        accountId: targetAccount.id,
        collaborationMode: input.collaborationMode,
        model: input.model,
        permissionMode: input.permissionMode,
        providerId: targetAccount.providerId,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        title: titleFromPrompt(message),
        workingDirectory: activeWorkspace.path,
      })
      setActiveChatId(chat.id)
      setChats((current) => upsertChat(current, chat))
      const optimisticMessage = createOptimisticChatMessage(chat.id, message, messagesByChatId[chat.id] ?? [], {
        delivery: input.delivery,
      })
      optimisticChatId = chat.id
      setMessagesByChatId((current) => ({
        ...current,
        [chat.id]: upsertMessage(current[chat.id] ?? [], optimisticMessage),
      }))
      const result = await apiClient.chats.execute(chat.id, {
        accountId: targetAccount.id,
        attachments: input.attachments,
        collaborationMode: input.collaborationMode,
        content: message,
        delivery: input.delivery,
        goalObjective: input.goalObjective,
        metadata: {
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          serviceTier: input.serviceTier,
        },
        permissionMode: input.permissionMode,
      })
      setMessagesByChatId((current) => ({
        ...current,
        [chat.id]: [result.message, result.assistantMessage]
          .filter((message): message is ChatMessageResponse => Boolean(message))
          .reduce((messages, message) => upsertMessage(messages, message), current[chat.id] ?? []),
      }))
    } catch (error) {
      setChatError(readError(error))
      if (optimisticChatId) {
        const chatId = optimisticChatId
        setMessagesByChatId((current) => ({
          ...current,
          [chatId]: removeOptimisticMessages(current[chatId] ?? [], { content: message, role: "USER" }),
        }))
      }
      throw error
    }
  }

  const sendChatMessage = async (input: ChatComposerSubmit) => {
    await sendChatMessageToTarget(input)
  }

  const deleteQueuedMessage = async (chatId: string, runId: string) => {
    setChatError(null)
    try {
      await apiClient.chats.deleteQueuedRun(chatId, runId)
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const editQueuedMessage = async (chatId: string, runId: string, content: string) => {
    const nextContent = window.prompt("Edit queued message", content)
    if (nextContent === null) {
      return
    }
    const trimmed = nextContent.trim()
    if (!trimmed) {
      return
    }
    setChatError(null)
    try {
      await apiClient.chats.updateQueuedRun(chatId, runId, { content: trimmed })
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const steerQueuedMessage = async (chatId: string, runId: string) => {
    setChatError(null)
    try {
      await apiClient.chats.steerQueuedRun(chatId, runId)
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const reorderQueuedMessages = async (chatId: string, runIds: string[]) => {
    setChatError(null)
    try {
      await apiClient.chats.reorderQueuedRuns(chatId, { runIds })
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const stopActiveChat = async () => {
    if (!activeChat) {
      return
    }
    const chatId = activeChat.id
    setChatError(null)
    try {
      const response = await apiClient.chats.interrupt(chatId)
      setChats((current) =>
        current.map((chat) => chat.id === chatId ? { ...chat, status: "IDLE" } : chat),
      )
      setMessagesByChatId((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).filter((message) => (
          message.status !== "STREAMING" ||
          (response.runId ? message.runId !== response.runId : false)
        )),
      }))
      await loadMessagesForChat(chatId)
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const switchChatAccount = async (accountId: string) => {
    const targetAccount = chatAccounts.find((account) => account.id === accountId)
    if (!targetAccount) {
      setProvidersDialogOpen(true)
      return
    }
    const previousAccountId = activeChat?.accountId ?? preferredAccountId
    setPreferredAccountId(accountId)
    if (!activeChat || activeChat.accountId === accountId) {
      return
    }
    setIsSwitchingAccount(true)
    setChatError(null)
    try {
      const updated = await apiClient.chats.update(activeChat.id, { accountId })
      setChats((current) => upsertChat(current, updated))
      await loadMessagesForChat(updated.id)
    } catch (error) {
      setPreferredAccountId(previousAccountId ?? null)
      setChatError(readError(error))
    } finally {
      setIsSwitchingAccount(false)
    }
  }

  const updateChatPermissionMode = async (chatId: string, permissionMode: ChatComposerAccessMode) => {
    setChatError(null)
    try {
      const updated = await apiClient.chats.update(chatId, { permissionMode })
      setChats((current) => upsertChat(current, updated))
    } catch (error) {
      setChatError(readError(error))
      throw error
    }
  }

  const updateChatRuntimeSettings = async (
    chatId: string,
    settings: { model?: string | null; reasoningEffort?: string | null; serviceTier?: string | null },
  ) => {
    setChatError(null)
    try {
      const updated = await apiClient.chats.update(chatId, settings)
      setChats((current) => upsertChat(current, updated))
    } catch (error) {
      setChatError(readError(error))
      throw error
    }
  }

  const archiveChat = async (chatId: string, snapshot?: ChatResponse) => {
    if (archivingChatIds.current.has(chatId)) return
    archivingChatIds.current.add(chatId)
    const original = snapshot ?? chats.find((chat) => chat.id === chatId)
    setChatError(null)
    setSidebarChatError(null)
    setArchivedChatIds((current) => ({ ...current, [chatId]: true }))
    setChats((current) => current.filter((chat) => chat.id !== chatId))
    setActiveChatId((current) => current === chatId ? null : current)
    try {
      await apiClient.chats.delete(chatId)
      setMessagesByChatId((current) => omitRecordKey(current, chatId))
    } catch (error) {
      setArchivedChatIds((current) => { const next = { ...current }; delete next[chatId]; return next })
      if (original?.workingDirectory && activeWorkspaceRef.current && samePath(original.workingDirectory, activeWorkspaceRef.current.path)) {
        setChats((current) => upsertChat(current, original))
      }
      setChatError(readError(error))
      setSidebarChatError(readError(error))
    } finally {
      archivingChatIds.current.delete(chatId)
      setSidebarChatRevision((current) => current + 1)
    }
  }

  const compactChat = async (chatId: string) => {
    setChatError(null)
    try {
      const updated = await apiClient.chats.compact(chatId)
      setChats((current) => upsertChat(current, updated))
      await loadMessagesForChat(chatId)
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const forkChat = async (chatId: string, lastTurnId?: string | null) => {
    setChatError(null)
    try {
      const forked = await apiClient.chats.fork(chatId, lastTurnId ? { lastTurnId } : {})
      setChats((current) => upsertChat(current, forked))
      setActiveChatId(forked.id)
      await loadMessagesForChat(forked.id)
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const refreshChat = async (chatId: string) => {
    setChatError(null)
    try {
      const response = await apiClient.chats.refresh(chatId)
      setChats((current) => upsertChat(current, response.chat))
      setMessagesByChatId((current) => ({ ...current, [chatId]: response.messages.data }))
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const renameChat = async (chatId: string, title: string) => {
    setChatError(null)
    try {
      const updated = await apiClient.chats.update(chatId, { title })
      setChats((current) => upsertChat(current, updated))
    } catch (error) {
      setChatError(readError(error))
      throw error
    }
  }

  const reviewChat = async (chatId: string, instructions?: string | null) => {
    setChatError(null)
    try {
      const updated = await apiClient.chats.review(chatId, instructions?.trim()
        ? { target: "custom", instructions: instructions.trim() }
        : { target: "uncommittedChanges" })
      setChats((current) => upsertChat(current, updated))
      await loadMessagesForChat(chatId)
    } catch (error) {
      setChatError(readError(error))
    }
  }

  const startNewChat = () => {
    setActiveAgentId(null)
    setNavigationView("home")
    setActiveChatId(null)
    setChatError(null)
    setMainMode("chat")
    setMobileDrawer(null)
  }

  const createSchedule = async () => {
    if (!activeWorkspace) {
      return
    }
    const targetAccount = selectChatAccount(activeChat, chatAccounts, preferredAccountId)
    if (!targetAccount) {
      setScheduleError("Connect a provider account before creating a schedule.")
      setProvidersDialogOpen(true)
      return
    }
    setScheduleError(null)
    try {
      const schedule = await apiClient.schedules.create({
        accountId: targetAccount.id,
        collaborationMode: "default",
        firstRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        message: "Describe the scheduled task.",
        permissionMode: "default",
        recurrence: { frequency: "none", interval: 1 },
        status: "PAUSED",
        title: "New schedule",
        workingDirectory: activeWorkspace.path,
      })
      setSchedules((current) => upsertSchedule(current, schedule))
      setActiveScheduleId(schedule.id)
      setNavigationView("scheduled")
      setMainMode("schedule")
      setMobileDrawer(null)
      void loadScheduleRuns(schedule.id)
      void loadChatsForWorkspace(activeWorkspace.path, activeWorkspace.id, { silent: true })
    } catch (error) {
      setScheduleError(readError(error))
    }
  }

  const selectSchedule = (scheduleId: string) => {
    setActiveAgentId(null)
    setActiveScheduleId(scheduleId)
    setNavigationView("scheduled")
    setProvidersDialogOpen(false)
    setInstructionsDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMainMode("schedule")
    setMobileDrawer(null)
  }

  const updateSchedule = async (scheduleId: string, body: Parameters<typeof apiClient.schedules.update>[1]) => {
    setScheduleError(null)
    try {
      const schedule = await apiClient.schedules.update(scheduleId, body)
      setSchedules((current) => upsertSchedule(current, schedule))
      return schedule
    } catch (error) {
      setScheduleError(readError(error))
      throw error
    }
  }

  const deleteSchedule = async (scheduleId: string) => {
    setScheduleError(null)
    try {
      await apiClient.schedules.delete(scheduleId)
      setSchedules((current) => current.filter((schedule) => schedule.id !== scheduleId))
      setScheduleRunsByScheduleId((current) => omitRecordKey(current, scheduleId))
      if (activeScheduleId === scheduleId) {
        setActiveScheduleId(null)
        setMainMode("chat")
      }
    } catch (error) {
      setScheduleError(readError(error))
    }
  }

  const openScheduleRunChat = async (run: MessageScheduleRunResponse) => {
    const chatId = run.chatId
    if (!chatId) {
      setScheduleError("This schedule run is not linked to a chat yet.")
      return
    }
    setActiveChatId(chatId)
    await loadMessagesForChat(chatId)
    switchToChat()
  }

  const switchToChat = () => {
    setActiveAgentId(null)
    setNavigationView("home")
    setProvidersDialogOpen(false)
    setInstructionsDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMainMode("chat")
    setMobileDrawer(null)
  }

  const switchToEditor = () => {
    setActiveAgentId(null)
    setNavigationView("home")
    writeDetachedEditorPreference(false)
    setMainMode("editor")
    setMobileDrawer(null)
  }

  const selectManagementView = (view: ManagementView) => {
    setProvidersDialogOpen(view === "providers")
    setInstructionsDialogOpen(view === "instructions")
    setMcpServersDialogOpen(view === "mcpServers")
    setMobileDrawer(null)
  }


  const selectNavigationView = (view: NavigationView) => {
    if (view !== "home") setActiveAgentId(null)
    setNavigationView(view)
    setProvidersDialogOpen(false)
    setInstructionsDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMobileDrawer(null)
    if (view === "home") setMainMode("chat")
    if (view === "scheduled") setMainMode("schedule")
  }

  const updateUserName = (value: string) => {
    const name = value.trim().slice(0, 80) || "Local user"
    window.localStorage.setItem("pockcode-user-name", name)
    setUserName(name)
  }

  const selectAgent = (agentId: string) => {
    setActiveAgentId(agentId)
    setActiveChatId(null)
    setNavigationView("home")
    setMainMode("chat")
    setProvidersDialogOpen(false)
    setInstructionsDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMobileDrawer(null)
  }

  const createAgent = async (request: CreateAssistantRequest) => {
    const agent = await apiClient.assistant.create(request)
    updateAgent(agent)
    selectAgent(agent.id)
  }

  return {
    activeAgentId,
    agents,
    sidebarChatRevision,
    archivedChatIds,
    sidebarChatError,
    openSidebarChat,
    agentError,
    isAgentsLoading,
    createAgent,
    selectAgent,
    updateAgent,
    activeChat,
    activeChatId,
    activeMessages,
    activeMessagesLoaded,
    activeSchedule,
    activeScheduleId,
    activeScheduleRuns: activeScheduleId ? scheduleRunsByScheduleId[activeScheduleId] ?? [] : [],
    activeWorkspace,
    accountSwitchPhase: activeChatId ? accountSwitchByChatId[activeChatId] ?? null : null,
    archiveChat,
    chatAccounts,
    chatError,
    chats: visibleChats,
    compactChat,
    closeFile,
    closeWorkspace,
    createSchedule,
    deleteSchedule,
    deleteQueuedMessage,
    editQueuedMessage,
    editorRevealTarget,
    forkChat,
    instructionsDialogOpen,
    isChatsLoading,
    isSchedulesLoading,
    isSwitchingAccount,
    isWorkspaceHistoryLoading,
    mainMode,
    mcpServersDialogOpen,
    messagesByChatId,
    mobileDrawer,
    openChatFileLink,
    openFiles,
    openRecentWorkspace,
    openSelectedFileDialog,
    openWorkspaceFilePath,
    openWorkspaceFromFolder,
    preferredAccountId,
    providerDefinitions,
    providersDialogOpen,
    recentWorkspaces,
    refreshChat,
    renameChat,
    reorderQueuedMessages,
    reviewChat,
    selectFile,
    selectManagementView,
    selectSchedule,
    selectWorkspace,
    selectedFile,
    selectedFileContent,
    selectedFileId,
    sendChatMessage,
    setActiveChatId,
    setActiveScheduleId,
    setInstructionsDialogOpen,
    setMainMode,
    setMcpServersDialogOpen,
    setMobileDrawer,
    setProvidersDialogOpen,
    setSidebarWidth,
    setWorkspaceBrowserOpen,
    setWorkspaceLoadError,
    setWorkspaceStartOpen,
    sidebarWidth,
    navigationView,
    selectNavigationView,
    userName,
    updateUserName,
    startNewChat,
    steerQueuedMessage,
    stopActiveChat,
    switchChatAccount,
    switchToChat,
    switchToEditor,
    openScheduleRunChat,
    scheduleError,
    schedules,
    updateChatPermissionMode,
    updateChatRuntimeSettings,
    updateSchedule,
    updateProviderData,
    updateFileContent,
    workspaceBrowserOpen,
    workspaceLoadError,
    workspaceStartOpen,
    workspaces,
  }
}

function SessionShellView() {
  const shell = useSessionShellState()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [titlebarActions, setTitlebarActions] = useState<HTMLDivElement | null>(null)

  return (
    <SessionTitlebarActionsContext.Provider value={titlebarActions}>
      <div className="app-shell-viewport session-app overflow-hidden text-foreground" style={{ "--session-sidebar-width": `${shell.sidebarWidth}px` } as CSSProperties}>
        <div className="session-shell" data-sidebar-collapsed={sidebarCollapsed}>
          <SessionTitleBar shell={shell} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed((current) => !current)} actionsRef={setTitlebarActions} />
          <div className="session-app-layout grid min-h-0 overflow-hidden">
            <SessionNavigation shell={shell} />
            <div className="session-sidebar-column hidden min-h-0 overflow-hidden md:block"><SessionSidebarPanel /></div>
            <div className="session-sidebar-resizer relative hidden min-h-0 md:block">
              <ResizeHandle label="sidebar" orientation="vertical" onPointerDown={(event) => startColumnResize(event, {
                max: 360, min: 240, side: "left", startWidth: shell.sidebarWidth, onResize: shell.setSidebarWidth,
              })} />
            </div>
            <main className="session-shell-grid grid min-h-0 min-w-0 overflow-hidden bg-background">
              <SessionWorkspaceContent />
            </main>
          </div>
        </div>
        <SessionMobileDrawers />
        <SessionDialogHost />
      </div>
    </SessionTitlebarActionsContext.Provider>
  )
}

function SessionWorkspaceContent() {
  const shell = useSessionShellState()

  if (shell.navigationView === "home" && shell.activeAgentId) return <Suspense fallback={<div className="grid place-items-center text-sm text-muted-foreground">Loading agent…</div>}><AssistantPage key={shell.activeAgentId} agentId={shell.activeAgentId} shell={shell} /></Suspense>
  if (shell.navigationView === "tasks") return <TasksBoardPage shell={shell} />
  if (shell.navigationView === "projects") return <ProjectsPage shell={shell} />
  if (shell.navigationView === "usage") return <UsagePage shell={shell} />
  if (shell.navigationView === "settings") return <SettingsPage shell={shell} />
  if (shell.navigationView === "scheduled" && (!shell.activeWorkspace || !shell.activeSchedule)) return <ScheduledEmptyPage shell={shell} />

  if (!shell.activeWorkspace || shell.workspaceStartOpen) {
    return (
      <EmptyWorkspacePane
        error={shell.workspaceLoadError}
        isLoading={shell.isWorkspaceHistoryLoading}
        recentWorkspaces={shell.recentWorkspaces}
        onOpenFolder={() => shell.setWorkspaceBrowserOpen(true)}
        onOpenRecent={shell.openRecentWorkspace}
      />
    )
  }

  return (
    <div className="min-h-0 min-w-0 overflow-hidden">
      <SessionMainContent onBackToChat={shell.switchToChat} />
    </div>
  )
}

function SessionSidebarPanel() {
  const shell = useSessionShellState()

  return <SessionSidebar shell={shell} />
}

function SessionMainContent({
  onBackToChat,
}: {
  onBackToChat: () => void
}) {
  const shell = useSessionShellState()

  if (!shell.activeWorkspace) {
    return null
  }

  return <MainContentPane onBackToChat={onBackToChat} />
}

function SessionMobileDrawers() {
  const shell = useSessionShellState()

  return (
    <MobilePanelDrawer side="left" title="Agents, projects and chats" open={shell.mobileDrawer === "sessions"} onClose={() => shell.setMobileDrawer(null)}>
      <SessionSidebarPanel />
    </MobilePanelDrawer>
  )
}

function SessionDialogHost() {
  const shell = useSessionShellState()
  const revealTarget = shell.selectedFile && shell.editorRevealTarget?.fileId === shell.selectedFile.id
    ? shell.editorRevealTarget
    : null

  return (
    <Suspense fallback={null}>
      {shell.activeWorkspace && shell.selectedFile && shell.mainMode === "dialog" ? (
        <FileDialog
          content={shell.selectedFileContent}
          file={shell.selectedFile}
          revealTarget={revealTarget}
          workspace={shell.activeWorkspace}
          onClose={() => shell.setMainMode("chat")}
          onContentChange={shell.updateFileContent}
          onOpenInMain={() => {
            writeDetachedEditorPreference(false)
            shell.setMainMode("editor")
          }}
        />
      ) : null}
      {shell.workspaceBrowserOpen ? (
      <WorkspaceFolderBrowserDialog
        open={shell.workspaceBrowserOpen}
        openWorkspacePaths={shell.workspaces.map((workspace) => workspace.path)}
        onClose={() => shell.setWorkspaceBrowserOpen(false)}
        onSelect={shell.openWorkspaceFromFolder}
      />
      ) : null}
      {shell.instructionsDialogOpen ? (
      <CodexInstructionsDialog
        open={shell.instructionsDialogOpen}
        onClose={() => shell.setInstructionsDialogOpen(false)}
      />
      ) : null}
      {shell.providersDialogOpen ? (
      <ProvidersManagementDialog
        open={shell.providersDialogOpen}
        onClose={() => shell.setProvidersDialogOpen(false)}
        onProviderDataChange={shell.updateProviderData}
      />
      ) : null}
      {shell.mcpServersDialogOpen ? (
      <McpServersManagementDialog
        open={shell.mcpServersDialogOpen}
        onClose={() => shell.setMcpServersDialogOpen(false)}
      />
      ) : null}
    </Suspense>
  )
}

function EmptyWorkspacePane({
  error,
  isLoading,
  recentWorkspaces,
  onOpenFolder,
  onOpenRecent,
}: {
  error: string | null
  isLoading: boolean
  recentWorkspaces: WorkspaceHistoryResponse[]
  onOpenFolder: () => void
  onOpenRecent: (workspace: WorkspaceHistoryResponse) => void
}) {
  if (isLoading) {
    return (
      <section className="grid min-h-0 place-items-center p-4">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin text-info" />
          Loading workspace data
        </div>
      </section>
    )
  }

  return (
    <section className="grid min-h-0 place-items-center p-4">
      <div className="grid w-full max-w-md gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <FolderOpen className="size-4 text-ide-folder" />
          Open a workspace
        </div>
        {error ? <div className="text-[12px] text-destructive">{error}</div> : null}
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground"
          type="button"
          onClick={onOpenFolder}
        >
          Open Folder
        </button>
        {recentWorkspaces.length ? (
          <div className="mt-1 border-t border-border pt-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recent</div>
            <div className="grid gap-1">
              {recentWorkspaces.slice(0, 8).map((workspace) => (
                <button
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
                  key={workspace.id}
                  type="button"
                  onClick={() => onOpenRecent(workspace)}
                >
                  <Folder className="size-4 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-foreground">{workspace.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{workspace.path}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function upsertRecentWorkspace(current: WorkspaceHistoryResponse[], workspace: WorkspaceHistoryResponse) {
  return [
    workspace,
    ...current.filter((item) => item.id !== workspace.id && !samePath(item.path, workspace.path)),
  ]
}

function updateRecentWorkspaceOpenState(
  current: WorkspaceHistoryResponse[],
  workspacePath: string,
  isOpen: boolean,
) {
  return current.map((item) => samePath(item.path, workspacePath) ? { ...item, isOpen } : item)
}

function ResizeHandle({
  label,
  orientation,
  style,
  onPointerDown,
}: {
  label: string
  orientation: "horizontal" | "vertical"
  style?: CSSProperties
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      aria-label={`Resize ${label}`}
      className={cn(
        "relative z-20 min-h-0 min-w-0 bg-transparent outline-none after:absolute after:bg-transparent hover:after:bg-accent focus-visible:after:bg-primary",
        orientation === "vertical" &&
          "h-full w-full cursor-col-resize after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2",
        orientation === "horizontal" &&
          "h-full w-full cursor-row-resize after:left-1/2 after:top-1/2 after:h-px after:w-14 after:-translate-x-1/2 after:-translate-y-1/2",
      )}
      style={style}
      type="button"
      onPointerDown={onPointerDown}
    />
  )
}

function MainContentPane({
  onBackToChat,
}: {
  onBackToChat: () => void
}) {
  const shell = useSessionShellState()
  const workspace = shell.activeWorkspace
  const selectedFile = shell.selectedFile

  if (!workspace) {
    return null
  }

  if (shell.mainMode === "editor" && selectedFile) {
    return (
      <FileEditorPane
        content={shell.selectedFileContent}
        file={selectedFile}
        openFiles={shell.openFiles}
        revealTarget={shell.editorRevealTarget?.fileId === selectedFile.id ? shell.editorRevealTarget : null}
        workspace={workspace}
        onFileClose={shell.closeFile}
        onContentChange={shell.updateFileContent}
        onFileSelect={shell.selectFile}
        onOpenDialog={shell.openSelectedFileDialog}
        onToggleMode={onBackToChat}
      />
    )
  }

  if (shell.mainMode === "schedule") {
    return <Suspense fallback={<div className="grid h-full place-items-center text-[13px] text-muted-foreground">Loading schedule</div>}><ScheduleDetailPane shell={shell} /></Suspense>
  }

  return (
    <ChatPane
      accounts={shell.chatAccounts}
      chat={shell.activeChat}
      error={shell.chatError}
      isLoading={shell.isChatsLoading}
      isMessagesLoading={Boolean(shell.activeChat && !shell.activeMessagesLoaded)}
      isSwitchingAccount={shell.isSwitchingAccount}
      accountSwitchPhase={shell.accountSwitchPhase}
      messages={shell.activeMessages}
      preferredAccountId={shell.preferredAccountId}
      providerDefinitions={shell.providerDefinitions}
      workspace={workspace}
      onArchiveChat={shell.archiveChat}
      onCompactChat={shell.compactChat}
      onDeleteQueuedMessage={shell.deleteQueuedMessage}
      onEditQueuedMessage={shell.editQueuedMessage}
      onFileLinkOpen={shell.openChatFileLink}
      onForkChat={shell.forkChat}
      onNewChat={shell.startNewChat}
      onOpenMcpServers={() => shell.setMcpServersDialogOpen(true)}
      onOpenProviders={() => shell.setProvidersDialogOpen(true)}
      onRefreshChat={shell.refreshChat}
      onRenameChat={shell.renameChat}
      onReviewChat={shell.reviewChat}
      onToggleMode={shell.selectedFile ? shell.switchToEditor : undefined}
      onReorderQueuedMessages={shell.reorderQueuedMessages}
      onPermissionModeChange={shell.updateChatPermissionMode}
      onRuntimeSettingsChange={shell.updateChatRuntimeSettings}
      onSendMessage={shell.sendChatMessage}
      onSteerQueuedMessage={shell.steerQueuedMessage}
      onSwitchAccount={shell.switchChatAccount}
      onStopChat={shell.stopActiveChat}
    />
  )
}

function findFileByAbsolutePath(nodes: FileNode[], targetPath: string): FileNode | null {
  for (const node of nodes) {
    if (node.type === "file" && node.path && samePath(node.path, targetPath)) {
      return node
    }
    const child = node.children ? findFileByAbsolutePath(node.children, targetPath) : null
    if (child) {
      return child
    }
  }
  return null
}

async function loadFilePathIntoWorkspaceTree(
  workspace: Workspace,
  targetPath: string,
): Promise<{ file: FileNode; fileTree: FileNode[] } | null> {
  const segments = relativePathSegments(workspace.path, targetPath)
  if (!segments?.length) {
    return null
  }

  const fileTree = cloneFileTree(workspace.fileTree)
  let current = fileTree[0]

  for (const segment of segments.slice(0, -1)) {
    if (!current || current.type !== "folder" || !current.path) {
      return null
    }
    if (!current.children) {
      current.children = await readFileTreeChildren(current)
    }
    const next = current.children.find((child) => child.type === "folder" && child.name === segment)
    if (!next) {
      return null
    }
    current = next
  }

  if (!current || current.type !== "folder" || !current.path) {
    return null
  }
  if (!current.children) {
    current.children = await readFileTreeChildren(current)
  }

  const fileName = segments.at(-1)
  const file = current.children.find((child) => child.type === "file" && child.name === fileName)
  return file ? { file, fileTree } : null
}

async function readFileTreeChildren(folder: FileNode): Promise<FileNode[]> {
  if (!folder.path) {
    return []
  }
  const entry = await apiClient.workspaces.readTree(folder.path)
  return (entry.children ?? []).map((child, index) =>
    browserEntryToFileNode(child, `${folder.id}/${index}-${slugifyWorkspaceId(child.name)}`),
  )
}

function cloneFileTree(nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneFileTree(node.children) : undefined,
  }))
}

function relativePathSegments(rootPath: string, targetPath: string): string[] | null {
  const root = trimTrailingSlash(normalizeWorkspaceAbsolutePath(rootPath))
  const target = trimTrailingSlash(normalizeWorkspaceAbsolutePath(targetPath))
  if (target === root || !target.startsWith(`${root}/`)) {
    return null
  }
  return target.slice(root.length + 1).split("/").filter(Boolean)
}

function normalizeWorkspaceAbsolutePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/")
}

function trimTrailingSlash(value: string): string {
  return value === "/" ? value : value.replace(/\/+$/u, "")
}

function startColumnResize(
  event: ReactPointerEvent<HTMLButtonElement>,
  options: {
    max: number
    min: number
    onResize: (width: number) => void
    side: "left" | "right"
    startWidth: number
  },
) {
  startHorizontalResize(event, {
    initialWidth: options.startWidth,
    max: options.max,
    min: options.min,
    onResize: options.onResize,
    origin: options.side,
  })
}

function readNavigationView(): NavigationView {
  const value = typeof window === "undefined" ? "" : window.location.hash.slice(1)
  return value === "tasks" || value === "scheduled" || value === "projects" || value === "usage" || value === "settings" ? value : "home"
}
