import { randomUUID } from "node:crypto"
import type {
  CreateMessageScheduleRequest,
  MessageScheduleRecurrence,
  MessageScheduleResponse,
  MessageScheduleRunResponse,
  MessageScheduleRunStatus,
  MessageScheduleStatus,
  UpdateMessageScheduleRequest,
} from "../types/providers"
import { requireConnectedAccount } from "./accounts.service"
import { createChat, executeMessage } from "./chats.service"
import { ensureDatabase } from "./database.server"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"
import { publishProviderEvent } from "./socket.server"

type MessageScheduleRow = {
  accountId: string | null
  chatId: string | null
  collaborationMode: string
  createdAt: Date | string
  goalObjective: string | null
  id: string
  lastRunAt: Date | string | null
  lastRunStatus: string | null
  message: string
  model: string | null
  nextRunAt: Date | string | null
  permissionMode: string
  providerId: string
  reasoningEffort: string | null
  recurrence: unknown
  serviceTier: string | null
  status: string
  title: string
  updatedAt: Date | string
  workingDirectory: string
}

type MessageScheduleRunRow = {
  chatId: string | null
  chatRunId: string | null
  createdAt: Date | string
  endedAt: Date | string | null
  error: string | null
  id: string
  scheduleId: string
  scheduledFor: Date | string
  startedAt: Date | string | null
  status: string
  updatedAt: Date | string
}

const terminalRunStatuses = new Set<MessageScheduleRunStatus>(["COMPLETED", "FAILED", "CANCELLED"])
const schedulePageLimit = 500
const dueScheduleLimit = 20

export async function listMessageSchedules(workingDirectory?: string | null): Promise<MessageScheduleResponse[]> {
  await ensureDatabase()
  const path = workingDirectory?.trim()
  const rows = path
    ? await prisma.$queryRawUnsafe<MessageScheduleRow[]>(
      `SELECT * FROM "MessageSchedule" WHERE "status" <> 'ARCHIVED' AND "workingDirectory" = ? ORDER BY "nextRunAt" IS NULL, "nextRunAt" ASC, "updatedAt" DESC LIMIT ?`,
      path,
      schedulePageLimit,
    )
    : await prisma.$queryRawUnsafe<MessageScheduleRow[]>(
      `SELECT * FROM "MessageSchedule" WHERE "status" <> 'ARCHIVED' ORDER BY "nextRunAt" IS NULL, "nextRunAt" ASC, "updatedAt" DESC LIMIT ?`,
      schedulePageLimit,
    )
  return rows.map(serializeSchedule)
}

export async function getMessageSchedule(scheduleId: string): Promise<MessageScheduleResponse> {
  const row = await readScheduleRow(scheduleId)
  if (row.status === "ARCHIVED") {
    throw new HttpError(404, "Schedule not found.")
  }
  return serializeSchedule(row)
}

export async function createMessageSchedule(dto: CreateMessageScheduleRequest): Promise<MessageScheduleResponse> {
  await ensureDatabase()
  const message = requiredTrimmed(dto.message, "message", 20_000)
  const title = normalizeTitle(dto.title) ?? titleFromMessage(message)
  const workingDirectory = requiredTrimmed(dto.workingDirectory, "workingDirectory", 2000)
  const firstRunAt = readDate(dto.firstRunAt, "firstRunAt")
  const account = await requireConnectedAccount(dto.accountId)
  const recurrence = normalizeRecurrence(dto.recurrence, firstRunAt)
  const status = dto.status === "PAUSED" ? "PAUSED" : "ACTIVE"
  const id = randomUUID()
  const timestamp = new Date().toISOString()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MessageSchedule" (
      "id", "title", "message", "workingDirectory", "chatId", "providerId", "accountId",
      "model", "reasoningEffort", "serviceTier", "collaborationMode", "permissionMode", "goalObjective",
      "status", "recurrence", "nextRunAt", "createdAt", "updatedAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    title,
    message,
    workingDirectory,
    null,
    account.providerId,
    account.id,
    nullableString(dto.model),
    nullableString(dto.reasoningEffort),
    nullableString(dto.serviceTier),
    dto.collaborationMode ?? "default",
    dto.permissionMode ?? "default",
    nullableString(dto.goalObjective),
    status,
    JSON.stringify(recurrence),
    firstRunAt.toISOString(),
    timestamp,
    timestamp,
  )
  const schedule = await getMessageSchedule(id)
  publishScheduleUpdated(schedule)
  return schedule
}

