import { LoaderCircle } from "lucide-react"
import { ChatMessageRow } from "@/components/session/chat-message-row"
import { ChatWorkBlock } from "@/components/session/chat-work-block"
import { ChatFileChangeBlock } from "@/components/session/chat-file-change-block"
import { chatRenderEntryId } from "@/lib/session"
import { useChatPane } from "@/components/session/chat-pane-context"
import type { ChatPaneState } from "@/components/session/chat-pane-state"

export function ChatMessageList() {
  const pane = useChatPane()

  return (
    <div className="min-h-0 overflow-auto px-4 py-4 ide-scrollbar" ref={pane.scrollRef}>
      {(pane.isLoading || pane.isMessagesLoading) && !pane.messages.length ? (
        <ChatMessageLoadingIndicator />
      ) : pane.renderEntries.length ? (
        <div className="mx-auto grid w-full max-w-3xl gap-3">
          {pane.renderEntries.map((entry) => <ChatRenderEntryView entry={entry} key={chatRenderEntryId(entry)} />)}
        </div>
      ) : (
        <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
          {pane.accounts.length ? "New chat" : "Connect a provider"}
        </div>
      )}
    </div>
  )
}

function ChatMessageLoadingIndicator() {
  return (
    <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
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
