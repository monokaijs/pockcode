import type { ReactNode, RefCallback } from "react"
import { Folder, PanelLeft, SquarePlus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import type { SessionShellState } from "@/components/session/session-shell"

export function SessionTitleBar({ shell, sidebarCollapsed, onToggleSidebar, actionsRef }: {
  shell: SessionShellState
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  actionsRef: RefCallback<HTMLDivElement>
}) {
  const titles = { home: "PockCode", tasks: "Tasks board", scheduled: "Scheduled tasks", projects: "Projects", usage: "Usage", settings: "Settings" }
  const title = shell.navigationView === "home"
    ? shell.activeAgentId
      ? shell.agents.find((agent) => agent.id === shell.activeAgentId)?.profile.name ?? "Assistant"
      : shell.mainMode === "editor" && shell.selectedFile
        ? shell.selectedFile.name
        : shell.activeChat?.title ?? shell.activeWorkspace?.name ?? "PockCode"
    : shell.navigationView === "scheduled" ? shell.activeSchedule?.title ?? titles.scheduled : titles[shell.navigationView]

  return (
    <header className="session-titlebar">
      <div className="session-titlebar-navigation flex min-w-0 items-center gap-2 px-3">
        <button aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"} aria-expanded={!sidebarCollapsed} className="session-icon-button hidden md:grid" type="button" onClick={onToggleSidebar}><PanelLeft className="size-3.5" /></button>
        <button aria-label="Open agents, projects and chats" className="session-icon-button md:hidden" type="button" onClick={() => shell.setMobileDrawer("sessions")}><PanelLeft className="size-4" /></button>
      </div>
      <div className="session-titlebar-content flex min-w-0 items-center gap-3 px-3">
        <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]" title={title}>{title}</span>
        <div className="flex h-full min-w-0 shrink-0 items-center" ref={actionsRef} />
        <button aria-label="New chat" className="session-icon-button" type="button" onClick={() => {
          if (shell.activeWorkspace) shell.startNewChat()
          else shell.setWorkspaceBrowserOpen(true)
        }}><SquarePlus className="size-3.5" /></button>
      </div>
    </header>
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
        className="session-app grid !w-[min(88vw,380px)] grid-rows-[40px_minmax(0,1fr)] gap-0 border-border bg-background p-0 shadow-2xl md:hidden"
        showCloseButton={false}
        side={side}
      >
        <div className="flex items-center gap-2 px-3">
          <SheetTitle className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{title}</SheetTitle>
          <Button variant="ghost" size="icon-sm"
            aria-label={`Close ${title.toLowerCase()} drawer`}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-3" />
          </Button>
        </div>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
