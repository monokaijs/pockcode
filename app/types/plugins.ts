import type { JsonObject } from "./json"

export type PluginFieldDefinition = {
  description?: string
  key: string
  label: string
  placeholder?: string
  required?: boolean
  secret?: boolean
  type: "boolean" | "secret" | "string"
}

export type PluginDefinition = {
  description?: string
  icon: string
  id: string
  label: string
  secretFields: PluginFieldDefinition[]
  settingsFields: PluginFieldDefinition[]
}

export type PluginStatus = {
  message?: string | null
  state: "disabled" | "error" | "running" | "starting"
  updatedAt?: string | null
}

export type PluginResponse = PluginDefinition & {
  enabled: boolean
  secretConfigured: Record<string, boolean>
  secrets: JsonObject
  settings: JsonObject
  stateSummary?: JsonObject
  status: PluginStatus
}

export type PluginSettingsUpdateRequest = {
  enabled?: boolean
  secrets?: JsonObject
  settings?: JsonObject
}

export type PluginActionResponse = {
  message?: string
  plugin: PluginResponse
}
