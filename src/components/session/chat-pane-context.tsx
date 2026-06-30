import { createContext, useContext } from "react"
import type { ChatPaneState } from "@/components/session/chat-pane-state"

export const ChatFileLinkContext = createContext<{ openFileLink: (href: string) => boolean } | null>(null)
export const ChatPaneStateContext = createContext<ChatPaneState | null>(null)

export function useChatPane(): ChatPaneState {
  const value = useContext(ChatPaneStateContext)
  if (!value) {
    throw new Error("useChatPane must be used within ChatPaneStateContext.")
  }
  return value
}