export async function updateMessageSchedule(
  scheduleId: string,
  dto: UpdateMessageScheduleRequest,
): Promise<MessageScheduleResponse> {
  const current = await readScheduleRow(scheduleId)
  if (current.status === "ARCHIVED") {
    throw new HttpError(404, "Schedule not found.")
  }
  const account = dto.accountId === undefined || dto.accountId === current.accountId
    ? null
    : dto.accountId
      ? await requireConnectedAccount(dto.accountId)
      : null
  if (account && account.providerId !== current.providerId) {
    throw new HttpError(400, "Switching provider types for an existing schedule is not supported.")
  }
  const firstRunAt = dto.firstRunAt === undefined
    ? null
    : dto.firstRunAt === null
      ? null
      : readDate(dto.firstRunAt, "firstRunAt")
  const anchorDate = firstRunAt ?? readNullableDate(current.nextRunAt) ?? readDateValue(current.createdAt)
  const recurrence = dto.recurrence === undefined
    ? readRecurrence(current.recurrence, anchorDate)
    : normalizeRecurrence(dto.recurrence, anchorDate)
  const nextStatus = readScheduleStatus(dto.status) ?? readScheduleStatus(current.status) ?? "ACTIVE"
  const nextRunAt = nextStatus === "ARCHIVED" || nextStatus === "COMPLETED"
    ? null
    : firstRunAt === null
      ? readNullableDate(current.nextRunAt)
      : firstRunAt

  await prisma.$executeRawUnsafe(
    `UPDATE "MessageSchedule" SET
      "title" = ?,
      "message" = ?,
      "accountId" = ?,
      "model" = ?,
      "reasoningEffort" = ?,
      "serviceTier" = ?,
      "collaborationMode" = ?,
      "permissionMode" = ?,
      "goalObjective" = ?,
      "status" = ?,
      "recurrence" = ?,
      "nextRunAt" = ?,
      "updatedAt" = ?
    WHERE "id" = ?`,
    dto.title === undefined ? current.title : normalizeTitle(dto.title) ?? current.title,
    dto.message === undefined ? current.message : requiredTrimmed(dto.message, "message", 20_000),
    dto.accountId === undefined ? current.accountId : account?.id ?? null,
    dto.model === undefined ? current.model : nullableString(dto.model),
    dto.reasoningEffort === undefined ? current.reasoningEffort : nullableString(dto.reasoningEffort),
    dto.serviceTier === undefined ? current.serviceTier : nullableString(dto.serviceTier),
    dto.collaborationMode === undefined ? current.collaborationMode : dto.collaborationMode ?? "default",
    dto.permissionMode === undefined ? current.permissionMode : dto.permissionMode ?? "default",
    dto.goalObjective === undefined ? current.goalObjective : nullableString(dto.goalObjective),
    nextStatus,
    JSON.stringify(recurrence),
    nextRunAt?.toISOString() ?? null,
    new Date().toISOString(),
    scheduleId,
  )
  const schedule = await getMessageSchedule(scheduleId)
  publishScheduleUpdated(schedule)
  return schedule
}

export async function archiveMessageSchedule(scheduleId: string): Promise<MessageScheduleResponse> {
  await readScheduleRow(scheduleId)
  await prisma.$executeRawUnsafe(
    `UPDATE "MessageSchedule" SET "status" = 'ARCHIVED', "nextRunAt" = NULL, "updatedAt" = ? WHERE "id" = ?`,
    new Date().toISOString(),
    scheduleId,
  )
  const row = await readScheduleRow(scheduleId)
  const schedule = serializeSchedule(row)
  publishScheduleUpdated(schedule)
  return schedule
}

