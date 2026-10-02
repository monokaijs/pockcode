import { ArrowRight, Clock3, FileText, Folder, FolderPlus, LoaderCircle, RefreshCw, Server } from "lucide-react"
import { useState, type ReactNode } from "react"
import { useTheme, type Theme } from "@/components/theme-provider"
import { useChatList } from "@/components/session/chat-list-context"
import { ProviderMark } from "@/components/session/provider-icons"
import { useProviderQuotas } from "@/components/session/provider-quota-context"
import { PushNotificationButton } from "@/components/session/push-notification-button"
import type { SessionShellState } from "@/components/session/session-shell"
import type { ProviderLimitsResponse } from "@/lib/api-client"
import { clampPercent, compareChatsByUpdatedTime, relativeTimeLabel } from "@/lib/session"
import { cn } from "@/lib/utils"

function Page({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="h-full min-h-0 overflow-auto px-5 py-8 ide-scrollbar sm:px-8 lg:px-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-9 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
            <p className="mt-2 text-[13px] text-muted-foreground">{description}</p>
          </div>
          {action}
        </div>
        {children}
      </div>
    </section>
  )
}

const actionClass = "flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-[13px] hover:bg-muted"

export function ProjectsPage({ shell }: { shell: SessionShellState }) {
  const projects = [...shell.workspaces, ...shell.recentWorkspaces.filter((recent) => !shell.workspaces.some((workspace) => workspace.path === recent.path))]

  return (
    <Page title="Projects" description="A place for everything you're working on." action={<button className={actionClass} type="button" onClick={() => shell.setWorkspaceBrowserOpen(true)}><FolderPlus className="size-4" />Open folder</button>}>
      {shell.workspaceLoadError ? <p role="alert" className="mb-4 text-sm text-destructive">{shell.workspaceLoadError}</p> : null}
      {shell.isWorkspaceHistoryLoading ? <p className="text-sm text-muted-foreground">Loading projects…</p> : projects.length ? (
        <div className="divide-y divide-border">
          {projects.map((project) => (
            <button className="group flex w-full min-w-0 items-center gap-4 rounded-lg px-3 py-4 text-left hover:bg-card" key={project.id} type="button" onClick={() => {
              const open = shell.workspaces.find((workspace) => workspace.id === project.id)
              if (open) {
                shell.selectWorkspace(open.id)
                shell.startNewChat()
                shell.selectNavigationView("home")
              } else {
                const recent = shell.recentWorkspaces.find((workspace) => workspace.id === project.id)
                if (recent) void shell.openRecentWorkspace(recent)
              }
            }}>
              <Folder className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{project.name}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">{project.path}</span>
              </span>
              {project.id === shell.activeWorkspace?.id ? <span className="hidden text-xs text-muted-foreground sm:block">Current project</span> : null}
              <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      ) : <EmptyPage icon={<Folder className="size-8" strokeWidth={1.3} />} title="Your next project starts here" description="Open a folder to start a conversation with your code." />}
    </Page>
  )
}

export function TasksBoardPage({ shell }: { shell: SessionShellState }) {
  const { chats, isChatRunning, isLoading } = useChatList()
  const sorted = [...chats].sort(compareChatsByUpdatedTime)
  const stateFor = (id: string) => {
    if (isChatRunning(id)) return "running"
    const latest = shell.messagesByChatId[id]?.at(-1)
    return latest?.status === "FAILED" || latest?.kind === "ERROR" ? "attention" : "idle"
  }
  const columns = [
    { id: "running", label: "In progress", dot: "bg-success" },
    { id: "attention", label: "Needs attention", dot: "bg-warning" },
    { id: "idle", label: "Idle", dot: "bg-muted-foreground" },
  ]

  return (
    <Page title="Tasks board" description={shell.activeWorkspace ? `Chat activity in ${shell.activeWorkspace.name}.` : "Open a project to see its chat activity."} action={<button className={actionClass} type="button" onClick={() => shell.activeWorkspace ? shell.startNewChat() : shell.setWorkspaceBrowserOpen(true)}><PlusIcon />New task</button>}>
      {shell.chatError ? <p role="alert" className="mb-4 text-sm text-destructive">{shell.chatError}</p> : null}
      {isLoading ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : (
        <div className="grid gap-5 lg:grid-cols-3">
          {columns.map((column) => {
            const items = sorted.filter((chat) => stateFor(chat.id) === column.id)
            return (
              <div className="min-w-0" key={column.id}>
                <div className="mb-4 flex items-center gap-2 text-[13px]">
                  <span className={cn("size-1.5 rounded-full", column.dot)} />{column.label}
                  <span className="ml-auto text-xs text-muted-foreground">{items.length}</span>
                </div>
                <div className="space-y-2 rounded-xl bg-card/50 p-2">
                  {items.map((chat) => (
                    <button className="block w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent" key={chat.id} type="button" onClick={() => {
                      shell.setActiveChatId(chat.id)
                      shell.switchToChat()
                    }}>
                      <span className="block text-[13px] leading-5">{chat.title}</span>
                      <span className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {column.id === "running" ? <LoaderCircle className="size-3 animate-spin text-success" /> : <ProviderMark icon={chat.providerId} className="size-3" />}
                        {relativeTimeLabel(chat.lastActivityAt)}
                      </span>
                    </button>
                  ))}
                  {!items.length ? <div className="px-3 py-8 text-center text-xs text-muted-foreground">No tasks</div> : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Page>
  )
}

function PlusIcon() {
  return <span aria-hidden="true" className="text-base leading-none">+</span>
}

export function ScheduledEmptyPage({ shell }: { shell: SessionShellState }) {
  return (
    <Page title="Scheduled" description={shell.activeWorkspace ? `Recurring work in ${shell.activeWorkspace.name}.` : "Open a project to schedule a task."} action={<button className={actionClass} type="button" onClick={() => shell.activeWorkspace ? void shell.createSchedule() : shell.setWorkspaceBrowserOpen(true)}><PlusIcon />New schedule</button>}>
      {shell.scheduleError ? <p role="alert" className="mb-4 text-sm text-destructive">{shell.scheduleError}</p> : null}
      <EmptyPage icon={<Clock3 className="size-8" strokeWidth={1.3} />} title={shell.schedules.length ? "Select a scheduled task" : "Let your tasks run on time"} description={shell.schedules.length ? "Choose a task in the sidebar to view its schedule and runs." : "Create a schedule and choose when it should run."} />
    </Page>
  )
}

export function UsagePage({ shell }: { shell: SessionShellState }) {
  const { accountLimits, error, accountErrors, isLoading, refreshQuotas } = useProviderQuotas()
  const accounts = shell.chatAccounts

  return (
    <Page title="Usage" description="Limits and remaining capacity for your connected accounts." action={<button className={actionClass} disabled={isLoading} type="button" onClick={() => void refreshQuotas()}><RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />Refresh</button>}>
      {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
      {accounts.length ? (
        <div className="max-w-2xl space-y-8">
          {accounts.map((account) => {
            const limits = accountLimits[account.id]
            const provider = shell.providerDefinitions.find((item) => item.id === account.providerId)
            return (
              <div className="rounded-2xl border border-border p-5" key={account.id}>
                <div className="mb-5 flex items-center gap-3">
                  <ProviderMark icon={provider?.icon ?? account.providerId} className="size-5 text-muted-foreground" />
                  <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{account.displayName}</h2><p className="mt-1 text-xs text-muted-foreground">{provider?.label ?? account.providerId}{limits?.rateLimits?.planType ? ` · ${limits.rateLimits.planType}` : ""}</p></div>
                </div>
                <QuotaWindows limits={limits} />
                {accountErrors[account.id] ? <p role="alert" className="text-xs text-destructive">{accountErrors[account.id]}</p> : null}
                {!limits?.rateLimits?.primary && !limits?.rateLimits?.secondary && !accountErrors[account.id] ? <p className="text-xs text-muted-foreground">{isLoading ? "Loading usage…" : "Usage is not available for this account."}</p> : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div><EmptyPage icon={<ProviderMark icon="codex" className="size-8" />} title="Connect an account to see usage" description="Your account limits will appear here." /><button className={cn(actionClass, "mx-auto")} type="button" onClick={() => shell.selectManagementView("providers")}>Connect provider</button></div>
      )}
    </Page>
  )
}

function QuotaWindows({ limits }: { limits?: ProviderLimitsResponse }) {
  const windows = [limits?.rateLimits?.primary, limits?.rateLimits?.secondary].filter((window) => window != null)
  return (
    <div className="space-y-5">
      {windows.map((window, index) => {
        const remaining = clampPercent(100 - window.usedPercent)
        const minutes = window.windowDurationMins
        const label = minutes ? minutes >= 1440 ? `${Math.round(minutes / 1440)} day limit` : `${Math.round(minutes / 60)} hour limit` : index === 0 ? "Primary limit" : "Secondary limit"
        const reset = window.resetsAt ? new Date(window.resetsAt > 1_000_000_000_000 ? window.resetsAt : window.resetsAt * 1000) : null
        return (
          <div key={index}>
            <div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">{label}</span><span>{Math.round(remaining)}% remaining</span></div>
            <div aria-label={`${label}: ${Math.round(remaining)}% remaining`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(remaining)} className="h-1.5 overflow-hidden rounded-full bg-accent" role="progressbar"><div className={cn("h-full rounded-full", remaining <= 10 ? "bg-warning" : "bg-foreground/75")} style={{ width: `${remaining}%` }} /></div>
            {reset && Number.isFinite(reset.getTime()) ? <p className="mt-2 text-[11px] text-muted-foreground">Resets {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(reset)}</p> : null}
          </div>
        )
      })}
    </div>
  )
}

export function SettingsPage({ shell }: { shell: SessionShellState }) {
  const { theme, setTheme } = useTheme()
  const [name, setName] = useState(shell.userName)

  return (
    <Page title="Settings" description="Make this workspace yours.">
      <div className="max-w-2xl divide-y divide-border">
        <div className="pb-6">
          <label className="block text-sm font-medium" htmlFor="profile-name">Display name</label>
          <p className="mt-1 text-xs text-muted-foreground">Used in your local user menu.</p>
          <form className="mt-4 flex gap-2" onSubmit={(event) => { event.preventDefault(); shell.updateUserName(name) }}>
            <input className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 text-sm outline-none focus:border-ring" id="profile-name" maxLength={80} required value={name} onChange={(event) => setName(event.target.value)} />
            <button className={cn(actionClass, "!h-9")} disabled={!name.trim() || name.trim() === shell.userName} type="submit">Save</button>
          </form>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 py-6">
          <div><h2 className="text-sm font-medium">Appearance</h2><p className="mt-1 text-xs text-muted-foreground">Choose your preferred theme.</p></div>
          <select aria-label="Theme" className="h-8 rounded-lg border border-border bg-card px-2 text-[13px] outline-none" value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select>
        </div>
        <div className="flex items-center justify-between gap-4 py-6"><div><h2 className="text-sm font-medium">Notifications</h2><p className="mt-1 text-xs text-muted-foreground">Get notified when a task needs you.</p></div><PushNotificationButton /></div>
        <button className="flex w-full items-center gap-3 py-5 text-left hover:text-muted-foreground" type="button" onClick={() => shell.selectManagementView("instructions")}><FileText className="size-4 text-muted-foreground" /><span className="flex-1 text-sm">Instructions</span><ArrowRight className="size-4 text-muted-foreground" /></button>
        <button className="flex w-full items-center gap-3 py-5 text-left hover:text-muted-foreground" type="button" onClick={() => shell.selectManagementView("mcpServers")}><Server className="size-4 text-muted-foreground" /><span className="flex-1 text-sm">MCP servers</span><ArrowRight className="size-4 text-muted-foreground" /></button>
      </div>
    </Page>
  )
}

function EmptyPage({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <div className="flex min-h-64 flex-col items-center justify-center text-center"><div className="mb-5 text-muted-foreground/60">{icon}</div><h2 className="text-base font-medium">{title}</h2><p className="mt-2 max-w-sm text-[13px] leading-6 text-muted-foreground">{description}</p></div>
}
