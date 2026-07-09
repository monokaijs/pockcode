import { ChevronRight, LoaderCircle, Wrench } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { ChatMessageRow } from "@/components/session/chat-message-row"
import { useAppendAnimationIds } from "@/components/session/chat-pane-animation"
import type { ChatMessageResponse } from "@/lib/api-client"
import {
  findLast,
  firstToolAction,
  groupWorkMessages,
  isRunningPlaceholderMessage,
  isToolMessage,
  parseFileChangeMessage,
  workDurationLabel,
} from "@/lib/session"
import { cn } from "@/lib/utils"
import { toolCallIcon, toolCallTitle } from "@/components/session/chat-tool-call-display"

function WorkActivityStatus({ messages }: { messages: ChatMessageResponse[] }) {
  const activeAction = findLast(messages, (message) => isToolMessage(message) && message.status === "STREAMING")
  const Icon = activeAction ? toolCallIcon(activeAction) : LoaderCircle
  const label = activeAction ? toolCallTitle(activeAction) : "Thinking"

  return (
    <div className="chat-append-enter flex min-h-7 max-w-full items-center gap-2 text-[13px] text-muted-foreground">
      <Icon className={cn("size-3.5 shrink-0", activeAction ? "" : "animate-spin")} />
      <span className="min-w-0 truncate">
        {label}
        <AnimatedEllipsis />
      </span>
    </div>
  )
}

function AnimatedEllipsis() {
  return (
    <span aria-hidden="true" className="inline-flex w-4">
      <span className="chat-status-dot">.</span>
      <span className="chat-status-dot">.</span>
      <span className="chat-status-dot">.</span>
    </span>
  )
}

