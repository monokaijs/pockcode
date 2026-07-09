import { Check, ChevronRight, Copy, GitBranch, GripVertical, LoaderCircle, Pencil, Route, Square } from "lucide-react"
import type { DragEvent as ReactDragEvent } from "react"
import { useContext, useMemo, useState } from "react"
import { MarkdownContent } from "@/components/session/chat-markdown"
import { apiClient, type ChatMessageResponse } from "@/lib/api-client"
import {
  firstToolAction,
  isOptimisticMessage,
  isToolMessage,
  parseFileChangeMessage,
  readRecord,
  readRecordString,
  serverRequestResponseFor,
} from "@/lib/session"
import { cn } from "@/lib/utils"
import type { ParsedFileChange } from "@/types/session"
import { ChatFileLinkContext, useChatPane } from "@/components/session/chat-pane-context"
import { toolCallIcon, toolCallTitle } from "@/components/session/chat-tool-call-display"

export function ChatMessageRow({
  animateIn,
  dragOverQueuedRunId,
  message,
  showActions = true,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onQueuedDragEnd,
  onQueuedDragEnter,
  onQueuedDrop,
  onSteerQueuedMessage,
}: {
  animateIn?: boolean
  dragOverQueuedRunId?: string | null
  message: ChatMessageResponse
  showActions?: boolean
  onDeleteQueuedMessage?: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage?: (chatId: string, runId: string, content: string) => Promise<void>
  onQueuedDragEnd?: () => void
  onQueuedDragEnter?: (runId: string) => void
  onQueuedDrop?: (sourceRunId: string, targetRunId: string, placement: "after" | "before") => void
  onSteerQueuedMessage?: (chatId: string, runId: string) => Promise<void>
}) {
  const fileLinks = useContext(ChatFileLinkContext)

  if (message.kind === "PLAN") {
    return <PlanMessageRow animateIn={animateIn} message={message} />
  }

  if (isToolMessage(message)) {
    return <ToolCallMessageRow animateIn={animateIn} message={message} />
  }

  const user = message.role === "USER"
  const error = message.kind === "ERROR"
  const queued = user && message.status === "PENDING" && Boolean(message.runId)
  const optimistic = isOptimisticMessage(message)
  const content = message.content || (message.status === "STREAMING" ? "Running" : "")
  const queueSortingEnabled = queued && Boolean(onQueuedDrop)
  const draggingOver = queued && message.runId === dragOverQueuedRunId
  const showMessageActions = showActions && message.role === "ASSISTANT" && message.kind === "CHAT" && message.status === "COMPLETED"

  return (
    <article
      className={cn(
        "grid min-w-0 gap-1",
        animateIn && "chat-append-enter",
        user && "justify-items-end",
        optimistic && "opacity-60 transition-opacity",
        draggingOver && "rounded-md outline outline-1 outline-primary/70",
      )}
      draggable={queueSortingEnabled}
      onDragEnd={() => onQueuedDragEnd?.()}
      onDragEnter={() => {
        if (queued && message.runId) {
          onQueuedDragEnter?.(message.runId)
        }
      }}
      onDragOver={(event) => {
        if (queued) {
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
        }
      }}
      onDragStart={(event: ReactDragEvent<HTMLElement>) => {
        if (!queued || !message.runId) {
          return
        }
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", message.runId)
      }}
      onDrop={(event) => {
        if (!queued || !message.runId) {
          return
        }
        event.preventDefault()
        const sourceRunId = event.dataTransfer.getData("text/plain")
        if (sourceRunId) {
          const bounds = event.currentTarget.getBoundingClientRect()
          const placement = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before"
          onQueuedDrop?.(sourceRunId, message.runId, placement)
        }
      }}
    >
      <div
        className={cn(
          "min-w-0 max-w-full text-[13px] leading-6",
          user
            ? "max-w-[min(680px,100%)] rounded-md bg-muted px-3 py-2 text-foreground"
            : error
              ? "w-full text-destructive"
              : "w-full text-foreground",
        )}
      >
        <MarkdownContent
          animateChanges={!user}
          compact={user}
          content={content}
          openFileLink={fileLinks?.openFileLink}
          scopeKey={message.id}
        />
      </div>
      {showMessageActions ? <ChatMessageActionRail message={message} /> : null}
      {queued && message.runId ? (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="grid size-5 cursor-grab place-items-center rounded text-muted-foreground" title="Drag to reorder">
            <GripVertical className="size-3.5" />
          </span>
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            type="button"
            onClick={() => void onSteerQueuedMessage?.(message.chatId, message.runId!)}
          >
            Steer
          </button>
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            type="button"
            onClick={() => void onEditQueuedMessage?.(message.chatId, message.runId!, message.content)}
          >
            Edit
          </button>
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-destructive"
            type="button"
            onClick={() => void onDeleteQueuedMessage?.(message.chatId, message.runId!)}
          >
            Delete
          </button>
        </div>
      ) : null}
    </article>
  )
}

