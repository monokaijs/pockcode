import { Bot, Send, UserRound, Wrench } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { AgentMessage, Project } from "@/types/ide"

export function AgentPanel({
  messages,
  project,
  onSendMessage,
}: {
  messages: AgentMessage[]
  project: Project
  onSendMessage: (content: string) => void
}) {
  const [draft, setDraft] = useState("")

  const send = () => {
    const content = draft.trim()
    if (!content) {
      return
    }
    onSendMessage(content)
    setDraft("")
  }

  return (
    <aside className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] border-l bg-[#111215]">
      <div className="flex h-9 min-w-0 items-center gap-2 border-b px-3">
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">AI Agent</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{project.name}</span>
      </div>

      <div className="min-h-0 space-y-3 overflow-auto p-3 ide-scrollbar">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>

      <div className="sticky bottom-0 border-t bg-background/95 p-3 backdrop-blur">
        <div className="rounded-xl border bg-background p-2 shadow-sm">
          <textarea
            className="min-h-20 w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Ask the agent..."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                send()
              }
            }}
          />
          <div className="flex items-center justify-between gap-2 pt-2">
            <span className="text-[11px] text-muted-foreground">Cmd/Ctrl Enter</span>
            <button disabled={!draft.trim()} size="sm" onClick={send}>
              <Send className="size-3.5" /> Send
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function MessageBubble({ message }: { message: AgentMessage }) {
  const Icon = roleIcon(message.role)
  const user = message.role === "user"
  return (
    <article className={cn("flex gap-2", user && "flex-row-reverse")}> 
      <div
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground",
          user && "text-primary",
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className={cn("min-w-0 flex-1", user && "text-right")}> 
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          {user ? <span className="ml-auto">{message.timestamp}</span> : <span>{message.timestamp}</span>}
          {message.meta ? <Badge variant="outline">{message.meta}</Badge> : null}
        </div>
        <div
          className={cn(
            "rounded-xl border bg-background p-3 text-sm leading-6 shadow-sm",
            user && "border-primary/25 bg-primary/10 text-left",
          )}
        >
          {message.title ? <div className="mb-1 font-medium">{message.title}</div> : null}
          <p className="whitespace-pre-wrap text-muted-foreground">{message.content}</p>
        </div>
      </div>
    </article>
  )
}

function roleIcon(role: AgentMessage["role"]) {
  if (role === "user") {
    return UserRound
  }
  if (role === "tool") {
    return Wrench
  }
  return Bot
}
