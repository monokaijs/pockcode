import { telegramPluginRegistration } from "./telegram.server"
import type { PluginRegistration } from "./types.server"

const registrations = new Map<string, PluginRegistration>([
  [telegramPluginRegistration.definition.id, telegramPluginRegistration],
])

export function listPluginRegistrations(): PluginRegistration[] {
  return [...registrations.values()]
}

export function readPluginRegistration(pluginId: string): PluginRegistration {
  const registration = registrations.get(pluginId)
  if (!registration) {
    throw new Error(`Unknown plugin: ${pluginId}`)
  }
  return registration
}
