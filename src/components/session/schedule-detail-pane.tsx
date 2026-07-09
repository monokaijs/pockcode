import { Check, Plus, Trash2 } from "lucide-react"
import { useEffect, useId, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
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
  accessModeLabel,
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

const responsiveFieldGridClass = "grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr))]"
const scheduleFieldLabelClass = "text-[12px] font-medium text-muted-foreground"
const scheduleInputClass = "bg-background text-[13px]"
const scheduleSelectTriggerClass = "w-full min-w-0 bg-background text-[13px]"

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
  const fieldId = useId()
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
          <Button className="mt-4" size="sm" variant="secondary" onClick={() => void shell.createSchedule()}>
            <Plus className="size-4" />
            New schedule
          </Button>
        </div>
      </section>
    )
  }

  const canSave = Boolean(draft.title.trim() && draft.message.trim() && draft.firstRunAt && draft.accountId)
  const isRecurring = draft.recurrenceFrequency !== "none"

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
          endAt: isRecurring && draft.endAt ? isoFromLocalDateTimeInput(draft.endAt) : null,
          frequency: draft.recurrenceFrequency,
          interval: isRecurring ? Number.parseInt(draft.interval, 10) || 1 : 1,
          maxRuns: isRecurring && draft.maxRuns ? Number.parseInt(draft.maxRuns, 10) || null : null,
        },
        serviceTier: supportsServiceTier ? composerServiceTierValue(draft.serviceTier) : null,
        status: draft.active ? "ACTIVE" : "PAUSED",
        title: draft.title,
      })
    } catch {
      // The shell owns schedule error state.
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-11 items-center gap-3 border-b border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="truncate text-[13px] font-semibold text-foreground">{draft.title.trim() || schedule.title}</h2>
          <Badge className="hidden shrink-0 sm:inline-flex" variant={draft.active ? "success" : "outline"}>
            {draft.active ? "active" : "paused"}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-muted-foreground">Active</span>
          <Switch
            aria-label={draft.active ? "Turn schedule off" : "Turn schedule on"}
            className="h-5 w-9 border-border bg-accent data-[state=checked]:border-success/60 data-[state=checked]:bg-success"
            checked={draft.active}
            title={draft.active ? "Schedule is on" : "Schedule is off"}
            onCheckedChange={(active) => setDraft({ ...draft, active })}
          />
        </div>
      </div>
      <div className="@container/schedule-detail min-h-0 overflow-auto p-3 ide-scrollbar">
        <div className="grid min-h-full gap-4 @5xl/schedule-detail:grid-cols-[minmax(0,1fr)_minmax(17rem,0.48fr)]">
          <form
            className="min-w-0"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <FieldGroup className="gap-5">
              {shell.scheduleError ? (
                <FieldError className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px]">
                  {shell.scheduleError}
                </FieldError>
              ) : null}

              <ScheduleSection title="Task">
                <Field className="min-w-0">
                  <FieldLabel className={scheduleFieldLabelClass} htmlFor={`${fieldId}-title`}>Title</FieldLabel>
                  <Input
                    className={scheduleInputClass}
                    id={`${fieldId}-title`}
                    required
                    value={draft.title}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  />
                </Field>
                <Field className="min-w-0">
                  <FieldLabel className={scheduleFieldLabelClass} htmlFor={`${fieldId}-message`}>Message</FieldLabel>
                  <Textarea
                    className={cn(scheduleInputClass, "min-h-32 resize-y leading-5")}
                    id={`${fieldId}-message`}
                    required
                    value={draft.message}
                    onChange={(event) => setDraft({ ...draft, message: event.target.value })}
                  />
                </Field>
              </ScheduleSection>

              <ScheduleSection className="border-t border-border pt-4" title="Schedule">
                <div className={responsiveFieldGridClass}>
                  <Field className="min-w-0">
                    <FieldLabel className={scheduleFieldLabelClass} htmlFor={`${fieldId}-first-run`}>First run</FieldLabel>
                    <Input
                      className={scheduleInputClass}
                      id={`${fieldId}-first-run`}
                      required
                      type="datetime-local"
                      value={draft.firstRunAt}
                      onChange={(event) => setDraft({ ...draft, firstRunAt: event.target.value })}
                    />
                  </Field>
                  <ScheduleSelectField
                    id={`${fieldId}-repeat`}
                    label="Repeat"
                    selectedLabel={recurrenceFrequencyLabel(draft.recurrenceFrequency)}
                    value={draft.recurrenceFrequency}
                    onValueChange={(frequency) => setDraft({ ...draft, recurrenceFrequency: readRecurrenceFrequency(frequency) })}
                  >
                    {(["none", "daily", "weekly", "monthly"] as const).map((frequency) => (
                      <SelectItem key={frequency} value={frequency}>
                        {recurrenceFrequencyLabel(frequency)}
                      </SelectItem>
                    ))}
                  </ScheduleSelectField>
                  {isRecurring ? (
                    <Field className="min-w-0">
                      <FieldLabel className={scheduleFieldLabelClass} htmlFor={`${fieldId}-interval`}>Interval</FieldLabel>
                      <Input
                        className={scheduleInputClass}
                        id={`${fieldId}-interval`}
                        min={1}
                        type="number"
                        value={draft.interval}
                        onChange={(event) => setDraft({ ...draft, interval: event.target.value })}
                      />
                    </Field>
                  ) : null}
                </div>
                {isRecurring ? (
                  <div className={responsiveFieldGridClass}>
                    <Field className="min-w-0">
                      <FieldLabel className={scheduleFieldLabelClass} htmlFor={`${fieldId}-max-runs`}>Stop after</FieldLabel>
                      <Input
                        className={scheduleInputClass}
                        id={`${fieldId}-max-runs`}
                        min={1}
                        placeholder="Run count"
                        type="number"
                        value={draft.maxRuns}
                        onChange={(event) => setDraft({ ...draft, maxRuns: event.target.value })}
                      />
                    </Field>
                    <Field className="min-w-0">
                      <FieldLabel className={scheduleFieldLabelClass} htmlFor={`${fieldId}-end-at`}>Stop on</FieldLabel>
                      <Input
                        className={scheduleInputClass}
                        id={`${fieldId}-end-at`}
                        type="datetime-local"
                        value={draft.endAt}
                        onChange={(event) => setDraft({ ...draft, endAt: event.target.value })}
                      />
                    </Field>
                  </div>
                ) : null}
              </ScheduleSection>

              <ScheduleSection className="border-t border-border pt-4" title="Run settings">
                <div className={responsiveFieldGridClass}>
                  <ScheduleSelectField
                    id={`${fieldId}-account`}
                    label="Provider account"
                    selectedLabel={availableAccounts.find((entry) => entry.id === draft.accountId)?.displayName ?? "Choose account"}
                    value={draft.accountId}
                    onValueChange={(accountId) => setDraft({ ...draft, accountId })}
                  >
                    {availableAccounts.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                  </ScheduleSelectField>
                  <ScheduleSelectField
                    id={`${fieldId}-access`}
                    label="Access"
                    selectedLabel={accessModeLabel(draft.permissionMode)}
                    value={draft.permissionMode}
                    onValueChange={(value) => setDraft({ ...draft, permissionMode: readComposerAccessMode(value) })}
                  >
                    <SelectItem value="askForApproval">Ask for approval</SelectItem>
                    <SelectItem value="fullAccess">Full access</SelectItem>
                  </ScheduleSelectField>
                  <ScheduleSelectField
                    id={`${fieldId}-mode`}
                    label="Mode"
                    selectedLabel={draft.collaborationMode === "plan" ? "Plan" : "Default"}
                    value={draft.collaborationMode}
                    onValueChange={(value) => setDraft({ ...draft, collaborationMode: value === "plan" ? "plan" : "default" })}
                  >
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="plan">Plan</SelectItem>
                  </ScheduleSelectField>
                  {supportsModels ? (
                    <ScheduleSelectField
                      id={`${fieldId}-model`}
                      label="Model"
                      selectedLabel={selectedModelLabel}
                      value={draft.model || visibleModelOptions[0]?.model || ""}
                      onValueChange={(model) => setDraft({ ...draft, model })}
                    >
                      {visibleModelOptions.map((option) => (
                        <SelectItem key={option.id} value={option.model}>
                          {option.displayName}
                        </SelectItem>
                      ))}
                    </ScheduleSelectField>
                  ) : null}
                  {supportsReasoningEffort ? (
                    <ScheduleSelectField
                      id={`${fieldId}-reasoning`}
                      label="Reasoning"
                      selectedLabel={composerReasoningEffortLabel(draft.reasoningEffort)}
                      value={draft.reasoningEffort}
                      onValueChange={(value) => setDraft({ ...draft, reasoningEffort: readComposerReasoningEffort(value) })}
                    >
                      {composerReasoningEffortOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </ScheduleSelectField>
                  ) : null}
                  {supportsServiceTier ? (
                    <ScheduleSelectField
                      id={`${fieldId}-speed`}
                      label="Speed"
                      selectedLabel={composerServiceTierLabel(draft.serviceTier)}
                      value={draft.serviceTier}
                      onValueChange={(value) => setDraft({ ...draft, serviceTier: readComposerServiceTier(value) })}
                    >
                      {composerServiceTierOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </ScheduleSelectField>
                  ) : null}
                </div>
              </ScheduleSection>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  type="button"
                  variant="destructive"
                  onClick={() => void shell.deleteSchedule(schedule.id)}
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
                <Button className="w-full sm:w-auto" disabled={!canSave || saving} size="sm" type="submit">
                  <Check className="size-3.5" />
                  {saving ? "Saving" : "Save"}
                </Button>
              </div>
            </FieldGroup>
          </form>

          <div className="min-w-0 border-t border-border pt-3 @5xl/schedule-detail:border-l @5xl/schedule-detail:border-t-0 @5xl/schedule-detail:pl-4 @5xl/schedule-detail:pt-0">
            <h3 className="text-[13px] font-semibold text-foreground">History</h3>
            <div className="mt-3 space-y-2">
              {runs.length ? runs.map((run) => (
                <Button
                  className="h-auto w-full justify-start rounded-md border-border bg-secondary/40 px-3 py-2 text-left hover:bg-popover"
                  key={run.id}
                  type="button"
                  variant="outline"
                  onClick={() => void shell.openScheduleRunChat(run)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{dateTimeLabel(run.scheduledFor)}</span>
                      <Badge className={cn("h-5 rounded px-1.5 text-[10px] font-semibold", scheduleRunStatusClass(run.status))} variant="outline">
                        {run.status.toLowerCase()}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[11px] font-normal text-muted-foreground">
                      {run.startedAt ? `Started ${relativeTimeLabel(run.startedAt)}` : "Waiting"}
                      {run.endedAt ? ` / Ended ${relativeTimeLabel(run.endedAt)}` : ""}
                    </div>
                    {run.error ? <div className="mt-1 line-clamp-2 text-[11px] font-normal text-destructive">{run.error}</div> : null}
                  </div>
                </Button>
              )) : (
                <div className="rounded-md border border-border bg-secondary/40 px-3 py-3 text-[12px] text-muted-foreground">No runs yet</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ScheduleSection({
  children,
  className,
  title,
}: {
  children: ReactNode
  className?: string
  title: string
}) {
  return (
    <FieldSet className={cn("gap-3", className)}>
      <FieldLegend className="mb-0 text-[12px] font-semibold text-foreground" variant="label">
        {title}
      </FieldLegend>
      <div className="grid gap-3">{children}</div>
    </FieldSet>
  )
}

function ScheduleSelectField({
  children,
  id,
  label,
  onValueChange,
  selectedLabel,
  value,
}: {
  children: ReactNode
  id: string
  label: string
  onValueChange: (value: string) => void
  selectedLabel: string
  value: string
}) {
  return (
    <Field className="min-w-0">
      <FieldLabel className={scheduleFieldLabelClass} htmlFor={id}>{label}</FieldLabel>
      <Select className="w-full min-w-0" value={value} onValueChange={onValueChange}>
        <SelectTrigger className={scheduleSelectTriggerClass} id={id}>
          <span className="min-w-0 truncate">{selectedLabel}</span>
        </SelectTrigger>
        <SelectContent align="start">
          {children}
        </SelectContent>
      </Select>
    </Field>
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
