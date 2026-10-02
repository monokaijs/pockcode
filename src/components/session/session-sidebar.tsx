import { Clock3, Folder, FolderOpen, LoaderCircle, Plus, Search, SquarePen, X } from "lucide-react"
import { AgentAvatar } from "@/components/session/agent-avatar"
import { useEffect, useRef, useState } from "react"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CreateAgentDialog } from "@/components/session/create-agent-dialog"
import { PushNotificationButton } from "@/components/session/push-notification-button"
import { SidebarChatList } from "@/components/session/sidebar-chat-list"
import { compareSchedules, dateTimeLabel } from "@/components/session/schedule-utils"
import { cn } from "@/lib/utils"
import type { SessionShellState } from "@/components/session/session-shell"

export function SessionSidebar({ shell }: { shell: SessionShellState }) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [agentDialogOpen, setAgentDialogOpen] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])
  const visitedProjects = useRef(new Set<string>())
  const activeProjectPath = shell.activeWorkspace?.path
  useEffect(() => {
    if (activeProjectPath && !visitedProjects.current.has(activeProjectPath)) {
      visitedProjects.current.add(activeProjectPath)
      setExpandedProjects((current) => current.includes(activeProjectPath) ? current : [...current, activeProjectPath])
    }
  }, [activeProjectPath])
  const scheduled = shell.navigationView === "scheduled"
  const matches = (value: string) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const projects = [
    ...shell.workspaces,
    ...shell.recentWorkspaces.filter((recent) => !shell.workspaces.some((workspace) => workspace.path === recent.path)),
  ].filter((project) => matches(project.name))

  const openProject = (id: string) => {
    const workspace = shell.workspaces.find((item) => item.id === id)
    if (workspace) {
      shell.selectWorkspace(workspace.id)
      shell.startNewChat()
    } else {
      const recent = shell.recentWorkspaces.find((item) => item.id === id)
      if (recent) void shell.openRecentWorkspace(recent)
    }
    shell.selectNavigationView("home")
  }


  return (
    <aside aria-label={scheduled ? "Scheduled tasks" : "Agents, projects and chats"} className="session-sidebar flex h-full min-h-0 flex-col overflow-hidden px-2 pb-2 pt-2">
      <div className="mb-1.5 flex h-9 shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">{scheduled ? "Scheduled" : "PockCode"}</span>
        <PushNotificationButton />
        <Button variant="ghost" aria-label={searchOpen ? "Close search" : "Search sidebar"} size="icon-sm" type="button" onClick={() => {
          setSearchOpen((open) => !open)
          setSearch("")
        }}>
          {searchOpen ? <X className="size-3.5" /> : <Search className="size-3.5" />}
        </Button>
      </div>
      {searchOpen ? (
        <Input maxLength={200} aria-label={scheduled ? "Search schedules" : "Search agents, projects and chats"} autoFocus className="mb-3 h-8 w-full shrink-0 rounded-lg border border-border bg-transparent px-2 text-[13px] outline-none focus:border-ring" placeholder={scheduled ? "Search schedules" : "Search agents, projects and chats"} value={search} onChange={(event) => setSearch(event.target.value)} />
      ) : null}
      <Button variant="ghost" className="mb-1 flex h-8 justify-start font-normal shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-[14px] hover:bg-sidebar-accent" type="button" onClick={() => {
        if (scheduled) {
          void shell.createSchedule()
        } else if (shell.activeWorkspace) {
          shell.startNewChat()
        } else {
          shell.setWorkspaceBrowserOpen(true)
        }
      }}>
        {scheduled ? <Plus className="size-4 text-muted-foreground" /> : <SquarePen className="size-4 text-muted-foreground" />}
        {scheduled ? "New schedule" : "New chat"}
      </Button>

      <ScrollArea className="min-h-0 flex-1"><div>
        {scheduled ? (
          <div className="space-y-1">
            {[...shell.schedules].sort(compareSchedules).filter((schedule) => matches(schedule.title)).map((schedule) => (
              <Button variant="ghost" aria-current={shell.activeScheduleId === schedule.id ? "true" : undefined} className={cn("flex h-auto w-full justify-start font-normal items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-sidebar-accent", shell.activeScheduleId === schedule.id && "bg-sidebar-accent")} key={schedule.id} type="button" onClick={() => shell.selectSchedule(schedule.id)}>
                <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{schedule.title}</span>
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">{schedule.nextRunAt ? dateTimeLabel(schedule.nextRunAt) : schedule.status.toLowerCase()}</span>
                </span>
                {schedule.status === "ACTIVE" ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" /> : null}
              </Button>
            ))}
            {shell.isSchedulesLoading ? <p className="px-2 py-2 text-xs text-muted-foreground">Loading schedules…</p> : !shell.schedules.length ? <p className="px-2 py-2 text-xs text-muted-foreground">No scheduled tasks yet.</p> : null}
          </div>
        ) : (
          <>
            <div className="mb-2 mt-2 flex items-center justify-between px-2">
              <h2 className="text-[13px] text-muted-foreground">Agents</h2>
              <Button variant="ghost" aria-label="New agent" title="New agent" size="icon-xs" type="button" onClick={() => setAgentDialogOpen(true)}><Plus className="size-3.5" /></Button>
            </div>
            <div className="space-y-1">
              {shell.agents.filter((agent) => matches(agent.profile.name)).map((agent) => {
                const active = shell.navigationView === "home" && shell.activeAgentId === agent.id
                return (
                  <Button variant="ghost" key={agent.id} aria-current={active ? "true" : undefined} aria-busy={agent.status === "running" || undefined} className={cn("flex h-auto min-h-8 justify-start font-normal w-full items-center gap-2.5 rounded-lg px-2 text-left text-[14px] hover:bg-sidebar-accent", active && "bg-sidebar-accent text-foreground")} title={agent.profile.personality} type="button" onClick={() => shell.selectAgent(agent.id)}>
                    <AgentAvatar name={agent.profile.name} avatar={agent.profile.avatar} className="size-4 text-[8px]" />
                    <span className="min-w-0 flex-1 truncate">{agent.profile.name}</span>
                    {agent.status === "running" ? <LoaderCircle aria-label="Running" className="size-3.5 shrink-0 animate-spin text-success" /> : null}
                  </Button>
                )
              })}
              {shell.isAgentsLoading ? <p className="px-2 py-2 text-xs text-muted-foreground">Loading agents…</p> : null}
              {shell.agentError ? <p role="alert" className="px-2 py-2 text-xs text-destructive">{shell.agentError}</p> : null}
            </div>
            <Accordion multiple defaultValue={["projects", "recents"]} className="mt-6 gap-6">
              <AccordionItem value="projects" className="border-0 not-last:border-0">
                <div className="mb-2 flex items-center gap-1 px-2">
                  <AccordionTrigger className="items-center px-0 py-1 text-[13px] font-normal text-muted-foreground hover:text-foreground hover:no-underline [&_[data-slot=accordion-trigger-icon]]:size-3">Projects</AccordionTrigger>
                  <Button variant="ghost" size="icon-xs" aria-label="Add project" onClick={() => shell.setWorkspaceBrowserOpen(true)}><Plus className="size-3.5" /></Button>
                </div>
                <AccordionContent className="pb-0">
                  <Accordion multiple value={expandedProjects} onValueChange={setExpandedProjects} className="gap-px">
                    {projects.map((project) => {
                      const expanded = expandedProjects.includes(project.path)
                      return (
                        <AccordionItem value={project.path} key={project.id} className="border-0 not-last:border-0">
                          <div className={cn("group/project flex items-center gap-1 rounded-lg hover:bg-sidebar-accent", project.id === shell.activeWorkspace?.id && !shell.activeAgentId && !shell.activeChatId && "bg-sidebar-accent")}>

                            <AccordionTrigger title={project.path} className="h-[30px] min-w-0 items-center gap-2.5 px-2 py-0 text-[14px] font-normal hover:bg-transparent hover:no-underline [&_[data-slot=accordion-trigger-icon]]:size-3 [&_[data-slot=accordion-trigger-icon]]:opacity-0 group-hover/project:[&_[data-slot=accordion-trigger-icon]]:opacity-100 group-focus-within/project:[&_[data-slot=accordion-trigger-icon]]:opacity-100">
                              {expanded ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                              <span className="min-w-0 flex-1 truncate">{project.name}</span>
                            </AccordionTrigger>
                            <Button variant="ghost" size="icon-xs" aria-label={`New chat in ${project.name}`} title={`New chat in ${project.name}`} className="opacity-0 transition-opacity group-hover/project:opacity-100 group-focus-within/project:opacity-100" onClick={() => openProject(project.id)}><Plus className="size-3.5" /></Button>
                          </div>
                          <AccordionContent className="space-y-0.5 pb-0">
                            <SidebarChatList shell={shell} workingDirectory={project.path} projectName={project.name} nested />
                          </AccordionContent>
                        </AccordionItem>
                      )
                    })}
                  </Accordion>
                  {shell.isWorkspaceHistoryLoading ? <p className="px-2 py-2 text-xs text-muted-foreground">Loading projects…</p> : !projects.length ? <p className="px-2 py-2 text-xs text-muted-foreground">{search ? "No matching projects" : "Open a folder to get started."}</p> : null}
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="recents" className="border-0 not-last:border-0">
                <AccordionTrigger className="mb-2 items-center px-2 py-1 text-[13px] font-normal text-muted-foreground hover:text-foreground hover:no-underline [&_[data-slot=accordion-trigger-icon]]:size-3">Recents</AccordionTrigger>
                <AccordionContent className="pb-0">
                  <SidebarChatList shell={shell} query={search.trim()} pageSize={12} />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            {shell.sidebarChatError ? <p role="alert" className="px-2 py-2 text-xs text-destructive">{shell.sidebarChatError}</p> : null}
          </>
        )}
      </div></ScrollArea>
      <CreateAgentDialog shell={shell} open={agentDialogOpen} onOpenChange={setAgentDialogOpen} />
    </aside>
  )
}