export async function listMessageScheduleRuns(scheduleId: string): Promise<MessageScheduleRunResponse[]> {
  await readScheduleRow(scheduleId)
  const rows = await prisma.$queryRawUnsafe<MessageScheduleRunRow[]>(
    `SELECT * FROM "MessageScheduleRun" WHERE "scheduleId" = ? ORDER BY "scheduledFor" DESC, "createdAt" DESC LIMIT 100`,
    scheduleId,
  )
  return rows.map(serializeScheduleRun)
}

export async function processDueMessageSchedules(now = new Date()): Promise<void> {
  await ensureDatabase()
  await syncMessageScheduleRunStatuses()
  const rows = await prisma.$queryRawUnsafe<MessageScheduleRow[]>(
    `SELECT * FROM "MessageSchedule"
      WHERE "status" = 'ACTIVE' AND "nextRunAt" IS NOT NULL AND datetime("nextRunAt") <= datetime(?)
      ORDER BY "nextRunAt" ASC LIMIT ?`,
    now.toISOString(),
    dueScheduleLimit,
  )
  for (const row of rows) {
    await executeDueSchedule(row, now)
  }
  await syncMessageScheduleRunStatuses()
}

export async function syncMessageScheduleRunStatuses(): Promise<void> {
  await ensureDatabase()
  const rows = await prisma.$queryRawUnsafe<(MessageScheduleRunRow & {
    chatRunEndedAt: Date | string | null
    chatRunError: string | null
    chatRunStatus: string | null
  })[]>(
    `SELECT
      "MessageScheduleRun".*,
      "ChatRun"."status" AS "chatRunStatus",
      "ChatRun"."error" AS "chatRunError",
      "ChatRun"."endedAt" AS "chatRunEndedAt"
    FROM "MessageScheduleRun"
    LEFT JOIN "ChatRun" ON "MessageScheduleRun"."chatRunId" = "ChatRun"."id"
    WHERE "MessageScheduleRun"."chatRunId" IS NOT NULL
      AND "MessageScheduleRun"."status" IN ('QUEUED', 'RUNNING')
    LIMIT 100`,
  )
  for (const row of rows) {
    const chatRunStatus = readRunStatus(row.chatRunStatus)
    if (!chatRunStatus || chatRunStatus === row.status) {
      continue
    }
    const endedAt = terminalRunStatuses.has(chatRunStatus)
      ? readNullableDate(row.chatRunEndedAt) ?? new Date()
      : null
    await prisma.$executeRawUnsafe(
      `UPDATE "MessageScheduleRun" SET "status" = ?, "error" = ?, "endedAt" = COALESCE(?, "endedAt"), "updatedAt" = ? WHERE "id" = ?`,
      chatRunStatus,
      chatRunStatus === "FAILED" ? row.chatRunError ?? "Scheduled chat run failed." : row.error,
      endedAt?.toISOString() ?? null,
      new Date().toISOString(),
      row.id,
    )
    const run = serializeScheduleRun({ ...row, endedAt: endedAt ?? row.endedAt, error: row.chatRunError ?? row.error, status: chatRunStatus })
    await refreshScheduleLastRunStatus(row.scheduleId, run)
    publishScheduleRunUpdated(run)
  }
}

