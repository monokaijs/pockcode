import { ChevronDown, FileText } from "lucide-react"
import { useState } from "react"
import type { ChatMessageResponse } from "@/lib/api-client"
import { editedFilesTitle, groupFileChanges, parseFileChangeMessage, workspaceRelativeDisplayPath } from "@/lib/session"
import { cn } from "@/lib/utils"

export function ChatFileChangeBlock({
  animateIn,
  messages,
  workspacePath,
}: {
  animateIn?: boolean
  messages: ChatMessageResponse[]
  workspacePath: string
}) {
  const [expanded, setExpanded] = useState(false)
  const changes = groupFileChanges(messages.flatMap(parseFileChangeMessage).map((change) => ({
    ...change,
    path: workspaceRelativeDisplayPath(change.path, workspacePath),
  })))
  const visibleChanges = expanded ? changes : changes.slice(0, 3)
  const hiddenCount = Math.max(0, changes.length - visibleChanges.length)
  const totals = changes.reduce(
    (current, change) => ({
      additions: current.additions + change.additions,
      deletions: current.deletions + change.deletions,
    }),
    { additions: 0, deletions: 0 },
  )

  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-card p-3 text-[13px]", animateIn && "chat-append-enter")}>
      <div className="flex min-w-0 items-center gap-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">{editedFilesTitle(changes, messages.length)}</div>
          <div className="mt-0.5 text-[12px] text-diff-addition-foreground">
            +{totals.additions} <span className="text-diff-deletion-foreground">-{totals.deletions}</span>
          </div>
        </div>
      </div>
      {changes.length > 1 ? (
        <div className="mt-3 grid gap-2 border-t border-border pt-3">
          {visibleChanges.map((change, index) => (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px]" key={`${change.path}:${index}`}>
              <span className="truncate text-foreground">{change.path}</span>
              <span className="text-diff-addition-foreground">
                +{change.additions} <span className="text-diff-deletion-foreground">-{change.deletions}</span>
              </span>
            </div>
          ))}
          {changes.length > 3 ? (
            <button
              className="mt-1 flex h-6 w-fit items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              type="button"
              onClick={() => setExpanded((current) => !current)}
            >
              <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Collapse files" : `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
