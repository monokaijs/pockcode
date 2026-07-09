import {
  Folder,
  FolderOpen,
  LoaderCircle,
} from "lucide-react"
import { io } from "socket.io-client"
import { ChatPane } from "@/components/session/chat-pane"
import { ChatListProvider } from "@/components/session/chat-list-context"
import { RightPanel } from "@/components/session/right-panel"
import { FileDialog, FileEditorPane } from "@/components/session/file-editor-pane"
import { McpServersManagementDialog } from "@/components/session/mcp-servers-management-dialog"
import { ProvidersManagementDialog } from "@/components/session/providers-management-dialog"
import { PluginsManagementDialog } from "@/components/session/plugins-management-dialog"
import { CodexInstructionsDialog } from "@/components/session/codex-instructions-dialog"
import { WorkspaceFolderBrowserDialog } from "@/components/session/workspace-folder-browser-dialog"
import { SessionSidebar } from "@/components/session/session-sidebar"
import { ScheduleDetailPane } from "@/components/session/schedule-detail-pane"
import {
  readMessageScheduleResponse,
  readMessageScheduleRunResponse,
  upsertSchedule,
  upsertScheduleRun,
} from "@/components/session/schedule-utils"
import { MobilePanelDrawer, TopBar } from "@/components/session/session-chrome"
import { ProviderQuotaProvider } from "@/components/session/provider-quota-context"
import { SessionTerminalPanel } from "@/components/session/terminal-panel"
import {
  DEFAULT_TERMINAL_HEIGHT,
  MAX_TERMINAL_HEIGHT,
  MIN_TERMINAL_HEIGHT,
  useWorkspaceTerminals,
} from "@/components/session/workspace-terminals"
import type {
  PointerEvent as ReactPointerEvent,
} from "react"
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
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
  PanelTab,
  SidebarTab,
  Workspace,
} from "@/types/session"
import {
  browserEntryToFileNode,
  clearSessionRouteTarget,
  collectInitialFolderIds,
  createOptimisticChatMessage,
  createWorkspaceFromBrowserEntry,
  fileContentFor,
  findFile,
  findFileByWorkspacePath,
  findNode,
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
  samePath,
  selectChatAccount,
  shouldShowFilesPanelByDefault,
  slugifyWorkspaceId,
  titleFromPrompt,
  updateFileNodeChildren,
  upsertChat,
  upsertMessage,
  removeOptimisticMessages,
  workspaceFromHistory,
  writeDetachedEditorPreference,
  writeSessionRouteTarget,
} from "@/lib/session"
import { startHorizontalResize, startVerticalResize } from "@/lib/resize"

