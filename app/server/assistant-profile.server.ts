import type { AssistantProfile } from "../types/assistant"
import { HttpError, readRecordField, readStringField } from "./http.server"
import { readSavedAvatar } from "./assistant-avatar.server"

export const defaultAssistantProfile: AssistantProfile = {
  name: "Pock",
  personality: "Friendly, clear, and concise. Be practical about coding work and explain blockers directly.",
}

export function readSavedAssistantProfile(value: unknown): AssistantProfile {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const avatar = readSavedAvatar(saved.avatar)
  return {
    name: typeof saved.name === "string" && saved.name.trim() && saved.name.length <= 80 ? saved.name.trim().replace(/\s+/gu, " ") : defaultAssistantProfile.name,
    personality: typeof saved.personality === "string" && saved.personality.trim() && saved.personality.length <= 2000 ? saved.personality.trim() : defaultAssistantProfile.personality,
    ...(avatar ? { avatar } : {}),
  }
}

export function updateAssistantProfile(current: AssistantProfile, value: unknown): AssistantProfile {
  const fields = readRecordField(value, "profile")
  if (!fields || !Object.keys(fields).length) throw new HttpError(400, "Provide a name or personality to update.")
  if (Object.keys(fields).some((key) => key !== "name" && key !== "personality")) throw new HttpError(400, "Unexpected profile field.")
  return {
    ...current,
    name: fields.name === undefined ? current.name : readStringField(fields.name, "name", { required: true, maxLength: 80 }).replace(/\s+/gu, " "),
    personality: fields.personality === undefined ? current.personality : readStringField(fields.personality, "personality", { required: true, maxLength: 2000 }),
  }
}

export function assistantProfileForModel({ avatar, ...profile }: AssistantProfile) {
  return { ...profile, ...(avatar ? { hasAvatar: true } : {}) }
}