async function executeDueSchedule(row: MessageScheduleRow, now: Date): Promise<void> {
  const schedule = serializeSchedule(row)
  const nextRunAt = readNullableDate(row.nextRunAt)
  if (!nextRunAt) {
    return
  }
  const scheduledFor = latestDueOccurrence(schedule.recurrence, nextRunAt, now)
  const runId = randomUUID()
  const timestamp = new Date().toISOString()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MessageScheduleRun" (
      "id", "scheduleId", "chatId", "scheduledFor", "status", "createdAt", "updatedAt"
    ) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)`,
    runId,
    row.id,
    null,
    scheduledFor.toISOString(),
    timestamp,
    timestamp,
  )
  publishScheduleRunUpdated(await getScheduleRun(runId))

  const runCountAfter = await countScheduleRuns(row.id)
  const advance = advanceSchedule(schedule.recurrence, scheduledFor, now, runCountAfter)
  let chatId: string | null = null
  try {
    chatId = await createScheduleRunChat(row)
    const result = await executeMessage(chatId, {
      accountId: row.accountId ?? undefined,
      collaborationMode: row.collaborationMode,
      content: row.message,
      goalObjective: row.goalObjective,
      metadata: {
        model: row.model,
        reasoningEffort: row.reasoningEffort,
        scheduleId: row.id,
        scheduleRunId: runId,
        serviceTier: row.serviceTier,
      },
      permissionMode: row.permissionMode,
    })
    const nextStatus = readRunStatus(result.status) ?? "QUEUED"
    await prisma.$executeRawUnsafe(
      `UPDATE "MessageScheduleRun" SET
        "chatId" = ?,
        "chatRunId" = ?,
        "startedAt" = ?,
        "status" = ?,
        "updatedAt" = ?
      WHERE "id" = ?`,
      chatId,
      result.runId ?? null,
      new Date().toISOString(),
      nextStatus,
      new Date().toISOString(),
      runId,
    )
    await updateScheduleAfterAttempt(row.id, scheduledFor, nextStatus, advance)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled message failed."
    const failedAt = new Date().toISOString()
    await prisma.$executeRawUnsafe(
      `UPDATE "MessageScheduleRun" SET "chatId" = COALESCE("chatId", ?), "status" = 'FAILED', "error" = ?, "startedAt" = COALESCE("startedAt", ?), "endedAt" = ?, "updatedAt" = ? WHERE "id" = ?`,
      chatId,
      message,
      failedAt,
      failedAt,
      failedAt,
      runId,
    )
    await updateScheduleAfterAttempt(row.id, scheduledFor, "FAILED", advance)
  }
  publishScheduleRunUpdated(await getScheduleRun(runId))
  publishScheduleUpdated(await getMessageSchedule(row.id).catch(() => serializeSchedule({ ...row, status: advance.status, nextRunAt: advance.nextRunAt })))
}

async function createScheduleRunChat(row: MessageScheduleRow): Promise<string> {
  if (!row.accountId) {
    throw new HttpError(400, "Schedule has no provider account.")
  }
  const account = await requireConnectedAccount(row.accountId)
  if (account.providerId !== row.providerId) {
    throw new HttpError(400, "Schedule account provider no longer matches the schedule.")
  }
  const chat = await createChat({
    accountId: account.id,
    collaborationMode: row.collaborationMode,
    model: row.model,
    permissionMode: row.permissionMode,
    providerId: row.providerId,
    reasoningEffort: row.reasoningEffort,
    serviceTier: row.serviceTier,
    title: `Schedule: ${row.title}`,
    workingDirectory: row.workingDirectory,
  })
  return chat.id
}

async function updateScheduleAfterAttempt(
  scheduleId: string,
  scheduledFor: Date,
  lastRunStatus: MessageScheduleRunStatus,
  advance: { nextRunAt: Date | null; status: MessageScheduleStatus },
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "MessageSchedule" SET
      "chatId" = NULL,
      "lastRunAt" = ?,
      "lastRunStatus" = ?,
      "nextRunAt" = ?,
      "status" = ?,
      "updatedAt" = ?
    WHERE "id" = ?`,
    scheduledFor.toISOString(),
    lastRunStatus,
    advance.nextRunAt?.toISOString() ?? null,
    advance.status,
    new Date().toISOString(),
    scheduleId,
  )
}

