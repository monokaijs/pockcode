import { useCallback, useEffect, useRef, useState } from "react"
import { io } from "socket.io-client"
import type { HostedTerminalSession, TerminalConnectionState } from "@/components/session/terminal-panel"
import { omitRecordKey, readRecord, readRecordString } from "@/lib/session"
import type { Workspace } from "@/types/session"

export const DEFAULT_TERMINAL_HEIGHT = 290
export const MIN_TERMINAL_HEIGHT = 160
export const MAX_TERMINAL_HEIGHT = 560

const TERMINAL_OUTPUT_LIMIT = 260_000

export function useWorkspaceTerminals(activeWorkspace: Workspace | null) {
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

    const appendOutput = (terminalId: string, data: string) => {
      setOutputByTerminalId((current) => {
        const output = (current[terminalId] ?? "") + data
        return {
          ...current,
          [terminalId]: output.length > TERMINAL_OUTPUT_LIMIT ? output.slice(-TERMINAL_OUTPUT_LIMIT) : output,
        }
      })
    }
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
      if (terminalId && data) {
        appendOutput(terminalId, data)
      }
    }
    const handleExit = (value: unknown) => {
      const record = readRecord(value)
      const terminalId = readRecordString(record, "id")
      if (!terminalId) {
        return
      }
      const exitCode = typeof record.exitCode === "number" && Number.isFinite(record.exitCode) ? record.exitCode : null
      setTerminals((current) =>
        current.map((terminal) =>
          terminal.id === terminalId
            ? { ...terminal, exitCode, status: "exited" }
            : terminal,
        ),
      )
      appendOutput(terminalId, `\r\n[process exited${exitCode === null ? "" : ` with code ${exitCode}`}]\r\n`)
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
        const record = readRecord(value)
        const terminalRecord = readRecord(record.terminal)
        const cwd = readRecordString(terminalRecord, "cwd")
        const id = readRecordString(terminalRecord, "id")
        const name = readRecordString(terminalRecord, "name")
        const shell = readRecordString(terminalRecord, "shell")
        if (record.ok !== true || !cwd || !id || !name || !shell) {
          setError(readRecordString(record, "error") || "Unable to start terminal.")
          removeTerminal(optimisticId)
          return
        }
        const terminal: HostedTerminalSession = {
          cwd,
          id,
          name,
          shell,
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
