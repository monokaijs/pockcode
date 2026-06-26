import type { PointerEvent as ReactPointerEvent } from "react"
import { Plus, Terminal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { TerminalSession } from "@/types/ide"

export function TerminalPanel({
  activeTerminalId,
  terminals,
  onResizeStart,
  onTerminalChange,
}: {
  activeTerminalId: string | null
  terminals: TerminalSession[]
  onResizeStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onTerminalChange: (terminalId: string) => void
}) {
  const activeTerminal =
    terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0] ?? null

  return (
    <section className="grid h-full min-h-0 grid-rows-[4px_auto_minmax(0,1fr)] overflow-hidden border-t bg-ide-terminal">
      <button
        aria-label="Resize terminal panel"
        className="group flex cursor-row-resize items-center justify-center bg-card"
        type="button"
        onPointerDown={onResizeStart}
      >
        <span className="h-0.5 w-12 rounded-full bg-muted-foreground/25 group-hover:bg-muted-foreground/60" />
      </button>
      <div className="flex min-h-9 min-w-0 items-center gap-1 border-b bg-card px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto ide-scrollbar" role="tablist">
          {terminals.map((terminal) => {
            const active = terminal.id === activeTerminal?.id
            return (
              <div
                className={cn(
                  "flex h-7 min-w-32 max-w-56 shrink-0 items-center rounded-md text-xs",
                  active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted/60",
                )}
                key={terminal.id}
              >
                <button
                  aria-selected={active}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
                  role="tab"
                  title={terminal.cwd}
                  type="button"
                  onClick={() => onTerminalChange(terminal.id)}
                >
                  <Terminal className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{terminal.name}</span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      terminal.status === "running" && "bg-success",
                      terminal.status === "idle" && "bg-warning",
                      terminal.status === "exited" && "bg-muted-foreground",
                    )}
                  />
                </button>
                <button
                  aria-label={`Close ${terminal.name}`}
                  className="mr-1 grid size-5 shrink-0 place-items-center rounded-sm hover:bg-background"
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        <Button size="icon-sm" title="New terminal" variant="ghost">
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 overflow-auto p-3 font-mono text-xs leading-5 text-foreground ide-scrollbar">
        {activeTerminal ? (
          <>
            <div className="mb-2 text-muted-foreground">{activeTerminal.cwd}</div>
            <pre className="whitespace-pre-wrap">{activeTerminal.lines.join("\n")}</pre>
            {activeTerminal.status === "running" ? (
              <span className="mt-2 inline-block h-4 w-2 animate-pulse bg-foreground align-middle" />
            ) : null}
          </>
        ) : (
          <div className="grid h-full place-items-center text-muted-foreground">No terminal</div>
        )}
      </div>
    </section>
  )
}