function ChatMessageActionRail({ message }: { message: ChatMessageResponse }) {
  const pane = useChatPane()
  const [copied, setCopied] = useState(false)
  const [forking, setForking] = useState(false)
  const canCopy = Boolean(message.content.trim())
  const canFork = Boolean(message.turnId) && !pane.running && !pane.isSwitchingAccount && !pane.threadAction

  const copyMessage = async () => {
    if (!canCopy) {
      return
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(message.content)
    } else {
      const textarea = document.createElement("textarea")
      textarea.value = message.content
      textarea.style.left = "-9999px"
      textarea.style.position = "fixed"
      textarea.style.top = "0"
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      try {
        document.execCommand("copy")
      } finally {
        document.body.removeChild(textarea)
      }
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const forkFromMessage = async () => {
    if (!canFork) {
      return
    }
    setForking(true)
    try {
      await pane.forkChat(message.turnId)
    } finally {
      setForking(false)
    }
  }

  return (
    <div className="flex min-h-6 items-center gap-1 text-[11px] font-medium text-muted-foreground">
      <button
        aria-label="Copy response"
        className="inline-flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
        disabled={!canCopy}
        title="Copy response"
        type="button"
        onClick={() => void copyMessage()}
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <button
        aria-label="Fork chat from this response"
        className="inline-flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
        disabled={!canFork}
        title={message.turnId ? "Fork chat from this response" : "Fork point unavailable"}
        type="button"
        onClick={() => void forkFromMessage()}
      >
        {forking ? <LoaderCircle className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
        <span>{forking ? "Forking" : "Fork chat"}</span>
      </button>
    </div>
  )
}

function PlanMessageRow({ animateIn, message }: { animateIn?: boolean; message: ChatMessageResponse }) {
  const pane = useChatPane()
  const [acceptingPlan, setAcceptingPlan] = useState(false)
  const fileLinks = useContext(ChatFileLinkContext)
  const content = message.content.trim()
  const streaming = message.status === "STREAMING"
  const steps = useMemo<RenderPlanStep[]>(() => {
    const metadata = readRecord(message.metadata)
    const rawSteps = metadata.planSteps
    if (!Array.isArray(rawSteps)) {
      return []
    }
    return rawSteps
      .map((value) => {
        const record = readRecord(value)
        const step = readRecordString(record, "step")
        const rawStatus = readRecordString(record, "status")
        const status = rawStatus === "completed" || rawStatus === "inProgress" || rawStatus === "pending"
          ? rawStatus
          : "pending"
        return step ? { status, step } : null
      })
      .filter((step): step is RenderPlanStep => Boolean(step))
  }, [message.metadata])
  const title = steps.length ? "Updated Plan" : "Plan"
  const showPlanActions = !streaming && message.status === "COMPLETED" && Boolean(content) && !steps.length
  const planActionDisabled = acceptingPlan || pane.sending || pane.running || pane.isSwitchingAccount || Boolean(pane.threadAction)

  const accept = async () => {
    if (planActionDisabled) {
      return
    }
    setAcceptingPlan(true)
    try {
      await pane.acceptPlan()
    } catch {
      // The pane writes the recoverable error into the composer notice.
    } finally {
      setAcceptingPlan(false)
    }
  }

  return (
    <article className={cn("min-w-0 rounded-md border border-border bg-card p-3 text-[13px] text-foreground", animateIn && "chat-append-enter")}>
      <div className="mb-2 flex min-h-6 items-center gap-2 text-[12px] font-semibold text-muted-foreground">
        {streaming ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-info" /> : <Route className="size-3.5 shrink-0 text-info" />}
        <span>{title}</span>
      </div>
      {content ? (
        <MarkdownContent
          animateChanges={streaming}
          content={content}
          openFileLink={fileLinks?.openFileLink}
          scopeKey={message.id}
        />
      ) : steps.length ? null : (
        <div className="text-[12px] text-muted-foreground">Planning</div>
      )}
      {steps.length ? (
        <div className={cn("grid gap-1.5", content && "mt-3")}>
          {steps.map((step, index) => (
            <PlanStepRow key={`${step.status}:${index}:${step.step}`} step={step} />
          ))}
        </div>
      ) : null}
      {showPlanActions ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={planActionDisabled}
            title="Switch to Default mode and implement this plan"
            type="button"
            onClick={() => void accept()}
          >
            {acceptingPlan ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            <span>{acceptingPlan ? "Accepting" : "Accept plan"}</span>
          </button>
          <button
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 text-[12px] font-semibold text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
            disabled={planActionDisabled}
            title="Stay in Plan mode and revise with your next message"
            type="button"
            onClick={pane.keepPlanning}
          >
            <Pencil className="size-3.5" />
            <span>Keep planning</span>
          </button>
        </div>
      ) : null}
    </article>
  )
}

type RenderPlanStep = {
  status: "completed" | "inProgress" | "pending"
  step: string
}

function PlanStepRow({ step }: { step: RenderPlanStep }) {
  const completed = step.status === "completed"
  const inProgress = step.status === "inProgress"
  return (
    <div className={cn(
      "grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-[12px] leading-5",
      completed ? "text-muted-foreground" : "text-foreground",
    )}>
      <span className="mt-0.5 grid size-4 place-items-center">
        {completed ? (
          <Check className="size-3.5 text-success" />
        ) : inProgress ? (
          <LoaderCircle className="size-3.5 animate-spin text-info" />
        ) : (
          <Square className="size-3 text-muted-foreground" />
        )}
      </span>
      <span className={cn("min-w-0", completed && "line-through decoration-muted-foreground/70")}>
        {step.step}
      </span>
    </div>
  )
}

function ToolCallMessageRow({ animateIn, message }: { animateIn?: boolean; message: ChatMessageResponse }) {
  const [expanded, setExpanded] = useState(false)
  const [responding, setResponding] = useState<"approve" | "deny" | null>(null)
  const fileLinks = useContext(ChatFileLinkContext)
  const Icon = toolCallIcon(message)
  const title = toolCallTitle(message)
  const fileChanges = message.kind === "FILE_CHANGE" ? parseFileChangeMessage(message) : []
  const detail = message.kind === "FILE_CHANGE"
    ? null
    : message.kind === "COMMAND_EXECUTION"
      ? (() => {
          const action = firstToolAction(message.content)
          if (action?.startsWith("read ") || action?.startsWith("list ") || action?.startsWith("search")) {
            return null
          }
          const output = message.content.match(/(?:^|\n)Output\s*\n~~~([\w.-]*)\n([\s\S]*?)\n~~~/u)
          const language = output?.[1]?.trim() || "text"
          const value = output?.[2]?.trim()
          return value ? `~~~${language}\n${value}\n~~~` : message.content.trim() || null
        })()
      : message.content.trim() || null
  const hasDetail = message.kind === "FILE_CHANGE" || Boolean(detail)
  const canRespond = message.status === "PENDING" && Boolean(message.requestId) &&
    message.kind === "APPROVAL"

  const respond = async (approved: boolean) => {
    if (!message.requestId) {
      return
    }
    setResponding(approved ? "approve" : "deny")
    try {
      await apiClient.chats.respondToServerRequest(message.chatId, message.requestId, serverRequestResponseFor(message, approved))
    } finally {
      setResponding(null)
    }
  }

  return (
    <article className={cn("min-w-0 text-[13px] text-muted-foreground", animateIn && "chat-append-enter")}>
      <div className="flex min-h-7 max-w-full items-center gap-2">
        <button
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-left",
            hasDetail && "hover:text-foreground",
            !hasDetail && "cursor-default",
          )}
          disabled={!hasDetail}
          type="button"
          onClick={() => {
            if (hasDetail) {
              setExpanded((current) => !current)
            }
          }}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {hasDetail ? (
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
          ) : null}
        </button>
        {canRespond ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-success hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(responding)}
              type="button"
              onClick={() => void respond(true)}
            >
              {responding === "approve" ? "Approving" : "Approve"}
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(responding)}
              type="button"
              onClick={() => void respond(false)}
            >
              {responding === "deny" ? "Denying" : "Deny"}
            </button>
          </div>
        ) : null}
      </div>
      {expanded && hasDetail ? (
        <div className="ml-5 mt-1 min-w-0 border-l border-border pl-3 text-foreground">
          {message.kind === "FILE_CHANGE" ? (
            <FileChangeStatsList changes={fileChanges} fallbackCount={1} />
          ) : (
            <MarkdownContent compact content={detail || title} openFileLink={fileLinks?.openFileLink} />
          )}
        </div>
      ) : null}
    </article>
  )
}

function FileChangeStatsList({
  changes,
  fallbackCount,
}: {
  changes: ParsedFileChange[]
  fallbackCount: number
}) {
  if (!changes.length) {
    return <div className="text-[12px] text-muted-foreground">Edited {fallbackCount} files</div>
  }

  return (
    <div className="grid gap-1.5">
      {changes.map((change, index) => (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px]" key={`${change.path}:${index}`}>
          <span className="truncate text-foreground">{change.path}</span>
          <span className="text-diff-addition-foreground">
            +{change.additions} <span className="text-diff-deletion-foreground">-{change.deletions}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
