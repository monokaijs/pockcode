import { FilePlus2, FileSymlink, GitBranch, Minus, Plus, RefreshCcw, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { GitChange, Project } from "@/types/ide"

export function GitPanel({ project }: { project: Project }) {
  const changedCount = project.gitChanges.length
  const additions = project.gitChanges.reduce((sum, change) => sum + change.additions, 0)
  const deletions = project.gitChanges.reduce((sum, change) => sum + change.deletions, 0)

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-border bg-card text-card-foreground">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Source Control
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GitBranch className="size-4 text-muted-foreground" />
          <span className="min-w-0 truncate">{project.status.branch}</span>
        </div>
      </div>
      <div className="grid gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <Badge variant={changedCount ? "warning" : "success"}>
            {changedCount} changes
          </Badge>
          <Button size="icon-xs" title="Refresh" variant="ghost">
            <RefreshCcw className="size-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 text-diff-addition-foreground">
            <Plus className="size-3" /> {additions}
          </span>
          <span className="inline-flex items-center gap-1 text-diff-deletion-foreground">
            <Minus className="size-3" /> {deletions}
          </span>
        </div>
      </div>
      <div className="min-h-0 overflow-auto py-1 ide-scrollbar">
        {project.gitChanges.map((change) => (
          <GitChangeRow change={change} key={`${change.status}:${change.path}`} />
        ))}
      </div>
    </section>
  )
}

function GitChangeRow({ change }: { change: GitChange }) {
  const Icon = changeIcon(change.status)
  return (
    <button
      className="group flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title={change.path}
      type="button"
    >
      <Icon className={cn("size-4 shrink-0", changeColor(change.status))} />
      <span className="min-w-0 flex-1 truncate">{change.path}</span>
      <span className="hidden shrink-0 items-center gap-1 font-mono text-[10px] group-hover:flex">
        <span className="text-diff-addition-foreground">+{change.additions}</span>
        <span className="text-diff-deletion-foreground">-{change.deletions}</span>
      </span>
      <span className="shrink-0 rounded border border-border bg-secondary px-1 py-0.5 text-[10px] uppercase text-secondary-foreground">
        {statusLabel(change.status)}
      </span>
    </button>
  )
}

function changeIcon(status: GitChange["status"]) {
  if (status === "added" || status === "untracked") {
    return FilePlus2
  }
  if (status === "deleted") {
    return Trash2
  }
  if (status === "renamed") {
    return FileSymlink
  }
  return GitBranch
}

function changeColor(status: GitChange["status"]): string {
  if (status === "added" || status === "untracked") {
    return "text-diff-addition-foreground"
  }
  if (status === "deleted") {
    return "text-diff-deletion-foreground"
  }
  if (status === "renamed") {
    return "text-info"
  }
  return "text-warning"
}

function statusLabel(status: GitChange["status"]): string {
  const labels: Record<GitChange["status"], string> = {
    added: "A",
    deleted: "D",
    modified: "M",
    renamed: "R",
    untracked: "U",
  }
  return labels[status]
}
