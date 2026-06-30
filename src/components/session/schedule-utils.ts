import type {
  MessageScheduleRecurrence,
  MessageScheduleResponse,
  MessageScheduleRunResponse,
  MessageScheduleRunStatus,
} from "@/lib/api-client"
import { readRecord, readRecordString } from "@/lib/session"

export function upsertSchedule(schedules: MessageScheduleResponse[], schedule: MessageScheduleResponse): MessageScheduleResponse[] {
  const next = schedules.some((entry) => entry.id === schedule.id)
    ? schedules.map((entry) => (entry.id === schedule.id ? schedule : entry))
    : [schedule, ...schedules]
  return next.sort(compareSchedules)
}

export function upsertScheduleRun(
  runs: MessageScheduleRunResponse[],
  run: MessageScheduleRunResponse,
): MessageScheduleRunResponse[] {
  const next = runs.some((entry) => entry.id === run.id)
    ? runs.map((entry) => (entry.id === run.id ? run : entry))
    : [run, ...runs]
  return next.sort((left, right) => Date.parse(right.scheduledFor) - Date.parse(left.scheduledFor))
}

export function compareSchedules(left: MessageScheduleResponse, right: MessageScheduleResponse): number {
  const leftNext = left.nextRunAt ? Date.parse(left.nextRunAt) : Number.POSITIVE_INFINITY
  const rightNext = right.nextRunAt ? Date.parse(right.nextRunAt) : Number.POSITIVE_INFINITY
  return leftNext - rightNext || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

export function recurrenceLabel(recurrence: MessageScheduleRecurrence): string {
  if (recurrence.frequency === "none") {
    return "One time"
  }
  const unit = recurrence.frequency === "daily"
    ? "day"
    : recurrence.frequency === "weekly"
      ? "week"
      : "month"
  return recurrence.interval > 1 ? `Every ${recurrence.interval} ${unit}s` : `Every ${unit}`
}

export function recurrenceFrequencyLabel(frequency: MessageScheduleRecurrence["frequency"]): string {
  if (frequency === "daily") return "Daily"
  if (frequency === "weekly") return "Weekly"
  if (frequency === "monthly") return "Monthly"
  return "One time"
}

export function readRecurrenceFrequency(value: string): MessageScheduleRecurrence["frequency"] {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : "none"
}

export function dateTimeLabel(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return ""
  }
  return date.toLocaleString([], {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  })
}

export function localDateTimeInputValue(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return ""
  }
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

export function isoFromLocalDateTimeInput(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return new Date().toISOString()
  }
  return date.toISOString()
}

export function scheduleRunStatusClass(status: MessageScheduleRunStatus): string {
  if (status === "COMPLETED") return "bg-success/10 text-success"
  if (status === "FAILED" || status === "CANCELLED") return "bg-destructive/10 text-destructive"
  if (status === "RUNNING") return "bg-info/15 text-info"
  return "bg-warning/10 text-warning"
}

export function readMessageScheduleResponse(value: unknown): MessageScheduleResponse | null {
  const record = readRecord(value)
  const id = readRecordString(record, "id")
  const status = record.status === "ACTIVE" || record.status === "PAUSED" || record.status === "COMPLETED" || record.status === "ARCHIVED"
  if (!id || !status || typeof record.message !== "string" || !readRecordString(record, "workingDirectory")) {
    return null
  }
  return record as MessageScheduleResponse
}

export function readMessageScheduleRunResponse(value: unknown): MessageScheduleRunResponse | null {
  const record = readRecord(value)
  const id = readRecordString(record, "id")
  const scheduleId = readRecordString(record, "scheduleId")
  const status = record.status === "QUEUED" || record.status === "RUNNING" || record.status === "COMPLETED" ||
    record.status === "FAILED" || record.status === "CANCELLED"
  if (!id || !scheduleId || !status || !readRecordString(record, "scheduledFor")) {
    return null
  }
  return record as MessageScheduleRunResponse
}
