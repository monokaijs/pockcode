import type { ProviderAdapter } from "./types.server"
import { claudeProviderAdapter } from "./claude.server"
import { codexProviderAdapter } from "./codex.server"

const adapters = new Map<string, ProviderAdapter>([
  [codexProviderAdapter.definition.id, codexProviderAdapter],
  [claudeProviderAdapter.definition.id, claudeProviderAdapter],
])

export function listProviderAdapters(): ProviderAdapter[] {
  return [...adapters.values()]
}

export function getProviderAdapter(providerId: string): ProviderAdapter {
  const adapter = adapters.get(providerId)
  if (!adapter) {
    throw new Error(`Unknown provider: ${providerId}`)
  }
  return adapter
}
