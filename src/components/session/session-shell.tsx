import {
  Plus,
  X,
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Check,
  Dock,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  HardDrive,
  ListFilter,
  LoaderCircle,
  Minus,
  PictureInPicture2,
  Plug,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { io } from "socket.io-client"
import { ChatPane } from "@/components/session/chat-pane"
import { MobilePanelDrawer, TopBar } from "@/components/session/session-chrome"
import { ModeToggleButton } from "@/components/session/mode-toggle-button"
import { ProviderGlyph, ProviderMark, ProviderStatusBadge } from "@/components/session/provider-icons"
import { ProviderQuotaProvider, useProviderQuotas } from "@/components/session/provider-quota-context"
import { useTheme } from "@/components/theme-provider"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  SessionTerminalPanel,
  type HostedTerminalSession,
  type TerminalConnectionState,
} from "@/components/session/terminal-panel"
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import {
  apiClient,
  type AccountAuthMode,
  type BrowserEntry,
  type ChatMessageResponse,
  type ChatResponse,
  type GitFileChange,
  type GitStatusResponse,
  type LanguageServerInfo,
  type MessageScheduleRecurrence,
  type MessageScheduleResponse,
  type MessageScheduleRunResponse,
  type MessageScheduleRunStatus,
  type MessageScheduleStatus,
  type McpServerResponse,
  type McpServerStatusItem,
  type McpServerTransportConfig,
  type McpToolApprovalMode,
  type ProviderAccountResponse,
  type ProviderDefinitionResponse,
  type ProviderModelListResponse,
  type WorkspaceHistoryResponse,
} from "@/lib/api-client"
import {
  attachMonacoLsp,
  fileUriFromPath,
  lspLanguageIdForPath,
  selectLanguageServer,
  type LspStatus,
  type MonacoApi,
} from "@/lib/lsp-client"
import { definePockcodeMonacoTheme, pockcodeMonacoThemeName } from "@/lib/theme-colors"
import { cn } from "@/lib/utils"
import type {
  ChatComposerAccessMode,
  ChatComposerReasoningEffort,
  ChatComposerServiceTier,
  ChatComposerSubmit,
  FileNode,
  FileRevealTarget,
  FileSelectOptions,
  MainMode,
  ManagementView,
  MobileDrawer,
  PanelTab,
  SidebarTab,
  VisibleTreeItem,
  Workspace,
} from "@/types/session"
import {
  browserEntryToFileNode,
  clearSessionRouteTarget,
  collectInitialFolderIds,
  compareChatsByUpdatedTime,
  composerReasoningEffortLabel,
  composerReasoningEffortOptions,
  composerReasoningEffortValue,
  composerServiceTierLabel,
  composerServiceTierOptions,
  composerServiceTierValue,
  createOptimisticChatMessage,
  createWorkspaceFromBrowserEntry,
  delay,
  defaultModelOptionsForProvider,
  defaultRuntimeDefaultValue,
  directoryResponseToBrowserEntry,
  fileContentFor,
  fileLanguage,
  filterBrowserEntries,
  findFile,
  findFileByWorkspacePath,
  findFilePath,
  findNode,
  flattenVisibleTree,
  formatJson,
  formatProviderQuota,
  hasChatStats,
  initialOpenFileIds,
  monacoLanguageFor,
  omitRecordKey,
  parentBrowserPath,
  parseChatFileLink,
  parseJsonRecord,
  pathInputFilter,
  mergeProviderModelOptions,
  readComposerReasoningEffort,
  readComposerServiceTier,
  readChatMessageResponse,
  readChatResponse,
  readCodexHomeValue,
  readCodexPersonalityValue,
  readComposerAccessMode,
  readDefaultCodexHomeValue,
  readDetachedEditorPreference,
  readError,
  readProviderSocketEvent,
  readRecord,
  readRecordString,
  readRunStatus,
  readSessionRouteTarget,
  readSharedCodexHomeValue,
  relativeTimeLabel,
  samePath,
  selectChatAccount,
  shouldShowFilesPanelByDefault,
  slugifyWorkspaceId,
  titleFromPrompt,
  treeItemElementId,
  updateBrowserEntryChildren,
  updateFileNodeChildren,
  upsertChat,
  upsertMessage,
  removeOptimisticMessages,
  withoutRecordKeys,
  workspaceFromHistory,
  writeDetachedEditorPreference,
  writeSessionRouteTarget,
} from "@/lib/session"
import { startHorizontalResize, startVerticalResize } from "@/lib/resize"

type ChatListContextValue = {
  chatStatusById: Record<string, ChatResponse["status"]>
  chats: ChatResponse[]
  isChatRunning: (chatId: string) => boolean
  isLoading: boolean
}

const ChatListContext = createContext<ChatListContextValue | null>(null)

function ChatListProvider({
  children,
  chats,
  isLoading,
  messagesByChatId,
}: {
  children: ReactNode
  chats: ChatResponse[]
  isLoading: boolean
  messagesByChatId: Record<string, ChatMessageResponse[]>
}) {
  const chatStatusById = useMemo<Record<string, ChatResponse["status"]>>(
    () => Object.fromEntries(chats.map((chat): [string, ChatResponse["status"]] => [
      chat.id,
      chat.status === "RUNNING" || hasStreamingMessages(messagesByChatId[chat.id] ?? []) ? "RUNNING" : chat.status,
    ])),
    [chats, messagesByChatId],
  )
  const value = useMemo<ChatListContextValue>(
    () => ({
      chatStatusById,
      chats,
      isChatRunning: (chatId) => chatStatusById[chatId] === "RUNNING",
      isLoading,
    }),
    [chatStatusById, chats, isLoading],
  )
  return <ChatListContext.Provider value={value}>{children}</ChatListContext.Provider>
}

export function useChatList(): ChatListContextValue {
  const value = useContext(ChatListContext)
  if (!value) {
    throw new Error("useChatList must be used within ChatListProvider.")
  }
  return value
}

function hasStreamingMessages(messages: ChatMessageResponse[]): boolean {
  return messages.some((message) => message.status === "STREAMING")
}

function useWorkspaceTerminals(activeWorkspace: Workspace | null) {
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("offline")
  const [error, setError] = useState<string | null>(null)
  const [outputByTerminalId, setOutputByTerminalId] = useState<Record<string, string>>({})
  const [terminals, setTerminals] = useState<HostedTerminalSession[]>([])
  const lastSizeRef = useRef({ cols: 80, rows: 24 })
  const pendingCreateRef = useRef(false)
  const socketRef = useRef<ReturnType<typeof io> | null>(null)

  const removeTerminal = useCallback((terminalId: string) => {
    setTerminals((current) => {
      const closedIndex = current.findIndex((terminal) => terminal.id === terminalId)
      const next = current.filter((terminal) => terminal.id !== terminalId)
      setActiveTerminalId((activeId) => {
        if (activeId !== terminalId) {
          return activeId
        }
        return next[Math.max(0, closedIndex - 1)]?.id ?? next[0]?.id ?? null
      })
      return next
    })
    setOutputByTerminalId((current) => omitRecordKey(current, terminalId))
  }, [])

  useEffect(() => {
    pendingCreateRef.current = false
    setActiveTerminalId(null)
    setError(null)
    setOutputByTerminalId({})
    setTerminals([])

    if (!activeWorkspace) {
      setConnectionState("offline")
      socketRef.current = null
      return
    }

    setConnectionState("connecting")
    const socket = io({ path: "/socket.io" })
    socketRef.current = socket

    const handleConnect = () => setConnectionState("connected")
    const handleDisconnect = () => {
      setConnectionState("offline")
      setTerminals((current) =>
        current.map((terminal) =>
          terminal.status === "running" ? { ...terminal, status: "exited" } : terminal,
        ),
      )
    }
    const handleOutput = (value: unknown) => {
      const record = readRecord(value)
      const terminalId = readRecordString(record, "id")
      const data = readRecordString(record, "data")
      if (!terminalId || !data) {
        return
      }
      setOutputByTerminalId((current) => appendTerminalOutput(current, terminalId, data))
    }
    const handleExit = (value: unknown) => {
      const record = readRecord(value)
      const terminalId = readRecordString(record, "id")
      if (!terminalId) {
        return
      }
      const exitCode = readRecordNumber(record, "exitCode")
      setTerminals((current) =>
        current.map((terminal) =>
          terminal.id === terminalId
            ? { ...terminal, exitCode, status: "exited" }
            : terminal,
        ),
      )
      setOutputByTerminalId((current) =>
        appendTerminalOutput(current, terminalId, `\r\n[process exited${exitCode === null ? "" : ` with code ${exitCode}`}]\r\n`),
      )
    }
    const handleClosed = (value: unknown) => {
      const terminalId = readRecordString(readRecord(value), "id")
      if (terminalId) {
        removeTerminal(terminalId)
      }
    }
    const handleError = (value: unknown) => {
      setError(readRecordString(readRecord(value), "error") || "Terminal host error.")
    }

    socket.on("connect", handleConnect)
    socket.on("disconnect", handleDisconnect)
    socket.on("terminal.output", handleOutput)
    socket.on("terminal.exit", handleExit)
    socket.on("terminal.closed", handleClosed)
    socket.on("terminal.error", handleError)

    return () => {
      socket.off("connect", handleConnect)
      socket.off("disconnect", handleDisconnect)
      socket.off("terminal.output", handleOutput)
      socket.off("terminal.exit", handleExit)
      socket.off("terminal.closed", handleClosed)
      socket.off("terminal.error", handleError)
      socket.disconnect()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [activeWorkspace?.path, removeTerminal])

  const createTerminal = useCallback(() => {
    const socket = socketRef.current
    if (!activeWorkspace || !socket || pendingCreateRef.current) {
      return
    }

    pendingCreateRef.current = true
    setError(null)
    const optimisticId = "pending-terminal-" + Date.now()
    const optimisticTerminal: HostedTerminalSession = {
      cwd: activeWorkspace.path,
      id: optimisticId,
      name: "starting",
      shell: "",
      status: "connecting",
    }
    setTerminals((current) => [...current, optimisticTerminal])
    setActiveTerminalId(optimisticId)
    socket.emit(
      "terminal.create",
      {
        cols: lastSizeRef.current.cols,
        rows: lastSizeRef.current.rows,
        workspacePath: activeWorkspace.path,
      },
      (value: unknown) => {
        pendingCreateRef.current = false
        const response = readTerminalCreateResponse(value)
        if (!response.ok) {
          setError(response.error)
          removeTerminal(optimisticId)
          return
        }
        const terminal: HostedTerminalSession = {
          ...response.terminal,
          status: "running",
        }
        setTerminals((current) => {
          const withoutOptimistic = current.filter((entry) => entry.id !== optimisticId)
          return withoutOptimistic.some((entry) => entry.id === terminal.id)
            ? withoutOptimistic.map((entry) => entry.id === terminal.id ? terminal : entry)
            : [...withoutOptimistic, terminal]
        })
        setActiveTerminalId(terminal.id)
      },
    )
  }, [activeWorkspace?.path, removeTerminal])

  const closeTerminal = useCallback((terminalId: string) => {
    socketRef.current?.emit("terminal.close", { id: terminalId })
    removeTerminal(terminalId)
  }, [removeTerminal])

  const resizeTerminal = useCallback((terminalId: string, cols: number, rows: number) => {
    lastSizeRef.current = { cols, rows }
    socketRef.current?.emit("terminal.resize", { cols, id: terminalId, rows })
  }, [])

  const writeTerminalInput = useCallback((terminalId: string, data: string) => {
    socketRef.current?.emit("terminal.input", { data, id: terminalId })
  }, [])

  return {
    activeTerminalId,
    closeTerminal,
    connectionState,
    createTerminal,
    error,
    outputByTerminalId,
    resizeTerminal,
    setActiveTerminalId,
    terminals,
    writeTerminalInput,
  }
}

type ManagementItem = {
  count?: number | string
  icon?: LucideIcon
  id?: ManagementView
  label: string
  providerIcon?: string
}

const customizations: ManagementItem[] = [
  { id: "providers", label: "Providers", providerIcon: "codex" },
  { icon: FileText, id: "instructions", label: "Instructions" },
  { icon: Wrench, label: "Hooks" },
  { icon: Server, id: "mcpServers", label: "MCP Servers" },
  { icon: Plug, label: "Plugins" },
]

type SessionShellState = ReturnType<typeof useSessionShellController>

type TerminalCreateResponse =
  | { ok: true; terminal: TerminalSocketMetadata }
  | { error: string; ok: false }

type TerminalSocketMetadata = {
  cwd: string
  id: string
  name: string
  shell: string
}

const DEFAULT_TERMINAL_HEIGHT = 290
const MIN_TERMINAL_HEIGHT = 160
const MAX_TERMINAL_HEIGHT = 560
const TERMINAL_OUTPUT_LIMIT = 260_000

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
  const [lspServersByWorkspace, setLspServersByWorkspace] = useState<Record<string, LanguageServerInfo[]>>({})
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
  const selectedFileContentLoaded = selectedFile
    ? !selectedFile.path || selectedFile.content !== undefined || fileContentById[selectedFile.id] !== undefined
    : false
  const activeLanguageServers = activeWorkspace ? lspServersByWorkspace[activeWorkspace.id] ?? [] : []
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
    if (!activeWorkspace) {
      return
    }
    let cancelled = false
    void apiClient.lsp.listServers(activeWorkspace.path)
      .then((servers) => {
        if (!cancelled) {
          setLspServersByWorkspace((current) => ({ ...current, [activeWorkspace.id]: servers }))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLspServersByWorkspace((current) => ({ ...current, [activeWorkspace.id]: [] }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspace?.id, activeWorkspace?.path])

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
    setLspServersByWorkspace((current) => omitRecordKey(current, workspaceId))
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
      const optimisticMessage = createOptimisticChatMessage(chat.id, message, messagesByChatId[chat.id] ?? [])
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
    setChatError(null)
    try {
      await apiClient.chats.interrupt(activeChat.id)
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
    setPreferredAccountId(accountId)
    if (!activeChat || activeChat.accountId === accountId) {
      return
    }
    setIsSwitchingAccount(true)
    setChatError(null)
    try {
      const updated = await apiClient.chats.update(activeChat.id, { accountId })
      setChats((current) => upsertChat(current, updated))
    } catch (error) {
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
    setMobileDrawer(null)
  }


  return {
    activeChat,
    activeChatId,
    activeLanguageServers,
    activeMessages,
    activeMessagesLoaded,
    activePanelTab,
    activeSchedule,
    activeScheduleId,
    activeScheduleRuns: activeScheduleId ? scheduleRunsByScheduleId[activeScheduleId] ?? [] : [],
    activeTerminalId: terminalHost.activeTerminalId,
    activeWorkspace,
    chatAccounts,
    chatError,
    chats,
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
    preferredAccountId,
    providerDefinitions,
    providersDialogOpen,
    recentWorkspaces,
    reorderQueuedMessages,
    selectFile,
    selectManagementView,
    selectSchedule,
    selectedFile,
    selectedFileContent,
    selectedFileContentLoaded,
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
    setMobileDrawer,
    setProvidersDialogOpen,
    setSidebarWidth,
    setSidebarTab,
    setTerminalHeight,
    setWorkspaceBrowserOpen,
    sidebarWidth,
    sidebarTab,
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
    <div className="h-svh overflow-hidden bg-background text-foreground">
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
      className="hidden min-h-0 gap-2 overflow-hidden bg-background p-2 md:grid"
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
          <SessionTerminalPanel
            activeTerminalId={shell.activeTerminalId}
            connectionState={shell.terminalConnectionState}
            error={shell.terminalError}
            outputByTerminalId={shell.terminalOutputByTerminalId}
            terminals={shell.terminals}
            workspaceName={shell.activeWorkspace?.name ?? "workspace"}
            workspacePath={shell.activeWorkspace?.path ?? ""}
            onActivateTerminal={shell.setActiveTerminalId}
            onCloseTerminal={shell.closeTerminal}
            onCreateTerminal={shell.createTerminal}
            onHide={() => shell.setIsTerminalPanelOpen(false)}
            onInput={shell.writeTerminalInput}
            onResize={shell.resizeTerminal}
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
    <div className="h-full min-h-0 overflow-hidden md:hidden">
      <SessionMainContent onBackToChat={shell.switchToChat} />
    </div>
  )
}

function SessionSidebarPanel() {
  const shell = useSessionShellState()

  if (!shell.activeWorkspace) {
    return null
  }

  return <SessionSidebar />
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
          contentLoaded={shell.selectedFileContentLoaded}
          file={shell.selectedFile}
          languageServers={shell.activeLanguageServers}
          revealTarget={revealTarget}
          workspace={shell.activeWorkspace}
          onClose={() => shell.setMainMode("chat")}
          onContentChange={shell.updateFileContent}
          onOpenLocation={shell.openWorkspaceFilePath}
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

function WorkspaceFolderBrowserDialog({
  open,
  openWorkspacePaths,
  onClose,
  onSelect,
}: {
  open: boolean
  openWorkspacePaths: string[]
  onClose: () => void
  onSelect: (entry: BrowserEntry) => void
}) {
  const browser = useWorkspaceFolderBrowserDialog(open, openWorkspacePaths, onSelect)

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, open])

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button
        aria-label="Close folder browser"
        className="absolute inset-0 cursor-default"
        type="button"
        onClick={onClose}
      />
      <section className="relative grid h-[80vh] min-h-[560px] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <WorkspaceFolderBrowserHeader onClose={onClose} />
        <WorkspaceFolderBrowserBody browser={browser} />
        <WorkspaceFolderBrowserFooter browser={browser} onClose={onClose} />
      </section>
    </div>
  )
}

function useWorkspaceFolderBrowserDialog(
  open: boolean,
  openWorkspacePaths: string[],
  onSelect: (entry: BrowserEntry) => void,
) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [pathInput, setPathInput] = useState("")
  const [rootEntry, setRootEntry] = useState<BrowserEntry | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<BrowserEntry | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const loadingDirectoryPathsRef = useRef<Set<string>>(new Set())

  const selectedAlreadyOpen = Boolean(
    selectedEntry && openWorkspacePaths.some((path) => samePath(path, selectedEntry.path)),
  )
  const canOpen = Boolean(selectedEntry && selectedEntry.type === "directory" && !selectedEntry.error && !isLoading)
  const pathFilter = rootEntry ? pathInputFilter(pathInput, rootEntry.path) : ""

  const setDirectoryLoading = (path: string, loading: boolean) => {
    const next = new Set(loadingDirectoryPathsRef.current)
    if (loading) {
      next.add(path)
    } else {
      next.delete(path)
    }
    loadingDirectoryPathsRef.current = next
    setLoadingDirectoryPaths(next)
  }

  const loadBrowserRoot = useCallback(async (path?: string, includeHidden = showHidden) => {
    const nextLoadingDirectoryPaths = new Set<string>()
    loadingDirectoryPathsRef.current = nextLoadingDirectoryPaths
    setLoadingDirectoryPaths(nextLoadingDirectoryPaths)
    setIsLoading(true)
    setNotice(null)
    try {
      const directory = await apiClient.workspaces.listDirectory(path, includeHidden)
      const entry = directoryResponseToBrowserEntry(directory)
      setRootEntry(entry)
      setSelectedEntry(entry)
      setPathInput(entry.path)
      setExpandedPaths(new Set([entry.path]))
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setIsLoading(false)
    }
  }, [showHidden])

  useEffect(() => {
    if (!open) {
      return
    }
    setExpandedPaths(new Set())
    setNotice(null)
    setPathInput("")
    setRootEntry(null)
    setSelectedEntry(null)
    setShowHidden(false)
    void loadBrowserRoot(undefined, false)
  }, [loadBrowserRoot, open])

  const selectEntry = (entry: BrowserEntry) => {
    if (entry.type !== "directory") {
      return
    }
    setSelectedEntry(entry)
    setNotice(entry.error ? { kind: "error", text: entry.error } : null)
  }

  const toggleDirectory = async (entry: BrowserEntry) => {
    selectEntry(entry)
    if (entry.type !== "directory" || entry.error || loadingDirectoryPathsRef.current.has(entry.path)) {
      return
    }

    if (expandedPaths.has(entry.path)) {
      setExpandedPaths((current) => {
        const next = new Set(current)
        next.delete(entry.path)
        return next
      })
      return
    }

    if (!entry.children) {
      setNotice(null)
      setDirectoryLoading(entry.path, true)
      try {
        const directory = await apiClient.workspaces.listDirectory(entry.path, showHidden)
        setRootEntry((current) => current ? updateBrowserEntryChildren(current, entry.path, directory.entries) : current)
      } catch (error) {
        setNotice({ kind: "error", text: readError(error) })
        return
      } finally {
        setDirectoryLoading(entry.path, false)
      }
    }

    setExpandedPaths((current) => new Set(current).add(entry.path))
  }

  const moveParent = () => {
    if (!rootEntry) {
      return
    }
    const parentPath = parentBrowserPath(rootEntry.path)
    if (parentPath) {
      void loadBrowserRoot(parentPath)
    }
  }

  const refreshBrowser = () => {
    void loadBrowserRoot(rootEntry?.path)
  }

  const openPathInput = () => {
    void loadBrowserRoot(pathInput.trim() || undefined)
  }

  const toggleHidden = (checked: boolean) => {
    setShowHidden(checked)
    void loadBrowserRoot(rootEntry?.path, checked)
  }

  const chooseSelectedFolder = async () => {
    if (!selectedEntry || selectedEntry.type !== "directory" || selectedEntry.error) {
      return
    }

    if (selectedAlreadyOpen) {
      onSelect(selectedEntry)
      return
    }

    setIsLoading(true)
    setNotice(null)
    try {
      onSelect(await apiClient.workspaces.readTree(selectedEntry.path, showHidden))
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setIsLoading(false)
    }
  }

  return {
    canOpen,
    chooseSelectedFolder,
    expandedPaths,
    isLoading,
    loadingDirectoryPaths,
    loadBrowserRoot,
    moveParent,
    notice,
    openPathInput,
    pathFilter,
    pathInput,
    refreshBrowser,
    rootEntry,
    selectEntry,
    selectedAlreadyOpen,
    selectedEntry,
    setPathInput,
    showHidden,
    toggleDirectory,
    toggleHidden,
  }
}

type WorkspaceFolderBrowserState = ReturnType<typeof useWorkspaceFolderBrowserDialog>

function WorkspaceFolderBrowserHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
      <Folder className="size-4 shrink-0 text-ide-folder" />
      <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">Open Folder</span>
      <button
        aria-label="Close folder browser"
        className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        type="button"
        onClick={onClose}
      >
        <X className="size-3.5" />
      </button>
    </header>
  )
}

