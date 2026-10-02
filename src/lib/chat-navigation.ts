import type { ChatMessageResponse } from "@/lib/api-client"
import { isDisplayAssistantMessage, isQueuedUserMessage, readRecordString } from "@/lib/session"

export type ChatNavigationItem = {
  id: string
  prompt: string
  response: string
}

export function chatNavigationItems(messages: ChatMessageResponse[]): ChatNavigationItem[] {
  const items: ChatNavigationItem[] = []
  for (const message of messages) {
    if (isQueuedUserMessage(message)) continue
    if (message.role === "USER") {
      const prompt = messagePreview(message)
      if (prompt || message.blocks?.length) {
        items.push({ id: message.id, prompt: prompt || "Attached content", response: "" })
      }
    } else if (isDisplayAssistantMessage(message) || message.kind === "PLAN") {
      const item = items.at(-1)
      const preview = messagePreview(message)
      if (item && preview) item.response = preview
    }
  }
  return items
}

function messagePreview(message: ChatMessageResponse): string {
  let text = message.content.trim() || message.blocks?.flatMap((block) => {
    if (block.type === "text") return [block.text]
    if (block.type === "resource_link") return [block.title || block.name]
    return []
  }).join(" ") || ""

  // Imported Codex transcripts also contain context updates and encoded question replies.
  text = text.replace(/<(external_codex_apps_open_page|environment_context)>[\s\S]*?<\/\1>/gu, "").trim()
  const questionReply = text.match(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/u)
  if (questionReply) {
    try {
      const replies: unknown = JSON.parse(questionReply[1])
      if (Array.isArray(replies)) {
        const questions = replies.map((reply) => readRecordString(reply, "question") || readRecordString(reply, "answer")).filter(Boolean)
        text = text.replace(questionReply[0], questions.join(" "))
      }
    } catch {
      // Keep malformed imports readable instead of failing the navigation rail.
    }
  }
  return text.slice(0, 2000)
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/(?:^|\n)\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/gu, " ")
    .replace(/[*_`~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
}