async function refreshScheduleLastRunStatus(scheduleId: string, run: MessageScheduleRunResponse): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "MessageSchedule" SET "lastRunStatus" = ?, "updatedAt" = ? WHERE "id" = ? AND "lastRunAt" = ?`,
    run.status,
    new Date().toISOString(),
    scheduleId,
    run.scheduledFor,
  )
  const schedule = await getMessageSchedule(scheduleId).catch(() => null)
  if (schedule) {
    publishScheduleUpdated(schedule)
  }
}

async function readScheduleRow(scheduleId: string): Promise<MessageScheduleRow> {
  await ensureDatabase()
  const rows = await prisma.$queryRawUnsafe<MessageScheduleRow[]>(
    `SELECT * FROM "MessageSchedule" WHERE "id" = ? LIMIT 1`,
    scheduleId,
  )
  const row = rows[0]
  if (!row) {
    throw new HttpError(404, "Schedule not found.")
  }
  return row
}

async function getScheduleRun(runId: string): Promise<MessageScheduleRunResponse> {
  const rows = await prisma.$queryRawUnsafe<MessageScheduleRunRow[]>(
    `SELECT * FROM "MessageScheduleRun" WHERE "id" = ? LIMIT 1`,
    runId,
  )
  const row = rows[0]
  if (!row) {
    throw new HttpError(404, "Schedule run not found.")
  }
  return serializeScheduleRun(row)
}

async function countScheduleRuns(scheduleId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
    `SELECT COUNT(*) AS "count" FROM "MessageScheduleRun" WHERE "scheduleId" = ? AND "status" <> 'CANCELLED'`,
    scheduleId,
  )
  const count = rows[0]?.count ?? 0
  return typeof count === "bigint" ? Number(count) : count
}

function advanceSchedule(
  recurrence: MessageScheduleRecurrence,
  scheduledFor: Date,
  now: Date,
  runCountAfter: number,
): { nextRunAt: Date | null; status: MessageScheduleStatus } {
  if (recurrence.frequency === "none") {
    return { nextRunAt: null, status: "COMPLETED" }
  }
  if (recurrence.maxRuns && runCountAfter >= recurrence.maxRuns) {
    return { nextRunAt: null, status: "COMPLETED" }
  }
  let nextRunAt = addRecurrence(scheduledFor, recurrence)
  let guard = 0
  while (nextRunAt.getTime() <= now.getTime() && guard < 10000) {
    nextRunAt = addRecurrence(nextRunAt, recurrence)
    guard += 1
  }
  const endAt = recurrence.endAt ? readDate(recurrence.endAt, "recurrence.endAt") : null
  if (endAt && nextRunAt.getTime() > endAt.getTime()) {
    return { nextRunAt: null, status: "COMPLETED" }
  }
  return { nextRunAt, status: "ACTIVE" }
}

function latestDueOccurrence(recurrence: MessageScheduleRecurrence, firstDue: Date, now: Date): Date {
  if (recurrence.frequency === "none") {
    return firstDue
  }
  let latest = firstDue
  let next = addRecurrence(latest, recurrence)
  let guard = 0
  while (next.getTime() <= now.getTime() && guard < 10000) {
    latest = next
    next = addRecurrence(latest, recurrence)
    guard += 1
  }
  return latest
}

function addRecurrence(date: Date, recurrence: MessageScheduleRecurrence): Date {
  const interval = Math.max(1, Math.floor(recurrence.interval || 1))
  if (recurrence.frequency === "daily") {
    const next = new Date(date)
    next.setUTCDate(next.getUTCDate() + interval)
    return next
  }
  if (recurrence.frequency === "weekly") {
    const next = new Date(date)
    next.setUTCDate(next.getUTCDate() + interval * 7)
    return next
  }
  if (recurrence.frequency === "monthly") {
    const anchorDay = recurrence.anchorDay ?? date.getUTCDate()
    return addMonthsClamped(date, interval, anchorDay)
  }
  return new Date(date)
}

function addMonthsClamped(date: Date, months: number, anchorDay: number): Date {
  const targetMonth = date.getUTCMonth() + months
  const target = new Date(Date.UTC(
    date.getUTCFullYear(),
    targetMonth,
    1,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(anchorDay, lastDay))
  return target
}

function normalizeRecurrence(value: Partial<MessageScheduleRecurrence> | undefined, firstRunAt: Date): MessageScheduleRecurrence {
  const frequency = value?.frequency === "daily" || value?.frequency === "weekly" || value?.frequency === "monthly"
    ? value.frequency
    : "none"
  const interval = typeof value?.interval === "number" && Number.isFinite(value.interval)
    ? Math.min(365, Math.max(1, Math.floor(value.interval)))
    : 1
  const maxRuns = typeof value?.maxRuns === "number" && Number.isFinite(value.maxRuns)
    ? Math.min(10000, Math.max(1, Math.floor(value.maxRuns)))
    : null
  const endAt = typeof value?.endAt === "string" && value.endAt.trim()
    ? readDate(value.endAt, "recurrence.endAt").toISOString()
    : null
  const anchorDay = typeof value?.anchorDay === "number" && Number.isFinite(value.anchorDay)
    ? Math.min(31, Math.max(1, Math.floor(value.anchorDay)))
    : firstRunAt.getUTCDate()
  return {
    anchorDay: frequency === "monthly" ? anchorDay : null,
    endAt,
    frequency,
    interval,
    maxRuns,
  }
}

function readRecurrence(value: unknown, anchorDate: Date): MessageScheduleRecurrence {
  if (!value) {
    return normalizeRecurrence(undefined, anchorDate)
  }
  const record = typeof value === "string" ? parseJsonObject(value) : value
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return normalizeRecurrence(undefined, anchorDate)
  }
  return normalizeRecurrence(record as Partial<MessageScheduleRecurrence>, anchorDate)
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function serializeSchedule(row: MessageScheduleRow): MessageScheduleResponse {
  const anchor = readNullableDate(row.nextRunAt) ?? readDateValue(row.createdAt)
  return {
    accountId: row.accountId,
    chatId: row.chatId,
    collaborationMode: row.collaborationMode,
    createdAt: readDateValue(row.createdAt).toISOString(),
    goalObjective: row.goalObjective,
    id: row.id,
    lastRunAt: readNullableDate(row.lastRunAt)?.toISOString() ?? null,
    lastRunStatus: readRunStatus(row.lastRunStatus),
    message: row.message,
    model: row.model,
    nextRunAt: readNullableDate(row.nextRunAt)?.toISOString() ?? null,
    permissionMode: row.permissionMode,
    providerId: row.providerId,
    reasoningEffort: row.reasoningEffort,
    recurrence: readRecurrence(row.recurrence, anchor),
    serviceTier: row.serviceTier,
    status: readScheduleStatus(row.status) ?? "ACTIVE",
    title: row.title,
    updatedAt: readDateValue(row.updatedAt).toISOString(),
    workingDirectory: row.workingDirectory,
  }
}

function serializeScheduleRun(row: MessageScheduleRunRow): MessageScheduleRunResponse {
  return {
    chatId: row.chatId,
    chatRunId: row.chatRunId,
    createdAt: readDateValue(row.createdAt).toISOString(),
    endedAt: readNullableDate(row.endedAt)?.toISOString() ?? null,
    error: row.error,
    id: row.id,
    scheduleId: row.scheduleId,
    scheduledFor: readDateValue(row.scheduledFor).toISOString(),
    startedAt: readNullableDate(row.startedAt)?.toISOString() ?? null,
    status: readRunStatus(row.status) ?? "QUEUED",
    updatedAt: readDateValue(row.updatedAt).toISOString(),
  }
}

function publishScheduleUpdated(schedule: MessageScheduleResponse): void {
  publishProviderEvent({ type: "schedule.updated", payload: schedule })
}

function publishScheduleRunUpdated(run: MessageScheduleRunResponse): void {
  publishProviderEvent({ type: "schedule.run.updated", payload: run })
}

function readDate(value: string, field: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(400, `${field} must be a valid date.`)
  }
  return date
}

function readNullableDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null
  }
  return readDateValue(value)
}

function readDateValue(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function readScheduleStatus(value: unknown): MessageScheduleStatus | null {
  return value === "ACTIVE" || value === "PAUSED" || value === "COMPLETED" || value === "ARCHIVED" ? value : null
}

function readRunStatus(value: unknown): MessageScheduleRunStatus | null {
  return value === "QUEUED" || value === "RUNNING" || value === "COMPLETED" || value === "FAILED" || value === "CANCELLED"
    ? value
    : null
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function requiredTrimmed(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required.`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`)
  }
  return trimmed
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const title = value.trim().replace(/\s+/gu, " ")
  return title ? title.slice(0, 160) : null
}

function titleFromMessage(value: string): string {
  return value.trim().replace(/\s+/gu, " ").slice(0, 80) || "Scheduled message"
}
