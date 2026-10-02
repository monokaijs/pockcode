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
        <div className="h-full min-h-0 min-w-0 overflow-hidden">
          <section aria-label="Chat" className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-background">
            <ChatPaneHeader />
            <ChatMessageList />
            <ChatComposer />
          </section>
        </div>
      </ChatFileLinkContext.Provider>
    </ChatPaneStateContext.Provider>
  )
}
