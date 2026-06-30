import { Check, ChevronDown, GitBranch, Minus, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { apiClient, type GitFileChange, type GitStatusResponse } from "@/lib/api-client"
import { readError } from "@/lib/session"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/types/session"

export type GitPanelState = ReturnType<typeof useGitPanelState>

export function useGitPanelState(workspacePath: string) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [status, setStatus] = useState<GitStatusResponse | null>(null)

  const refresh = useCallback(async () => {
    setBusyAction((current) => current ?? "refresh")
    setNotice(null)
    try {
      setStatus(await apiClient.git.status(workspacePath))
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setBusyAction((current) => current === "refresh" ? null : current)
    }
  }, [workspacePath])

  useEffect(() => {
    setStatus(null)
    void refresh()
  }, [refresh])

  const runAction = useCallback(async (
    action: string,
    request: () => Promise<GitStatusResponse>,
    success: string,
  ) => {
    setBusyAction(action)
    setNotice(null)
    try {
      setStatus(await request())
      setNotice({ kind: "info", text: success })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setBusyAction(null)
    }
  }, [])

  return {
    busyAction,
    canUseRepository: Boolean(status?.isRepository),
    init: () => runAction("init", () => apiClient.git.init(workspacePath), "Repository initialized."),
    isBusy: Boolean(busyAction),
    isLoading: busyAction === "refresh" && !status,
    notice,
    refresh,
    stage: (paths: string[]) => runAction("stage", () => apiClient.git.stage(workspacePath, paths), "Changes staged."),
    status,
    unstage: (paths: string[]) => runAction("unstage", () => apiClient.git.unstage(workspacePath, paths), "Changes unstaged."),
    discard: (paths: string[]) => runAction("discard", () => apiClient.git.discard(workspacePath, paths), "Changes discarded."),
    commit: (message: string) => runAction("commit", () => apiClient.git.commit(workspacePath, message), "Commit created."),
    pull: () => runAction("pull", () => apiClient.git.pull(workspacePath), "Pulled latest changes."),
    push: () => runAction("push", () => apiClient.git.push(workspacePath), "Pushed local commits."),
  }
}

export function GitPanelSummary({ gitPanel, workspace }: { gitPanel: GitPanelState; workspace: Workspace }) {
  const [commitMessage, setCommitMessage] = useState("")
  const status = gitPanel.status
  const changes = status?.changes ?? []
  const stagedChanges = changes.filter((change) => change.staged)
  const unstagedChanges = changes.filter((change) => !change.staged)
  const canCommit = Boolean(commitMessage.trim() && stagedChanges.length && !gitPanel.isBusy)

  if (!status) {
    return (
      <div className="grid h-40 place-items-center text-[12px] text-muted-foreground">
        Loading source control
      </div>
    )
  }

  if (!status.isRepository) {
    return (
      <div className="grid gap-3 px-3 py-4 text-[13px] text-muted-foreground">
        <div className="flex items-center gap-2 text-foreground">
          <GitBranch className="size-4 text-muted-foreground" />
          <span className="min-w-0 truncate">{workspace.name}</span>
        </div>
        <p className="text-[12px] leading-5 text-muted-foreground">
          This workspace is not initialized as a Git repository.
        </p>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={gitPanel.isBusy}
          type="button"
          onClick={() => void gitPanel.init()}
        >
          Initialize Repository
        </button>
        {gitPanel.notice ? <GitNotice notice={gitPanel.notice} /> : null}
      </div>
    )
  }

  return (
    <div className="grid gap-3 text-[13px] text-muted-foreground">
      <div className="grid gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-2 px-1.5 text-foreground">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{status.branch || workspace.branch}</span>
          {status.ahead || status.behind ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {status.ahead ? `↑${status.ahead}` : ""}{status.behind ? ` ↓${status.behind}` : ""}
            </span>
          ) : null}
        </div>
        <input
          className="h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="Message (Ctrl+Enter to commit)"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canCommit) {
              void gitPanel.commit(commitMessage).then(() => setCommitMessage(""))
            }
          }}
        />
        <button
          className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!canCommit}
          type="button"
          onClick={() => void gitPanel.commit(commitMessage).then(() => setCommitMessage(""))}
        >
          <Check className="size-4" />
          Commit
        </button>
        {gitPanel.notice ? <GitNotice notice={gitPanel.notice} /> : null}
      </div>

      {changes.length ? (
        <>
          <GitChangeGroup
            actionLabel="Unstage all"
            changes={stagedChanges}
            count={stagedChanges.length}
            title="Staged Changes"
            onAction={() => void gitPanel.unstage(stagedChanges.map((change) => change.path))}
            onDiscardAll={() => void gitPanel.discard(stagedChanges.map((change) => change.path))}
            onDiscard={(path) => void gitPanel.discard([path])}
            onToggle={(path) => void gitPanel.unstage([path])}
          />
          <GitChangeGroup
            actionLabel="Stage all"
            changes={unstagedChanges}
            count={unstagedChanges.length}
            title="Changes"
            onAction={() => void gitPanel.stage(unstagedChanges.map((change) => change.path))}
            onDiscardAll={() => void gitPanel.discard(unstagedChanges.map((change) => change.path))}
            onDiscard={(path) => void gitPanel.discard([path])}
            onToggle={(path) => void gitPanel.stage([path])}
          />
        </>
      ) : (
        <div className="px-3 py-2 text-[12px] text-muted-foreground">No changes</div>
      )}

      {status.commits.length ? (
        <GitGraph status={status} />
      ) : null}
    </div>
  )
}

