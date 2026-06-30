import type { ReactNode } from "react"
import { createContext, useContext, useMemo } from "react"
import type { ChatMessageResponse, ChatResponse } from "@/lib/api-client"

type ChatListContextValue = {
  chatStatusById: Record<string, ChatResponse["status"]>
  chats: ChatResponse[]
  isChatRunning: (chatId: string) => boolean
  isLoading: boolean
}

const ChatListContext = createContext<ChatListContextValue | null>(null)

export function ChatListProvider({
  children,
  chats,
  isLoading,
  messagesByChatId,
}: {
  children: ReactNode
  chats: ChatResponse[]
  isLoading: boolean
  messagesByChatId: Record<string, ChatMessageResponse[]>
}) {
  const chatStatusById = useMemo<Record<string, ChatResponse["status"]>>(
    () => Object.fromEntries(chats.map((chat): [string, ChatResponse["status"]] => [
      chat.id,
      chat.status === "RUNNING" || (messagesByChatId[chat.id] ?? []).some((message) => message.status === "STREAMING") ? "RUNNING" : chat.status,
    ])),
    [chats, messagesByChatId],
  )
  const value = useMemo<ChatListContextValue>(
    () => ({
      chatStatusById,
      chats,
      isChatRunning: (chatId) => chatStatusById[chatId] === "RUNNING",
      isLoading,
    }),
    [chatStatusById, chats, isLoading],
  )
  return <ChatListContext.Provider value={value}>{children}</ChatListContext.Provider>
}

export function useChatList(): ChatListContextValue {
  const value = useContext(ChatListContext)
  if (!value) {
    throw new Error("useChatList must be used within ChatListProvider.")
  }
  return value
}

