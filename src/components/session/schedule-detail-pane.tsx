import { Check, Plus, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  dateTimeLabel,
  isoFromLocalDateTimeInput,
  localDateTimeInputValue,
  readRecurrenceFrequency,
  recurrenceFrequencyLabel,
  scheduleRunStatusClass,
} from "@/components/session/schedule-utils"
import { apiClient, type MessageScheduleRecurrence, type MessageScheduleResponse, type ProviderModelListResponse } from "@/lib/api-client"
import {
  composerReasoningEffortLabel,
  composerReasoningEffortOptions,
  composerReasoningEffortValue,
  composerServiceTierLabel,
  composerServiceTierOptions,
  composerServiceTierValue,
  mergeProviderModelOptions,
  readComposerAccessMode,
  readComposerReasoningEffort,
  readComposerServiceTier,
  relativeTimeLabel,
} from "@/lib/session"
import { cn } from "@/lib/utils"
import type { SessionShellState } from "@/components/session/session-shell"
import type {
  ChatComposerAccessMode,
  ChatComposerReasoningEffort,
  ChatComposerServiceTier,
} from "@/types/session"

type ScheduleDetailShell = Pick<
  SessionShellState,
  | "activeSchedule"
  | "activeScheduleRuns"
  | "chatAccounts"
  | "createSchedule"
  | "deleteSchedule"
  | "openScheduleRunChat"
  | "providerDefinitions"
  | "scheduleError"
  | "updateSchedule"
>

type ScheduleDraft = {
  accountId: string
  active: boolean
  collaborationMode: string
  endAt: string
  firstRunAt: string
  interval: string
  maxRuns: string
  message: string
  model: string
  permissionMode: ChatComposerAccessMode
  reasoningEffort: ChatComposerReasoningEffort
  recurrenceFrequency: MessageScheduleRecurrence["frequency"]
  serviceTier: ChatComposerServiceTier
  title: string
}

