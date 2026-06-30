import type { JsonObject } from "../types/json"
import type { PluginActionResponse, PluginResponse, PluginSettingsUpdateRequest } from "../types/plugins"
import { HttpError } from "./http.server"
import { createPluginContext, getPluginStatus, restartPlugin } from "./plugins/manager.server"
import { listPluginRegistrations, readPluginRegistration } from "./plugins/registry.server"
import { readPluginSetting, readPluginState, writePluginSetting } from "./plugins/storage.server"
import { verifyTelegramBotToken } from "./plugins/telegram.server"

export async function listPlugins(): Promise<PluginResponse[]> {
  return Promise.all(listPluginRegistrations().map((registration) => serializePlugin(registration.definition.id)))
}

export async function updatePlugin(pluginId: string, dto: PluginSettingsUpdateRequest): Promise<PluginResponse> {
  const registration = readKnownPlugin(pluginId)
  const current = await readPluginSetting(pluginId, registration.definition.defaultSettings)
  const settings = dto.settings === undefined
    ? current.settings
    : filterSettings(dto.settings, registration.definition.settingsFields.map((field) => field.key), current.settings)
  const secrets = dto.secrets === undefined
    ? current.secrets
    : filterSecrets(dto.secrets, registration.definition.secretFields.map((field) => field.key), current.secrets)
  const enabled = dto.enabled ?? current.enabled
  if (pluginId === "telegram" && enabled) {
    await verifyTelegramBotToken(readSecret(secrets, "botToken"))
  }
  await writePluginSetting({
    enabled,
    pluginId,
    secrets,
    settings,
  })
  await restartPlugin(pluginId)
  return serializePlugin(pluginId)
}

export async function runPluginAction(pluginId: string, action: string): Promise<PluginActionResponse> {
  const registration = readKnownPlugin(pluginId)
  const handler = registration.actions?.[action]
  if (!handler) {
    throw new HttpError(404, "Plugin action not found.")
  }
  const setting = await readPluginSetting(pluginId, registration.definition.defaultSettings)
  const result = await handler(createPluginContext(pluginId, setting))
  await restartPlugin(pluginId)
  return {
    message: result?.message,
    plugin: await serializePlugin(pluginId),
  }
}

async function serializePlugin(pluginId: string): Promise<PluginResponse> {
  const registration = readKnownPlugin(pluginId)
  const setting = await readPluginSetting(pluginId, registration.definition.defaultSettings)
  const state = await readPluginState(pluginId)
  return {
    description: registration.definition.description,
    enabled: setting.enabled,
    icon: registration.definition.icon,
    id: registration.definition.id,
    label: registration.definition.label,
    secretConfigured: Object.fromEntries(
      registration.definition.secretFields.map((field) => [field.key, Boolean(readSecret(setting.secrets, field.key))]),
    ),
    secrets: setting.secrets,
    secretFields: registration.definition.secretFields,
    settings: setting.settings,
    settingsFields: registration.definition.settingsFields,
    stateSummary: registration.summarizeState?.(state) ?? {},
    status: setting.enabled ? getPluginStatus(pluginId) : { state: "disabled", message: null, updatedAt: null },
  }
}

function readKnownPlugin(pluginId: string) {
  try {
    return readPluginRegistration(pluginId)
  } catch {
    throw new HttpError(404, "Plugin not found.")
  }
}

function filterSettings(value: JsonObject, allowedKeys: string[], current: JsonObject): JsonObject {
  const next: JsonObject = { ...current }
  for (const key of allowedKeys) {
    if (value[key] !== undefined) {
      next[key] = value[key]
    }
  }
  return next
}

function filterSecrets(value: JsonObject, allowedKeys: string[], current: JsonObject): JsonObject {
  const next: JsonObject = { ...current }
  for (const key of allowedKeys) {
    const secret = value[key]
    if (typeof secret === "string" && secret.trim()) {
      next[key] = secret.trim()
    }
    if (secret === null) {
      delete next[key]
    }
  }
  return next
}

function readSecret(secrets: JsonObject, key: string): string {
  const value = secrets[key]
  return typeof value === "string" ? value : ""
}
