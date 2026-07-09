import * as webPush from "web-push"
import type { PushSubscription as WebPushSubscription } from "web-push"
import type {
  PushPublicKeyResponse,
  PushSubscriptionRequest,
  PushSubscriptionResponse,
  PushTestResponse,
} from "../types/push"
import { ensureDatabase } from "./database.server"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"
import { onProviderEvent, type ProviderSocketEvent } from "./socket.server"

type PushSubscriptionRow = {
  createdAt: Date | string
  endpoint: string
  expirationTime: number | null
  keys: unknown
  updatedAt: Date | string
  userAgent: string | null
}

type PushNotificationPayload = {
  body?: string
  data?: {
    chatId?: string | null
    runId?: string | null
    url?: string
  }
  tag?: string
  title: string
}

type VapidKeys = {
  privateKey: string
  publicKey: string
}

const vapidSettingId = "web-push-vapid"
const defaultSubject = "mailto:pockcode@localhost"

const globalForWebPush = globalThis as typeof globalThis & {
  pockcodeWebPush?: {
    configuredKey?: string
    keysPromise?: Promise<VapidKeys | null>
    unsubscribeProviderEvents?: (() => void) | null
  }
}

const webPushState = globalForWebPush.pockcodeWebPush ?? {
  unsubscribeProviderEvents: null,
}
globalForWebPush.pockcodeWebPush = webPushState

export function startWebPushEventBridge(): void {
  if (webPushState.unsubscribeProviderEvents) {
    webPushState.unsubscribeProviderEvents()
  }
  webPushState.unsubscribeProviderEvents = onProviderEvent((event) => {
    void sendProviderEventNotification(event).catch((error) => {
      console.error("Web push notification failed.", error)
    })
  })
}

export function stopWebPushEventBridge(): void {
  webPushState.unsubscribeProviderEvents?.()
  webPushState.unsubscribeProviderEvents = null
}

export async function readWebPushPublicKey(): Promise<PushPublicKeyResponse> {
  const keys = await ensureVapidKeys()
  return { publicKey: keys?.publicKey ?? null, supported: Boolean(keys) }
}

export async function saveWebPushSubscription(
  subscription: PushSubscriptionRequest,
  userAgent?: string | null,
): Promise<PushSubscriptionResponse> {
  await ensureDatabase()
  await ensureVapidKeys()
  const normalized = normalizeSubscription(subscription)
  const timestamp = new Date().toISOString()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PushSubscription" (
      "endpoint", "expirationTime", "keys", "userAgent", "createdAt", "updatedAt"
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT("endpoint") DO UPDATE SET
      "expirationTime" = excluded."expirationTime",
      "keys" = excluded."keys",
      "userAgent" = excluded."userAgent",
      "updatedAt" = excluded."updatedAt"`,
    normalized.endpoint,
    normalized.expirationTime ?? null,
    JSON.stringify(normalized.keys),
    userAgent?.slice(0, 500) ?? null,
    timestamp,
    timestamp,
  )
  return serializeSubscription(await readSubscription(normalized.endpoint))
}

export async function deleteWebPushSubscription(endpoint: string): Promise<{ endpoint: string }> {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    throw new HttpError(400, "endpoint is required.")
  }
  await ensureDatabase()
  await prisma.$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE "endpoint" = ?`, trimmed)
  return { endpoint: trimmed }
}

export async function sendTestWebPushNotification(): Promise<PushTestResponse> {
  const sent = await sendWebPushNotification({
    body: "Notifications are ready.",
    data: { url: "/" },
    tag: "pockcode-test",
    title: "pockcode",
  })
  return { sent }
}