export function ScheduleDetailPane({ shell }: { shell: ScheduleDetailShell }) {
  const schedule = shell.activeSchedule
  const runs = shell.activeScheduleRuns
  const [draft, setDraft] = useState<ScheduleDraft | null>(() => schedule ? scheduleDraftFrom(schedule) : null)
  const [modelOptions, setModelOptions] = useState<ProviderModelListResponse["data"]>([])
  const [saving, setSaving] = useState(false)
  const account = shell.chatAccounts.find((entry) => entry.id === draft?.accountId) ??
    shell.chatAccounts.find((entry) => entry.id === schedule?.accountId) ??
    null
  const providerDefinition = shell.providerDefinitions.find((provider) => provider.id === account?.providerId) ??
    shell.providerDefinitions.find((provider) => provider.id === schedule?.providerId) ??
    null
  const supportsModels = Boolean(account && providerDefinition?.capabilities.includes("models"))
  const supportsReasoningEffort = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "reasoningEffort"))
  const supportsServiceTier = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "serviceTier"))
  const availableAccounts = schedule
    ? shell.chatAccounts.filter((entry) => entry.providerId === schedule.providerId)
    : shell.chatAccounts
  const visibleModelOptions = mergeProviderModelOptions(account?.providerId, modelOptions)
    .filter((option) => !option.hidden)
  const selectedModelLabel =
    visibleModelOptions.find((option) => option.model === draft?.model || option.id === draft?.model)?.displayName ??
    draft?.model ??
    "Default"

  useEffect(() => {
    setDraft(schedule ? scheduleDraftFrom(schedule) : null)
  }, [schedule?.id])

  useEffect(() => {
    let cancelled = false
    setModelOptions([])
    if (!account || !supportsModels) {
      return
    }
    apiClient.providerAccounts.models(account.id)
      .then((response) => {
        if (!cancelled) {
          setModelOptions(response.data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [account?.id, supportsModels])

  if (!schedule || !draft) {
    return (
      <section className="grid h-full min-h-0 place-items-center rounded-xl border border-border bg-card p-6 text-center">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Scheduler</h2>
          <p className="mt-2 max-w-sm text-[13px] text-muted-foreground">Select a schedule or create one from the scheduler tab.</p>
          <button
            className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-secondary px-3 text-[13px] text-foreground hover:bg-accent"
            type="button"
            onClick={() => void shell.createSchedule()}
          >
            <Plus className="size-4" />
            New schedule
          </button>
        </div>
      </section>
    )
  }

  const canSave = Boolean(draft.title.trim() && draft.message.trim() && draft.firstRunAt && draft.accountId)
  const scheduleControlClass = "border-input bg-background text-foreground shadow-none focus-visible:border-ring focus-visible:ring-ring/35"
  const scheduleLabelClass = "mb-1 block text-[11px] font-medium leading-none text-muted-foreground"
  const scheduleSelectTriggerClass = "h-8 w-full border-input bg-background px-2 text-[12px] text-foreground shadow-none hover:bg-secondary/60 focus-visible:border-ring focus-visible:ring-ring/35"

  const save = async () => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      await shell.updateSchedule(schedule.id, {
        accountId: draft.accountId,
        collaborationMode: draft.collaborationMode,
        firstRunAt: isoFromLocalDateTimeInput(draft.firstRunAt),
        message: draft.message,
        model: draft.model || null,
        permissionMode: draft.permissionMode,
        reasoningEffort: supportsReasoningEffort ? composerReasoningEffortValue(draft.reasoningEffort) : null,
        recurrence: {
          endAt: draft.endAt ? isoFromLocalDateTimeInput(draft.endAt) : null,
          frequency: draft.recurrenceFrequency,
          interval: Number.parseInt(draft.interval, 10) || 1,
          maxRuns: draft.maxRuns ? Number.parseInt(draft.maxRuns, 10) || null : null,
        },
        serviceTier: supportsServiceTier ? composerServiceTierValue(draft.serviceTier) : null,
        status: draft.active ? "ACTIVE" : "PAUSED",
        title: draft.title,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-11 items-center gap-3 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-foreground">{draft.title.trim() || schedule.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-muted-foreground">{draft.active ? "On" : "Off"}</span>
          <Switch
            aria-label={draft.active ? "Turn schedule off" : "Turn schedule on"}
            className={cn(
              "h-5 w-9 border-border bg-accent data-[state=checked]:border-success/60 data-[state=checked]:bg-success",
            )}
            checked={draft.active}
            title={draft.active ? "Schedule is on" : "Schedule is off"}
            onCheckedChange={(active) => setDraft({ ...draft, active })}
          />
        </div>
      </div>
      <div className="grid min-h-0 gap-4 overflow-auto p-3 ide-scrollbar lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
        <div className="min-w-0 space-y-5">
          {shell.scheduleError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{shell.scheduleError}</div>
          ) : null}
          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold text-foreground">Details</h3>
            <Label className="block">
              <span className={scheduleLabelClass}>Title</span>
              <input
                className={cn("h-8 px-2 text-[13px]", scheduleControlClass)}
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </Label>
            <Label className="block">
              <span className={scheduleLabelClass}>Message</span>
              <textarea
                className={cn("min-h-36 resize-none px-2 py-2 text-[13px] leading-5", scheduleControlClass)}
                value={draft.message}
                onChange={(event) => setDraft({ ...draft, message: event.target.value })}
              />
            </Label>
          </div>
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-[12px] font-semibold text-foreground">Timing</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>First run</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  type="datetime-local"
                  value={draft.firstRunAt}
                  onChange={(event) => setDraft({ ...draft, firstRunAt: event.target.value })}
                />
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Repeat</span>
                <Select className="w-full min-w-0" value={draft.recurrenceFrequency} onValueChange={(frequency) => setDraft({ ...draft, recurrenceFrequency: readRecurrenceFrequency(frequency) })}>
                  <SelectTrigger aria-label="Repeat" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{recurrenceFrequencyLabel(draft.recurrenceFrequency)}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    {(["none", "daily", "weekly", "monthly"] as const).map((frequency) => (
                      <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={frequency} value={frequency}>
                        {recurrenceFrequencyLabel(frequency)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Interval</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  disabled={draft.recurrenceFrequency === "none"}
                  min={1}
                  type="number"
                  value={draft.interval}
                  onChange={(event) => setDraft({ ...draft, interval: event.target.value })}
                />
              </Label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>End after</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  disabled={draft.recurrenceFrequency === "none"}
                  min={1}
                  placeholder="Run count"
                  type="number"
                  value={draft.maxRuns}
                  onChange={(event) => setDraft({ ...draft, maxRuns: event.target.value })}
                />
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>End date</span>
                <input
                  className={cn("h-8 px-2 text-[12px]", scheduleControlClass)}
                  disabled={draft.recurrenceFrequency === "none"}
                  type="datetime-local"
                  value={draft.endAt}
                  onChange={(event) => setDraft({ ...draft, endAt: event.target.value })}
                />
              </Label>
            </div>
          </div>
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-[12px] font-semibold text-foreground">Execution</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Provider account</span>
                <Select className="w-full min-w-0" value={draft.accountId} onValueChange={(accountId) => setDraft({ ...draft, accountId })}>
                  <SelectTrigger aria-label="Provider account" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{availableAccounts.find((entry) => entry.id === draft.accountId)?.displayName ?? "Choose account"}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    {availableAccounts.map((entry) => (
                      <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Access</span>
                <Select className="w-full min-w-0" value={draft.permissionMode} onValueChange={(value) => setDraft({ ...draft, permissionMode: readComposerAccessMode(value) })}>
                  <SelectTrigger aria-label="Access mode" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{draft.permissionMode === "fullAccess" ? "Full access" : "Ask for approval"}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="askForApproval">Ask for approval</SelectItem>
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="fullAccess">Full access</SelectItem>
                  </SelectContent>
                </Select>
              </Label>
              <Label className="block min-w-0">
                <span className={scheduleLabelClass}>Mode</span>
                <Select className="w-full min-w-0" value={draft.collaborationMode} onValueChange={(value) => setDraft({ ...draft, collaborationMode: value === "plan" ? "plan" : "default" })}>
                  <SelectTrigger aria-label="Mode" className={scheduleSelectTriggerClass}>
                    <span className="truncate">{draft.collaborationMode === "plan" ? "Plan" : "Default"}</span>
                  </SelectTrigger>
                  <SelectContent align="start" className="border-border bg-popover text-foreground">
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="default">Default</SelectItem>
                    <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="plan">Plan</SelectItem>
                  </SelectContent>
                </Select>
              </Label>
            </div>
          </div>
          {supportsModels || supportsReasoningEffort || supportsServiceTier ? (
            <div className="space-y-3 border-t border-border pt-4">
              <h3 className="text-[12px] font-semibold text-foreground">Runtime</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {supportsModels ? (
                  <Label className="block min-w-0">
                    <span className={scheduleLabelClass}>Model</span>
                    <Select className="w-full min-w-0" value={draft.model || visibleModelOptions[0]?.model || ""} onValueChange={(model) => setDraft({ ...draft, model })}>
                      <SelectTrigger aria-label="Model" className={scheduleSelectTriggerClass}>
                        <span className="truncate">{selectedModelLabel}</span>
                      </SelectTrigger>
                      <SelectContent align="start" className="max-h-72 border-border bg-popover text-foreground">
                        {visibleModelOptions.map((option) => (
                          <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.id} value={option.model}>
                            {option.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                ) : null}
                {supportsReasoningEffort ? (
                  <Label className="block min-w-0">
                    <span className={scheduleLabelClass}>Reasoning</span>
                    <Select className="w-full min-w-0" value={draft.reasoningEffort} onValueChange={(value) => setDraft({ ...draft, reasoningEffort: readComposerReasoningEffort(value) })}>
                      <SelectTrigger aria-label="Reasoning" className={scheduleSelectTriggerClass}>
                        <span className="truncate">{composerReasoningEffortLabel(draft.reasoningEffort)}</span>
                      </SelectTrigger>
                      <SelectContent align="start" className="border-border bg-popover text-foreground">
                        {composerReasoningEffortOptions.map((option) => (
                          <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                ) : null}
                {supportsServiceTier ? (
                  <Label className="block min-w-0">
                    <span className={scheduleLabelClass}>Speed</span>
                    <Select className="w-full min-w-0" value={draft.serviceTier} onValueChange={(value) => setDraft({ ...draft, serviceTier: readComposerServiceTier(value) })}>
                      <SelectTrigger aria-label="Speed" className={scheduleSelectTriggerClass}>
                        <span className="truncate">{composerServiceTierLabel(draft.serviceTier)}</span>
                      </SelectTrigger>
                      <SelectContent align="start" className="border-border bg-popover text-foreground">
                        {composerServiceTierOptions.map((option) => (
                          <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            <button
              className="h-8 gap-2 rounded-md border-destructive/30 bg-destructive/10 px-3 text-[12px] text-destructive hover:bg-destructive/10"
              type="button"
              onClick={() => void shell.deleteSchedule(schedule.id)}
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
            <button
              className="h-8 gap-2 rounded-md border-border bg-secondary px-3 text-[12px] text-foreground hover:bg-accent"
              disabled={!canSave || saving}
              type="button"
              onClick={() => void save()}
            >
              <Check className="size-3.5" />
              {saving ? "Saving" : "Save"}
            </button>
          </div>
        </div>
        <div className="min-w-0 border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <h3 className="text-[13px] font-semibold text-foreground">Execution History</h3>
          <div className="mt-3 space-y-2">
            {runs.length ? runs.map((run) => (
              <button
                className="block w-full rounded-md border border-border bg-secondary/40 px-3 py-2 text-left hover:bg-popover"
                key={run.id}
                type="button"
                onClick={() => void shell.openScheduleRunChat(run)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{dateTimeLabel(run.scheduledFor)}</span>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", scheduleRunStatusClass(run.status))}>{run.status.toLowerCase()}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {run.startedAt ? `Started ${relativeTimeLabel(run.startedAt)}` : "Waiting"}
                  {run.endedAt ? ` / Ended ${relativeTimeLabel(run.endedAt)}` : ""}
                </div>
                {run.error ? <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{run.error}</div> : null}
              </button>
            )) : (
              <div className="rounded-md border border-border bg-secondary/40 px-3 py-3 text-[12px] text-muted-foreground">No runs yet</div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function scheduleDraftFrom(schedule: MessageScheduleResponse): ScheduleDraft {
  return {
    accountId: schedule.accountId ?? "",
    active: schedule.status === "ACTIVE",
    collaborationMode: schedule.collaborationMode === "plan" ? "plan" : "default",
    endAt: schedule.recurrence.endAt ? localDateTimeInputValue(schedule.recurrence.endAt) : "",
    firstRunAt: localDateTimeInputValue(schedule.nextRunAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()),
    interval: String(schedule.recurrence.interval || 1),
    maxRuns: schedule.recurrence.maxRuns ? String(schedule.recurrence.maxRuns) : "",
    message: schedule.message,
    model: schedule.model ?? "",
    permissionMode: readComposerAccessMode(schedule.permissionMode),
    reasoningEffort: readComposerReasoningEffort(schedule.reasoningEffort),
    recurrenceFrequency: schedule.recurrence.frequency,
    serviceTier: readComposerServiceTier(schedule.serviceTier),
    title: schedule.title,
  }
}
