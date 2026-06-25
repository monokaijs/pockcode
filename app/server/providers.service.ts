import { Prisma } from "@prisma/client"
import type { ProviderDefinitionResponse, ProviderSettingsResponse } from "../types/providers"
import type { JsonObject } from "../types/json"
import { ensureDatabase } from "./database.server"
import { prisma } from "./prisma.server"
import { getProviderAdapter, listProviderAdapters } from "./providers/registry.server"
import { serializeProviderDefinition } from "./providers/types.server"

export async function listProviders(): Promise<ProviderDefinitionResponse[]> {
  await ensureDatabase()
  return listProviderAdapters().map((adapter) => serializeProviderDefinition(adapter.definition))
}

export async function getProviderSettings(providerId: string): Promise<ProviderSettingsResponse> {
  await ensureDatabase()
  const adapter = getProviderAdapter(providerId)
  const row = await prisma.providerSetting.findUnique({ where: { providerId } })
  return {
    provider: serializeProviderDefinition(adapter.definition),
    settings: mergeJson(adapter.defaultSettings(), (row?.settings as JsonObject | null) ?? null),
  }
}

export async function updateProviderSettings(providerId: string, settings: JsonObject): Promise<ProviderSettingsResponse> {
  await ensureDatabase()
  const adapter = getProviderAdapter(providerId)
  const merged = mergeJson(adapter.defaultSettings(), settings)
  const row = await prisma.providerSetting.upsert({
    where: { providerId },
    create: {
      providerId,
      settings: merged as Prisma.InputJsonObject,
    },
    update: {
      settings: merged as Prisma.InputJsonObject,
    },
  })
  return {
    provider: serializeProviderDefinition(adapter.definition),
    settings: row.settings as JsonObject,
  }
}

function mergeJson(base: JsonObject, override: JsonObject | null): JsonObject {
  return { ...base, ...(override ?? {}) }
}