async function sendProviderEventNotification(event: ProviderSocketEvent): Promise<void> {
  if (event.type !== "run.status" || !event.threadId) {
    return
  }
  const payload = readRunStatusPayload(event.payload)
  if (!payload || (payload.status !== "COMPLETED" && payload.status !== "FAILED")) {
    return
  }
  await ensureDatabase()
  const chat = await prisma.chat.findUnique({
    select: { status: true, title: true, workingDirectory: true },
    where: { id: event.threadId },
  }).catch(() => null)
  if (payload.status === "COMPLETED" && chat?.status !== "IDLE") {
    return
  }
  const url = await notificationUrlForChat(event.threadId, chat?.workingDirectory ?? null)
  const title = payload.status === "COMPLETED" ? "Task finished" : "Task failed"
  const body = payload.status === "FAILED"
    ? payload.error ?? chat?.title ?? "A pockcode task failed."
    : chat?.title ?? "A pockcode task completed."
  await sendWebPushNotification({
    body,
    data: {
      chatId: event.threadId,
      runId: payload.runId,
      url,
    },
    tag: `pockcode-run-${payload.runId}`,
    title,
  })
}

async function notificationUrlForChat(chatId: string, workingDirectory: string | null): Promise<string> {
  const params = new URLSearchParams()
  if (workingDirectory) {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "WorkspaceHistory" WHERE "path" = ? LIMIT 1`,
      workingDirectory,
    ).catch(() => [])
    if (rows[0]?.id) {
      params.set("workspace", rows[0].id)
    }
  }
  params.set("chat", chatId)
  return `/?${params.toString()}`
}

async function sendWebPushNotification(payload: PushNotificationPayload): Promise<number> {
  const keys = await ensureVapidKeys()
  if (!keys) {
    return 0
  }
  const subscriptions = await listSubscriptions()
  let sent = 0
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 60 * 60,
        urgency: "normal",
        vapidDetails: {
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          subject: process.env.POCKCODE_WEB_PUSH_SUBJECT ?? defaultSubject,
        },
      })
      sent += 1
    } catch (error) {
      if (isExpiredSubscriptionError(error)) {
        await prisma.$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE "endpoint" = ?`, subscription.endpoint)
        return
      }
      console.error("Unable to send web push notification.", error)
    }
  }))
  return sent
}

async function ensureVapidKeys(): Promise<VapidKeys | null> {
  webPushState.keysPromise ??= readOrCreateVapidKeys()
  const keys = await webPushState.keysPromise
  if (!keys) {
    return null
  }
  const configuredKey = `${keys.publicKey}:${keys.privateKey}`
  if (webPushState.configuredKey !== configuredKey) {
    webPush.setVapidDetails(process.env.POCKCODE_WEB_PUSH_SUBJECT ?? defaultSubject, keys.publicKey, keys.privateKey)
    webPushState.configuredKey = configuredKey
  }
  return keys
}

