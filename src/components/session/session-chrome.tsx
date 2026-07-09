import type { ReactNode } from "react"
import { PanelLeft, PanelRight, Plus, Terminal, X } from "lucide-react"
import { ThemeModeToggle } from "@/components/theme-mode-toggle"
import { PushNotificationButton } from "@/components/session/push-notification-button"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/types/session"

export function TopBar({
  activeWorkspaceId,
  isFilesPanelOpen,
  isTerminalPanelOpen,
  workspaces,
  onAddWorkspace,
  onCloseWorkspace,
  onOpenFilesDrawer,
  onOpenSessionsDrawer,
  onSelectWorkspace,
  onToggleFilesPanel,
  onToggleTerminalPanel,
}: {
  activeWorkspaceId: string | null
  isFilesPanelOpen: boolean
  isTerminalPanelOpen: boolean
  workspaces: Workspace[]
  onAddWorkspace: () => void
  onCloseWorkspace: (workspaceId: string) => void
  onOpenFilesDrawer: () => void
  onOpenSessionsDrawer: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onToggleFilesPanel: () => void
  onToggleTerminalPanel: () => void
}) {
  return (
    <header className="session-shell-top-bar flex min-w-0 items-center bg-background">
      <div className="flex h-full shrink-0 items-center pl-2 md:hidden">
        <button
          aria-label="Open chats panel"
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          type="button"
          onClick={onOpenSessionsDrawer}
        >
          <PanelLeft className="size-4" />
        </button>
      </div>
      <WorkspaceTabs
        activeWorkspaceId={activeWorkspaceId}
        workspaces={workspaces}
        onAddWorkspace={onAddWorkspace}
        onCloseWorkspace={onCloseWorkspace}
        onSelectWorkspace={onSelectWorkspace}
      />

      <div className="ml-auto flex items-center justify-end gap-2 px-3">
        <PushNotificationButton />
        <button
          aria-label={isTerminalPanelOpen ? "Hide terminal panel" : "Show terminal panel"}
          aria-pressed={isTerminalPanelOpen}
          className={cn(
            "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
            isTerminalPanelOpen && "bg-accent text-foreground",
          )}
          type="button"
          onClick={onToggleTerminalPanel}
        >
          <Terminal className="size-4" />
        </button>
        <ThemeModeToggle />
        <button
          aria-label="Open files panel"
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          type="button"
          onClick={onOpenFilesDrawer}
        >
          <PanelRight className="size-4" />
        </button>
        <button
          aria-label={isFilesPanelOpen ? "Hide files panel" : "Show files panel"}
          aria-pressed={isFilesPanelOpen}
          className={cn(
            "hidden size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:grid",
            isFilesPanelOpen && "bg-accent text-foreground",
          )}
          type="button"
          onClick={onToggleFilesPanel}
        >
          <PanelRight className="size-4" />
        </button>
      </div>
    </header>
  )
}

function WorkspaceTabs({
  activeWorkspaceId,
  workspaces,
  onAddWorkspace,
  onCloseWorkspace,
  onSelectWorkspace,
}: {
  activeWorkspaceId: string | null
  workspaces: Workspace[]
  onAddWorkspace: () => void
  onCloseWorkspace: (workspaceId: string) => void
  onSelectWorkspace: (workspaceId: string) => void
}) {
  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden px-2">
      {workspaces.map((workspace) => (
        <WorkspaceTab
          active={workspace.id === activeWorkspaceId}
          key={workspace.id}
          label={workspace.name}
          onClose={() => onCloseWorkspace(workspace.id)}
          onSelect={() => onSelectWorkspace(workspace.id)}
        />
      ))}
      <button
        aria-label="Open workspace"
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        type="button"
        onClick={onAddWorkspace}
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}

function WorkspaceTab({
  active,
  label,
  onClose,
  onSelect,
}: {
  active?: boolean
  label: string
  onClose: () => void
  onSelect: () => void
}) {
  return (
    <div
      className={cn(
        "group relative flex h-6 min-w-0 max-w-34 shrink-0 items-center rounded-md border border-transparent text-[11px] font-medium transition-colors",
        active
          ? "border-border bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      title={label}
    >
      <button className="min-w-0 flex-1 px-1.5 text-left" type="button" onClick={onSelect}>
        <span className="block truncate">{label}</span>
      </button>
      <button
        aria-label={`Close ${label}`}
        className={cn(
          "mr-1 grid size-3 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <X className="size-2" />
      </button>
    </div>
  )
}

export function MobilePanelDrawer({
  children,
  open,
  side,
  title,
  onClose,
}: {
  children: ReactNode
  open: boolean
  side: "left" | "right"
  title: string
  onClose: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        onClose()
      }
    }}>
      <SheetContent
        className="grid !w-[min(88vw,380px)] grid-rows-[40px_minmax(0,1fr)] gap-0 border-border bg-background p-0 shadow-2xl md:hidden"
        showCloseButton={false}
        side={side}
      >
        <div className="flex items-center gap-2 px-3">
          <SheetTitle className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{title}</SheetTitle>
          <button
            aria-label={`Close ${title.toLowerCase()} drawer`}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-3" />
          </button>
        </div>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