function GitNotice({ notice }: { notice: { kind: "error" | "info"; text: string } }) {
  return (
    <div className={cn("truncate rounded-md px-2 py-1 text-[11px]", notice.kind === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")} title={notice.text}>
      {notice.text}
    </div>
  )
}

function GitChangeGroup({
  actionLabel,
  changes,
  count,
  title,
  onAction,
  onDiscardAll,
  onDiscard,
  onToggle,
}: {
  actionLabel: string
  changes: GitFileChange[]
  count: number
  title: string
  onAction: () => void
  onDiscardAll: () => void
  onDiscard: (path: string) => void
  onToggle: (path: string) => void
}) {
  if (!count) {
    return null
  }

  return (
    <section>
      <div className="group flex h-7 min-w-0 items-center gap-1 px-1.5 text-[12px] font-semibold text-muted-foreground">
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
        <span className="grid min-w-5 place-items-center rounded-full bg-secondary px-1 text-[10px] leading-5 text-secondary-foreground">{count}</span>
        <button
          aria-label={actionLabel}
          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-accent-foreground group-hover:opacity-100"
          title={actionLabel}
          type="button"
          onClick={onAction}
        >
          {actionLabel.startsWith("Unstage") ? <Minus className="size-4" /> : <Plus className="size-4" />}
        </button>
        <button
          aria-label={`Discard all ${title.toLowerCase()}`}
          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive group-hover:opacity-100"
          title={`Discard all ${title.toLowerCase()}`}
          type="button"
          onClick={onDiscardAll}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div>
        {changes.map((change) => (
          <GitChangeRow
            change={change}
            key={`${change.staged}:${change.path}:${change.indexStatus}:${change.workingTreeStatus}`}
            onDiscard={() => onDiscard(change.path)}
            onToggle={() => onToggle(change.path)}
          />
        ))}
      </div>
    </section>
  )
}

function GitChangeRow({
  change,
  onDiscard,
  onToggle,
}: {
  change: GitFileChange
  onDiscard: () => void
  onToggle: () => void
}) {
  return (
    <div
      className="group flex h-[26px] min-w-0 items-center gap-2 rounded-sm px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title={change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path}
    >
      <span className={cn("w-4 shrink-0 text-center font-mono text-[13px]", gitStatusColor(change.status))}>
        {gitStatusLabel(change.status)}
      </span>
      <span className="min-w-0 flex-1 truncate">{change.path}</span>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          aria-label={change.staged ? "Unstage change" : "Stage change"}
          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
          type="button"
          onClick={onToggle}
        >
          {change.staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        </button>
        <button
          aria-label="Discard change"
          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
          type="button"
          onClick={onDiscard}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function GitGraph({ status }: { status: GitStatusResponse }) {
  return (
    <section className="border-t border-border pt-2">
      <div className="flex h-7 items-center gap-2 px-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        <ChevronDown className="size-4" />
        <span className="min-w-0 flex-1 truncate">Graph</span>
        <GitBranch className="size-3.5" />
        <span className="truncate normal-case tracking-normal">{status.branch}</span>
      </div>
      <div>
        {status.commits.map((commit, index) => (
          <div className="grid h-7 min-w-0 grid-cols-[24px_minmax(0,1fr)] items-center gap-1 px-1.5 text-[12px]" key={`${commit.hash}:${index}`}>
            <span className="relative grid h-full place-items-center">
              <span className="absolute bottom-0 top-0 left-1/2 w-px -translate-x-1/2 bg-border" />
              <span className="relative size-2 rounded-full border border-border bg-background" />
            </span>
            <span className="min-w-0 truncate text-muted-foreground">
              {commit.subject}
              {commit.refs ? <span className="ml-1 text-muted-foreground">{commit.refs}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function gitStatusLabel(status: GitFileChange["status"]) {
  const labels: Record<GitFileChange["status"], string> = {
    added: "A",
    deleted: "D",
    modified: "M",
    renamed: "R",
    untracked: "U",
  }
  return labels[status]
}

function gitStatusColor(status: GitFileChange["status"]) {
  if (status === "added" || status === "untracked") return "text-diff-addition-foreground"
  if (status === "deleted") return "text-diff-deletion-foreground"
  if (status === "renamed") return "text-info"
  return "text-warning"
}
