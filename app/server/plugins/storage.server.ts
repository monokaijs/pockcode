import type { JsonObject } from "../../types/json"
import { ensureDatabase } from "../database.server"
import { prisma } from "../prisma.server"

export type PluginSettingRecord = {
  enabled: boolean
  pluginId: string
  secrets: JsonObject
  settings: JsonObject
}

type PluginSettingRow = {
  enabled: boolean | number
  pluginId: string
  secrets: unknown
  settings: unknown
}

type PluginStateRow = {
  pluginId: string
  state: unknown
}

export async function readPluginSetting(pluginId: string, defaults: JsonObject = {}): Promise<PluginSettingRecord> {
  await ensureDatabase()
  const rows = await prisma.$queryRawUnsafe<PluginSettingRow[]>(
    `SELECT "pluginId", "enabled", "settings", "secrets" FROM "PluginSetting" WHERE "pluginId" = ? LIMIT 1`,
    pluginId,
  )
  const row = rows[0]
  if (!row) {
    return { enabled: false, pluginId, secrets: {}, settings: defaults }
  }
  return {
    enabled: row.enabled === true || row.enabled === 1,
    pluginId: row.pluginId,
    secrets: readJsonObject(row.secrets),
    settings: { ...defaults, ...readJsonObject(row.settings) },
  }
}

export async function writePluginSetting(record: PluginSettingRecord): Promise<PluginSettingRecord> {
  await ensureDatabase()
  const timestamp = new Date().toISOString()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PluginSetting" ("pluginId", "enabled", "settings", "secrets", "createdAt", "updatedAt")
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT("pluginId") DO UPDATE SET
        "enabled" = excluded."enabled",
        "settings" = excluded."settings",
        "secrets" = excluded."secrets",
        "updatedAt" = excluded."updatedAt"`,
    record.pluginId,
    record.enabled ? 1 : 0,
    JSON.stringify(record.settings),
    JSON.stringify(record.secrets),
    timestamp,
    timestamp,
  )
  return record
}

export async function readPluginState(pluginId: string): Promise<JsonObject> {
  await ensureDatabase()
  const rows = await prisma.$queryRawUnsafe<PluginStateRow[]>(
    `SELECT "pluginId", "state" FROM "PluginState" WHERE "pluginId" = ? LIMIT 1`,
    pluginId,
  )
  return readJsonObject(rows[0]?.state)
}

export async function writePluginState(pluginId: string, state: JsonObject): Promise<JsonObject> {
  await ensureDatabase()
  const timestamp = new Date().toISOString()
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PluginState" ("pluginId", "state", "createdAt", "updatedAt")
      VALUES (?, ?, ?, ?)
      ON CONFLICT("pluginId") DO UPDATE SET
        "state" = excluded."state",
        "updatedAt" = excluded."updatedAt"`,
    pluginId,
    JSON.stringify(state),
    timestamp,
    timestamp,
  )
  return state
}

export async function updatePluginState(
  pluginId: string,
  updater: (state: JsonObject) => JsonObject | Promise<JsonObject>,
): Promise<JsonObject> {
  const current = await readPluginState(pluginId)
  const next = await updater(current)
  return writePluginState(pluginId, next)
}

export function readJsonObject(value: unknown): JsonObject {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return readJsonObject(parsed)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return value as JsonObject
}
