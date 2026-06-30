import type { ProviderSocketEvent } from "../socket.server"
import type { JsonObject } from "../../types/json"
import type {
  PluginActionResponse,
  PluginDefinition as PluginDefinitionResponse,
  PluginFieldDefinition,
  PluginStatus,
} from "../../types/plugins"

export type PluginDefinition = PluginDefinitionResponse & {
  defaultSettings: JsonObject
}

export type PluginContext = {
  getState(): Promise<JsonObject>
  pluginId: string
  secrets: JsonObject
  setState(state: JsonObject): Promise<void>
  setStatus(status: PluginStatus): void
  settings: JsonObject
  updateState(updater: (state: JsonObject) => JsonObject | Promise<JsonObject>): Promise<JsonObject>
}

export type PluginRuntime = {
  handleProviderEvent?(event: ProviderSocketEvent): Promise<void> | void
  start(context: PluginContext): Promise<void> | void
  stop(): Promise<void> | void
}

export type PluginRegistration = {
  actions?: Record<string, (context: PluginContext) => Promise<PluginActionResponse | { message?: string } | void>>
  definition: PluginDefinition
  runtime(): PluginRuntime
  summarizeState?(state: JsonObject): JsonObject
}

export type { PluginFieldDefinition }
