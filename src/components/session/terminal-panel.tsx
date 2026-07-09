import type { Terminal as XtermTerminal } from "@xterm/xterm"
import {
  LoaderCircle,
  Plus,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react"
import {
  useEffect,
  useRef,
} from "react"
import { useTheme } from "@/components/theme-provider"
import { terminalThemeColors } from "@/lib/theme-colors"
import { cn } from "@/lib/utils"

export type HostedTerminalStatus = "connecting" | "running" | "exited"

export type HostedTerminalSession = {
  cwd: string
  exitCode?: number | null
  id: string
  name: string
  shell: string
  status: HostedTerminalStatus
}

export type TerminalConnectionState = "connected" | "connecting" | "offline"

export function SessionTerminalPanel({
  activeTerminalId,
  connectionState,
  error,
  outputByTerminalId,
  terminals,
  workspaceName,
  workspacePath,
  onActivateTerminal,
  onCloseTerminal,
  onCreateTerminal,
  onHide,
  onInput,
  onResize,
}: {
  activeTerminalId: string | null
  connectionState: TerminalConnectionState
  error: string | null
  outputByTerminalId: Record<string, string>
  terminals: HostedTerminalSession[]
  workspaceName: string
  workspacePath: string
  onActivateTerminal: (terminalId: string) => void
  onCloseTerminal: (terminalId: string) => void
  onCreateTerminal: () => void
  onHide: () => void
  onInput: (terminalId: string, data: string) => void
  onResize: (terminalId: string, cols: number, rows: number) => void
}) {
  const activeTerminal =
    terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0] ?? null

  return (
    <section className="relative grid h-full min-h-0 grid-rows-[36px_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-background">
      <header className="flex min-w-0 items-center border-b border-border bg-secondary/40 px-2">
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden pr-2 ide-scrollbar" role="tablist">
          {terminals.length ? (
            terminals.map((terminal) => {
              const active = terminal.id === activeTerminal?.id
              return (
                <div
                  className={cn(
                    "group flex h-7 min-w-28 max-w-48 shrink-0 items-center rounded-md text-[12px]",
                    active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent",
                  )}
                  key={terminal.id}
                >
                  <button
                    aria-selected={active}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
                    role="tab"
                    title={`${terminal.cwd} - ${workspaceName}`}
                    type="button"
                    onClick={() => onActivateTerminal(terminal.id)}
                  >
                    <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{terminalTabLabel(terminal, terminals)}</span>
                  </button>
                  <div className="relative mr-1 grid size-5 shrink-0 place-items-center">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
                        terminal.status === "running" && "bg-success",
                        terminal.status === "connecting" && "bg-info",
                        terminal.status === "exited" && "bg-muted-foreground",
                      )}
                    />
                    <button
                      aria-label={`Close ${terminalTabLabel(terminal, terminals)}`}
                      className="pointer-events-none absolute inset-0 grid place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                      type="button"
                      onClick={() => onCloseTerminal(terminal.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground" title={workspacePath}>
              <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {connectionState === "connecting" ? "Connecting" : "No terminal"}
              </span>
              {connectionState === "connecting" ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-info" /> : null}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label="New terminal"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="New terminal"
            type="button"
            onClick={onCreateTerminal}
          >
            <Plus className="size-4" />
          </button>
          <button
            aria-label="Close terminal"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            disabled={!activeTerminal}
            title="Close terminal"
            type="button"
            onClick={() => activeTerminal ? onCloseTerminal(activeTerminal.id) : undefined}
          >
            <Trash2 className="size-4" />
          </button>
          <button
            aria-label="Hide terminal panel"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Hide terminal panel"
            type="button"
            onClick={onHide}
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 min-w-0 overflow-hidden bg-background">
        {activeTerminal ? (
          <TerminalViewport
            key={activeTerminal.id}
            output={outputByTerminalId[activeTerminal.id] ?? ""}
            terminal={activeTerminal}
            onInput={(data) => onInput(activeTerminal.id, data)}
            onResize={(cols, rows) => onResize(activeTerminal.id, cols, rows)}
          />
        ) : (
          <div className="grid h-full place-items-center p-4 text-center text-[12px] text-muted-foreground">
            <button
              className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 font-semibold text-primary-foreground hover:bg-primary/80"
              type="button"
              onClick={onCreateTerminal}
            >
              <TerminalIcon className="size-4" />
              Start terminal
            </button>
          </div>
        )}
      </div>

      {error ? (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </div>
      ) : null}
    </section>
  )
}

function terminalTabLabel(terminal: HostedTerminalSession, terminals: HostedTerminalSession[]) {
  const matchingTerminals = terminals.filter((entry) => entry.name === terminal.name)
  if (matchingTerminals.length <= 1) {
    return terminal.name
  }
  return `${terminal.name} ${matchingTerminals.findIndex((entry) => entry.id === terminal.id) + 1}`
}

function TerminalViewport({
  output,
  terminal,
  onInput,
  onResize,
}: {
  output: string
  terminal: HostedTerminalSession
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const lastOutputLengthRef = useRef(0)
  const onInputRef = useRef(onInput)
  const onResizeRef = useRef(onResize)
  const outputRef = useRef(output)
  const terminalRef = useRef<XtermTerminal | null>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    onInputRef.current = onInput
    onResizeRef.current = onResize
    outputRef.current = output
  }, [onInput, onResize, output])

  useEffect(() => {
    let cancelled = false
    let cleanup: () => void = () => undefined
    const container = containerRef.current

    if (!container) {
      return cleanup
    }

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).then(([xtermModule, fitModule]) => {
      if (cancelled || !containerRef.current) {
        return
      }
      const xterm = new xtermModule.Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
        fontSize: 12,
        letterSpacing: 0,
        lineHeight: 1.25,
        macOptionIsMeta: true,
        scrollback: 5000,
        theme: terminalThemeColors(),
      })
      const fitAddon = new fitModule.FitAddon()
      xterm.loadAddon(fitAddon)
      xterm.open(containerRef.current)
      terminalRef.current = xterm

      const fitTerminal = () => {
        try {
          fitAddon.fit()
          onResizeRef.current(xterm.cols, xterm.rows)
        } catch {
          // Xterm can briefly have no measurable box while the panel is resizing.
        }
      }
      const dataDisposable = xterm.onData((data) => onInputRef.current(data))
      const resizeObserver = new ResizeObserver(fitTerminal)
      resizeObserver.observe(containerRef.current)
      requestAnimationFrame(fitTerminal)

      const currentOutput = outputRef.current
      if (currentOutput) {
        xterm.write(currentOutput)
      }
      lastOutputLengthRef.current = currentOutput.length
      xterm.focus()

      cleanup = () => {
        dataDisposable.dispose()
        resizeObserver.disconnect()
        xterm.dispose()
        terminalRef.current = null
        lastOutputLengthRef.current = 0
      }
    })

    return () => {
      cancelled = true
      cleanup()
    }
  }, [terminal.id])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalThemeColors()
    }
  }, [resolvedTheme])

  useEffect(() => {
    const xterm = terminalRef.current
    if (!xterm) {
      return
    }
    const previousLength = lastOutputLengthRef.current
    if (output.length < previousLength) {
      xterm.reset()
      if (output) {
        xterm.write(output)
      }
    } else if (output.length > previousLength) {
      xterm.write(output.slice(previousLength))
    }
    lastOutputLengthRef.current = output.length
  }, [output])

  return (
    <div
      ref={containerRef}
      className={cn(
        "h-full min-h-0 w-full overflow-hidden px-2 py-1",
        terminal.status === "exited" && "opacity-80",
      )}
    />
  )
}
