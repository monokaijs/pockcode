import { LoaderCircle } from "lucide-react"
import { useMemo, useRef } from "react"
import { ChatMessageRow } from "@/components/session/chat-message-row"
import { ChatWorkBlock } from "@/components/session/chat-work-block"
import { ChatFileChangeBlock } from "@/components/session/chat-file-change-block"
import { chatRenderEntryId } from "@/lib/session"
import { useChatPane } from "@/components/session/chat-pane-context"
import type { ChatPaneState } from "@/components/session/chat-pane-state"
import { ChatMessageNavigation } from "@/components/session/chat-message-navigation"
import { chatNavigationItems } from "@/lib/chat-navigation"

export function ChatMessageList() {
  const pane = useChatPane()
  const contentRef = useRef<HTMLDivElement>(null)
  const previousScrollTopRef = useRef(0)
  const navigationItems = useMemo(() => chatNavigationItems(pane.messages), [pane.messages])

  return (
    <div className="relative min-h-0 min-w-0">
      <div
        className="session-chat-scroll h-full min-h-0 overflow-auto px-6 py-6 ide-scrollbar"
        ref={pane.scrollRef}
        onScroll={(event) => {
          const viewport = event.currentTarget
          pane.followLatestRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48 &&
            (pane.followLatestRef.current || viewport.scrollTop >= previousScrollTopRef.current)
          previousScrollTopRef.current = viewport.scrollTop
        }}
      >
        <div className="flex min-h-full flex-col" ref={contentRef}>
          {(pane.isLoading || pane.isMessagesLoading) && !pane.messages.length ? (
            <ChatMessageLoadingIndicator />
          ) : pane.renderEntries.length ? (
            <div className="session-conversation-column mx-auto grid w-full gap-5">
              {pane.renderEntries.map((entry) => (
                <div className="min-w-0" data-chat-message-id={entry.type === "message" ? entry.message.id : undefined} key={chatRenderEntryId(entry)}>
                  <ChatRenderEntryView entry={entry} />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-[13px] text-muted-foreground">
              {pane.accounts.length ? "New chat" : "Connect a provider"}
            </div>
          )}
        </div>
      </div>
      <ChatMessageNavigation
        contentRef={contentRef}
        items={navigationItems}
        key={pane.chat?.id ?? "new"}
        onNavigate={() => { pane.followLatestRef.current = false }}
        scrollRef={pane.scrollRef}
      />
    </div>
  )
}

function ChatMessageLoadingIndicator() {
  return (
    <div className="grid flex-1 place-items-center text-[13px] text-muted-foreground">
      <span className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin text-info" />
        Loading
      </span>
    </div>
  )
}

function ChatRenderEntryView({ entry }: { entry: ChatPaneState["renderEntries"][number] }) {
  const pane = useChatPane()
  const entryId = chatRenderEntryId(entry)
  const animateIn = pane.appendedEntryIds.has(entryId)
  if (entry.type === "work") {
    return (
      <ChatWorkBlock
        animateIn={animateIn}
        completedAt={entry.completedAt}
        dragOverQueuedRunId={pane.dragOverQueuedRunId}
        finished={entry.finished}
        messages={entry.messages}
        startedAt={entry.startedAt}
        onDeleteQueuedMessage={pane.onDeleteQueuedMessage}
        onEditQueuedMessage={pane.onEditQueuedMessage}
        onQueuedDragEnd={() => pane.setDragOverQueuedRunId(null)}
        onQueuedDragEnter={pane.setDragOverQueuedRunId}
        onQueuedDrop={pane.reorderQueuedMessage}
        onSteerQueuedMessage={pane.onSteerQueuedMessage}
      />
    )
  }
  if (entry.type === "fileChange") {
    return <ChatFileChangeBlock animateIn={animateIn} messages={entry.messages} workspacePath={pane.workspace.path} />
  }
  return (
    <ChatMessageRow
      animateIn={animateIn}
      dragOverQueuedRunId={pane.dragOverQueuedRunId}
      message={entry.message}
      onDeleteQueuedMessage={pane.onDeleteQueuedMessage}
      onEditQueuedMessage={pane.onEditQueuedMessage}
      onQueuedDragEnd={() => pane.setDragOverQueuedRunId(null)}
      onQueuedDragEnter={pane.setDragOverQueuedRunId}
      onQueuedDrop={pane.reorderQueuedMessage}
      onSteerQueuedMessage={pane.onSteerQueuedMessage}
    />
  )
}