export function ChatWorkBlock({
  animateIn,
  completedAt,
  dragOverQueuedRunId,
  finished,
  messages,
  startedAt,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onQueuedDragEnd,
  onQueuedDragEnter,
  onQueuedDrop,
  onSteerQueuedMessage,
}: {
  animateIn?: boolean
  completedAt?: string | null
  dragOverQueuedRunId?: string | null
  finished: boolean
  messages: ChatMessageResponse[]
  startedAt?: string | null
  onDeleteQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage: (chatId: string, runId: string, content: string) => Promise<void>
  onQueuedDragEnd?: () => void
  onQueuedDragEnter?: (runId: string) => void
  onQueuedDrop?: (sourceRunId: string, targetRunId: string, placement: "after" | "before") => void
  onSteerQueuedMessage: (chatId: string, runId: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(!finished)
  const visibleMessages = useMemo(() => messages.filter((message) => !isRunningPlaceholderMessage(message)), [messages])
  const workEntries = useMemo(() => groupWorkMessages(visibleMessages, finished), [finished, visibleMessages])
  const messageIds = useMemo(() => visibleMessages.map((message) => message.id), [visibleMessages])
  const appendedMessageIds = useAppendAnimationIds(
    messageIds,
    visibleMessages[0]?.runId ?? visibleMessages[0]?.id ?? messages[0]?.runId ?? messages[0]?.id ?? null,
    !finished && expanded,
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  const duration = workDurationLabel(messages, startedAt, completedAt, finished, nowMs)

  useEffect(() => {
    setExpanded(!finished)
  }, [finished])

  useEffect(() => {
    if (finished) {
      return
    }
    setNowMs(Date.now())
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [finished])

  return (
    <section className={cn("min-w-0 text-[13px] text-muted-foreground", animateIn && "chat-append-enter")}>
      <button
        className="flex h-6 max-w-full items-center gap-1.5 text-left font-medium hover:text-foreground"
        type="button"
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <span className="truncate">{duration ? `Worked for ${duration}` : "Worked"}</span>
      </button>
      {expanded ? (
        <div className="mt-2 grid gap-3">
          {workEntries.map((entry) => entry.type === "actionGroup" ? (
            <CompactActionGroup
              animateIn={entry.messages.some((message) => appendedMessageIds.has(message.id))}
              dragOverQueuedRunId={dragOverQueuedRunId}
              key={entry.id}
              messages={entry.messages}
              onDeleteQueuedMessage={onDeleteQueuedMessage}
              onEditQueuedMessage={onEditQueuedMessage}
              onQueuedDragEnd={onQueuedDragEnd}
              onQueuedDragEnter={onQueuedDragEnter}
              onQueuedDrop={onQueuedDrop}
              onSteerQueuedMessage={onSteerQueuedMessage}
            />
          ) : (
            <ChatMessageRow
              animateIn={appendedMessageIds.has(entry.message.id)}
              dragOverQueuedRunId={dragOverQueuedRunId}
              key={entry.message.id}
              message={entry.message}
              showActions={false}
              onDeleteQueuedMessage={onDeleteQueuedMessage}
              onEditQueuedMessage={onEditQueuedMessage}
              onQueuedDragEnd={onQueuedDragEnd}
              onQueuedDragEnter={onQueuedDragEnter}
              onQueuedDrop={onQueuedDrop}
              onSteerQueuedMessage={onSteerQueuedMessage}
            />
          ))}
          {!finished ? <WorkActivityStatus messages={messages} /> : null}
        </div>
      ) : null}
    </section>
  )
}

function CompactActionGroup({
  animateIn,
  dragOverQueuedRunId,
  messages,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onQueuedDragEnd,
  onQueuedDragEnter,
  onQueuedDrop,
  onSteerQueuedMessage,
}: {
  animateIn?: boolean
  dragOverQueuedRunId?: string | null
  messages: ChatMessageResponse[]
  onDeleteQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage: (chatId: string, runId: string, content: string) => Promise<void>
  onQueuedDragEnd?: () => void
  onQueuedDragEnter?: (runId: string) => void
  onQueuedDrop?: (sourceRunId: string, targetRunId: string, placement: "after" | "before") => void
  onSteerQueuedMessage: (chatId: string, runId: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const firstTool = messages.find(isToolMessage)
  const Icon = firstTool ? toolCallIcon(firstTool) : Wrench
  const label = useMemo(() => {
    const counts = messages.reduce(
      (current, message) => {
        if (message.kind === "FILE_CHANGE") {
          current.edits += Math.max(1, parseFileChangeMessage(message).length)
          return current
        }
        if (message.kind === "COMMAND_EXECUTION") {
          const action = firstToolAction(message.content)
          if (action?.startsWith("read ") || action?.startsWith("list ")) {
            current.reads += 1
            return current
          }
          if (action?.startsWith("search")) {
            current.searches += 1
            return current
          }
          current.commands += 1
          return current
        }
        if (isToolMessage(message)) {
          current.tools += 1
        }
        return current
      },
      { commands: 0, edits: 0, reads: 0, searches: 0, tools: 0 },
    )
    const phrases = [
      counts.reads ? `Read ${counts.reads} ${counts.reads === 1 ? "file" : "files"}` : "",
      counts.searches ? (counts.searches === 1 ? "searched code" : `searched code ${counts.searches} times`) : "",
      counts.commands ? `ran ${counts.commands === 1 ? "a command" : `${counts.commands} commands`}` : "",
      counts.edits ? `edited ${counts.edits === 1 ? "a file" : `${counts.edits} files`}` : "",
      counts.tools ? `used ${counts.tools === 1 ? "a tool" : `${counts.tools} tools`}` : "",
    ].filter(Boolean)
    if (!phrases.length) {
      return "Completed actions"
    }
    return phrases.length === 1
      ? phrases[0] ?? "Completed actions"
      : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
  }, [messages])

  return (
    <article className={cn("min-w-0 text-[13px] text-muted-foreground", animateIn && "chat-append-enter")}>
      <button
        className="flex min-h-7 max-w-full items-center gap-2 text-left hover:text-foreground"
        type="button"
        onClick={() => setExpanded((current) => !current)}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
      </button>
      {expanded ? (
        <div className="ml-5 mt-1 grid gap-2 border-l border-border pl-3">
          {messages.map((message) => (
            <ChatMessageRow
              dragOverQueuedRunId={dragOverQueuedRunId}
              key={message.id}
              message={message}
              showActions={false}
              onDeleteQueuedMessage={onDeleteQueuedMessage}
              onEditQueuedMessage={onEditQueuedMessage}
              onQueuedDragEnd={onQueuedDragEnd}
              onQueuedDragEnter={onQueuedDragEnter}
              onQueuedDrop={onQueuedDrop}
              onSteerQueuedMessage={onSteerQueuedMessage}
            />
          ))}
        </div>
      ) : null}
    </article>
  )
}
