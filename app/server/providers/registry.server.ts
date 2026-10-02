import type { ProviderAdapter } from "./types.server"
import { codexProviderAdapter } from "./codex.server"
import { HttpError } from "../http.server"

export function listProviderAdapters(): ProviderAdapter[] {
  return [codexProviderAdapter]
}

export function getProviderAdapter(providerId: string): ProviderAdapter {
  if (providerId !== codexProviderAdapter.definition.id) {
    throw new HttpError(400, "Only OpenAI Codex is supported.")
  }
  return codexProviderAdapter
}
