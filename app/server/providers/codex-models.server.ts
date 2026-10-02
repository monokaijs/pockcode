import type { ProviderModelListResponse } from "../../types/providers"
import type { JsonObject, JsonSerializable } from "../../types/json"
import { asJsonObject, readString } from "../json.server"

// Ask the account's Codex runtime on every call; never supplement its catalog with model IDs.
export async function listCodexModels(
  request: (params: JsonObject) => Promise<{ result?: unknown }>,
): Promise<ProviderModelListResponse> {
  const data: ProviderModelListResponse["data"] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  do {
    const response = await request({ includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) })
    const page = normalizeModelList(response.result)
    data.push(...page.data)
    cursor = page.nextCursor ?? null
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error("Codex returned a repeated model catalog cursor.")
      }
      seenCursors.add(cursor)
    }
  } while (cursor)
  return { data, nextCursor: null }
}

function normalizeModelList(value: unknown): ProviderModelListResponse {
  const result = asJsonObject(value)
  const rows = Array.isArray(result?.data) ? result.data : []
  const models = rows.map((row) => {
    const object = asJsonObject(row) ?? {}
    const id = readString(object.id) ?? readString(object.model) ?? "unknown"
    const upgrade = readString(object.upgrade)
    return {
      id,
      model: readString(object.model) ?? id,
      displayName: readString(object.displayName) ?? readString(object.display_name) ?? id,
      hidden: Boolean(object.hidden),
      defaultReasoningEffort: readString(object.defaultReasoningEffort) ?? readString(object.default_reasoning_effort) ?? null,
      defaultServiceTier: readString(object.defaultServiceTier) ?? readString(object.default_service_tier) ?? null,
      inputModalities: readStringList(object.inputModalities) ?? readStringList(object.input_modalities) ?? [],
      isDefault: readBooleanValue(object.isDefault) ?? readBooleanValue(object.is_default) ?? false,
      serviceTiers: readModelServiceTiers(object.serviceTiers) ?? readModelServiceTiers(object.service_tiers) ?? [],
      supportsPersonality: readBooleanValue(object.supportsPersonality) ?? readBooleanValue(object.supports_personality) ?? false,
      supportedReasoningEfforts: readSupportedReasoningEfforts(object.supportedReasoningEfforts)
        ?? readSupportedReasoningEfforts(object.supported_reasoning_efforts)
        ?? [],
      upgradeInfo: readModelUpgradeInfo(object.upgradeInfo) ?? readModelUpgradeInfo(object.upgrade_info) ?? (upgrade ? { upgrade } : null),
    }
  })
  return {
    data: models.filter((model) => !model.hidden),
    nextCursor: readString(result?.nextCursor) ?? readString(result?.next_cursor) ?? null,
  }
}

function readSupportedReasoningEfforts(value: unknown): ProviderModelListResponse["data"][number]["supportedReasoningEfforts"] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const efforts = value
    .map((entry) => {
      if (typeof entry === "string") {
        return { reasoningEffort: entry }
      }
      const object = asJsonObject(entry)
      const reasoningEffort = readString(object?.reasoningEffort) ?? readString(object?.reasoning_effort)
      return reasoningEffort
        ? { reasoningEffort, description: readString(object?.description) }
        : null
    })
    .filter((entry): entry is { description?: string; reasoningEffort: string } => Boolean(entry))
  return efforts.length ? efforts : null
}

function readModelServiceTiers(value: unknown): ProviderModelListResponse["data"][number]["serviceTiers"] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const tiers = value
    .map((entry) => {
      const object = asJsonObject(entry)
      const id = readString(object?.id)
      if (!id) {
        return null
      }
      return {
        id,
        name: readString(object?.name) ?? id,
        description: readString(object?.description) ?? "",
      }
    })
    .filter((entry): entry is { description: string; id: string; name: string } => Boolean(entry))
  return tiers.length ? tiers : null
}

function readModelUpgradeInfo(value: unknown): JsonSerializable | null {
  if (value === undefined || value === null) {
    return null
  }
  const object = asJsonObject(value)
  return object ?? null
}

function readStringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null
}

function readBooleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}
