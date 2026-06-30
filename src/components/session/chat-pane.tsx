import { ChatComposer } from "@/components/session/chat-composer"
import { ChatMessageList } from "@/components/session/chat-message-list"
import { ChatPaneHeader } from "@/components/session/chat-pane-header"
import { ChatFileLinkContext, ChatPaneStateContext } from "@/components/session/chat-pane-context"
import { useChatPaneState } from "@/components/session/chat-pane-state"
import type { ChatPaneProps } from "@/components/session/chat-pane-types"

export function ChatPane(props: ChatPaneProps) {
  const pane = useChatPaneState(props)

  return (
    <ChatPaneStateContext.Provider value={pane}>
      <ChatFileLinkContext.Provider value={pane.fileLinkContext}>
        <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card">
          <ChatPaneHeader />
          <ChatMessageList />
          <ChatComposer />
        </section>
      </ChatFileLinkContext.Provider>
    </ChatPaneStateContext.Provider>
  )
}