async function readOrCreateVapidKeys(): Promise<VapidKeys | null> {
  if (process.env.POCKCODE_WEB_PUSH_PUBLIC_KEY && process.env.POCKCODE_WEB_PUSH_PRIVATE_KEY) {
    return {
      privateKey: process.env.POCKCODE_WEB_PUSH_PRIVATE_KEY,
      publicKey: process.env.POCKCODE_WEB_PUSH_PUBLIC_KEY,
    }
  }
  await ensureDatabase()
  const rows = await prisma.$queryRawUnsafe<{ settings: unknown }[]>(
    `SELECT "settings" FROM "ProviderSetting" WHERE "providerId" = ? LIMIT 1`,
    vapidSettingId,
  )
  const stored = readStoredVapidKeys(rows[0]?.settings)
  if (stored) {
    return stored
  }
  const generated = webPush.generateVAPIDKeys()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProviderSetting" ("providerId", "settings", "createdAt", "updatedAt")
      VALUES (?, ?, ?, ?)
      ON CONFLICT("providerId") DO UPDATE SET "settings" = excluded."settings", "updatedAt" = excluded."updatedAt"`,
    vapidSettingId,
    JSON.stringify(generated),
    new Date().toISOString(),
    new Date().toISOString(),
  )
  return generated
}

async function listSubscriptions(): Promise<WebPushSubscription[]> {
  await ensureDatabase()
  const rows = await prisma.$queryRawUnsafe<PushSubscriptionRow[]>(`SELECT * FROM "PushSubscription"`)
  return rows
    .map((row) => normalizeStoredSubscription(row))
    .filter((subscription): subscription is WebPushSubscription => Boolean(subscription))
}

async function readSubscription(endpoint: string): Promise<PushSubscriptionRow> {
  const rows = await prisma.$queryRawUnsafe<PushSubscriptionRow[]>(
    `SELECT * FROM "PushSubscription" WHERE "endpoint" = ? LIMIT 1`,
    endpoint,
  )
  const row = rows[0]
  if (!row) {
    throw new HttpError(404, "Push subscription not found.")
  }
  return row
}

function normalizeSubscription(subscription: PushSubscriptionRequest): WebPushSubscription {
  if (!subscription || typeof subscription !== "object") {
    throw new HttpError(400, "subscription must be an object.")
  }
  const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint.trim() : ""
  const auth = typeof subscription.keys?.auth === "string" ? subscription.keys.auth.trim() : ""
  const p256dh = typeof subscription.keys?.p256dh === "string" ? subscription.keys.p256dh.trim() : ""
  if (!endpoint || !auth || !p256dh) {
    throw new HttpError(400, "subscription endpoint and keys are required.")
  }
  if (endpoint.length > 2000 || auth.length > 500 || p256dh.length > 500) {
    throw new HttpError(400, "subscription is too large.")
  }
  const expirationTime = typeof subscription.expirationTime === "number" && Number.isFinite(subscription.expirationTime)
    ? subscription.expirationTime
    : null
  return {
    endpoint,
    expirationTime,
    keys: { auth, p256dh },
  }
}

function normalizeStoredSubscription(row: PushSubscriptionRow): WebPushSubscription | null {
  const keys = typeof row.keys === "string" ? parseJsonObject(row.keys) : row.keys
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    return null
  }
  const auth = (keys as { auth?: unknown }).auth
  const p256dh = (keys as { p256dh?: unknown }).p256dh
  if (typeof auth !== "string" || typeof p256dh !== "string") {
    return null
  }
  return {
    endpoint: row.endpoint,
    expirationTime: row.expirationTime,
    keys: { auth, p256dh },
  }
}

function serializeSubscription(row: PushSubscriptionRow): PushSubscriptionResponse {
  return {
    createdAt: readDateValue(row.createdAt).toISOString(),
    endpoint: row.endpoint,
    updatedAt: readDateValue(row.updatedAt).toISOString(),
  }
}

function readStoredVapidKeys(value: unknown): VapidKeys | null {
  const record = typeof value === "string" ? parseJsonObject(value) : value
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null
  }
  const publicKey = (record as { publicKey?: unknown }).publicKey
  const privateKey = (record as { privateKey?: unknown }).privateKey
  return typeof publicKey === "string" && typeof privateKey === "string"
    ? { privateKey, publicKey }
    : null
}

function readRunStatusPayload(payload: unknown): {
  error?: string
  runId: string
  status: "COMPLETED" | "FAILED" | "RUNNING" | "QUEUED" | "CANCELLED"
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null
  }
  const runId = (payload as { runId?: unknown }).runId
  const status = (payload as { status?: unknown }).status
  const error = (payload as { error?: unknown }).error
  if (typeof runId !== "string") {
    return null
  }
  if (status !== "COMPLETED" && status !== "FAILED" && status !== "RUNNING" && status !== "QUEUED" && status !== "CANCELLED") {
    return null
  }
  return {
    error: typeof error === "string" ? error : undefined,
    runId,
    status,
  }
}

function isExpiredSubscriptionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode
  return statusCode === 404 || statusCode === 410
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function readDateValue(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}