export type SessionShellState = ReturnType<typeof useSessionShellController>

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
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>("files")
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatResponse[]>([])
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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chats")
  const [isWorkspaceHistoryLoading, setIsWorkspaceHistoryLoading] = useState(true)
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceHistoryResponse[]>([])
  const [editorRevealTarget, setEditorRevealTarget] = useState<FileRevealTarget | null>(null)
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set())
  const [loadingFolderIds, setLoadingFolderIds] = useState<Set<string>>(new Set())
  const [fileContentById, setFileContentById] = useState<Record<string, string>>({})
  const [filesWidth, setFilesWidth] = useState(380)
  const [isFilesPanelOpen, setIsFilesPanelOpen] = useState(() => shouldShowFilesPanelByDefault())
  const [isTerminalPanelOpen, setIsTerminalPanelOpen] = useState(false)
  const [mainMode, setMainMode] = useState<MainMode>("chat")
  const [messagesByChatId, setMessagesByChatId] = useState<Record<string, ChatMessageResponse[]>>({})
  const [mobileDrawer, setMobileDrawer] = useState<MobileDrawer>(null)
  const [openFileIdsByWorkspace, setOpenFileIdsByWorkspace] = useState<Record<string, string[]>>({})
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [selectedFileByWorkspace, setSelectedFileByWorkspace] = useState<Record<string, string>>({})
  const [terminalHeight, setTerminalHeight] = useState(DEFAULT_TERMINAL_HEIGHT)
  const [providersDialogOpen, setProvidersDialogOpen] = useState(false)
  const [instructionsDialogOpen, setInstructionsDialogOpen] = useState(false)
  const [mcpServersDialogOpen, setMcpServersDialogOpen] = useState(false)
  const [pluginsDialogOpen, setPluginsDialogOpen] = useState(false)
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null)
  const [workspaceBrowserOpen, setWorkspaceBrowserOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const activeChatIdRef = useRef<string | null>(null)
  const activeScheduleIdRef = useRef<string | null>(null)
  const loadingFolderIdsRef = useRef<Set<string>>(new Set())
  const providerSocketRef = useRef<ReturnType<typeof io> | null>(null)
  const terminalAutoCreateWorkspaceRef = useRef<string | null>(null)

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0] ?? null,
    [activeWorkspaceId, workspaces],
  )
  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? null,
    [activeChatId, chats],
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
  const desktopGridColumns = isFilesPanelOpen
    ? `${sidebarWidth}px minmax(420px, 1fr) ${filesWidth}px`
    : `${sidebarWidth}px minmax(420px, 1fr)`
  const terminalHost = useWorkspaceTerminals(activeWorkspace)

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
      const targetHistory = history.find((item) => item.id === routeTarget.workspaceId)
      if (targetHistory) {
        const workspace = await workspaceFromHistory(targetHistory, nextWorkspaces)
        if (workspace) {
          nextWorkspaces.push(workspace)
        }
      }
      setWorkspaces(nextWorkspaces)
      setExpandedFolderIds(new Set(nextWorkspaces.flatMap((workspace) => collectInitialFolderIds(workspace))))
      setOpenFileIdsByWorkspace(Object.fromEntries(nextWorkspaces.map((workspace) => [workspace.id, initialOpenFileIds(workspace)])))
      setSelectedFileByWorkspace(Object.fromEntries(nextWorkspaces.map((workspace) => [workspace.id, workspace.selectedFileId])))
      setActiveWorkspaceId((current) =>
        nextWorkspaces.find((workspace) => workspace.id === current)?.id ??
        nextWorkspaces.find((workspace) => workspace.id === routeTarget.workspaceId)?.id ??
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
      setChats(nextChats)
      setSchedules(nextSchedules)
      updateProviderData(nextProviders, nextAccounts)
      const routeChatId = workspaceId && routeTarget.workspaceId === workspaceId ? routeTarget.chatId : null
      const nextActiveChatId =
        nextChats.find((chat) => chat.id === activeChatId)?.id ??
        nextChats.find((chat) => chat.id === routeChatId)?.id ??
        nextChats[0]?.id ??
        null
      setActiveChatId(nextActiveChatId)
      if (nextActiveChatId && !options?.silent) {
        void loadMessagesForChat(nextActiveChatId)
      }
      if (workspaceId && routeTarget.workspaceId === workspaceId) {
        setRouteTargetPending(false)
      }
    } catch (error) {
      setChatError(readError(error))
      if (!options?.silent) {
        setChats([])
        setSchedules([])
        setActiveChatId(null)
      }
    } finally {
      if (!options?.silent) {
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

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)")
    const hideFilesPanelOnTablet = (event: MediaQueryListEvent | MediaQueryList) => {
      if (!event.matches) {
        setIsFilesPanelOpen(false)
      }
    }

    hideFilesPanelOnTablet(mediaQuery)
    mediaQuery.addEventListener("change", hideFilesPanelOnTablet)
    return () => mediaQuery.removeEventListener("change", hideFilesPanelOnTablet)
  }, [])

  useEffect(() => {
    void loadSavedWorkspaces()
  }, [])

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
    if (!activeWorkspace) {
      return
    }
    const pendingChatId = routeTargetPending && routeTarget.workspaceId === activeWorkspace.id ? routeTarget.chatId : null
    writeSessionRouteTarget(activeWorkspace.id, activeChatId ?? pendingChatId)
  }, [activeChatId, activeWorkspace?.id, routeTarget.chatId, routeTarget.workspaceId, routeTargetPending])

  useEffect(() => {
    activeChatIdRef.current = activeChatId
  }, [activeChatId])

  useEffect(() => {
    activeScheduleIdRef.current = activeScheduleId
  }, [activeScheduleId])

  useEffect(() => {
    if (!isTerminalPanelOpen || !activeWorkspace) {
      return
    }
    if (terminalHost.terminals.length > 0) {
      terminalAutoCreateWorkspaceRef.current = activeWorkspace.id
      return
    }
    if (terminalAutoCreateWorkspaceRef.current === activeWorkspace.id) {
      return
    }
    terminalAutoCreateWorkspaceRef.current = activeWorkspace.id
    terminalHost.createTerminal()
  }, [activeWorkspace?.id, isTerminalPanelOpen, terminalHost.createTerminal, terminalHost.terminals.length])

  useEffect(() => {
    if (!activeWorkspace) {
      return
    }
    const socket = io({ path: "/socket.io" })
    providerSocketRef.current = socket
    const joinSocketRooms = () => {
      socket.emit("workspace.join", activeWorkspace.path)
      if (activeChatIdRef.current) {
        socket.emit("chat.join", activeChatIdRef.current)
      }
    }
    joinSocketRooms()
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

    socket.on("connect", joinSocketRooms)
    socket.on("provider.event", handleProviderEvent)
    socket.on("message.created", handleMessageCreated)
    socket.on("message.deleted", handleMessageDeleted)
    return () => {
      socket.emit("workspace.leave", activeWorkspace.path)
      socket.off("connect", joinSocketRooms)
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
    if (directory.type !== "directory" || directory.error) {
      return
    }

    const existingWorkspace = workspaces.find((workspace) => samePath(workspace.path, directory.path))
    if (existingWorkspace) {
      setActiveWorkspaceId(existingWorkspace.id)
      await apiClient.workspaces.saveHistory(existingWorkspace.path).catch(() => undefined)
      setRouteTargetPending(false)
      setWorkspaceBrowserOpen(false)
      setMobileDrawer(null)
      return
    }

    const savedWorkspace = await apiClient.workspaces.saveHistory(directory.path).catch((error) => {
      setWorkspaceLoadError(readError(error))
      return null
    })
    const workspace = createWorkspaceFromBrowserEntry(directory, workspaces, savedWorkspace?.id)
    setWorkspaces((current) => [...current, workspace])
    setOpenFileIdsByWorkspace((current) => ({
      ...current,
      [workspace.id]: initialOpenFileIds(workspace),
    }))
    setSelectedFileByWorkspace((current) => ({ ...current, [workspace.id]: workspace.selectedFileId }))
    setExpandedFolderIds((current) => {
      const next = new Set(current)
      for (const id of collectInitialFolderIds(workspace)) {
        next.add(id)
      }
      return next
    })
    setActivePanelTab("files")
    setActiveWorkspaceId(workspace.id)
    setProvidersDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMainMode("chat")
    setMobileDrawer(null)
    setWorkspaceBrowserOpen(false)
    setRouteTargetPending(false)
  }

  const openRecentWorkspace = async (recent: WorkspaceHistoryResponse) => {
    const existingWorkspace = workspaces.find((workspace) => workspace.id === recent.id || samePath(workspace.path, recent.path))
    if (existingWorkspace) {
      setActiveWorkspaceId(existingWorkspace.id)
      await apiClient.workspaces.saveHistory(existingWorkspace.path).catch(() => undefined)
      setWorkspaceBrowserOpen(false)
      setMobileDrawer(null)
      setRouteTargetPending(false)
      return
    }
    setWorkspaceLoadError(null)
    try {
      const workspace = await workspaceFromHistory(recent, workspaces)
      if (!workspace) {
        setWorkspaceLoadError("Unable to open workspace.")
        return
      }
      setWorkspaces((current) => [...current, workspace])
      setOpenFileIdsByWorkspace((current) => ({ ...current, [workspace.id]: initialOpenFileIds(workspace) }))
      setSelectedFileByWorkspace((current) => ({ ...current, [workspace.id]: workspace.selectedFileId }))
      setExpandedFolderIds((current) => {
        const next = new Set(current)
        for (const id of collectInitialFolderIds(workspace)) {
          next.add(id)
        }
        return next
      })
      setActiveWorkspaceId(workspace.id)
      setProvidersDialogOpen(false)
      setMcpServersDialogOpen(false)
      setMainMode("chat")
      setMobileDrawer(null)
      setRouteTargetPending(false)
      const saved = await apiClient.workspaces.saveHistory(workspace.path).catch(() => null)
      if (saved) {
        setRecentWorkspaces((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      }
    } catch (error) {
      setWorkspaceLoadError(readError(error))
    }
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
    void apiClient.workspaces.deleteHistory(closingWorkspace.path).catch(() => undefined)
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

  const setFolderLoading = (folderId: string, loading: boolean) => {
    const next = new Set(loadingFolderIdsRef.current)
    if (loading) {
      next.add(folderId)
    } else {
      next.delete(folderId)
    }
    loadingFolderIdsRef.current = next
    setLoadingFolderIds(next)
  }

  const loadFolderChildren = async (folder: FileNode) => {
    if (!activeWorkspace || folder.type !== "folder" || folder.children || !folder.path || loadingFolderIdsRef.current.has(folder.id)) {
      return
    }

    const folderId = folder.id
    const workspaceId = activeWorkspace.id
    setFolderLoading(folderId, true)
    try {
      const entry = await apiClient.workspaces.readTree(folder.path)
      const children = (entry.children ?? []).map((child, index) =>
        browserEntryToFileNode(child, `${folderId}/${index}-${slugifyWorkspaceId(child.name)}`),
      )
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, fileTree: updateFileNodeChildren(workspace.fileTree, folderId, children) }
            : workspace,
        ),
      )
    } catch {
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, fileTree: updateFileNodeChildren(workspace.fileTree, folderId, []) }
            : workspace,
        ),
      )
    } finally {
      setFolderLoading(folderId, false)
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
    const file = findFileByWorkspacePath(activeWorkspace.fileTree, target.path)
    if (!file) {
      return false
    }
    selectFile(file.id, { lineNumber: target.lineNumber, column: target.column })
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
      setExpandedFolderIds((current) => {
        const next = new Set(current)
        for (const id of loaded.expandedFolderIds) {
          next.add(id)
        }
        return next
      })
    }

    void loadFileContent(target)
    setOpenFileIdsByWorkspace((current) => {
      const openIds = current[activeWorkspace.id] ?? []
      return openIds.includes(target.id) ? current : { ...current, [activeWorkspace.id]: [...openIds, target.id] }
    })
    setSelectedFileByWorkspace((current) => ({ ...current, [activeWorkspace.id]: target.id }))
    setMainMode("editor")
    setEditorRevealTarget({ column, fileId: target.id, lineNumber, nonce: Date.now() })
    return true
  }

  const toggleFolder = (id: string) => {
    const folder = activeWorkspace ? findNode(activeWorkspace.fileTree, id) : null
    if (folder?.type === "folder" && !folder.children) {
      void loadFolderChildren(folder)
    }
    setExpandedFolderIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
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

  const sendChatMessage = async (input: ChatComposerSubmit) => {
    const message = input.content.trim()
    if (!message || !activeWorkspace) {
      return
    }
    setChatError(null)
    let optimisticChatId: string | null = null
    try {
      const targetAccount = selectChatAccount(activeChat, chatAccounts, preferredAccountId)
      if (!targetAccount) {
        setChatError("Connect a provider account before sending a message.")
        setProvidersDialogOpen(true)
        return
      }
      const chat = activeChat ?? await apiClient.chats.create({
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
    }
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

  const archiveChat = async (chatId: string) => {
    setChatError(null)
    try {
      await apiClient.chats.delete(chatId)
      setChats((current) => {
        const next = current.filter((chat) => chat.id !== chatId)
        if (activeChatId === chatId) {
          setActiveChatId(next[0]?.id ?? null)
        }
        return next
      })
      setMessagesByChatId((current) => omitRecordKey(current, chatId))
    } catch (error) {
      setChatError(readError(error))
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
      setSidebarTab("scheduler")
      setMainMode("schedule")
      setMobileDrawer(null)
      void loadScheduleRuns(schedule.id)
      void loadChatsForWorkspace(activeWorkspace.path, activeWorkspace.id, { silent: true })
    } catch (error) {
      setScheduleError(readError(error))
    }
  }

  const selectSchedule = (scheduleId: string) => {
    setActiveScheduleId(scheduleId)
    setSidebarTab("scheduler")
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
    const chatId = run.chatId ?? activeSchedule?.chatId
    if (!chatId) {
      setScheduleError("This schedule run is not linked to a chat yet.")
      return
    }
    setActiveChatId(chatId)
    await loadMessagesForChat(chatId)
    switchToChat()
  }

  const switchToChat = () => {
    setProvidersDialogOpen(false)
    setInstructionsDialogOpen(false)
    setMcpServersDialogOpen(false)
    setMainMode("chat")
    setMobileDrawer(null)
  }

  const switchToEditor = () => {
    writeDetachedEditorPreference(false)
    setMainMode("editor")
    setMobileDrawer(null)
  }

  const selectManagementView = (view: ManagementView) => {
    setProvidersDialogOpen(view === "providers")
    setInstructionsDialogOpen(view === "instructions")
    setMcpServersDialogOpen(view === "mcpServers")
    setPluginsDialogOpen(view === "plugins")
    setMobileDrawer(null)
  }


  return {
    activeChat,
    activeChatId,
    activeMessages,
    activeMessagesLoaded,
    activePanelTab,
    activeSchedule,
    activeScheduleId,
    activeScheduleRuns: activeScheduleId ? scheduleRunsByScheduleId[activeScheduleId] ?? [] : [],
    activeTerminalId: terminalHost.activeTerminalId,
    activeWorkspace,
    accountSwitchPhase: activeChatId ? accountSwitchByChatId[activeChatId] ?? null : null,
    archiveChat,
    chatAccounts,
    chatError,
    chats,
    compactChat,
    closeTerminal: terminalHost.closeTerminal,
    closeFile,
    closeWorkspace,
    createSchedule,
    createTerminal: terminalHost.createTerminal,
    deleteSchedule,
    deleteQueuedMessage,
    desktopGridColumns,
    editQueuedMessage,
    editorRevealTarget,
    expandedFolderIds,
    filesWidth,
    forkChat,
    instructionsDialogOpen,
    isChatsLoading,
    isFilesPanelOpen,
    isSchedulesLoading,
    isSwitchingAccount,
    isTerminalPanelOpen,
    isWorkspaceHistoryLoading,
    loadingFolderIds,
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
    pluginsDialogOpen,
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
    selectedFile,
    selectedFileContent,
    selectedFileId,
    sendChatMessage,
    setActiveChatId,
    setActivePanelTab,
    setActiveScheduleId,
    setActiveTerminalId: terminalHost.setActiveTerminalId,
    setActiveWorkspaceId,
    setFilesWidth,
    setInstructionsDialogOpen,
    setIsFilesPanelOpen,
    setIsTerminalPanelOpen,
    setMainMode,
    setMcpServersDialogOpen,
    setPluginsDialogOpen,
    setMobileDrawer,
    setProvidersDialogOpen,
    setSidebarWidth,
    setSidebarTab,
    setTerminalHeight,
    setWorkspaceBrowserOpen,
    sidebarWidth,
    sidebarTab,
    startNewChat,
    steerQueuedMessage,
    stopActiveChat,
    switchChatAccount,
    switchToChat,
    switchToEditor,
    openScheduleRunChat,
    scheduleError,
    schedules,
    terminalConnectionState: terminalHost.connectionState,
    terminalError: terminalHost.error,
    terminalHeight,
    terminalOutputByTerminalId: terminalHost.outputByTerminalId,
    terminals: terminalHost.terminals,
    toggleFolder,
    updateChatPermissionMode,
    updateChatRuntimeSettings,
    updateSchedule,
    updateProviderData,
    updateFileContent,
    resizeTerminal: terminalHost.resizeTerminal,
    writeTerminalInput: terminalHost.writeTerminalInput,
    workspaceBrowserOpen,
    workspaceLoadError,
    workspaces,
  }
}

function SessionShellView() {
  const shell = useSessionShellState()

  return (
    <div className="app-safe-viewport overflow-hidden bg-background text-foreground">
      <main className="grid h-full overflow-hidden bg-background" style={{ gridTemplateRows: "40px minmax(0, 1fr)" }}>
        <TopBar
          activeWorkspaceId={shell.activeWorkspace?.id ?? null}
          isFilesPanelOpen={shell.isFilesPanelOpen}
          isTerminalPanelOpen={shell.isTerminalPanelOpen}
          workspaces={shell.workspaces}
          onAddWorkspace={() => shell.setWorkspaceBrowserOpen(true)}
          onCloseWorkspace={shell.closeWorkspace}
          onOpenFilesDrawer={() => shell.setMobileDrawer("files")}
          onOpenSessionsDrawer={() => shell.setMobileDrawer("sessions")}
          onSelectWorkspace={shell.setActiveWorkspaceId}
          onToggleFilesPanel={() => shell.setIsFilesPanelOpen((current) => !current)}
          onToggleTerminalPanel={() => shell.setIsTerminalPanelOpen((current) => !current)}
        />
        <SessionWorkspaceContent />
      </main>
      <SessionMobileDrawers />
      <SessionDialogHost />
    </div>
  )
}

function SessionWorkspaceContent() {
  const shell = useSessionShellState()

  if (!shell.activeWorkspace) {
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
    <>
      <SessionDesktopWorkspace />
      <SessionMobileMain />
    </>
  )
}

function SessionDesktopWorkspace() {
  const shell = useSessionShellState()
  const terminalColumnEnd = shell.isFilesPanelOpen ? 4 : 3

  return (
    <div
      className="hidden min-h-0 gap-2 overflow-hidden bg-background p-2 pt-0 md:grid"
      style={{
        gridTemplateColumns: shell.desktopGridColumns,
        gridTemplateRows: shell.isTerminalPanelOpen
          ? `minmax(0, 1fr) ${shell.terminalHeight}px`
          : "minmax(0, 1fr)",
      }}
    >
      <div className="relative min-h-0 overflow-hidden" style={{ gridColumn: "1", gridRow: "1 / -1" }}>
        <SessionSidebarPanel />
        <ResizeHandle
          edge="right"
          label="chats panel"
          onPointerDown={(event) =>
            startColumnResize(event, {
              max: 440,
              min: 220,
              side: "left",
              startWidth: shell.sidebarWidth,
              onResize: shell.setSidebarWidth,
            })
          }
        />
      </div>
      <div className="relative min-h-0 overflow-hidden rounded-xl" style={{ gridColumn: "2", gridRow: "1" }}>
        <SessionMainContent onBackToChat={() => shell.setMainMode("chat")} />
        {shell.isFilesPanelOpen ? (
          <ResizeHandle
            edge="right"
            label="files panel"
            onPointerDown={(event) =>
              startColumnResize(event, {
                max: 560,
                min: 300,
                side: "right",
                startWidth: shell.filesWidth,
                onResize: shell.setFilesWidth,
              })
            }
          />
        ) : null}
      </div>
      {shell.isFilesPanelOpen ? (
        <div className="min-h-0 overflow-hidden" style={{ gridColumn: "3", gridRow: "1" }}>
          <SessionRightPanel treeId="desktop-files" />
        </div>
      ) : null}
      {shell.isTerminalPanelOpen ? (
        <div className="min-h-0 overflow-hidden" style={{ gridColumn: `2 / ${terminalColumnEnd}`, gridRow: "2" }}>
          <SessionTerminalPanelHost
            onResizeStart={(event) =>
              startTerminalResize(event, {
                startHeight: shell.terminalHeight,
                onResize: shell.setTerminalHeight,
              })
            }
          />
        </div>
      ) : null}
    </div>
  )
}

function SessionMobileMain() {
  const shell = useSessionShellState()

  return (
    <div
      className={cn(
        "grid h-full min-h-0 overflow-hidden bg-background md:hidden",
        shell.isTerminalPanelOpen && "gap-2 p-2 pt-0",
      )}
      style={{
        gridTemplateRows: shell.isTerminalPanelOpen
          ? `minmax(0, 1fr) clamp(${MIN_TERMINAL_HEIGHT}px, ${shell.terminalHeight}px, 46dvh)`
          : "minmax(0, 1fr)",
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <SessionMainContent onBackToChat={shell.switchToChat} />
      </div>
      {shell.isTerminalPanelOpen ? (
        <div className="min-h-0 overflow-hidden">
          <SessionTerminalPanelHost
            onResizeStart={(event) =>
              startTerminalResize(event, {
                startHeight: shell.terminalHeight,
                onResize: shell.setTerminalHeight,
              })
            }
          />
        </div>
      ) : null}
    </div>
  )
}

function SessionSidebarPanel() {
  const shell = useSessionShellState()

  if (!shell.activeWorkspace) {
    return null
  }

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

function SessionRightPanel({ treeId }: { treeId: string }) {
  const shell = useSessionShellState()

  if (!shell.activeWorkspace) {
    return null
  }

  return (
    <RightPanel
      activeTab={shell.activePanelTab}
      expandedFolderIds={shell.expandedFolderIds}
      loadingFolderIds={shell.loadingFolderIds}
      selectedFileId={shell.selectedFileId}
      treeId={treeId}
      workspace={shell.activeWorkspace}
      onFileSelect={shell.selectFile}
      onFolderToggle={shell.toggleFolder}
      onTabChange={shell.setActivePanelTab}
    />
  )
}

function SessionTerminalPanelHost({
  onResizeStart,
}: {
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  const shell = useSessionShellState()

  if (!shell.activeWorkspace) {
    return null
  }

  return (
    <SessionTerminalPanel
      activeTerminalId={shell.activeTerminalId}
      connectionState={shell.terminalConnectionState}
      error={shell.terminalError}
      outputByTerminalId={shell.terminalOutputByTerminalId}
      terminals={shell.terminals}
      workspaceName={shell.activeWorkspace.name}
      workspacePath={shell.activeWorkspace.path}
      onActivateTerminal={shell.setActiveTerminalId}
      onCloseTerminal={shell.closeTerminal}
      onCreateTerminal={shell.createTerminal}
      onHide={() => shell.setIsTerminalPanelOpen(false)}
      onInput={shell.writeTerminalInput}
      onResize={shell.resizeTerminal}
      onResizeStart={onResizeStart}
    />
  )
}

function SessionMobileDrawers() {
  const shell = useSessionShellState()

  if (!shell.activeWorkspace) {
    return null
  }

  return (
    <>
      <MobilePanelDrawer side="left" title="Chats" open={shell.mobileDrawer === "sessions"} onClose={() => shell.setMobileDrawer(null)}>
        <SessionSidebarPanel />
      </MobilePanelDrawer>
      <MobilePanelDrawer side="right" title="Files" open={shell.mobileDrawer === "files"} onClose={() => shell.setMobileDrawer(null)}>
        <SessionRightPanel treeId="mobile-files" />
      </MobilePanelDrawer>
    </>
  )
}

function SessionDialogHost() {
  const shell = useSessionShellState()
  const revealTarget = shell.selectedFile && shell.editorRevealTarget?.fileId === shell.selectedFile.id
    ? shell.editorRevealTarget
    : null

  return (
    <>
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
      <WorkspaceFolderBrowserDialog
        open={shell.workspaceBrowserOpen}
        openWorkspacePaths={shell.workspaces.map((workspace) => workspace.path)}
        onClose={() => shell.setWorkspaceBrowserOpen(false)}
        onSelect={shell.openWorkspaceFromFolder}
      />
      <CodexInstructionsDialog open={shell.instructionsDialogOpen} onClose={() => shell.setInstructionsDialogOpen(false)} />
      <ProvidersManagementDialog
        open={shell.providersDialogOpen}
        onClose={() => shell.setProvidersDialogOpen(false)}
        onProviderDataChange={shell.updateProviderData}
      />
      <McpServersManagementDialog
        open={shell.mcpServersDialogOpen}
        onClose={() => shell.setMcpServersDialogOpen(false)}
      />
      <PluginsManagementDialog
        open={shell.pluginsDialogOpen}
        onClose={() => shell.setPluginsDialogOpen(false)}
      />
    </>
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


function ResizeHandle({
  edge,
  label,
  onPointerDown,
}: {
  edge: "right"
  label: string
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      aria-label={`Resize ${label}`}
      className={cn(
        "absolute top-0 z-20 h-full w-2 cursor-col-resize bg-transparent outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-accent focus-visible:after:bg-primary",
        edge === "right" && "right-[-4px]",
      )}
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
    return <ScheduleDetailPane shell={shell} />
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
      onOpenPlugins={() => shell.setPluginsDialogOpen(true)}
      onRefreshChat={shell.refreshChat}
      onRenameChat={shell.renameChat}
      onReviewChat={shell.reviewChat}
      onToggleMode={shell.switchToEditor}
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
): Promise<{ expandedFolderIds: string[]; file: FileNode; fileTree: FileNode[] } | null> {
  const segments = relativePathSegments(workspace.path, targetPath)
  if (!segments?.length) {
    return null
  }

  const fileTree = cloneFileTree(workspace.fileTree)
  let current = fileTree[0]
  const expandedFolderIds: string[] = []

  for (const segment of segments.slice(0, -1)) {
    if (!current || current.type !== "folder" || !current.path) {
      return null
    }
    expandedFolderIds.push(current.id)
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
  expandedFolderIds.push(current.id)
  if (!current.children) {
    current.children = await readFileTreeChildren(current)
  }

  const fileName = segments.at(-1)
  const file = current.children.find((child) => child.type === "file" && child.name === fileName)
  return file ? { expandedFolderIds, file, fileTree } : null
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

function startTerminalResize(
  event: ReactPointerEvent<HTMLButtonElement>,
  options: {
    onResize: (height: number) => void
    startHeight: number
  },
) {
  startVerticalResize(event, {
    initialHeight: options.startHeight,
    max: typeof window === "undefined"
      ? MAX_TERMINAL_HEIGHT
      : Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight - 180)),
    min: MIN_TERMINAL_HEIGHT,
    onResize: options.onResize,
    origin: "top",
  })
}
