import { useCallback, useEffect, useRef, useState } from "react"
import { io } from "socket.io-client"
import type { HostedTerminalSession, HostedTerminalStatus, TerminalConnectionState } from "@/components/session/terminal-panel"
import { omitRecordKey, readRecord, readRecordString, samePath } from "@/lib/session"
import type { Workspace } from "@/types/session"

export const DEFAULT_TERMINAL_HEIGHT = 290
export const MIN_TERMINAL_HEIGHT = 160
export const MAX_TERMINAL_HEIGHT = 560

const TERMINAL_OUTPUT_LIMIT = 260_000

export function useWorkspaceTerminals(activeWorkspace: Workspace | null) {
  const [activeTerminalIdByWorkspacePath, setActiveTerminalIdByWorkspacePath] = useState<Record<string, string>>({})
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("offline")
  const [error, setError] = useState<string | null>(null)
  const [isWorkspaceLoaded, setIsWorkspaceLoaded] = useState(false)
  const [outputByTerminalId, setOutputByTerminalId] = useState<Record<string, string>>({})
  const [terminals, setTerminals] = useState<HostedTerminalSession[]>([])
  const activeWorkspacePathRef = useRef<string | null>(activeWorkspace?.path ?? null)
  const lastSizeRef = useRef({ cols: 80, rows: 24 })
  const pendingCreateRef = useRef(false)
  const socketRef = useRef<ReturnType<typeof io> | null>(null)

  const activeWorkspacePath = activeWorkspace?.path ?? null
  const activeTerminalId = activeWorkspacePath ? activeTerminalIdByWorkspacePath[activeWorkspacePath] ?? null : null

  useEffect(() => {
    activeWorkspacePathRef.current = activeWorkspacePath
  }, [activeWorkspacePath])

  const appendOutput = useCallback((terminalId: string, data: string) => {
    setOutputByTerminalId((current) => {
      const output = (current[terminalId] ?? "") + data
      return {
        ...current,
        [terminalId]: output.length > TERMINAL_OUTPUT_LIMIT ? output.slice(-TERMINAL_OUTPUT_LIMIT) : output,
      }
    })
  }, [])

  const isActiveWorkspaceEvent = useCallback((workspacePath: string) => (
    Boolean(activeWorkspacePathRef.current && workspacePath && samePath(activeWorkspacePathRef.current, workspacePath))
  ), [])

  const removeTerminal = useCallback((terminalId: string, workspacePath: string) => {
    const activePath = activeWorkspacePathRef.current
    if (!activePath || !samePath(activePath, workspacePath)) {
      return
    }

    setTerminals((current) => {
      const closedIndex = current.findIndex((terminal) => terminal.id === terminalId)
      const next = current.filter((terminal) => terminal.id !== terminalId)
      setActiveTerminalIdByWorkspacePath((activeByWorkspace) => {
        if (activeByWorkspace[activePath] !== terminalId) {
          return activeByWorkspace
        }
        const nextActiveId = next[Math.max(0, closedIndex - 1)]?.id ?? next[0]?.id ?? null
        return nextActiveId
          ? { ...activeByWorkspace, [activePath]: nextActiveId }
          : omitRecordKey(activeByWorkspace, activePath)
      })
      return next
    })
    setOutputByTerminalId((current) => omitRecordKey(current, terminalId))
  }, [])

  const upsertTerminal = useCallback((
    terminal: HostedTerminalSession,
    workspacePath: string,
    options: { activate?: boolean } = {},
  ) => {
    const activePath = activeWorkspacePathRef.current
    if (!activePath || !samePath(activePath, workspacePath)) {
      return
    }

    setTerminals((current) =>
      current.some((entry) => entry.id === terminal.id)
        ? current.map((entry) => entry.id === terminal.id ? terminal : entry)
        : [...current, terminal],
    )
    setActiveTerminalIdByWorkspacePath((current) =>
      options.activate || !current[activePath]
        ? { ...current, [activePath]: terminal.id }
        : current,
    )
  }, [])

  const applyTerminalSnapshot = useCallback((value: unknown) => {
    const record = readRecord(value)
    const workspacePath = readRecordString(record, "workspacePath")
    if (record.ok !== true || !workspacePath) {
      setError(readRecordString(record, "error") || "Unable to load terminals.")
      setIsWorkspaceLoaded(true)
      return
    }
    const activePath = activeWorkspacePathRef.current
    if (!activePath || !samePath(activePath, workspacePath)) {
      return
    }

    const terminalRecords = Array.isArray(record.terminals) ? record.terminals : []
    const nextTerminals: HostedTerminalSession[] = []
    const nextOutputByTerminalId: Record<string, string> = {}

    for (const terminalRecord of terminalRecords) {
      const terminal = readHostedTerminal(terminalRecord)
      if (!terminal) {
        continue
      }
      nextTerminals.push(terminal)
      nextOutputByTerminalId[terminal.id] = readRecordString(terminalRecord, "output")
    }

    setTerminals(nextTerminals)
    setOutputByTerminalId(nextOutputByTerminalId)
    setActiveTerminalIdByWorkspacePath((current) => {
      const activeId = current[activePath]
      const nextActiveId = activeId && nextTerminals.some((terminal) => terminal.id === activeId)
        ? activeId
        : nextTerminals[0]?.id ?? null
      return nextActiveId
        ? { ...current, [activePath]: nextActiveId }
        : omitRecordKey(current, activePath)
    })
    setError(null)
    setIsWorkspaceLoaded(true)
  }, [])

  const attachWorkspace = useCallback((workspacePath: string) => {
    const socket = socketRef.current
    if (!socket?.connected) {
      return
    }
    setIsWorkspaceLoaded(false)
    socket.emit("terminal.attach", { workspacePath }, (value: unknown) => {
      if (!activeWorkspacePathRef.current || !samePath(activeWorkspacePathRef.current, workspacePath)) {
        return
      }
      applyTerminalSnapshot(value)
    })
  }, [applyTerminalSnapshot])

  useEffect(() => {
    setConnectionState("connecting")
    const socket = io({
      path: "/socket.io",
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    })
    socketRef.current = socket

    const handleConnect = () => {
      setConnectionState("connected")
      const workspacePath = activeWorkspacePathRef.current
      if (workspacePath) {
        attachWorkspace(workspacePath)
      } else {
        setIsWorkspaceLoaded(true)
      }
    }
    const handleDisconnect = () => {
      setConnectionState("offline")
      setIsWorkspaceLoaded(false)
    }
    const handleOutput = (value: unknown) => {
      const record = readRecord(value)
      const workspacePath = readRecordString(record, "workspacePath")
      const terminalId = readRecordString(record, "id")
      const data = readRecordString(record, "data")
      if (isActiveWorkspaceEvent(workspacePath) && terminalId && data) {
        appendOutput(terminalId, data)
      }
    }
    const handleCreated = (value: unknown) => {
      const record = readRecord(value)
      const workspacePath = readRecordString(record, "workspacePath")
      const terminal = readHostedTerminal(record)
      if (workspacePath && terminal) {
        upsertTerminal(terminal, workspacePath)
      }
    }
    const handleExit = (value: unknown) => {
      const record = readRecord(value)
      const workspacePath = readRecordString(record, "workspacePath")
      const terminalId = readRecordString(record, "id")
      if (!isActiveWorkspaceEvent(workspacePath) || !terminalId) {
        return
      }
      const exitCode = readExitCode(record.exitCode)
      setTerminals((current) =>
        current.map((terminal) =>
          terminal.id === terminalId
            ? { ...terminal, exitCode, status: "exited" }
            : terminal,
        ),
      )
    }
    const handleClosed = (value: unknown) => {
      const record = readRecord(value)
      const workspacePath = readRecordString(record, "workspacePath")
      const terminalId = readRecordString(record, "id")
      if (workspacePath && terminalId) {
        removeTerminal(terminalId, workspacePath)
      }
    }
    const handleError = (value: unknown) => {
      setError(readRecordString(readRecord(value), "error") || "Terminal host error.")
    }

    socket.on("connect", handleConnect)
    socket.on("disconnect", handleDisconnect)
    socket.on("terminal.closed", handleClosed)
    socket.on("terminal.created", handleCreated)
    socket.on("terminal.error", handleError)
    socket.on("terminal.exit", handleExit)
    socket.on("terminal.output", handleOutput)

    return () => {
      socket.off("connect", handleConnect)
      socket.off("disconnect", handleDisconnect)
      socket.off("terminal.closed", handleClosed)
      socket.off("terminal.created", handleCreated)
      socket.off("terminal.error", handleError)
      socket.off("terminal.exit", handleExit)
      socket.off("terminal.output", handleOutput)
      socket.disconnect()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [appendOutput, attachWorkspace, isActiveWorkspaceEvent, removeTerminal, upsertTerminal])

  useEffect(() => {
    pendingCreateRef.current = false
    setError(null)
    setOutputByTerminalId({})
    setTerminals([])
    setIsWorkspaceLoaded(false)

    if (!activeWorkspacePath) {
      setIsWorkspaceLoaded(true)
      return
    }

    const socket = socketRef.current
    if (!socket) {
      setConnectionState("connecting")
      return
    }
    if (socket.connected) {
      attachWorkspace(activeWorkspacePath)
    } else {
      setConnectionState("connecting")
      socket.connect()
    }

    return () => {
      socketRef.current?.emit("terminal.detach", { workspacePath: activeWorkspacePath })
    }
  }, [activeWorkspacePath, attachWorkspace])

  const createTerminal = useCallback(() => {
    const workspacePath = activeWorkspacePathRef.current
    const socket = socketRef.current
    if (!workspacePath || !socket || pendingCreateRef.current) {
      return
    }
    if (!socket.connected) {
      setConnectionState("connecting")
      socket.connect()
      return
    }

    pendingCreateRef.current = true
    setError(null)
    const optimisticId = "pending-terminal-" + Date.now()
    const optimisticTerminal: HostedTerminalSession = {
      cwd: workspacePath,
      id: optimisticId,
      name: "starting",
      shell: "",
      status: "connecting",
    }
    setTerminals((current) => [...current, optimisticTerminal])
    setActiveTerminalIdByWorkspacePath((current) => ({ ...current, [workspacePath]: optimisticId }))
    socket.emit(
      "terminal.create",
      {
        cols: lastSizeRef.current.cols,
        rows: lastSizeRef.current.rows,
        workspacePath,
      },
      (value: unknown) => {
        pendingCreateRef.current = false
        const activePath = activeWorkspacePathRef.current
        if (!activePath || !samePath(activePath, workspacePath)) {
          return
        }
        const record = readRecord(value)
        const terminalRecord = readRecord(record.terminal)
        const responseWorkspacePath = readRecordString(terminalRecord, "workspacePath")
        const terminal = readHostedTerminal(terminalRecord)
        if (record.ok !== true || !terminal || !responseWorkspacePath) {
          setError(readRecordString(record, "error") || "Unable to start terminal.")
          removeTerminal(optimisticId, workspacePath)
          return
        }
        if (!samePath(activePath, responseWorkspacePath)) {
          return
        }
        setTerminals((current) => current.filter((entry) => entry.id !== optimisticId))
        setOutputByTerminalId((current) => omitRecordKey(current, optimisticId))
        upsertTerminal(terminal, responseWorkspacePath, { activate: true })
      },
    )
  }, [removeTerminal, upsertTerminal])

  const closeTerminal = useCallback((terminalId: string) => {
    const workspacePath = activeWorkspacePathRef.current
    if (!workspacePath) {
      return
    }
    socketRef.current?.emit("terminal.close", { id: terminalId })
    removeTerminal(terminalId, workspacePath)
  }, [removeTerminal])

  const resizeTerminal = useCallback((terminalId: string, cols: number, rows: number) => {
    lastSizeRef.current = { cols, rows }
    socketRef.current?.emit("terminal.resize", { cols, id: terminalId, rows })
  }, [])

  const setActiveTerminalId = useCallback((terminalId: string | null) => {
    const workspacePath = activeWorkspacePathRef.current
    if (!workspacePath) {
      return
    }
    setActiveTerminalIdByWorkspacePath((current) =>
      terminalId
        ? { ...current, [workspacePath]: terminalId }
        : omitRecordKey(current, workspacePath),
    )
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
    isWorkspaceLoaded,
    outputByTerminalId,
    resizeTerminal,
    setActiveTerminalId,
    terminals,
    writeTerminalInput,
  }
}

function readHostedTerminal(value: unknown): HostedTerminalSession | null {
  const record = readRecord(value)
  const cwd = readRecordString(record, "cwd")
  const id = readRecordString(record, "id")
  const name = readRecordString(record, "name")
  const shell = readRecordString(record, "shell")
  if (!cwd || !id || !name || !shell) {
    return null
  }

  return {
    cwd,
    exitCode: readExitCode(record.exitCode),
    id,
    name,
    shell,
    status: readTerminalStatus(record.status),
  }
}

function readTerminalStatus(value: unknown): HostedTerminalStatus {
  return value === "connecting" || value === "exited" || value === "running" ? value : "running"
}

function readExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