function WorkspaceFolderBrowserBody({ browser }: { browser: WorkspaceFolderBrowserState }) {
  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <WorkspaceFolderBrowserToolbar browser={browser} />
      <div className="min-h-0 overflow-auto px-1.5 py-2 ide-scrollbar">
        {browser.isLoading && !browser.rootEntry ? (
          <div className="grid h-full place-items-center text-[12px] text-muted-foreground">Loading</div>
        ) : browser.rootEntry ? (
          <FolderBrowserTreeNode
            entry={browser.rootEntry}
            expandedPaths={browser.expandedPaths}
            filter={browser.pathFilter}
            level={1}
            loadingDirectoryPaths={browser.loadingDirectoryPaths}
            selectedPath={browser.selectedEntry?.path ?? ""}
            onSelect={browser.selectEntry}
            onToggle={browser.toggleDirectory}
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-muted-foreground">No folder</div>
        )}
      </div>
    </div>
  )
}

function WorkspaceFolderBrowserToolbar({ browser }: { browser: WorkspaceFolderBrowserState }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-2 py-2">
      <FolderBrowserIconButton label="Back" onClick={browser.moveParent}>
        <ArrowLeft className="size-4" />
      </FolderBrowserIconButton>
      <FolderBrowserIconButton label="Home" onClick={() => void browser.loadBrowserRoot()}>
        <Folder className="size-4" />
      </FolderBrowserIconButton>
      <FolderBrowserIconButton label="Refresh" onClick={browser.refreshBrowser}>
        <RefreshCw className={cn("size-4", browser.isLoading && "animate-spin")} />
      </FolderBrowserIconButton>
      <input
        autoCapitalize="none"
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        placeholder="~"
        spellCheck={false}
        value={browser.pathInput}
        onChange={(event) => browser.setPathInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            browser.openPathInput()
          }
        }}
      />
    </div>
  )
}

function WorkspaceFolderBrowserFooter({
  browser,
  onClose,
}: {
  browser: WorkspaceFolderBrowserState
  onClose: () => void
}) {
  return (
    <footer className="flex h-11 min-w-0 items-center gap-2 border-t border-border bg-secondary/30 px-2">
      <label className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
        <input
          checked={browser.showHidden}
          className="size-3.5 accent-primary"
          type="checkbox"
          onChange={(event) => browser.toggleHidden(event.target.checked)}
        />
        Hidden
      </label>
      <div className="min-w-0 flex-1">
      </div>
      <WorkspaceFolderBrowserNotice browser={browser} />
      <div className="flex shrink-0 justify-end gap-2">
        <button
          className="h-8 rounded-md border border-border px-3 text-[12px] font-medium text-foreground hover:bg-accent"
          type="button"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!browser.canOpen}
          type="button"
          onClick={browser.chooseSelectedFolder}
        >
          {browser.selectedAlreadyOpen ? "Focus" : "Open"}
        </button>
      </div>
    </footer>
  )
}

function WorkspaceFolderBrowserNotice({ browser }: { browser: WorkspaceFolderBrowserState }) {
  if (browser.notice) {
    return (
      <div
        className={cn(
          "max-w-64 shrink-0 truncate text-[11px]",
          browser.notice.kind === "error" ? "text-destructive" : "text-muted-foreground",
        )}
        title={browser.notice.text}
      >
        {browser.notice.text}
      </div>
    )
  }
  return browser.selectedAlreadyOpen ? (
    <div className="max-w-64 shrink-0 truncate text-[11px] text-muted-foreground">Already open</div>
  ) : null
}

