import {
  FileText,
  LoaderCircle,
  Plug,
  Plus,
  Search,
  Server,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { ChatListScrollArea } from "@/components/session/chat-list-scroll-area"
import { PanelActionButton } from "@/components/session/panel-action-button"
import { ProviderMark } from "@/components/session/provider-icons"
import {
  compareSchedules,
  dateTimeLabel,
  recurrenceLabel,
} from "@/components/session/schedule-utils"
import { useChatList } from "@/components/session/chat-list-context"
import {
  compareChatsByUpdatedTime,
  hasChatStats,
  relativeTimeLabel,
} from "@/lib/session"
import { cn } from "@/lib/utils"
import type { MessageScheduleResponse } from "@/lib/api-client"
import type { SessionShellState } from "@/components/session/session-shell"
import type { ManagementView } from "@/types/session"

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
  { icon: Plug, id: "plugins", label: "Plugins" },
]

export function SessionSidebar({ shell }: { shell: SessionShellState }) {
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
        : shell.pluginsDialogOpen
          ? "plugins"
          : null
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
      .filter((chat) => {
        const normalized = chatSearch.trim().toLocaleLowerCase()
        if (!normalized) {
          return true
        }
        return [chat.title, chat.providerId, providerLabelById.get(chat.providerId) ?? ""]
          .some((value) => value.toLocaleLowerCase().includes(normalized))
      })
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

  if (!shell.activeWorkspace) {
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
