import { useEffect, useRef, useState } from "react"
import { Archive, Ellipsis, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useChatList } from "@/components/session/chat-list-context"
import type { SessionShellState } from "@/components/session/session-shell"
import { apiClient, type ChatResponse } from "@/lib/api-client"
import { cn } from "@/lib/utils"

function useChatPages(workingDirectory: string | undefined, query: string, pageSize: number, revision: number) {
  const [state, setState] = useState({ data: [] as ChatResponse[], nextCursor: null as string | null, loading: true, busy: false, error: null as string | null })
  const lastRevisionRef = useRef(revision)
  const refreshRef = useRef(() => {})
  const moreRef = useRef(() => {})
  useEffect(() => {
    let disposed = false
    let busy = false
    let refreshPending = false
    let windowSize = pageSize
    let nextCursor: string | null = null
    setState({ data: [], nextCursor: null, loading: true, busy: true, error: null })
    const finish = () => {
      busy = false
      if (!disposed) {
        setState((current) => ({ ...current, loading: false, busy: false }))
        if (refreshPending) { refreshPending = false; void refresh() }
      }
    }
    const refresh = async () => {
      if (disposed) return
      if (busy) { refreshPending = true; return }
      busy = true
      setState((current) => ({ ...current, busy: true }))
      try {
        let cursor: string | null = null
        const data: ChatResponse[] = []
        do {
          const page = await apiClient.chats.page({ workingDirectory, query, limit: pageSize, cursor })
          if (disposed) return
          data.push(...page.data)
          cursor = page.nextCursor
        } while (cursor && data.length < windowSize)
        nextCursor = cursor
        setState({ data, nextCursor, loading: false, busy: true, error: null })
      } catch (cause) {
        if (!disposed) setState((current) => ({ ...current, error: cause instanceof Error ? cause.message : "Unable to load chats." }))
      } finally { finish() }
    }
    const more = async () => {
      if (disposed || busy || !nextCursor) return
      busy = true
      setState((current) => ({ ...current, busy: true }))
      try {
        const page = await apiClient.chats.page({ workingDirectory, query, limit: pageSize, cursor: nextCursor })
        if (disposed) return
        nextCursor = page.nextCursor
        windowSize += page.data.length
        setState((current) => ({ ...current, data: [...new Map([...current.data, ...page.data].map((chat) => [chat.id, chat])).values()], nextCursor, error: null }))
      } catch (cause) {
        if (!disposed) setState((current) => ({ ...current, error: cause instanceof Error ? cause.message : "Unable to load more chats." }))
      } finally { finish() }
    }
    refreshRef.current = () => { void refresh() }
    moreRef.current = () => { void more() }
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [workingDirectory, query, pageSize])
  useEffect(() => {
    if (lastRevisionRef.current !== revision) { lastRevisionRef.current = revision; refreshRef.current() }
  }, [revision])
  return { ...state, loadMore: () => moreRef.current(), retry: () => refreshRef.current() }
}

export function SidebarChatList({ shell, workingDirectory, query = "", pageSize = 4, nested = false, projectName }: { shell: SessionShellState; workingDirectory?: string; query?: string; pageSize?: number; nested?: boolean; projectName?: string }) {
  const page = useChatPages(workingDirectory, query, pageSize, shell.sidebarChatRevision)
  const { chats, isChatRunning } = useChatList()
  const live = new Map(chats.map((chat) => [chat.id, chat]))
  const visible = page.data.filter((chat) => !shell.archivedChatIds[chat.id])
  return (
    <div className="space-y-px">
      {visible.map((saved) => {
        const chat = live.get(saved.id) ?? saved
        const active = !shell.activeAgentId && shell.activeChatId === chat.id && shell.navigationView === "home"
        const running = isChatRunning(chat.id) || chat.status === "RUNNING"
        return (
          <div key={chat.id} className={cn("group/chat flex min-w-0 items-center rounded-lg transition-colors hover:bg-sidebar-accent", nested && "ml-6", active && "bg-sidebar-accent")}>
            <Button variant="ghost" aria-current={active ? "true" : undefined} aria-busy={running || undefined} className="h-[30px] min-w-0 flex-1 justify-start gap-2 rounded-lg px-2 text-left text-[14px] font-normal text-sidebar-foreground hover:bg-transparent dark:hover:bg-transparent" title={chat.title} onClick={() => void shell.openSidebarChat(chat)}>
              <span className="min-w-0 flex-1 truncate">{chat.title}</span>
              {running ? <LoaderCircle aria-label="Running" className="size-3 shrink-0 animate-spin text-success" /> : null}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`Chat actions for ${chat.title}`} className="opacity-0 transition-opacity group-hover/chat:opacity-100 group-focus-within/chat:opacity-100 data-popup-open:opacity-100" render={<Button variant="ghost" size="icon-xs" />}><Ellipsis className="size-3.5" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void shell.archiveChat(chat.id, chat)}><Archive className="size-3.5" />Archive</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      })}
      {page.loading ? <p className={cn("px-2 py-2 text-xs text-muted-foreground", nested && "pl-8")}>Loading chats…</p> : !visible.length && !page.error ? <p className={cn("px-2 py-2 text-xs text-muted-foreground", nested && "pl-8")}>{query ? "No matching chats" : nested ? "No chats yet." : "Your chats will appear here."}</p> : null}
      {page.error ? <div role="alert" className="px-2 py-2 text-xs text-destructive">{page.error}<Button variant="link" size="xs" disabled={page.busy} onClick={page.retry}>Retry</Button></div> : null}
      {page.nextCursor ? <Button variant="ghost" size="sm" aria-label={projectName ? `Load more chats in ${projectName}` : "Load more recent chats"} disabled={page.busy} className={cn("h-7 justify-start px-2 text-xs font-normal text-muted-foreground", nested && "ml-6")} onClick={page.loadMore}>{page.busy ? <LoaderCircle className="size-3 animate-spin" /> : null}Load more</Button> : null}
    </div>
  )
}
