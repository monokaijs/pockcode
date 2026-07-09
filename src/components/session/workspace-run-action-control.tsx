import { ChevronDown, Check, LoaderCircle, MessageSquare, Play, Plus, Terminal } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type {
  CreateWorkspaceRunActionRequest,
  WorkspaceChatRunConfig,
  WorkspaceRunActionKind,
  WorkspaceRunActionResponse,
} from "@/lib/api-client"

type RunActionDraft = {
  command: string
  cwd: string
  keepOpen: boolean
  kind: WorkspaceRunActionKind
  message: string
  name: string
  shell: string
  target: WorkspaceChatRunConfig["target"]
}

const emptyDraft: RunActionDraft = {
  command: "",
  cwd: "",
  keepOpen: true,
  kind: "terminal",
  message: "",
  name: "",
  shell: "",
  target: "current",
}

export function WorkspaceRunActionControl({
  actions,
  defaultShell,
  defaultWorkingDirectory,
  error,
  runningActionId,
  selectedActionId,
  onCreateAction,
  onRunAction,
  onSelectAction,
}: {
  actions: WorkspaceRunActionResponse[]
  defaultShell: string
  defaultWorkingDirectory: string
  error: string | null
  runningActionId: string | null
  selectedActionId: string | null
  onCreateAction: (body: Omit<CreateWorkspaceRunActionRequest, "workspacePath">) => Promise<void>
  onRunAction: (action: WorkspaceRunActionResponse) => Promise<void>
  onSelectAction: (actionId: string) => void
}) {
  const selectedAction = actions.find((action) => action.id === selectedActionId) ?? actions[0] ?? null
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<RunActionDraft>(emptyDraft)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const runningSelected = selectedAction ? runningActionId === selectedAction.id : false

  useEffect(() => {
    setFormError(null)
  }, [draft.kind])

  const openCreateDialog = () => {
    setDraft({ ...emptyDraft, cwd: defaultWorkingDirectory, shell: defaultShell })
    setFormError(null)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    if (saving) {
      return
    }
    setDialogOpen(false)
    setFormError(null)
  }

  const saveDraft = async () => {
    const payload = payloadFromDraft(draft)
    if ("error" in payload) {
      setFormError(payload.error)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await onCreateAction(payload.body)
      setDialogOpen(false)
      setFormError(null)
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Unable to save run action.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center overflow-hidden rounded-md border border-border bg-background">
        <button
          className="flex h-7 min-w-0 max-w-38 items-center gap-1.5 px-2 text-[12px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!selectedAction || Boolean(runningActionId)}
          title={selectedAction ? `Run ${selectedAction.name}` : "Run"}
          type="button"
          onClick={() => selectedAction ? void onRunAction(selectedAction) : undefined}
        >
          {runningSelected ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-info" /> : <Play className="size-3.5 shrink-0 text-success" />}
          <span className="min-w-0 truncate">{selectedAction?.name ?? "Run"}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label="Run actions"
                className="grid h-7 w-6 shrink-0 place-items-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Run actions"
                type="button"
              />
            }
          >
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem className="text-[12px]" onClick={openCreateDialog}>
              <Plus className="size-3.5" />
              <span>Add new action</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Run actions</DropdownMenuLabel>
              {actions.length ? (
                actions.map((action) => (
                  <DropdownMenuItem className="text-[12px]" key={action.id} onClick={() => onSelectAction(action.id)}>
                    <RunActionIcon kind={action.kind} />
                    <span className="min-w-0 flex-1 truncate">{action.name}</span>
                    {action.id === selectedAction?.id ? <Check className="size-3.5" /> : null}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem className="text-[12px] text-muted-foreground" disabled>
                  <Play className="size-3.5" />
                  <span>No actions</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            {error ? (
              <>
                <DropdownMenuSeparator />
                <div className="px-1.5 py-1 text-[11px] text-destructive">{error}</div>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open) {
          closeDialog()
        }
      }}>
        <DialogContent className="!w-[min(42rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>New Run Action</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="run-action-name">Name</Label>
              <Input
                id="run-action-name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <Select value={draft.kind} onValueChange={(value) => setDraft((current) => ({ ...current, kind: value === "chat" ? "chat" : "terminal" }))}>
                <SelectTrigger className="w-full">
                  <span className="flex min-w-0 items-center gap-2 truncate">
                    <RunActionIcon kind={draft.kind} />
                    <span>{runActionKindLabel(draft.kind)}</span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="terminal">
                    <Terminal className="size-4" />
                    Terminal
                  </SelectItem>
                  <SelectItem value="chat">
                    <MessageSquare className="size-4" />
                    Chat
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.kind === "terminal" ? (
              <TerminalRunActionFields draft={draft} setDraft={setDraft} />
            ) : (
              <ChatRunActionFields draft={draft} setDraft={setDraft} />
            )}
            {formError ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{formError}</div> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button disabled={saving} onClick={() => void saveDraft()}>
              {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TerminalRunActionFields({
  draft,
  setDraft,
}: {
  draft: RunActionDraft
  setDraft: (update: (current: RunActionDraft) => RunActionDraft) => void
}) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="run-action-command">Command</Label>
        <Textarea
          className="min-h-20 resize-none font-mono text-[12px]"
          id="run-action-command"
          value={draft.command}
          onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="run-action-cwd">Working directory</Label>
          <Input
            id="run-action-cwd"
            value={draft.cwd}
            onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="run-action-shell">Shell</Label>
          <Input
            id="run-action-shell"
            value={draft.shell}
            onChange={(event) => setDraft((current) => ({ ...current, shell: event.target.value }))}
          />
        </div>
      </div>
      <Label className="flex h-8 items-center justify-between rounded-md border border-border px-2.5">
        <span>Keep shell open</span>
        <Switch checked={draft.keepOpen} size="sm" onCheckedChange={(checked) => setDraft((current) => ({ ...current, keepOpen: checked }))} />
      </Label>
    </>
  )
}

function ChatRunActionFields({
  draft,
  setDraft,
}: {
  draft: RunActionDraft
  setDraft: (update: (current: RunActionDraft) => RunActionDraft) => void
}) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label>Target</Label>
        <Select value={draft.target} onValueChange={(value) => setDraft((current) => ({ ...current, target: value === "new" ? "new" : "current" }))}>
          <SelectTrigger className="w-full">
            <span>{chatTargetLabel(draft.target)}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">Current chat</SelectItem>
            <SelectItem value="new">New chat</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="run-action-message">Message</Label>
        <Textarea
          className="min-h-28 resize-none"
          id="run-action-message"
          value={draft.message}
          onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
        />
      </div>
    </>
  )
}

function RunActionIcon({ kind }: { kind: WorkspaceRunActionKind }) {
  return kind === "terminal" ? <Terminal className="size-3.5" /> : <MessageSquare className="size-3.5" />
}

function runActionKindLabel(kind: WorkspaceRunActionKind) {
  return kind === "terminal" ? "Terminal" : "Chat"
}

function chatTargetLabel(target: WorkspaceChatRunConfig["target"]) {
  return target === "new" ? "New chat" : "Current chat"
}

function payloadFromDraft(draft: RunActionDraft):
  | { body: Omit<CreateWorkspaceRunActionRequest, "workspacePath"> }
  | { error: string } {
  const name = draft.name.trim()
  if (!name) {
    return { error: "Name is required." }
  }
  if (draft.kind === "terminal") {
    const command = draft.command.trim()
    if (!command) {
      return { error: "Command is required." }
    }
    return {
      body: {
        config: {
          command,
          cwd: draft.cwd.trim() || null,
          keepOpen: draft.keepOpen,
          shell: draft.shell.trim() || null,
        },
        kind: "terminal",
        name,
      },
    }
  }

  const message = draft.message.trim()
  if (!message) {
    return { error: "Message is required." }
  }
  return {
    body: {
      config: {
        message,
        target: draft.target,
      },
      kind: "chat",
      name,
    },
  }
}