function FolderBrowserTreeNode({
  entry,
  expandedPaths,
  filter,
  level,
  loadingDirectoryPaths,
  selectedPath,
  onSelect,
  onToggle,
}: {
  entry: BrowserEntry
  expandedPaths: Set<string>
  filter: string
  level: number
  loadingDirectoryPaths: Set<string>
  selectedPath: string
  onSelect: (entry: BrowserEntry) => void
  onToggle: (entry: BrowserEntry) => void
}) {
  const expanded = expandedPaths.has(entry.path)
  const loading = loadingDirectoryPaths.has(entry.path)
  const selected = samePath(selectedPath, entry.path)
  const children = useMemo(
    () => filterBrowserEntries(entry.children ?? [], filter),
    [entry.children, filter],
  )
  const directories = children.filter((child) => child.type === "directory")
  const nonDirectories = children.filter((child) => child.type !== "directory")

  return (
    <div className="min-w-0">
      <FolderBrowserDirectoryRow
        entry={entry}
        expanded={expanded}
        level={level}
        loading={loading}
        selected={selected}
        onSelect={onSelect}
        onToggle={onToggle}
      />

      {expanded ? (
        <div className="min-w-0">
          {entry.error ? (
            <div
              className="h-7 truncate px-2 text-[12px] leading-7 text-destructive"
              style={{ paddingLeft: 24 + level * 16 }}
            >
              {entry.error}
            </div>
          ) : null}

          {!entry.error && directories.map((child) => (
            <FolderBrowserTreeNode
              entry={child}
              expandedPaths={expandedPaths}
              filter={filter}
              key={child.path}
              level={level + 1}
              loadingDirectoryPaths={loadingDirectoryPaths}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}

          {!entry.error && nonDirectories.map((child) => (
            <FolderBrowserNonDirectoryRow entry={child} key={child.path} level={level + 1} />
          ))}

          {!entry.error && !children.length ? (
            <div
              className="h-7 truncate px-2 text-[12px] leading-7 text-muted-foreground"
              style={{ paddingLeft: 24 + level * 16 }}
            >
              {filter.trim() ? "No match" : "Empty"}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function FolderBrowserDirectoryRow({
  entry,
  expanded,
  level,
  loading,
  selected,
  onSelect,
  onToggle,
}: {
  entry: BrowserEntry
  expanded: boolean
  level: number
  loading: boolean
  selected: boolean
  onSelect: (entry: BrowserEntry) => void
  onToggle: (entry: BrowserEntry) => void
}) {
  const canExpand = entry.type === "directory"

  return (
    <div
      aria-busy={loading || undefined}
      className={cn(
        "group grid h-7 min-w-0 grid-cols-[1.5rem_1rem_minmax(0,1fr)_auto] items-center gap-1 rounded-sm px-1 text-[13px] font-medium",
        selected ? "bg-accent text-foreground" : "text-foreground hover:bg-accent",
      )}
      style={{ paddingLeft: 4 + (level - 1) * 16 }}
    >
      <button
        aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
        className={cn(
          "grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
          !canExpand && "pointer-events-none opacity-35",
          loading && "cursor-wait opacity-70",
        )}
        disabled={loading}
        type="button"
        onClick={() => onToggle(entry)}
      >
        <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
      </button>
      {loading ? (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-info" />
      ) : expanded ? (
        <FolderOpen className="size-4 shrink-0 text-ide-folder" />
      ) : (
        <Folder className="size-4 shrink-0 text-ide-folder" />
      )}
      <button
        className="min-w-0 truncate text-left"
        title={entry.path}
        type="button"
        onClick={() => onSelect(entry)}
        onDoubleClick={() => onToggle(entry)}
      >
        {entry.name}
      </button>
      {entry.error ? (
        <span className="grid size-5 shrink-0 place-items-center rounded bg-destructive/10 text-destructive" title="Blocked">
          <X className="size-3" />
        </span>
      ) : null}
    </div>
  )
}

function FolderBrowserNonDirectoryRow({
  entry,
  level,
}: {
  entry: BrowserEntry
  level: number
}) {
  return (
    <div
      className="grid h-7 min-w-0 grid-cols-[1.5rem_1rem_minmax(0,1fr)_auto] items-center gap-1 rounded-sm px-1 text-[13px] text-muted-foreground"
      style={{ paddingLeft: 4 + (level - 1) * 16 }}
      title={`${entry.path} is not a folder`}
    >
      <span />
      <FileText className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{entry.name}</span>
      <span className="size-5 shrink-0" />
    </div>
  )
}

function FolderBrowserIconButton({
  children,
  label,
  onClick,
  pressed,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  pressed?: boolean
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        pressed && "bg-accent text-foreground",
      )}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
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

function ChatListScrollArea({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerStartY: number; scrollStartTop: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [scrollbar, setScrollbar] = useState({ height: 0, isScrollable: false, offset: 0 })

  const updateScrollbar = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const scrollableDistance = viewport.scrollHeight - viewport.clientHeight
    if (scrollableDistance <= 1) {
      setScrollbar((current) =>
        current.height === 0 && !current.isScrollable && current.offset === 0
          ? current
          : { height: 0, isScrollable: false, offset: 0 },
      )
      return
    }

    const height = Math.max(28, Math.round((viewport.clientHeight / viewport.scrollHeight) * viewport.clientHeight))
    const maxOffset = Math.max(0, viewport.clientHeight - height)
    const offset = Math.round((viewport.scrollTop / scrollableDistance) * maxOffset)
    setScrollbar((current) =>
      current.height === height && current.isScrollable && current.offset === offset
        ? current
        : { height, isScrollable: true, offset },
    )
  }, [])

  useEffect(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) {
      return
    }

    updateScrollbar()
    const resizeObserver = new ResizeObserver(updateScrollbar)
    resizeObserver.observe(content)
    resizeObserver.observe(viewport)
    return () => resizeObserver.disconnect()
  }, [updateScrollbar])

  useEffect(() => {
    updateScrollbar()
  }, [children, updateScrollbar])

  useEffect(() => {
    if (!isDragging) {
      return
    }

    function handlePointerMove(event: PointerEvent) {
      const drag = dragRef.current
      const viewport = viewportRef.current
      if (!drag || !viewport) {
        return
      }

      event.preventDefault()
      const scrollableDistance = viewport.scrollHeight - viewport.clientHeight
      const thumbTravel = viewport.clientHeight - scrollbar.height
      if (scrollableDistance <= 0 || thumbTravel <= 0) {
        return
      }

      viewport.scrollTop = drag.scrollStartTop + ((event.clientY - drag.pointerStartY) / thumbTravel) * scrollableDistance
      updateScrollbar()
    }

    function handlePointerEnd() {
      dragRef.current = null
      setIsDragging(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerEnd)
    window.addEventListener("pointercancel", handlePointerEnd)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerEnd)
      window.removeEventListener("pointercancel", handlePointerEnd)
    }
  }, [isDragging, scrollbar.height, updateScrollbar])

  return (
    <div className="relative mt-2 min-h-0 flex-1">
      <div className="chat-list-scroll-viewport h-full min-h-0 overflow-auto" ref={viewportRef} onScroll={updateScrollbar}>
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  )
}

function SessionSidebar() {
  const shell = useSessionShellState()
  const { chats, isChatRunning, isLoading } = useChatList()
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearch, setChatSearch] = useState("")
  const chatSearchRef = useRef<HTMLInputElement>(null)
  const activeManagementView = shell.providersDialogOpen
    ? "providers"
    : shell.instructionsDialogOpen
      ? "instructions"
      : shell.mcpServersDialogOpen
        ? "mcpServers"
        : null
  const workspace = shell.activeWorkspace
  const providerIconById = useMemo(
    () => new Map(shell.providerDefinitions.map((provider) => [provider.id, provider.icon])),
    [shell.providerDefinitions],
  )
  const providerLabelById = useMemo(
    () => new Map(shell.providerDefinitions.map((provider) => [provider.id, provider.label])),
    [shell.providerDefinitions],
  )
  const sortedChats = useMemo(
    () => [...chats]
      .filter((chat) => chatMatchesSearch(chat, chatSearch, providerLabelById.get(chat.providerId)))
      .sort(compareChatsByUpdatedTime),
    [chatSearch, chats, providerLabelById],
  )
  const sortedSchedules = useMemo(
    () => [...shell.schedules].sort(compareSchedules),
    [shell.schedules],
  )
  const connectedProviderCount = shell.chatAccounts.length
  const managementItems = useMemo(
    () =>
      customizations.map((item) =>
        item.id === "providers"
          ? { ...item, count: connectedProviderCount }
          : item,
      ),
    [connectedProviderCount],
  )

  if (!workspace) {
    return null
  }

  const activeTab = shell.sidebarTab

  return (
    <aside className="chat-list-panel flex h-full min-h-0 flex-col overflow-hidden bg-background px-2 py-2">
      {chatSearchOpen && activeTab === "chats" ? (
        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-secondary/40 px-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label="Search chats"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="Search chats"
            ref={chatSearchRef}
            value={chatSearch}
            onBlur={() => {
              if (!chatSearch.trim()) {
                setChatSearchOpen(false)
              }
            }}
            onChange={(event) => setChatSearch(event.target.value)}
          />
          {chatSearch ? (
            <button
              aria-label="Clear chat search"
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setChatSearch("")
                setChatSearchOpen(false)
              }}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex h-9 items-center gap-3">
          <div className="flex gap-1 text-[12px] font-semibold">
            <button
              className={cn("rounded-md px-1.5 py-0.5", activeTab === "chats" ? "bg-accent text-foreground" : "text-muted-foreground")}
              type="button"
              onClick={() => shell.setSidebarTab("chats")}
            >
              Chats
            </button>
            <button
              className={cn("rounded-md px-1.5 py-0.5", activeTab === "scheduler" ? "bg-accent text-foreground" : "text-muted-foreground")}
              type="button"
              onClick={() => shell.setSidebarTab("scheduler")}
            >
              Scheduler
            </button>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {activeTab === "chats" ? (
              <>
                <button
                  className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground shadow-sm"
                  type="button"
                  onClick={() => {
                    shell.setActiveChatId(null)
                    shell.switchToChat()
                  }}
                >
                  New
                </button>
                <PanelActionButton label="Search chats" onClick={() => {
                  setChatSearchOpen(true)
                  window.requestAnimationFrame(() => chatSearchRef.current?.focus())
                }}>
                  <Search className="size-4" />
                </PanelActionButton>
              </>
            ) : (
              <PanelActionButton label="New schedule" onClick={() => void shell.createSchedule()}>
                <Plus className="size-4" />
              </PanelActionButton>
            )}
          </div>
        </div>
      )}

      {activeTab === "chats" ? (
        <ChatListScrollArea>
          {isLoading ? (
            <div className="py-3 text-[12px] text-muted-foreground">Loading</div>
          ) : sortedChats.length ? (
            <div className="space-y-1">
              {sortedChats.map((chat) => {
                const active = chat.id === shell.activeChatId && shell.mainMode === "chat"
                const running = isChatRunning(chat.id)
                return (
                  <button
                    aria-busy={running || undefined}
                    aria-pressed={active || undefined}
                    className={cn(
                      "block w-full rounded-md px-2 py-2 text-left hover:bg-accent",
                      active && "bg-accent",
                    )}
                    key={chat.id}
                    type="button"
                    onClick={() => {
                      shell.setActiveChatId(chat.id)
                      shell.switchToChat()
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
                      <ProviderMark
                        icon={providerIconById.get(chat.providerId) ?? chat.providerId}
                        className={cn("size-4 shrink-0 text-muted-foreground", running && "text-foreground")}
                      />
                      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                      {running ? (
                        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-info" aria-hidden="true" />
                      ) : null}
                    </div>
                    <div className="ml-6 mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="truncate">{relativeTimeLabel(chat.lastActivityAt)}</span>
                      {hasChatStats(chat.stats) ? (
                        <span className="flex shrink-0 items-center gap-1 font-medium">
                          <span className="text-success">+{chat.stats.additions}</span>
                          <span className="text-diff-deletion-foreground">-{chat.stats.deletions}</span>
                        </span>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="py-3 text-[12px] text-muted-foreground">{chatSearch.trim() ? "No matching chats" : "No chats"}</div>
          )}
        </ChatListScrollArea>
      ) : (
        <ChatListScrollArea>
          {shell.isSchedulesLoading ? (
            <div className="py-3 text-[12px] text-muted-foreground">Loading</div>
          ) : sortedSchedules.length ? (
            <div className="space-y-1">
              {sortedSchedules.map((schedule) => (
                <ScheduleListItem
                  active={shell.activeScheduleId === schedule.id && shell.mainMode === "schedule"}
                  key={schedule.id}
                  schedule={schedule}
                  onSelect={() => shell.selectSchedule(schedule.id)}
                />
              ))}
            </div>
          ) : (
            <div className="py-3 text-[12px] text-muted-foreground">No schedules</div>
          )}
        </ChatListScrollArea>
      )}

      <div className="mt-3 border-t border-border pt-4">
        <h3 className="mb-3 text-[13px] font-semibold text-foreground">Managements</h3>
        <div className="space-y-1">
          {managementItems.map((item) => {
            const itemId = item.id
            const active = itemId === activeManagementView
            return (
              <button
                aria-pressed={active || undefined}
                className={cn(
                  "flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] font-medium text-foreground hover:bg-accent hover:text-foreground",
                  active && "bg-accent text-foreground",
                )}
                key={item.label}
                type="button"
                onClick={itemId ? () => shell.selectManagementView(itemId) : undefined}
              >
                {item.providerIcon ? (
                  <ProviderMark icon={item.providerIcon} className={cn("size-4 text-muted-foreground", active && "text-foreground")} />
                ) : item.icon ? (
                  <item.icon className={cn("size-4 text-muted-foreground", active && "text-foreground")} />
                ) : null}
                <span>{item.label}</span>
                {item.count !== undefined ? (
                  <span
                    className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                    title={item.id === "providers" ? "Connected providers" : undefined}
                  >
                    {item.count}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

function ScheduleListItem({
  active,
  schedule,
  onSelect,
}: {
  active: boolean
  schedule: MessageScheduleResponse
  onSelect: () => void
}) {
  return (
    <button
      aria-pressed={active || undefined}
      className={cn(
        "block w-full rounded-md px-2 py-2 text-left hover:bg-accent",
        active && "bg-accent",
      )}
      type="button"
      onClick={onSelect}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
        <span className="min-w-0 flex-1 truncate">{schedule.title}</span>
        <span className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold",
          schedule.status === "ACTIVE" && "bg-success/10 text-success",
          schedule.status === "PAUSED" && "bg-warning/10 text-warning",
          schedule.status === "COMPLETED" && "bg-info/15 text-info",
        )}>
          {schedule.status.toLowerCase()}
        </span>
      </div>
      <div className="mt-1 min-w-0 truncate text-[11px] text-muted-foreground">
        {schedule.nextRunAt ? `Next ${dateTimeLabel(schedule.nextRunAt)}` : "No upcoming run"}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">{recurrenceLabel(schedule.recurrence)}</span>
        {schedule.lastRunStatus ? (
          <span className="shrink-0 text-muted-foreground">Last {schedule.lastRunStatus.toLowerCase()}</span>
        ) : null}
      </div>
    </button>
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
        contentLoaded={shell.selectedFileContentLoaded}
        file={selectedFile}
        languageServers={shell.activeLanguageServers}
        openFiles={shell.openFiles}
        revealTarget={shell.editorRevealTarget?.fileId === selectedFile.id ? shell.editorRevealTarget : null}
        workspace={workspace}
        onFileClose={shell.closeFile}
        onContentChange={shell.updateFileContent}
        onFileSelect={shell.selectFile}
        onOpenLocation={shell.openWorkspaceFilePath}
        onOpenDialog={shell.openSelectedFileDialog}
        onToggleMode={onBackToChat}
      />
    )
  }

  if (shell.mainMode === "schedule") {
    return <ScheduleDetailPane />
  }

  return (
    <ChatPane
      accounts={shell.chatAccounts}
      chat={shell.activeChat}
      error={shell.chatError}
      isLoading={shell.isChatsLoading}
      isMessagesLoading={Boolean(shell.activeChat && !shell.activeMessagesLoaded)}
      isSwitchingAccount={shell.isSwitchingAccount}
      messages={shell.activeMessages}
      preferredAccountId={shell.preferredAccountId}
      providerDefinitions={shell.providerDefinitions}
      workspace={workspace}
      onDeleteQueuedMessage={shell.deleteQueuedMessage}
      onEditQueuedMessage={shell.editQueuedMessage}
      onFileLinkOpen={shell.openChatFileLink}
      onOpenProviders={() => shell.setProvidersDialogOpen(true)}
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

type ScheduleDraft = {
  accountId: string
  active: boolean
  collaborationMode: string
  endAt: string
  firstRunAt: string
  interval: string
  maxRuns: string
  message: string
  model: string
  permissionMode: ChatComposerAccessMode
  reasoningEffort: ChatComposerReasoningEffort
  recurrenceFrequency: MessageScheduleRecurrence["frequency"]
  serviceTier: ChatComposerServiceTier
  title: string
}

function ScheduleDetailPane() {
  const shell = useSessionShellState()
  const schedule = shell.activeSchedule
  const runs = shell.activeScheduleRuns
  const [draft, setDraft] = useState<ScheduleDraft | null>(() => schedule ? scheduleDraftFrom(schedule) : null)
  const [modelOptions, setModelOptions] = useState<ProviderModelListResponse["data"]>([])
  const [saving, setSaving] = useState(false)
  const account = shell.chatAccounts.find((entry) => entry.id === draft?.accountId) ??
    shell.chatAccounts.find((entry) => entry.id === schedule?.accountId) ??
    null
  const providerDefinition = shell.providerDefinitions.find((provider) => provider.id === account?.providerId) ??
    shell.providerDefinitions.find((provider) => provider.id === schedule?.providerId) ??
    null
  const supportsModels = Boolean(account && providerDefinition?.capabilities.includes("models"))
  const supportsReasoningEffort = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "reasoningEffort"))
  const supportsServiceTier = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "serviceTier"))
  const availableAccounts = schedule
    ? shell.chatAccounts.filter((entry) => entry.providerId === schedule.providerId)
    : shell.chatAccounts
  const visibleModelOptions = mergeProviderModelOptions(account?.providerId, modelOptions)
    .filter((option) => !option.hidden)
  const selectedModelLabel = visibleModelOptions.find((option) => option.model === draft?.model || option.id === draft?.model)?.displayName ??
    (draft?.model ||
    "Default"
    )

  useEffect(() => {
    setDraft(schedule ? scheduleDraftFrom(schedule) : null)
  }, [schedule?.id])

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

  if (!schedule || !draft) {
    return (
      <section className="grid h-full min-h-0 place-items-center rounded-xl border border-border bg-card p-6 text-center">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Scheduler</h2>
          <p className="mt-2 max-w-sm text-[13px] text-muted-foreground">Select a schedule or create one from the scheduler tab.</p>
          <button
            className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-secondary px-3 text-[13px] text-foreground hover:bg-accent"
            type="button"
            onClick={() => void shell.createSchedule()}
          >
            <Plus className="size-4" />
            New schedule
          </button>
        </div>
      </section>
    )
  }

  const canSave = Boolean(draft.title.trim() && draft.message.trim() && draft.firstRunAt && draft.accountId)
  const scheduleControlClass = "border-input bg-background text-foreground shadow-none focus-visible:border-ring focus-visible:ring-ring/35"
  const scheduleLabelClass = "mb-1 block text-[11px] font-medium leading-none text-muted-foreground"
  const scheduleSelectTriggerClass = "h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60 focus-visible:border-ring focus-visible:ring-ring/35"

  const save = async () => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      await shell.updateSchedule(schedule.id, {
        accountId: draft.accountId,
        collaborationMode: draft.collaborationMode,
        firstRunAt: isoFromLocalDateTimeInput(draft.firstRunAt),
        message: draft.message,
        model: draft.model || null,
        permissionMode: draft.permissionMode,
        reasoningEffort: supportsReasoningEffort ? composerReasoningEffortValue(draft.reasoningEffort) : null,
        recurrence: {
          endAt: draft.endAt ? isoFromLocalDateTimeInput(draft.endAt) : null,
          frequency: draft.recurrenceFrequency,
          interval: Number.parseInt(draft.interval, 10) || 1,
          maxRuns: draft.maxRuns ? Number.parseInt(draft.maxRuns, 10) || null : null,
        },
        serviceTier: supportsServiceTier ? composerServiceTierValue(draft.serviceTier) : null,
        status: draft.active ? "ACTIVE" : "PAUSED",
        title: draft.title,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-11 items-center gap-3 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-foreground">{draft.title.trim() || schedule.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-muted-foreground">{draft.active ? "On" : "Off"}</span>
          <Switch
            aria-label={draft.active ? "Turn schedule off" : "Turn schedule on"}
            className={cn(
              "h-5 w-9 border-border bg-accent data-[state=checked]:border-success/60 data-[state=checked]:bg-success",
            )}
            checked={draft.active}
            title={draft.active ? "Schedule is on" : "Schedule is off"}
            onCheckedChange={(active) => setDraft({ ...draft, active })}
          />
        </div>
      </div>
      <div className="grid min-h-0 gap-4 overflow-auto p-3 ide-scrollbar lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
        <div className="min-w-0 space-y-5">
          {shell.scheduleError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{shell.scheduleError}</div>
          ) : null}
          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold text-foreground">Details</h3>
            <Label className="block">
              <span className={scheduleLabelClass}>Title</span>
              <input
                className={cn("h-8 px-2 text-[13px]", scheduleControlClass)}
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </Label>
            <Label className="block">
              <span className={scheduleLabelClass}>Message</span>
              <textarea
                className={cn("min-h-36 resize-none px-2 py-2 text-[13px] leading-5", scheduleControlClass)}
                value={draft.message}
                onChange={(event) => setDraft({ ...draft, message: event.target.value })}
              />
            </Label>
          </div>
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-[12px] font-semibold text-foreground">Timing</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>First run</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  type="datetime-local"
                  value={draft.firstRunAt}
                  onChange={(event) => setDraft({ ...draft, firstRunAt: event.target.value })}
                />
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Repeat</span>
                <Select className="w-full min-w-0" value={draft.recurrenceFrequency} onValueChange={(frequency) => setDraft({ ...draft, recurrenceFrequency: readRecurrenceFrequency(frequency) })}>
                  <SelectTrigger aria-label="Repeat" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{recurrenceFrequencyLabel(draft.recurrenceFrequency)}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    {(["none", "daily", "weekly", "monthly"] as const).map((frequency) => (
                      <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={frequency} value={frequency}>
                        {recurrenceFrequencyLabel(frequency)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Interval</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  disabled={draft.recurrenceFrequency === "none"}
                  min={1}
                  type="number"
                  value={draft.interval}
                  onChange={(event) => setDraft({ ...draft, interval: event.target.value })}
                />
              </Label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>End after</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  disabled={draft.recurrenceFrequency === "none"}
                  min={1}
                  placeholder="Run count"
                  type="number"
                  value={draft.maxRuns}
                  onChange={(event) => setDraft({ ...draft, maxRuns: event.target.value })}
                />
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>End date</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  disabled={draft.recurrenceFrequency === "none"}
                  type="datetime-local"
                  value={draft.endAt}
                  onChange={(event) => setDraft({ ...draft, endAt: event.target.value })}
                />
              </Label>
            </div>
          </div>
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-[12px] font-semibold text-foreground">Execution</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Provider account</span>
                <Select className="w-full min-w-0" value={draft.accountId} onValueChange={(accountId) => setDraft({ ...draft, accountId })}>
                  <SelectTrigger aria-label="Provider account" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{availableAccounts.find((entry) => entry.id === draft.accountId)?.displayName ?? "Choose account"}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    {availableAccounts.map((entry) => (
                      <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Access</span>
                <Select className="w-full min-w-0" value={draft.permissionMode} onValueChange={(value) => setDraft({ ...draft, permissionMode: readComposerAccessMode(value) })}>
                  <SelectTrigger aria-label="Access mode" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{draft.permissionMode === "fullAccess" ? "Full access" : "Ask for approval"}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="askForApproval">Ask for approval</SelectItem>
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="fullAccess">Full access</SelectItem>
                  </SelectContent>
                </Select>
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Mode</span>
                <Select className="w-full min-w-0" value={draft.collaborationMode} onValueChange={(value) => setDraft({ ...draft, collaborationMode: value === "plan" ? "plan" : "default" })}>
                  <SelectTrigger aria-label="Mode" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{draft.collaborationMode === "plan" ? "Plan" : "Default"}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="default">Default</SelectItem>
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="plan">Plan</SelectItem>
                  </SelectContent>
                </Select>
              </Label>
            </div>
          </div>
          {supportsModels || supportsReasoningEffort || supportsServiceTier ? (
            <div className="space-y-3 border-t border-border pt-4">
              <h3 className="text-[12px] font-semibold text-foreground">Runtime</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {supportsModels ? (
                  <Label className="block min-w-0">
                    <span className={scheduleLabelClass}>Model</span>
                    <Select className="w-full min-w-0" value={draft.model || visibleModelOptions[0]?.model || ""} onValueChange={(model) => setDraft({ ...draft, model })}>
                      <SelectTrigger aria-label="Model" className={scheduleSelectTriggerClass}>
                        <span className="truncate">{selectedModelLabel}</span>
                      </SelectTrigger>
                      <SelectContent align="start" className="max-h-72 border-border bg-popover text-foreground">
                        {visibleModelOptions.map((option) => (
                          <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.id} value={option.model}>
                            {option.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                ) : null}
                {supportsReasoningEffort ? (
                  <Label className="block min-w-0">
                    <span className={scheduleLabelClass}>Reasoning</span>
                    <Select className="w-full min-w-0" value={draft.reasoningEffort} onValueChange={(value) => setDraft({ ...draft, reasoningEffort: readComposerReasoningEffort(value) })}>
                      <SelectTrigger aria-label="Reasoning" className={scheduleSelectTriggerClass}>
                        <span className="truncate">{composerReasoningEffortLabel(draft.reasoningEffort)}</span>
                      </SelectTrigger>
                      <SelectContent align="start" className="border-border bg-popover text-foreground">
                        {composerReasoningEffortOptions.map((option) => (
                          <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                ) : null}
                {supportsServiceTier ? (
                  <Label className="block min-w-0">
                    <span className={scheduleLabelClass}>Speed</span>
                    <Select className="w-full min-w-0" value={draft.serviceTier} onValueChange={(value) => setDraft({ ...draft, serviceTier: readComposerServiceTier(value) })}>
                      <SelectTrigger aria-label="Speed" className={scheduleSelectTriggerClass}>
                        <span className="truncate">{composerServiceTierLabel(draft.serviceTier)}</span>
                      </SelectTrigger>
                      <SelectContent align="start" className="border-border bg-popover text-foreground">
                        {composerServiceTierOptions.map((option) => (
                          <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            <button
              className="h-8 gap-2 rounded-md border-destructive/30 bg-destructive/10 px-3 text-[12px] text-destructive hover:bg-destructive/10"
              type="button"
              onClick={() => void shell.deleteSchedule(schedule.id)}
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
            <button
              className="h-8 gap-2 rounded-md border-border bg-secondary px-3 text-[12px] text-foreground hover:bg-accent"
              disabled={!canSave || saving}
              type="button"
              onClick={() => void save()}
            >
              <Check className="size-3.5" />
              {saving ? "Saving" : "Save"}
            </button>
          </div>
        </div>
        <div className="min-w-0 border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <h3 className="text-[13px] font-semibold text-foreground">Execution History</h3>
          <div className="mt-3 space-y-2">
            {runs.length ? runs.map((run) => (
              <button
                className="block w-full rounded-md border border-border bg-secondary/40 px-3 py-2 text-left hover:bg-popover"
                key={run.id}
                type="button"
                onClick={() => void shell.openScheduleRunChat(run)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{dateTimeLabel(run.scheduledFor)}</span>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", scheduleRunStatusClass(run.status))}>{run.status.toLowerCase()}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {run.startedAt ? `Started ${relativeTimeLabel(run.startedAt)}` : "Waiting"}
                  {run.endedAt ? ` / Ended ${relativeTimeLabel(run.endedAt)}` : ""}
                </div>
                {run.error ? <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{run.error}</div> : null}
              </button>
            )) : (
              <div className="rounded-md border border-border bg-secondary/40 px-3 py-3 text-[12px] text-muted-foreground">No runs yet</div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function CodexInstructionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const loadRequestIdRef = useRef(0)

  const loadInstructions = async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    setIsLoading(true)
    setNotice(null)
    try {
      const response = await apiClient.providers.codexInstructions()
      if (loadRequestIdRef.current !== requestId) {
        return
      }
      setDraft(response.instructions)
    } catch (error) {
      if (loadRequestIdRef.current !== requestId) {
        return
      }
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false)
      }
    }
  }

  useEffect(() => {
    if (open) {
      void loadInstructions()
    }
  }, [open])

  const saveInstructions = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const response = await apiClient.providers.updateCodexInstructions({ instructions: draft })
      setDraft(response.instructions)
      setNotice({ kind: "info", text: `Saved to ${response.paths.length} Codex homes` })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close instructions" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[82vh] min-h-72 w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <FileText className="size-4 shrink-0 text-info" />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Instructions</h1>
          <button
            aria-label="Reload instructions"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
            type="button"
            onClick={() => void loadInstructions()}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </button>
          <button
            aria-label="Close instructions"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
          {notice ? (
            <div
              className={cn(
                "mb-3 rounded-md border px-3 py-2 text-[12px]",
                notice.kind === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-info/20 bg-info/10 text-info",
              )}
            >
              {notice.text}
            </div>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">AGENTS.md</span>
            <textarea
              className="h-[min(52vh,28rem)] w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-[12px] leading-5 text-foreground outline-none focus:border-primary disabled:opacity-65"
              disabled={isLoading}
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
        </div>

        <footer className="flex h-11 items-center justify-end gap-2 border-t border-border px-3">
          <button
            className="h-8 rounded-md border border-border px-3 text-[12px] font-medium text-foreground hover:bg-accent"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
            disabled={isLoading || saving}
            type="button"
            onClick={() => void saveInstructions()}
          >
            {saving ? "Saving" : "Save"}
          </button>
        </footer>
      </section>
    </div>
  )
}

type McpServerDraft = {
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

function McpServersManagementDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [accounts, setAccounts] = useState<ProviderAccountResponse[]>([])
  const [draft, setDraft] = useState<McpServerDraft>(() => emptyMcpDraft())
  const [isLoading, setIsLoading] = useState(true)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [oauthing, setOauthing] = useState(false)
  const [refreshingStatus, setRefreshingStatus] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [servers, setServers] = useState<McpServerResponse[]>([])
  const [statusAccountId, setStatusAccountId] = useState("")
  const [statusItems, setStatusItems] = useState<McpServerStatusItem[]>([])
  const [syncing, setSyncing] = useState(false)
  const codexAccounts = accounts.filter((account) => account.providerId === "codex")
  const selectedServer = servers.find((server) => server.id === selectedId) ?? null
  const selectedStatus = selectedServer
    ? statusItems.find((item) => item.name === selectedServer.name)
    : null

  const loadMcpData = async (preferredSelectedId = selectedId) => {
    setIsLoading(true)
    setNotice(null)
    try {
      const [nextServers, nextAccounts] = await Promise.all([
        apiClient.mcpServers.list(),
        apiClient.providerAccounts.list(),
      ])
      setServers(nextServers)
      setAccounts(nextAccounts)
      const nextSelected = nextServers.find((server) => server.id === preferredSelectedId) ?? nextServers[0] ?? null
      setSelectedId(nextSelected?.id ?? null)
      setDraft(nextSelected ? mcpDraftFromServer(nextSelected) : emptyMcpDraft())
      const firstCodexAccountId = nextAccounts.find((account) => account.providerId === "codex")?.id ?? ""
      setStatusAccountId((current) => current || nextSelected?.installations[0]?.accountId || firstCodexAccountId)
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      void loadMcpData()
    }
  }, [open])

  const selectServer = (server: McpServerResponse) => {
    setSelectedId(server.id)
    setDraft(mcpDraftFromServer(server))
    setNotice(null)
  }

  const createNewServer = () => {
    setSelectedId(null)
    setDraft(emptyMcpDraft())
    setStatusItems([])
    setNotice(null)
  }

  const saveServer = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const body = mcpRequestFromDraft(draft)
      const saved = selectedServer
        ? await apiClient.mcpServers.update(selectedServer.id, body)
        : await apiClient.mcpServers.create(body)
      setSelectedId(saved.id)
      setDraft(mcpDraftFromServer(saved))
      await loadMcpData(saved.id)
      setNotice({ kind: "info", text: "Saved" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  const deleteServer = async () => {
    if (!selectedServer || !window.confirm("Delete MCP server?")) {
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      await apiClient.mcpServers.delete(selectedServer.id)
      setSelectedId(null)
      setDraft(emptyMcpDraft())
      await loadMcpData(null)
      setNotice({ kind: "info", text: "Deleted" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  const syncServer = async () => {
    if (!selectedServer) {
      await saveServer()
      return
    }
    setSyncing(true)
    setNotice(null)
    try {
      const synced = await apiClient.mcpServers.sync(selectedServer.id, { accountIds: draft.accountIds })
      setDraft(mcpDraftFromServer(synced))
      await loadMcpData()
      setNotice({ kind: "info", text: "Synced" })
      const accountId = statusAccountId || draft.accountIds[0]
      if (accountId) {
        await refreshStatus(accountId)
      }
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSyncing(false)
    }
  }

  const refreshStatus = async (accountId = statusAccountId || draft.accountIds[0] || codexAccounts[0]?.id || "") => {
    if (!accountId) {
      setNotice({ kind: "error", text: "Choose a Codex account." })
      return
    }
    setRefreshingStatus(true)
    setNotice(null)
    try {
      const response = await apiClient.mcpServers.status(accountId)
      setStatusAccountId(accountId)
      setStatusItems(response.data)
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setRefreshingStatus(false)
    }
  }

  const startOauthLogin = async () => {
    if (!selectedServer) {
      setNotice({ kind: "error", text: "Save this MCP server before OAuth login." })
      return
    }
    const accountId = statusAccountId || draft.accountIds[0] || codexAccounts[0]?.id
    if (!accountId) {
      setNotice({ kind: "error", text: "Choose a Codex account." })
      return
    }
    setOauthing(true)
    setNotice(null)
    try {
      const response = await apiClient.mcpServers.oauthLogin(selectedServer.id, {
        accountId,
        scopes: parseLineList(draft.scopesText),
      })
      window.open(response.authorizationUrl, "_blank", "noopener,noreferrer")
      await delay(800)
      await refreshStatus(accountId)
      setNotice({ kind: "info", text: "OAuth started" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setOauthing(false)
    }
  }

  const updateDraft = <K extends keyof McpServerDraft>(key: K, value: McpServerDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close MCP servers" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[86vh] w-full max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <Server className="size-4 shrink-0 text-info" />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">MCP Servers</h1>
          <button
            aria-label="Add MCP server"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add"
            type="button"
            onClick={createNewServer}
          >
            <Plus className="size-4" />
          </button>
          <button
            aria-label="Refresh MCP servers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
            type="button"
            onClick={() => void loadMcpData()}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </button>
          <button
            aria-label="Close MCP servers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)] overflow-hidden">
          <aside className="min-h-0 overflow-auto border-r border-border p-2 ide-scrollbar">
            {isLoading ? (
              <div className="grid min-h-44 place-items-center text-[13px] text-muted-foreground">Loading</div>
            ) : servers.length ? (
              <div className="space-y-1">
                {servers.map((server) => {
                  const active = server.id === selectedId
                  const lastError = server.installations.find((installation) => installation.lastError)?.lastError
                  return (
                    <button
                      aria-pressed={active || undefined}
                      className={cn(
                        "grid w-full gap-1 rounded-md px-2 py-2 text-left hover:bg-accent",
                        active && "bg-accent",
                      )}
                      key={server.id}
                      type="button"
                      onClick={() => selectServer(server)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                          {server.displayName || server.name}
                        </span>
                        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {server.transport.type === "stdio" ? "stdio" : "http"}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">{server.name}</span>
                        <span className="ml-auto shrink-0">{server.installations.length}</span>
                      </span>
                      {lastError ? <span className="truncate text-[11px] text-destructive">{lastError}</span> : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="grid min-h-44 place-items-center text-[13px] text-muted-foreground">No MCP servers</div>
            )}
          </aside>

          <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
            {notice ? (
              <div
                className={cn(
                  "mb-3 rounded-md border px-3 py-2 text-[12px]",
                  notice.kind === "error"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-success/30 bg-success/10 text-success",
                )}
              >
                {notice.text}
              </div>
            ) : null}

            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <McpTextField label="Name" value={draft.name} onChange={(value) => updateDraft("name", value)} />
                <McpTextField label="Display" value={draft.displayName} onChange={(value) => updateDraft("displayName", value)} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-border">
                  {(["stdio", "streamable_http"] as const).map((type) => (
                    <button
                      className={cn(
                        "h-8 px-3 text-[12px] font-medium",
                        draft.transportType === type ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent",
                      )}
                      key={type}
                      type="button"
                      onClick={() => updateDraft("transportType", type)}
                    >
                      {type === "stdio" ? "stdio" : "HTTP"}
                    </button>
                  ))}
                </div>
                <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-[12px] text-foreground">
                  <input
                    checked={draft.enabled}
                    className="accent-primary"
                    type="checkbox"
                    onChange={(event) => updateDraft("enabled", event.currentTarget.checked)}
                  />
                  Enabled
                </label>
                <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-[12px] text-foreground">
                  <input
                    checked={draft.required}
                    className="accent-primary"
                    type="checkbox"
                    onChange={(event) => updateDraft("required", event.currentTarget.checked)}
                  />
                  Required
                </label>
              </div>

              {draft.transportType === "stdio" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <McpTextField label="Command" value={draft.command} onChange={(value) => updateDraft("command", value)} />
                  <McpTextField label="cwd" value={draft.cwd} onChange={(value) => updateDraft("cwd", value)} />
                  <McpTextArea label="Args" value={draft.argsText} onChange={(value) => updateDraft("argsText", value)} />
                  <McpTextArea label="Env" value={draft.envText} onChange={(value) => updateDraft("envText", value)} />
                  <McpTextArea label="Env vars" value={draft.envVarsText} onChange={(value) => updateDraft("envVarsText", value)} />
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  <McpTextField label="URL" value={draft.url} onChange={(value) => updateDraft("url", value)} />
                  <McpTextField label="Bearer env" value={draft.bearerTokenEnvVar} onChange={(value) => updateDraft("bearerTokenEnvVar", value)} />
                  <McpTextArea label="Headers" value={draft.httpHeadersText} onChange={(value) => updateDraft("httpHeadersText", value)} />
                  <McpTextArea label="Env headers" value={draft.envHttpHeadersText} onChange={(value) => updateDraft("envHttpHeadersText", value)} />
                  <McpTextField label="OAuth client" value={draft.oauthClientId} onChange={(value) => updateDraft("oauthClientId", value)} />
                  <McpTextField label="OAuth resource" value={draft.oauthResource} onChange={(value) => updateDraft("oauthResource", value)} />
                  <McpTextArea label="Scopes" value={draft.scopesText} onChange={(value) => updateDraft("scopesText", value)} />
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-3">
                <McpTextField label="Startup timeout" value={draft.startupTimeoutSec} onChange={(value) => updateDraft("startupTimeoutSec", value)} />
                <McpTextField label="Tool timeout" value={draft.toolTimeoutSec} onChange={(value) => updateDraft("toolTimeoutSec", value)} />
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Approval
                  <select
                    className="h-8 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary"
                    value={draft.defaultToolsApprovalMode}
                    onChange={(event) => updateDraft("defaultToolsApprovalMode", event.currentTarget.value as McpServerDraft["defaultToolsApprovalMode"])}
                  >
                    <option value="">Default</option>
                    <option value="auto">Auto</option>
                    <option value="prompt">Prompt</option>
                    <option value="approve">Approve</option>
                  </select>
                </label>
                <McpTextArea label="Enabled tools" value={draft.enabledToolsText} onChange={(value) => updateDraft("enabledToolsText", value)} />
                <McpTextArea label="Disabled tools" value={draft.disabledToolsText} onChange={(value) => updateDraft("disabledToolsText", value)} />
                <McpTextArea label="Tool approvals" value={draft.toolOverridesText} onChange={(value) => updateDraft("toolOverridesText", value)} />
              </div>

              <div className="grid gap-2">
                <div className="text-[12px] font-medium text-foreground">Accounts</div>
                {codexAccounts.length ? (
                  <div className="grid gap-1 md:grid-cols-2">
                    {codexAccounts.map((account) => (
                      <label
                        className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px] text-foreground"
                        key={account.id}
                      >
                        <input
                          checked={draft.accountIds.includes(account.id)}
                          className="accent-primary"
                          type="checkbox"
                          onChange={(event) => {
                            updateDraft(
                              "accountIds",
                              event.currentTarget.checked
                                ? [...draft.accountIds, account.id]
                                : draft.accountIds.filter((accountId) => accountId !== account.id),
                            )
                          }}
                        />
                        <ProviderMark icon="codex" className="size-3.5 shrink-0 text-info" />
                        <span className="min-w-0 flex-1 truncate">{account.displayName}</span>
                        <ProviderStatusBadge status={account.status} />
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-muted-foreground">No Codex accounts</div>
                )}
              </div>

              <div className="grid gap-2 border-t border-border pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-8 min-w-56 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary"
                    value={statusAccountId}
                    onChange={(event) => setStatusAccountId(event.currentTarget.value)}
                  >
                    <option value="">Account</option>
                    {codexAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.displayName}</option>
                    ))}
                  </select>
                  <button
                    className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-accent"
                    type="button"
                    onClick={() => void refreshStatus()}
                  >
                    <RefreshCw className={cn("size-3.5", refreshingStatus && "animate-spin")} />
                    Refresh
                  </button>
                  {selectedStatus ? (
                    <span className="text-[12px] text-muted-foreground">
                      {selectedStatus.authStatus} · {selectedStatus.toolCount} tools
                    </span>
                  ) : null}
                </div>
                {selectedStatus?.error || selectedStatus?.lastError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                    {selectedStatus.error || selectedStatus.lastError}
                  </div>
                ) : selectedStatus ? (
                  <div className="text-[12px] text-muted-foreground">
                    {selectedStatus.tools.slice(0, 12).join(", ") || "No tools reported"}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <footer className="flex min-h-12 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <button
            className="flex h-8 items-center gap-1.5 rounded-md border border-destructive/30 px-2 text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
            disabled={!selectedServer || saving}
            type="button"
            onClick={() => void deleteServer()}
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-accent disabled:opacity-50"
              disabled={!selectedServer || syncing}
              type="button"
              onClick={() => void syncServer()}
            >
              <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
              Sync
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-accent disabled:opacity-50"
              disabled={!selectedServer || draft.transportType !== "streamable_http" || oauthing}
              type="button"
              onClick={() => void startOauthLogin()}
            >
              <ExternalLink className="size-3.5" />
              OAuth
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
              disabled={saving}
              type="button"
              onClick={() => void saveServer()}
            >
              {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Save
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function McpTextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="grid gap-1 text-[12px] text-muted-foreground">
      {label}
      <input
        className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}

function McpTextArea({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="grid gap-1 text-[12px] text-muted-foreground">
      {label}
      <textarea
        className="min-h-20 resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}

function emptyMcpDraft(): McpServerDraft {
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

function mcpDraftFromServer(server: McpServerResponse): McpServerDraft {
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

function mcpRequestFromDraft(draft: McpServerDraft) {
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

function parseLineList(value: string): string[] {
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

function ProvidersManagementDialog({
  open,
  onClose,
  onProviderDataChange,
}: {
  open: boolean
  onClose: () => void
  onProviderDataChange: (providers: ProviderDefinitionResponse[], accounts: ProviderAccountResponse[]) => void
}) {
  const [accounts, setAccounts] = useState<ProviderAccountResponse[]>([])
  const [accountDialogId, setAccountDialogId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderDefinitionResponse[]>([])
  const { accountLimits } = useProviderQuotas()
  const selectedAccount = accounts.find((account) => account.id === accountDialogId) ?? null
  const selectedProvider = selectedAccount
    ? providers.find((provider) => provider.id === selectedAccount.providerId) ?? null
    : null

  const loadProviderData = async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const [nextProviders, nextAccounts] = await Promise.all([
        apiClient.providers.list(),
        apiClient.providerAccounts.list(),
      ])
      setProviders(nextProviders)
      setAccounts(nextAccounts)
      onProviderDataChange(nextProviders, nextAccounts)
    } catch (error) {
      setLoadError(readError(error))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      void loadProviderData()
    }
  }, [open])

  const createAccount = async (providerId: string) => {
    setLoadError(null)
    try {
      const account = await apiClient.providerAccounts.create({ providerId })
      const nextAccounts = [...accounts, account]
      setAccounts(nextAccounts)
      onProviderDataChange(providers, nextAccounts)
      setAccountDialogId(account.id)
      setPickerOpen(false)
    } catch (error) {
      setLoadError(readError(error))
    }
  }

  const updateAccount = (account: ProviderAccountResponse) => {
    const nextAccounts = accounts.map((entry) => entry.id === account.id ? account : entry)
    setAccounts(nextAccounts)
    onProviderDataChange(providers, nextAccounts)
  }

  const removeAccount = (accountId: string) => {
    const nextAccounts = accounts.filter((entry) => entry.id !== accountId)
    setAccounts(nextAccounts)
    onProviderDataChange(providers, nextAccounts)
    setAccountDialogId(null)
  }

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close providers" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[82vh] min-h-72 w-full max-w-lg grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <ProviderMark icon={providers[0]?.icon ?? "codex"} className="size-4 shrink-0 text-info" />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Providers</h1>
          <button
            aria-label="Add provider account"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add"
            type="button"
            onClick={() => setPickerOpen(true)}
          >
            <Plus className="size-4" />
          </button>
          <button
            aria-label="Refresh providers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
            type="button"
            onClick={() => void loadProviderData()}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </button>
          <button
            aria-label="Close providers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
          {loadError ? (
            <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {loadError}
            </div>
          ) : null}

          {isLoading ? (
            <div className="grid h-full min-h-44 place-items-center text-[13px] text-muted-foreground">Loading</div>
          ) : accounts.length ? (
            <div className="space-y-1.5">
              {accounts.map((account) => {
                const provider = providers.find((entry) => entry.id === account.providerId)
                const quota = formatProviderQuota(accountLimits[account.id])
                return (
                  <button
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
                    key={account.id}
                    type="button"
                    onClick={() => setAccountDialogId(account.id)}
                  >
                    <ProviderGlyph icon={provider?.icon ?? "bot"} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-foreground">{account.displayName}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {provider?.label ?? account.providerId}
                        {quota ? ` · ${quota}` : ""}
                      </span>
                    </span>
                    <ProviderStatusBadge status={account.status} />
                    <Wrench className="size-4 text-muted-foreground" />
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="grid h-full min-h-44 place-items-center text-[13px] text-muted-foreground">No accounts</div>
          )}
        </div>
      </section>

      <ProviderPickerDialog
        open={pickerOpen}
        providers={providers}
        onClose={() => setPickerOpen(false)}
        onSelect={(providerId) => void createAccount(providerId)}
      />
      <ProviderAccountDialog
        account={selectedAccount}
        provider={selectedProvider}
        onAccountChange={updateAccount}
        onAccountDelete={removeAccount}
        onClose={() => setAccountDialogId(null)}
        onReload={loadProviderData}
      />
    </div>
  )
}

function ProviderPickerDialog({
  open,
  providers,
  onClose,
  onSelect,
}: {
  open: boolean
  providers: ProviderDefinitionResponse[]
  onClose: () => void
  onSelect: (providerId: string) => void
}) {
  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close provider picker" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 items-center gap-2 border-b border-border px-3">
          <Plus className="size-4 text-info" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Add provider</h2>
          <button
            aria-label="Close provider picker"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="p-2">
          {providers.map((provider) => (
            <button
              className="flex h-12 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left hover:bg-accent"
              key={provider.id}
              type="button"
              onClick={() => onSelect(provider.id)}
            >
              <ProviderGlyph icon={provider.icon} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-foreground">{provider.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{provider.id}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function ProviderAccountDialog({
  account,
  provider,
  onAccountChange,
  onAccountDelete,
  onClose,
  onReload,
}: {
  account: ProviderAccountResponse | null
  provider: ProviderDefinitionResponse | null
  onAccountChange: (account: ProviderAccountResponse) => void
  onAccountDelete: (accountId: string) => void
  onClose: () => void
  onReload: () => Promise<void>
}) {
  const dialog = useProviderAccountDialogState(account, provider, onAccountChange, onAccountDelete, onReload)

  if (!account || !provider) {
    return null
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/55 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close provider account" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[84vh] w-full max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <ProviderAccountDialogHeader account={account} provider={provider} onClose={onClose} />
        <ProviderAccountDialogBody account={account} dialog={dialog} provider={provider} />
        <ProviderAccountDialogFooter connected={dialog.connected} deleting={dialog.deleting} saving={dialog.saving} onClose={onClose} onDelete={dialog.deleteProviderAccount} onSave={dialog.saveConfig} />
      </section>
    </div>
  )
}

function useProviderAccountDialogState(
  account: ProviderAccountResponse | null,
  provider: ProviderDefinitionResponse | null,
  onAccountChange: (account: ProviderAccountResponse) => void,
  onAccountDelete: (accountId: string) => void,
  onReload: () => Promise<void>,
) {
  const [authenticating, setAuthenticating] = useState(false)
  const [authMenuOpen, setAuthMenuOpen] = useState(false)
  const [codexHome, setCodexHome] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<ChatComposerReasoningEffort>("medium")
  const [defaultServiceTier, setDefaultServiceTier] = useState<ChatComposerServiceTier>("standard")
  const [deleting, setDeleting] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [modelOptions, setModelOptions] = useState<ProviderModelListResponse["data"]>([])
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [personality, setPersonality] = useState<"friendly" | "pragmatic">("pragmatic")
  const [runtimeDefaultsJson, setRuntimeDefaultsJson] = useState("{}")
  const [saving, setSaving] = useState(false)
  const [settingsJson, setSettingsJson] = useState("{}")
  const hasDefaultModelField = Boolean(provider?.capabilities.includes("models") && provider.runtimeFields.some((field) => field.key === "model"))
  const hasDefaultReasoningField = Boolean(provider?.runtimeFields.some((field) => field.key === "reasoningEffort"))
  const hasDefaultServiceTierField = Boolean(provider?.runtimeFields.some((field) => field.key === "serviceTier"))
  const runtimeDefaultStructuredKeys = useMemo(
    () => [
      hasDefaultModelField ? "model" : null,
      hasDefaultReasoningField ? "reasoningEffort" : null,
      hasDefaultServiceTierField ? "serviceTier" : null,
    ].filter((key): key is string => Boolean(key)),
    [hasDefaultModelField, hasDefaultReasoningField, hasDefaultServiceTierField],
  )

  useEffect(() => {
    if (!account || !provider) {
      return
    }
    setAuthMenuOpen(false)
    setCodexHome(readCodexHomeValue(account, provider))
    setDefaultModel(readRecordString(account.runtimeDefaults, "model") || defaultRuntimeDefaultValue(provider.id, "model") || (defaultModelOptionsForProvider(provider.id)[0]?.model ?? ""))
    setDefaultReasoningEffort(readComposerReasoningEffort(readRecordString(account.runtimeDefaults, "reasoningEffort") || defaultRuntimeDefaultValue(provider.id, "reasoningEffort")))
    setDefaultServiceTier(readComposerServiceTier(readRecordString(account.runtimeDefaults, "serviceTier") || defaultRuntimeDefaultValue(provider.id, "serviceTier")))
    setDisplayName(account.displayName)
    setPersonality(readCodexPersonalityValue(account.settings))
    setRuntimeDefaultsJson(formatJson(withoutRecordKeys(account.runtimeDefaults, runtimeDefaultStructuredKeys)))
    setSettingsJson(formatJson(withoutRecordKeys(account.settings, ["codexHome", "personality"])))
    setNotice(null)
  }, [account, provider, runtimeDefaultStructuredKeys])

  useEffect(() => {
    let cancelled = false
    setModelOptions(defaultModelOptionsForProvider(provider?.id))
    if (!account || !hasDefaultModelField || account.status !== "CONNECTED") {
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
          setModelOptions(defaultModelOptionsForProvider(provider?.id))
        }
      })
    return () => {
      cancelled = true
    }
  }, [account?.id, account?.status, hasDefaultModelField, provider?.id])

  const usingSharedCodexHome = account ? readRecordString(account.authState, "codexHomeMode") === "shared" : false
  const defaultCodexHome = account && provider ? readDefaultCodexHomeValue(account, provider) : ""
  const sharedCodexHome = provider ? readSharedCodexHomeValue(provider) : ""

  function readConfigDraft() {
    if (!account || !provider) {
      throw new Error("No provider account selected.")
    }
    const settings = parseJsonRecord(settingsJson, "Settings") as ProviderAccountResponse["settings"]
    const runtimeDefaults = parseJsonRecord(runtimeDefaultsJson, "Runtime defaults") as ProviderAccountResponse["runtimeDefaults"]
    const codexHomePath = usingSharedCodexHome ? "" : codexHome.trim()
    if (codexHomePath === "~/.codex" || codexHomePath === sharedCodexHome) {
      throw new Error(`Use Local account to use ${sharedCodexHome}.`)
    }
    if (codexHomePath && codexHomePath !== defaultCodexHome) {
      settings.codexHome = codexHomePath
    } else {
      delete settings.codexHome
    }
    if (provider.id === "codex") {
      settings.personality = personality
    }
    if (hasDefaultModelField) {
      const nextDefaultModel = defaultModel || selectedDefaultModelOption?.model || defaultRuntimeDefaultValue(provider.id, "model")
      if (!nextDefaultModel) {
        throw new Error("Choose a default model.")
      }
      runtimeDefaults.model = nextDefaultModel
    }
    if (hasDefaultReasoningField) {
      runtimeDefaults.reasoningEffort = composerReasoningEffortValue(defaultReasoningEffort)
    }
    if (hasDefaultServiceTierField) {
      runtimeDefaults.serviceTier = composerServiceTierValue(defaultServiceTier)
    }
    return { displayName, runtimeDefaults, settings }
  }

  async function saveDraftConfig() {
    if (!account) {
      throw new Error("No provider account selected.")
    }
    const updated = await apiClient.providerAccounts.update(account.id, readConfigDraft())
    onAccountChange(updated)
    return updated
  }

  async function authenticate(mode: AccountAuthMode = "browser") {
    setAuthenticating(true)
    setAuthMenuOpen(false)
    setNotice(null)
    try {
      const updated = await saveDraftConfig()
      const response = await apiClient.providerAccounts.authenticate(updated.id, mode)
      if (response.authUrl) {
        window.open(response.authUrl, "_blank", "noopener,noreferrer")
      }
      const refreshed = await refreshAccount()
      if (response.status === "CONNECTED" || refreshed?.status === "CONNECTED") {
        setNotice({ kind: "info", text: response.message ?? "Connected" })
        await onReload()
        return
      }
      if (response.status === "ERROR") {
        setNotice({ kind: "error", text: response.message ?? "Authentication failed." })
        return
      }
      setNotice({ kind: "info", text: response.message ?? "Authentication started." })
      await pollConnectedAccount()
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setAuthenticating(false)
    }
  }

  async function refreshAccount() {
    if (!account) {
      await onReload()
      return null
    }
    const accounts = await apiClient.providerAccounts.list()
    const refreshed = accounts.find((entry) => entry.id === account.id) ?? null
    if (refreshed) {
      onAccountChange(refreshed)
    } else {
      await onReload()
    }
    return refreshed
  }

  async function pollConnectedAccount() {
    for (let index = 0; index < 60; index += 1) {
      await delay(1000)
      const refreshed = await refreshAccount()
      if (refreshed?.status === "CONNECTED") {
        setNotice({ kind: "info", text: "Connected" })
        await onReload()
        return
      }
      if (refreshed?.status === "ERROR") {
        setNotice({ kind: "error", text: refreshed.lastError ?? "Authentication failed." })
        return
      }
    }
  }

  async function saveConfig() {
    if (!account) {
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const updated = await apiClient.providerAccounts.update(account.id, {
        ...readConfigDraft(),
      })
      onAccountChange(updated)
      setNotice({ kind: "info", text: "Saved" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  async function deleteProviderAccount() {
    if (!account) {
      return
    }
    if (!window.confirm("Delete provider account?")) {
      return
    }
    setDeleting(true)
    setNotice(null)
    try {
      await apiClient.providerAccounts.delete(account.id)
      onAccountDelete(account.id)
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setDeleting(false)
    }
  }

  const connected = account?.status === "CONNECTED"
  const hasCodexHomeField = Boolean(provider?.accountFields.some((field) => field.key === "codexHome"))
  const visibleModelOptions = mergeProviderModelOptions(provider?.id, modelOptions).filter((option) => !option.hidden)
  const selectedDefaultModelOption = visibleModelOptions.find((option) => option.model === defaultModel || option.id === defaultModel) ?? visibleModelOptions[0] ?? null

  return {
    authenticating,
    authMenuOpen,
    authenticate,
    codexHome,
    connected,
    defaultModel,
    defaultReasoningEffort,
    defaultServiceTier,
    deleteProviderAccount,
    deleting,
    displayName,
    hasCodexHomeField,
    hasDefaultModelField,
    hasDefaultReasoningField,
    hasDefaultServiceTierField,
    modelOptions: visibleModelOptions,
    notice,
    personality,
    runtimeDefaultsJson,
    saveConfig,
    saving,
    setAuthMenuOpen,
    setCodexHome,
    setDefaultModel,
    setDefaultReasoningEffort,
    setDefaultServiceTier,
    setDisplayName,
    setPersonality,
    setRuntimeDefaultsJson,
    setSettingsJson,
    selectedDefaultModelOption,
    settingsJson,
    usingSharedCodexHome,
  }
}

type ProviderAccountDialogState = ReturnType<typeof useProviderAccountDialogState>

function ProviderAccountDialogHeader({
  account,
  provider,
  onClose,
}: {
  account: ProviderAccountResponse
  provider: ProviderDefinitionResponse
  onClose: () => void
}) {
  return (
    <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
      <ProviderGlyph icon={provider.icon} />
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{provider.label}</h2>
      <ProviderStatusBadge status={account.status} />
      <button
        aria-label="Close provider account"
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        type="button"
        onClick={onClose}
      >
        <X className="size-4" />
      </button>
    </header>
  )
}

function ProviderAccountDialogBody({
  account,
  dialog,
  provider,
}: {
  account: ProviderAccountResponse
  dialog: ProviderAccountDialogState
  provider: ProviderDefinitionResponse
}) {
  return (
    <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
      <ProviderAccountNotice notice={dialog.notice} />
      <div className="space-y-3">
        <ProviderAccountNameAuth dialog={dialog} />
        {provider.id === "codex" ? <ProviderPersonalityField dialog={dialog} /> : null}
        {dialog.hasCodexHomeField ? <ProviderCodexHomeField dialog={dialog} /> : null}
        {dialog.hasDefaultModelField || dialog.hasDefaultReasoningField || dialog.hasDefaultServiceTierField
          ? <ProviderRuntimeDefaultsField dialog={dialog} />
          : null}
        {account.status === "CONNECTED" ? <ProviderConfigEditors dialog={dialog} /> : null}
      </div>
    </div>
  )
}

function ProviderAccountNotice({ notice }: { notice: ProviderAccountDialogState["notice"] }) {
  if (!notice) {
    return null
  }
  return (
    <div
      className={cn(
        "mb-3 rounded-md border px-3 py-2 text-[12px]",
        notice.kind === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-info/20 bg-info/10 text-info",
      )}
    >
      {notice.text}
    </div>
  )
}

function ProviderAccountNameAuth({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Name</span>
        <input
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary"
          value={dialog.displayName}
          onChange={(event) => dialog.setDisplayName(event.target.value)}
        />
      </label>
      <ProviderAccountAuthMenu dialog={dialog} />
    </div>
  )
}

function ProviderAccountAuthMenu({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div className="relative">
      <button
        className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55"
        disabled={dialog.authenticating}
        type="button"
        onClick={() => dialog.setAuthMenuOpen((open) => !open)}
      >
        <ExternalLink className="size-3.5" />
        <span className="whitespace-nowrap">
          {dialog.connected ? "Re-authenticate" : dialog.authenticating ? "Authenticating" : "Authenticate"}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
      {dialog.authMenuOpen ? <ProviderAccountAuthOptions dialog={dialog} /> : null}
    </div>
  )
}

function ProviderAccountAuthOptions({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div className="absolute right-0 top-9 z-10 w-40 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-xl">
      <button
        className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12px] text-foreground hover:bg-accent"
        type="button"
        onClick={() => void dialog.authenticate("browser")}
      >
        <ExternalLink className="size-3.5 text-info" />
        Browser
      </button>
      <button
        className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12px] text-foreground hover:bg-accent"
        type="button"
        onClick={() => void dialog.authenticate("local")}
      >
        <HardDrive className="size-3.5 text-info" />
        Local account
      </button>
    </div>
  )
}

function ProviderPersonalityField({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Personality</span>
      <div className="inline-flex rounded-md border border-input bg-background p-0.5">
        {(["pragmatic", "friendly"] as const).map((option) => (
          <button
            className={cn(
              "h-7 rounded px-2.5 text-[12px] font-medium",
              dialog.personality === option
                ? "bg-primary/20 text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            key={option}
            type="button"
            onClick={() => dialog.setPersonality(option)}
          >
            {option === "pragmatic" ? "Pragmatic" : "Friendly"}
          </button>
        ))}
      </div>
    </div>
  )
}

function ProviderCodexHomeField({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Codex home</span>
      <input
        className="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary disabled:opacity-65"
        disabled={dialog.usingSharedCodexHome}
        value={dialog.codexHome}
        onChange={(event) => dialog.setCodexHome(event.target.value)}
      />
    </label>
  )
}

function ProviderRuntimeDefaultsField({ dialog }: { dialog: ProviderAccountDialogState }) {
  const hasExactDefaultModel = dialog.modelOptions.some((option) => option.model === dialog.defaultModel || option.id === dialog.defaultModel)
  const modelOptions = dialog.defaultModel && !hasExactDefaultModel
    ? [
        {
          id: dialog.defaultModel,
          model: dialog.defaultModel,
          displayName: dialog.defaultModel,
        },
        ...dialog.modelOptions,
      ]
    : dialog.modelOptions

  return (
    <div className="grid gap-2">
      <span className="block text-[11px] font-medium text-muted-foreground">Defaults</span>
      <div className="grid gap-2 sm:grid-cols-3">
        {dialog.hasDefaultModelField ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-[11px] text-muted-foreground">Model</span>
            <Select className="w-full min-w-0" value={dialog.defaultModel || (dialog.selectedDefaultModelOption?.model ?? "")} onValueChange={dialog.setDefaultModel}>
              <SelectTrigger aria-label="Default model" className="h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60">
                <span className="min-w-0 truncate">
                  {hasExactDefaultModel || !dialog.defaultModel
                    ? dialog.selectedDefaultModelOption?.displayName ?? dialog.defaultModel
                    : dialog.defaultModel}
                </span>
              </SelectTrigger>
              <SelectContent align="start" className="max-h-72 border-border bg-popover text-foreground">
                {modelOptions.map((option) => (
                  <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.id} value={option.model}>
                    {option.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {dialog.hasDefaultReasoningField ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-[11px] text-muted-foreground">Reasoning</span>
            <Select className="w-full min-w-0" value={dialog.defaultReasoningEffort} onValueChange={(value) => dialog.setDefaultReasoningEffort(readComposerReasoningEffort(value))}>
              <SelectTrigger aria-label="Default reasoning" className="h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60">
                <span className="min-w-0 truncate">{composerReasoningEffortLabel(dialog.defaultReasoningEffort)}</span>
              </SelectTrigger>
              <SelectContent align="start" className="border-border bg-popover text-foreground">
                {composerReasoningEffortOptions.map((option) => (
                  <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {dialog.hasDefaultServiceTierField ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-[11px] text-muted-foreground">Speed</span>
            <Select className="w-full min-w-0" value={dialog.defaultServiceTier} onValueChange={(value) => dialog.setDefaultServiceTier(readComposerServiceTier(value))}>
              <SelectTrigger aria-label="Default speed" className="h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60">
                <span className="min-w-0 truncate">{composerServiceTierLabel(dialog.defaultServiceTier)}</span>
              </SelectTrigger>
              <SelectContent align="start" className="border-border bg-popover text-foreground">
                {composerServiceTierOptions.map((option) => (
                  <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                    <span className="grid min-w-0">
                      <span className="truncate">{option.label}</span>
                      <span className="truncate text-[11px] font-normal text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
      </div>
    </div>
  )
}

function ProviderConfigEditors({ dialog }: { dialog: ProviderAccountDialogState }) {
  return (
    <div className="grid gap-3">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Settings</span>
        <textarea
          className="h-28 w-full resize-none rounded-md border border-input bg-background px-2 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
          spellCheck={false}
          value={dialog.settingsJson}
          onChange={(event) => dialog.setSettingsJson(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Runtime defaults</span>
        <textarea
          className="h-28 w-full resize-none rounded-md border border-input bg-background px-2 py-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
          spellCheck={false}
          value={dialog.runtimeDefaultsJson}
          onChange={(event) => dialog.setRuntimeDefaultsJson(event.target.value)}
        />
      </label>
    </div>
  )
}

function ProviderAccountDialogFooter({
  connected,
  deleting,
  saving,
  onClose,
  onDelete,
  onSave,
}: {
  connected: boolean
  deleting: boolean
  saving: boolean
  onClose: () => void
  onDelete: () => Promise<void>
  onSave: () => Promise<void>
}) {
  return (
    <footer className="flex h-11 items-center justify-between gap-2 border-t border-border px-3">
      <button
        className="h-8 rounded-md border border-destructive/30 px-3 text-[12px] font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-55"
        disabled={deleting}
        type="button"
        onClick={() => void onDelete()}
      >
        {deleting ? "Deleting" : "Delete"}
      </button>
      <div className="flex items-center justify-end gap-2">
        <button
          className="h-8 rounded-md border border-border px-3 text-[12px] font-medium text-foreground hover:bg-accent"
          type="button"
          onClick={onClose}
        >
          Close
        </button>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!connected || saving}
          type="button"
          onClick={() => void onSave()}
        >
          {saving ? "Saving" : "Save"}
        </button>
      </div>
    </footer>
  )
}


function FileEditorPane({
  content,
  contentLoaded,
  file,
  languageServers,
  openFiles,
  revealTarget,
  workspace,
  onFileClose,
  onContentChange,
  onFileSelect,
  onOpenDialog,
  onOpenLocation,
  onToggleMode,
}: {
  content: string
  contentLoaded: boolean
  file: FileNode
  languageServers: LanguageServerInfo[]
  openFiles: FileNode[]
  revealTarget: FileRevealTarget | null
  workspace: Workspace
  onFileClose: (id: string) => void
  onContentChange: (id: string, value: string) => void
  onFileSelect: (id: string, options?: FileSelectOptions) => void
  onOpenDialog: () => void
  onOpenLocation: (filePath: string, lineNumber: number, column: number) => Promise<boolean>
  onToggleMode: () => void
}) {
  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-10 min-w-0 items-stretch border-b border-border bg-secondary/40 text-[12px] font-medium text-muted-foreground">
        <div className="flex min-w-0 flex-1 overflow-x-auto ide-scrollbar">
          {openFiles.map((openFile) => {
            const active = openFile.id === file.id
            const path = findFilePath(workspace.fileTree, openFile.id)?.join(" / ") ?? openFile.name

            return (
              <div
                className={cn(
                  "group relative flex h-full min-w-32 max-w-48 shrink-0 items-center border-l border-border",
                  active ? "bg-accent text-foreground" : "bg-secondary/40 text-muted-foreground hover:bg-accent/50",
                )}
                key={openFile.id}
                title={path}
              >
                {active ? <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" /> : null}
                <button
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left"
                  type="button"
                  onClick={() => onFileSelect(openFile.id)}
                >
                  <FileGlyph icon={openFile.icon} />
                  <span className="min-w-0 truncate">{openFile.name}</span>
                </button>
                <button
                  aria-label={`Close ${openFile.name}`}
                  className={cn(
                    "mr-1 grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  type="button"
                  onClick={() => onFileClose(openFile.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-border px-2">
          <ModeToggleButton mode="editor" onClick={onToggleMode} />
        </div>
      </div>
      <FileViewer
        content={content}
        contentLoaded={contentLoaded}
        file={file}
        languageServers={languageServers}
        revealTarget={revealTarget}
        workspace={workspace}
        onOpenLocation={onOpenLocation}
        onContentChange={onContentChange}
        footerAction={
          <button
            aria-label="Open current file in dialog"
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Open current file in dialog"
            type="button"
            onClick={onOpenDialog}
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
        }
      />
    </section>
  )
}

function FileDialog({
  content,
  contentLoaded,
  file,
  languageServers,
  revealTarget,
  workspace,
  onClose,
  onContentChange,
  onOpenLocation,
  onOpenInMain,
}: {
  content: string
  contentLoaded: boolean
  file: FileNode
  languageServers: LanguageServerInfo[]
  revealTarget: FileRevealTarget | null
  workspace: Workspace
  onClose: () => void
  onContentChange: (id: string, value: string) => void
  onOpenLocation: (filePath: string, lineNumber: number, column: number) => Promise<boolean>
  onOpenInMain: () => void
}) {
  const path = findFilePath(workspace.fileTree, file.id)?.join(" / ") ?? file.name

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-6" role="dialog" aria-modal="true">
      <div className="grid h-[72vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex h-11 min-w-0 items-center gap-2 px-3 text-[12px] font-medium text-muted-foreground">
          <FileGlyph icon={file.icon} />
          <span className="min-w-0 truncate text-foreground">{path}</span>
          <button
            aria-label="Close file dialog"
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <FileViewer
          content={content}
          contentLoaded={contentLoaded}
          file={file}
          languageServers={languageServers}
          revealTarget={revealTarget}
          workspace={workspace}
          onOpenLocation={onOpenLocation}
          onContentChange={onContentChange}
          footerAction={
            <button
              aria-label="Collapse file to main editor"
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Collapse to main editor"
              type="button"
              onClick={onOpenInMain}
            >
              <Dock className="size-3.5" />
            </button>
          }
        />
      </div>
    </div>
  )
}

function FileViewer({
  content,
  contentLoaded,
  file,
  footerAction,
  languageServers,
  onOpenLocation,
  revealTarget,
  workspace,
  onContentChange,
}: {
  content: string
  contentLoaded: boolean
  file: FileNode
  footerAction?: ReactNode
  languageServers: LanguageServerInfo[]
  onOpenLocation?: (filePath: string, lineNumber: number, column: number) => boolean | Promise<boolean>
  revealTarget?: FileRevealTarget | null
  workspace: Workspace
  onContentChange: (id: string, value: string) => void
}) {
  const language = file.language ?? fileLanguage(file.name)
  const monacoLanguage = file.language ?? monacoLanguageFor(file.name)
  const lspLanguageId = file.path ? lspLanguageIdForPath(file.path, monacoLanguage) : monacoLanguage
  const lspServer = file.path ? selectLanguageServer(languageServers, file.path, lspLanguageId) : null
  const editorPath = file.path ? fileUriFromPath(file.path) : `${workspace.id}/${file.id.replace(/[:/]/g, "_")}/${file.name}`
  const lines = content.split("\n")
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const diskSnapshotRef = useRef({ content: "", fileId: "" })
  const [diagnosticCounts, setDiagnosticCounts] = useState({ errors: 0, warnings: 0 })
  const [lspEnabledFileIds, setLspEnabledFileIds] = useState<Set<string>>(new Set())
  const [lspStatus, setLspStatus] = useState<LspStatus>({ state: "idle" })
  const [monacoApi, setMonacoApi] = useState<MonacoApi | null>(null)
  const { resolvedTheme } = useTheme()
  const monacoThemeName = pockcodeMonacoThemeName(resolvedTheme)
  const snapshot = diskSnapshotRef.current
  const lspEnabled = lspEnabledFileIds.has(file.id)
  const lspStale = contentLoaded && snapshot.fileId === file.id && snapshot.content !== content

  const revealLine = useCallback((target: FileRevealTarget) => {
    const editor = editorRef.current
    if (!editor || target.fileId !== file.id) {
      return
    }
    const lineCount = editor.getModel()?.getLineCount() ?? lines.length
    const lineNumber = clamp(target.lineNumber ?? 1, 1, Math.max(1, lineCount))
    const column = clamp(target.column ?? 1, 1, editor.getModel()?.getLineMaxColumn(lineNumber) ?? 1)
    editor.setPosition({ lineNumber, column })
    editor.revealLineInCenter(lineNumber)
    editor.focus()
  }, [file.id, lines.length])

  useEffect(() => {
    if (!revealTarget) {
      return
    }
    const frame = window.requestAnimationFrame(() => revealLine(revealTarget))
    return () => window.cancelAnimationFrame(frame)
  }, [revealLine, revealTarget?.nonce])

  useEffect(() => {
    if (!contentLoaded) {
      return
    }
    diskSnapshotRef.current = { content, fileId: file.id }
    setDiagnosticCounts({ errors: 0, warnings: 0 })
    setLspStatus({ state: "idle" })
  }, [contentLoaded, file.id, file.path])

  useEffect(() => {
    const editor = editorRef.current
    if (!lspEnabled) {
      setDiagnosticCounts({ errors: 0, warnings: 0 })
      setLspStatus({ state: "idle" })
      return
    }
    if (!editor || !monacoApi || !file.path || !contentLoaded) {
      return
    }
    if (!lspServer) {
      setLspStatus({
        state: languageServers.length ? "unavailable" : "idle",
        detail: languageServers.length ? "No language server" : undefined,
      })
      return
    }

    return attachMonacoLsp({
      content: diskSnapshotRef.current.fileId === file.id ? diskSnapshotRef.current.content : content,
      editor,
      filePath: file.path,
      languageId: lspLanguageId,
      monaco: monacoApi,
      server: lspServer,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      onDiagnostics: (diagnostics) => {
        setDiagnosticCounts({
          errors: diagnostics.filter((diagnostic) => diagnostic.severity === 1).length,
          warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 2).length,
        })
      },
      onOpenLocation,
      onStatus: setLspStatus,
    })
  }, [
    contentLoaded,
    file.id,
    file.path,
    languageServers.length,
    lspEnabled,
    lspLanguageId,
    lspServer,
    monacoApi,
    onOpenLocation,
    workspace.name,
    workspace.path,
  ])

  useEffect(() => {
    if (!monacoApi) {
      return
    }
    monacoApi.editor.setTheme(definePockcodeMonacoTheme(monacoApi, resolvedTheme))
  }, [monacoApi, resolvedTheme])

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-card">
      <div className="min-h-0 overflow-hidden">
        <Editor
          height="100%"
          language={monacoLanguage}
          path={editorPath}
          theme={monacoThemeName}
          value={content}
          beforeMount={(monaco) => {
            configureMonacoLanguageDefaults(monaco)
            definePockcodeMonacoTheme(monaco, resolvedTheme)
          }}
          onChange={(value) => onContentChange(file.id, value ?? "")}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            setMonacoApi(monaco)
            if (revealTarget) {
              window.requestAnimationFrame(() => revealLine(revealTarget))
            }
          }}
          options={{
            automaticLayout: true,
            bracketPairColorization: { enabled: true },
            contextmenu: true,
            cursorBlinking: "smooth",
            fixedOverflowWidgets: true,
            fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: 12,
            guides: { bracketPairs: true, indentation: true },
            lineHeight: 20,
            minimap: { enabled: false },
            overviewRulerBorder: false,
            padding: { bottom: 12, top: 12 },
            renderLineHighlight: "all",
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            tabSize: 2,
            wordWrap: "off",
          }}
        />
      </div>
      <div className="flex h-8 items-center gap-2 border-t border-border px-3 text-[11px] font-medium text-muted-foreground">
        <span>{language}</span>
        <span className="h-3 w-px bg-border" />
        <span>{lines.length} lines</span>
        <span className="h-3 w-px bg-border" />
        <LspFooterToggle
          diagnostics={diagnosticCounts}
          enabled={lspEnabled}
          server={lspServer}
          stale={lspStale}
          status={lspStatus}
          onToggle={() =>
            setLspEnabledFileIds((current) => {
              const next = new Set(current)
              if (next.has(file.id)) {
                next.delete(file.id)
              } else {
                next.add(file.id)
              }
              return next
            })
          }
        />
        {footerAction ? <div className="ml-auto">{footerAction}</div> : null}
      </div>
    </div>
  )
}

function lspEnableTitle(server: LanguageServerInfo | null): string {
  return server ? `Start ${server.displayName} language server` : "No language server is available for this file."
}

function LspFooterToggle({
  diagnostics,
  enabled,
  server,
  stale,
  status,
  onToggle,
}: {
  diagnostics: { errors: number; warnings: number }
  enabled: boolean
  server: LanguageServerInfo | null
  stale: boolean
  status: LspStatus
  onToggle: () => void
}) {
  const disabled = !server && !enabled
  const label = enabled ? lspFooterLabel(status, stale, diagnostics) : server ? "LSP off" : "LSP unavailable"

  return (
    <button
      aria-checked={enabled}
      aria-label="Toggle LSP"
      className="flex h-6 items-center gap-1.5 rounded px-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-55"
      disabled={disabled}
      role="switch"
      title={enabled ? lspStatusTitle(status, server) : lspEnableTitle(server)}
      type="button"
      onClick={onToggle}
    >
      <span
        className={cn(
          "relative h-3.5 w-6 rounded-full border transition-colors",
          enabled ? "border-primary bg-primary/60" : "border-border bg-secondary",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full transition-transform",
            enabled ? "translate-x-3 bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground",
          )}
        />
      </span>
      <span>{label}</span>
    </button>
  )
}

function lspFooterLabel(
  status: LspStatus,
  stale: boolean,
  diagnostics: { errors: number; warnings: number },
): string {
  if (stale && status.state === "ready") {
    return "LSP stale"
  }
  if (status.state === "ready") {
    if (diagnostics.errors || diagnostics.warnings) {
      return `${diagnostics.errors} errors, ${diagnostics.warnings} warnings`
    }
    return "LSP ready"
  }
  if (status.state === "starting") {
    return "LSP starting"
  }
  if (status.state === "unavailable") {
    return "LSP unavailable"
  }
  if (status.state === "error") {
    return "LSP stopped"
  }
  return "LSP idle"
}

function configureMonacoLanguageDefaults(monaco: MonacoApi): void {
  const typescriptLanguage = monaco.languages.typescript as unknown as {
    javascriptDefaults?: { setDiagnosticsOptions: (options: { noSemanticValidation: boolean; noSyntaxValidation: boolean }) => void }
    typescriptDefaults?: { setDiagnosticsOptions: (options: { noSemanticValidation: boolean; noSyntaxValidation: boolean }) => void }
  }
  typescriptLanguage.typescriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })
  typescriptLanguage.javascriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })
}

function lspStatusTitle(status: LspStatus, server: LanguageServerInfo | null): string {
  if (status.detail) {
    return status.detail
  }
  if (server) {
    return `${server.displayName}: ${server.command}`
  }
  return "No language server is attached to this file."
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

function RightPanel({
  activeTab,
  expandedFolderIds,
  loadingFolderIds,
  selectedFileId,
  treeId,
  workspace,
  onFileSelect,
  onFolderToggle,
  onTabChange,
}: {
  activeTab: PanelTab
  expandedFolderIds: Set<string>
  loadingFolderIds: Set<string>
  selectedFileId: string
  treeId: string
  workspace: Workspace
  onFileSelect: (id: string) => void
  onFolderToggle: (id: string) => void
  onTabChange: (tab: PanelTab) => void
}) {
  const gitPanel = useGitPanelState(workspace.path)

  return (
    <aside className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-10 items-center gap-3 px-3">
        <div className="flex gap-1 text-[12px] font-semibold">
          <button
            className={cn("rounded-md px-1.5 py-0.5", activeTab === "files" ? "bg-accent text-foreground" : "text-muted-foreground")}
            type="button"
            onClick={() => onTabChange("files")}
          >
            Files
          </button>
          <button
            className={cn("rounded-md px-1.5 py-0.5", activeTab === "git" ? "bg-accent text-foreground" : "text-muted-foreground")}
            type="button"
            onClick={() => onTabChange("git")}
          >
            Git
          </button>
        </div>
        <div className="ml-auto flex items-center gap-1 text-muted-foreground">
          {activeTab === "files" ? (
            <>
              <PanelActionButton label="Refresh files">
                <RefreshCw className="size-4" />
              </PanelActionButton>
              <PanelActionButton label="Search files">
                <Search className="size-4" />
              </PanelActionButton>
              <PanelActionButton label="Filter files">
                <ListFilter className="size-4" />
              </PanelActionButton>
            </>
          ) : activeTab === "git" ? (
            <>
              <PanelActionButton
                disabled={!gitPanel.canUseRepository || gitPanel.isBusy}
                label="Pull"
                onClick={() => void gitPanel.pull()}
              >
                <ArrowDownToLine className="size-4" />
              </PanelActionButton>
              <PanelActionButton
                disabled={!gitPanel.canUseRepository || gitPanel.isBusy}
                label="Push"
                onClick={() => void gitPanel.push()}
              >
                <ArrowUpFromLine className="size-4" />
              </PanelActionButton>
              <PanelActionButton
                disabled={gitPanel.isBusy}
                label="Refresh source control"
                onClick={() => void gitPanel.refresh()}
              >
                <RefreshCw className={cn("size-4", gitPanel.isLoading && "animate-spin")} />
              </PanelActionButton>
            </>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 overflow-auto px-1.5 pb-3 pt-1 ide-scrollbar">
        {activeTab === "files" ? (
          <FileTreeView
            expandedFolderIds={expandedFolderIds}
            loadingFolderIds={loadingFolderIds}
            nodes={workspace.fileTree}
            selectedFileId={selectedFileId}
            treeId={treeId}
            onFileSelect={onFileSelect}
            onFolderToggle={onFolderToggle}
          />
        ) : (
          <GitPanelSummary gitPanel={gitPanel} workspace={workspace} />
        )}
      </div>
    </aside>
  )
}

function PanelActionButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick?: () => void
}) {
  return (
    <button
      aria-label={label}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function FileTreeView({
  expandedFolderIds,
  loadingFolderIds,
  nodes,
  selectedFileId,
  treeId,
  onFileSelect,
  onFolderToggle,
}: {
  expandedFolderIds: Set<string>
  loadingFolderIds: Set<string>
  nodes: FileNode[]
  selectedFileId: string
  treeId: string
  onFileSelect: (id: string) => void
  onFolderToggle: (id: string) => void
}) {
  const visibleItems = useMemo(
    () => flattenVisibleTree(nodes, expandedFolderIds),
    [expandedFolderIds, nodes],
  )
  const selectedIsVisible = visibleItems.some((item) => item.node.id === selectedFileId)
  const [focusedId, setFocusedId] = useState(selectedIsVisible ? selectedFileId : visibleItems[0]?.node.id)
  const activeFocusId = visibleItems.some((item) => item.node.id === focusedId)
    ? focusedId
    : selectedIsVisible
      ? selectedFileId
      : visibleItems[0]?.node.id

  const focusTreeItem = (id: string | undefined) => {
    if (!id) {
      return
    }
    setFocusedId(id)
    window.requestAnimationFrame(() => {
      document.getElementById(treeItemElementId(treeId, id))?.focus()
    })
  }

  const activateNode = (node: FileNode) => {
    if (node.type === "file") {
      onFileSelect(node.id)
      return
    }
    onFolderToggle(node.id)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, item: VisibleTreeItem) => {
    const currentIndex = visibleItems.findIndex((visibleItem) => visibleItem.node.id === item.node.id)
    const hasChildren = item.node.type === "folder" && (item.node.children === undefined || item.node.children.length > 0)
    const expanded = item.node.type === "folder" && expandedFolderIds.has(item.node.id)

    if (event.key === "ArrowDown") {
      event.preventDefault()
      focusTreeItem(visibleItems[Math.min(currentIndex + 1, visibleItems.length - 1)]?.node.id)
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      focusTreeItem(visibleItems[Math.max(currentIndex - 1, 0)]?.node.id)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focusTreeItem(visibleItems[0]?.node.id)
      return
    }

    if (event.key === "End") {
      event.preventDefault()
      focusTreeItem(visibleItems[visibleItems.length - 1]?.node.id)
      return
    }

    if (event.key === "ArrowRight" && item.node.type === "folder") {
      event.preventDefault()
      if (!hasChildren) {
        return
      }
      if (!expanded) {
        onFolderToggle(item.node.id)
        return
      }
      focusTreeItem(item.node.children?.[0]?.id)
      return
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault()
      if (item.node.type === "folder" && expanded) {
        onFolderToggle(item.node.id)
        return
      }
      focusTreeItem(item.parentId)
      return
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      activateNode(item.node)
    }
  }

  return (
    <div aria-label="Workspace files" role="tree">
      {visibleItems.map((item) => {
        const node = item.node
        const hasChildren = node.type === "folder" && (node.children === undefined || node.children.length > 0)
        const expanded = node.type === "folder" && expandedFolderIds.has(node.id)
        const loading = node.type === "folder" && loadingFolderIds.has(node.id)
        const selected = node.id === selectedFileId

        return (
          <div
            aria-busy={loading || undefined}
            aria-expanded={node.type === "folder" && hasChildren ? expanded : undefined}
            aria-level={item.level}
            aria-selected={selected}
            className={cn(
              "flex h-[26px] w-full min-w-0 cursor-default items-center gap-1.5 rounded-sm px-2 text-left text-[13px] font-medium text-foreground outline-none hover:bg-accent focus-visible:bg-accent",
              selected && "bg-accent text-foreground hover:bg-accent focus-visible:bg-accent",
            )}
            id={treeItemElementId(treeId, node.id)}
            key={node.id}
            role="treeitem"
            style={{ paddingLeft: 8 + (item.level - 1) * 14 }}
            tabIndex={node.id === activeFocusId ? 0 : -1}
            title={node.name}
            onClick={() => activateNode(node)}
            onFocus={() => setFocusedId(node.id)}
            onKeyDown={(event) => handleKeyDown(event, item)}
          >
            {node.type === "folder" ? (
              loading ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin text-info" />
              ) : hasChildren && expanded ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground", !hasChildren && "opacity-35")} />
              )
            ) : (
              <FileGlyph icon={node.icon} />
            )}
            <span className="min-w-0 truncate">{node.name}</span>
          </div>
        )
      })}
    </div>
  )
}

function FileGlyph({ icon }: { icon?: FileNode["icon"] }) {
  const className = "size-4 shrink-0"
  if (icon === "shell") return <span className="w-4 shrink-0 text-center text-sm font-bold text-success">$</span>
  if (icon === "js") return <span className="w-4 shrink-0 text-center text-[11px] font-bold text-ide-file-yellow">JS</span>
  if (icon === "json") return <span className="w-4 shrink-0 text-center text-sm font-bold text-ide-file-yellow">{"{}"}</span>
  if (icon === "make") return <span className="w-4 shrink-0 text-center text-sm font-bold text-warning">M</span>
  if (icon === "docker") return <HardDrive className={cn(className, "text-muted-foreground")} />
  if (icon === "info") return <span className="w-4 shrink-0 text-center text-sm text-ide-file-blue">i</span>
  return <FileText className={cn(className, "text-muted-foreground")} />
}

type GitPanelState = ReturnType<typeof useGitPanelState>

function useGitPanelState(workspacePath: string) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [status, setStatus] = useState<GitStatusResponse | null>(null)

  const refresh = useCallback(async () => {
    setBusyAction((current) => current ?? "refresh")
    setNotice(null)
    try {
      setStatus(await apiClient.git.status(workspacePath))
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setBusyAction((current) => current === "refresh" ? null : current)
    }
  }, [workspacePath])

  useEffect(() => {
    setStatus(null)
    void refresh()
  }, [refresh])

  const runAction = useCallback(async (
    action: string,
    request: () => Promise<GitStatusResponse>,
    success: string,
  ) => {
    setBusyAction(action)
    setNotice(null)
    try {
      setStatus(await request())
      setNotice({ kind: "info", text: success })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setBusyAction(null)
    }
  }, [])

  return {
    busyAction,
    canUseRepository: Boolean(status?.isRepository),
    init: () => runAction("init", () => apiClient.git.init(workspacePath), "Repository initialized."),
    isBusy: Boolean(busyAction),
    isLoading: busyAction === "refresh" && !status,
    notice,
    refresh,
    stage: (paths: string[]) => runAction("stage", () => apiClient.git.stage(workspacePath, paths), "Changes staged."),
    status,
    unstage: (paths: string[]) => runAction("unstage", () => apiClient.git.unstage(workspacePath, paths), "Changes unstaged."),
    discard: (paths: string[]) => runAction("discard", () => apiClient.git.discard(workspacePath, paths), "Changes discarded."),
    commit: (message: string) => runAction("commit", () => apiClient.git.commit(workspacePath, message), "Commit created."),
    pull: () => runAction("pull", () => apiClient.git.pull(workspacePath), "Pulled latest changes."),
    push: () => runAction("push", () => apiClient.git.push(workspacePath), "Pushed local commits."),
  }
}

function GitPanelSummary({ gitPanel, workspace }: { gitPanel: GitPanelState; workspace: Workspace }) {
  const [commitMessage, setCommitMessage] = useState("")
  const status = gitPanel.status
  const changes = status?.changes ?? []
  const stagedChanges = changes.filter((change) => change.staged)
  const unstagedChanges = changes.filter((change) => !change.staged)
  const canCommit = Boolean(commitMessage.trim() && stagedChanges.length && !gitPanel.isBusy)

  if (!status) {
    return (
      <div className="grid h-40 place-items-center text-[12px] text-muted-foreground">
        Loading source control
      </div>
    )
  }

  if (!status.isRepository) {
    return (
      <div className="grid gap-3 px-3 py-4 text-[13px] text-muted-foreground">
        <div className="flex items-center gap-2 text-foreground">
          <GitBranch className="size-4 text-muted-foreground" />
          <span className="min-w-0 truncate">{workspace.name}</span>
        </div>
        <p className="text-[12px] leading-5 text-muted-foreground">
          This workspace is not initialized as a Git repository.
        </p>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={gitPanel.isBusy}
          type="button"
          onClick={() => void gitPanel.init()}
        >
          Initialize Repository
        </button>
        {gitPanel.notice ? <GitNotice notice={gitPanel.notice} /> : null}
      </div>
    )
  }

  return (
    <div className="grid gap-3 text-[13px] text-muted-foreground">
      <div className="grid gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-2 px-1.5 text-foreground">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{status.branch || workspace.branch}</span>
          {status.ahead || status.behind ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {status.ahead ? `↑${status.ahead}` : ""}{status.behind ? ` ↓${status.behind}` : ""}
            </span>
          ) : null}
        </div>
        <input
          className="h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="Message (Ctrl+Enter to commit)"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canCommit) {
              void gitPanel.commit(commitMessage).then(() => setCommitMessage(""))
            }
          }}
        />
        <button
          className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!canCommit}
          type="button"
          onClick={() => void gitPanel.commit(commitMessage).then(() => setCommitMessage(""))}
        >
          <Check className="size-4" />
          Commit
        </button>
        {gitPanel.notice ? <GitNotice notice={gitPanel.notice} /> : null}
      </div>

      {changes.length ? (
        <>
          <GitChangeGroup
            actionLabel="Unstage all"
            changes={stagedChanges}
            count={stagedChanges.length}
            title="Staged Changes"
            onAction={() => void gitPanel.unstage(stagedChanges.map((change) => change.path))}
            onDiscardAll={() => void gitPanel.discard(stagedChanges.map((change) => change.path))}
            onDiscard={(path) => void gitPanel.discard([path])}
            onToggle={(path) => void gitPanel.unstage([path])}
          />
          <GitChangeGroup
            actionLabel="Stage all"
            changes={unstagedChanges}
            count={unstagedChanges.length}
            title="Changes"
            onAction={() => void gitPanel.stage(unstagedChanges.map((change) => change.path))}
            onDiscardAll={() => void gitPanel.discard(unstagedChanges.map((change) => change.path))}
            onDiscard={(path) => void gitPanel.discard([path])}
            onToggle={(path) => void gitPanel.stage([path])}
          />
        </>
      ) : (
        <div className="px-3 py-2 text-[12px] text-muted-foreground">No changes</div>
      )}

      {status.commits.length ? (
        <GitGraph status={status} />
      ) : null}
    </div>
  )
}

function GitNotice({ notice }: { notice: { kind: "error" | "info"; text: string } }) {
  return (
    <div className={cn("truncate rounded-md px-2 py-1 text-[11px]", notice.kind === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")} title={notice.text}>
      {notice.text}
    </div>
  )
}

function GitChangeGroup({
  actionLabel,
  changes,
  count,
  title,
  onAction,
  onDiscardAll,
  onDiscard,
  onToggle,
}: {
  actionLabel: string
  changes: GitFileChange[]
  count: number
  title: string
  onAction: () => void
  onDiscardAll: () => void
  onDiscard: (path: string) => void
  onToggle: (path: string) => void
}) {
  if (!count) {
    return null
  }

  return (
    <section>
      <div className="group flex h-7 min-w-0 items-center gap-1 px-1.5 text-[12px] font-semibold text-muted-foreground">
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
        <span className="grid min-w-5 place-items-center rounded-full bg-secondary px-1 text-[10px] leading-5 text-secondary-foreground">{count}</span>
        <button
          aria-label={actionLabel}
          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-accent-foreground group-hover:opacity-100"
          title={actionLabel}
          type="button"
          onClick={onAction}
        >
          {actionLabel.startsWith("Unstage") ? <Minus className="size-4" /> : <Plus className="size-4" />}
        </button>
        <button
          aria-label={`Discard all ${title.toLowerCase()}`}
          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive group-hover:opacity-100"
          title={`Discard all ${title.toLowerCase()}`}
          type="button"
          onClick={onDiscardAll}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div>
        {changes.map((change) => (
          <GitChangeRow
            change={change}
            key={`${change.staged}:${change.path}:${change.indexStatus}:${change.workingTreeStatus}`}
            onDiscard={() => onDiscard(change.path)}
            onToggle={() => onToggle(change.path)}
          />
        ))}
      </div>
    </section>
  )
}

function GitChangeRow({
  change,
  onDiscard,
  onToggle,
}: {
  change: GitFileChange
  onDiscard: () => void
  onToggle: () => void
}) {
  return (
    <div
      className="group flex h-[26px] min-w-0 items-center gap-2 rounded-sm px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title={change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path}
    >
      <span className={cn("w-4 shrink-0 text-center font-mono text-[13px]", gitStatusColor(change.status))}>
        {gitStatusLabel(change.status)}
      </span>
      <span className="min-w-0 flex-1 truncate">{change.path}</span>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          aria-label={change.staged ? "Unstage change" : "Stage change"}
          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
          type="button"
          onClick={onToggle}
        >
          {change.staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        </button>
        <button
          aria-label="Discard change"
          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
          type="button"
          onClick={onDiscard}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function GitGraph({ status }: { status: GitStatusResponse }) {
  return (
    <section className="border-t border-border pt-2">
      <div className="flex h-7 items-center gap-2 px-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        <ChevronDown className="size-4" />
        <span className="min-w-0 flex-1 truncate">Graph</span>
        <GitBranch className="size-3.5" />
        <span className="truncate normal-case tracking-normal">{status.branch}</span>
      </div>
      <div>
        {status.commits.map((commit, index) => (
          <div className="grid h-7 min-w-0 grid-cols-[24px_minmax(0,1fr)] items-center gap-1 px-1.5 text-[12px]" key={`${commit.hash}:${index}`}>
            <span className="relative grid h-full place-items-center">
              <span className="absolute bottom-0 top-0 left-1/2 w-px -translate-x-1/2 bg-border" />
              <span className="relative size-2 rounded-full border border-border bg-background" />
            </span>
            <span className="min-w-0 truncate text-muted-foreground">
              {commit.subject}
              {commit.refs ? <span className="ml-1 text-muted-foreground">{commit.refs}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function gitStatusLabel(status: GitFileChange["status"]) {
  const labels: Record<GitFileChange["status"], string> = {
    added: "A",
    deleted: "D",
    modified: "M",
    renamed: "R",
    untracked: "U",
  }
  return labels[status]
}

function upsertSchedule(schedules: MessageScheduleResponse[], schedule: MessageScheduleResponse): MessageScheduleResponse[] {
  const next = schedules.some((entry) => entry.id === schedule.id)
    ? schedules.map((entry) => (entry.id === schedule.id ? schedule : entry))
    : [schedule, ...schedules]
  return next.sort(compareSchedules)
}

function upsertScheduleRun(runs: MessageScheduleRunResponse[], run: MessageScheduleRunResponse): MessageScheduleRunResponse[] {
  const next = runs.some((entry) => entry.id === run.id)
    ? runs.map((entry) => (entry.id === run.id ? run : entry))
    : [run, ...runs]
  return next.sort((left, right) => Date.parse(right.scheduledFor) - Date.parse(left.scheduledFor))
}

function compareSchedules(left: MessageScheduleResponse, right: MessageScheduleResponse): number {
  const leftNext = left.nextRunAt ? Date.parse(left.nextRunAt) : Number.POSITIVE_INFINITY
  const rightNext = right.nextRunAt ? Date.parse(right.nextRunAt) : Number.POSITIVE_INFINITY
  return leftNext - rightNext || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

function chatMatchesSearch(chat: ChatResponse, query: string, providerLabel?: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) {
    return true
  }
  return [
    chat.title,
    chat.providerId,
    providerLabel ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(normalized))
}

function scheduleDraftFrom(schedule: MessageScheduleResponse): ScheduleDraft {
  return {
    accountId: schedule.accountId ?? "",
    active: schedule.status === "ACTIVE",
    collaborationMode: schedule.collaborationMode === "plan" ? "plan" : "default",
    endAt: schedule.recurrence.endAt ? localDateTimeInputValue(schedule.recurrence.endAt) : "",
    firstRunAt: localDateTimeInputValue(schedule.nextRunAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()),
    interval: String(schedule.recurrence.interval || 1),
    maxRuns: schedule.recurrence.maxRuns ? String(schedule.recurrence.maxRuns) : "",
    message: schedule.message,
    model: schedule.model ?? "",
    permissionMode: readComposerAccessMode(schedule.permissionMode),
    reasoningEffort: readComposerReasoningEffort(schedule.reasoningEffort),
    recurrenceFrequency: schedule.recurrence.frequency,
    serviceTier: readComposerServiceTier(schedule.serviceTier),
    title: schedule.title,
  }
}

function recurrenceLabel(recurrence: MessageScheduleRecurrence): string {
  if (recurrence.frequency === "none") {
    return "One time"
  }
  const unit = recurrence.frequency === "daily"
    ? "day"
    : recurrence.frequency === "weekly"
      ? "week"
      : "month"
  return recurrence.interval > 1 ? `Every ${recurrence.interval} ${unit}s` : `Every ${unit}`
}

function recurrenceFrequencyLabel(frequency: MessageScheduleRecurrence["frequency"]): string {
  if (frequency === "daily") return "Daily"
  if (frequency === "weekly") return "Weekly"
  if (frequency === "monthly") return "Monthly"
  return "One time"
}

function readRecurrenceFrequency(value: string): MessageScheduleRecurrence["frequency"] {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : "none"
}

function dateTimeLabel(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return ""
  }
  return date.toLocaleString([], {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  })
}

function localDateTimeInputValue(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return ""
  }
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function isoFromLocalDateTimeInput(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return new Date().toISOString()
  }
  return date.toISOString()
}

function scheduleRunStatusClass(status: MessageScheduleRunStatus): string {
  if (status === "COMPLETED") return "bg-success/10 text-success"
  if (status === "FAILED" || status === "CANCELLED") return "bg-destructive/10 text-destructive"
  if (status === "RUNNING") return "bg-info/15 text-info"
  return "bg-warning/10 text-warning"
}

function readMessageScheduleResponse(value: unknown): MessageScheduleResponse | null {
  const record = readRecord(value)
  const id = readRecordString(record, "id")
  const status = readMessageScheduleStatus(record.status)
  if (!id || !status || typeof record.message !== "string" || !readRecordString(record, "workingDirectory")) {
    return null
  }
  return record as MessageScheduleResponse
}

function readMessageScheduleRunResponse(value: unknown): MessageScheduleRunResponse | null {
  const record = readRecord(value)
  const id = readRecordString(record, "id")
  const scheduleId = readRecordString(record, "scheduleId")
  const status = readMessageScheduleRunStatus(record.status)
  if (!id || !scheduleId || !status || !readRecordString(record, "scheduledFor")) {
    return null
  }
  return record as MessageScheduleRunResponse
}

function readMessageScheduleStatus(value: unknown): MessageScheduleStatus | null {
  return value === "ACTIVE" || value === "PAUSED" || value === "COMPLETED" || value === "ARCHIVED" ? value : null
}

function readMessageScheduleRunStatus(value: unknown): MessageScheduleRunStatus | null {
  return value === "QUEUED" || value === "RUNNING" || value === "COMPLETED" || value === "FAILED" || value === "CANCELLED"
    ? value
    : null
}

function gitStatusColor(status: GitFileChange["status"]) {
  if (status === "added" || status === "untracked") return "text-diff-addition-foreground"
  if (status === "deleted") return "text-diff-deletion-foreground"
  if (status === "renamed") return "text-info"
  return "text-warning"
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
    max: maxTerminalHeight(),
    min: MIN_TERMINAL_HEIGHT,
    onResize: options.onResize,
    origin: "top",
  })
}

function maxTerminalHeight() {
  if (typeof window === "undefined") {
    return MAX_TERMINAL_HEIGHT
  }
  return Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight - 180))
}

function appendTerminalOutput(
  outputByTerminalId: Record<string, string>,
  terminalId: string,
  data: string,
): Record<string, string> {
  const output = (outputByTerminalId[terminalId] ?? "") + data
  return {
    ...outputByTerminalId,
    [terminalId]: output.length > TERMINAL_OUTPUT_LIMIT ? output.slice(-TERMINAL_OUTPUT_LIMIT) : output,
  }
}

function readTerminalCreateResponse(value: unknown): TerminalCreateResponse {
  const record = readRecord(value)
  if (record.ok === true) {
    const terminal = readTerminalSocketMetadata(record.terminal)
    if (terminal) {
      return { ok: true, terminal }
    }
  }
  return {
    error: readRecordString(record, "error") || "Unable to start terminal.",
    ok: false,
  }
}

function readTerminalSocketMetadata(value: unknown): TerminalSocketMetadata | null {
  const record = readRecord(value)
  const cwd = readRecordString(record, "cwd")
  const id = readRecordString(record, "id")
  const name = readRecordString(record, "name")
  const shell = readRecordString(record, "shell")
  return cwd && id && name && shell ? { cwd, id, name, shell } : null
}

function readRecordNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const recordValue = (value as Record<string, unknown>)[key]
  return typeof recordValue === "number" && Number.isFinite(recordValue) ? recordValue : null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
