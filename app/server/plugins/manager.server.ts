import type { ProviderSocketEvent } from "../socket.server"
import { onProviderEvent } from "../socket.server"
import type { JsonObject } from "../../types/json"
import type { PluginStatus } from "../../types/plugins"
import type { PluginContext, PluginRuntime } from "./types.server"
import { listPluginRegistrations, readPluginRegistration } from "./registry.server"
import { readPluginSetting, readPluginState, type PluginSettingRecord, updatePluginState, writePluginState } from "./storage.server"

type ActivePlugin = {
  runtime: PluginRuntime
}

type PluginRuntimeManagerState = {
  activePlugins: Map<string, ActivePlugin>
  pluginStatuses: Map<string, PluginStatus>
  unsubscribeProviderEvents: (() => void) | null
}

const globalForPlugins = globalThis as typeof globalThis & {
  pockcodePluginRuntimeManager?: PluginRuntimeManagerState
}
const managerState = globalForPlugins.pockcodePluginRuntimeManager ?? {
  activePlugins: new Map<string, ActivePlugin>(),
  pluginStatuses: new Map<string, PluginStatus>(),
  unsubscribeProviderEvents: null,
}
globalForPlugins.pockcodePluginRuntimeManager = managerState

const activePlugins = managerState.activePlugins
const pluginStatuses = managerState.pluginStatuses

export function startPluginRuntimeManager(): void {
  if (managerState.unsubscribeProviderEvents) {
    managerState.unsubscribeProviderEvents()
  }
  managerState.unsubscribeProviderEvents = onProviderEvent((event) => {
    void dispatchProviderEvent(event).catch(() => undefined)
  })
  void reconcilePlugins().catch((error) => {
    for (const registration of listPluginRegistrations()) {
      setPluginStatus(registration.definition.id, { state: "error", message: readErrorMessage(error) })
    }
  })
}

export async function reconcilePlugins(): Promise<void> {
  for (const registration of listPluginRegistrations()) {
    await restartPlugin(registration.definition.id)
  }
}

export async function restartPlugin(pluginId: string): Promise<void> {
  const registration = readPluginRegistration(pluginId)
  await stopPlugin(pluginId)
  const setting = await readPluginSetting(pluginId, registration.definition.defaultSettings)
  if (!setting.enabled) {
    setPluginStatus(pluginId, { state: "disabled", message: null })
    return
  }

  setPluginStatus(pluginId, { state: "starting", message: null })
  const runtime = registration.runtime()
  activePlugins.set(pluginId, { runtime })
  try {
    await runtime.start(createPluginContext(pluginId, setting))
    const currentStatus = getPluginStatus(pluginId)
    if (currentStatus.state === "starting") {
      setPluginStatus(pluginId, { state: "running", message: null })
    }
  } catch (error) {
    activePlugins.delete(pluginId)
    setPluginStatus(pluginId, { state: "error", message: readErrorMessage(error) })
    await Promise.resolve(runtime.stop()).catch(() => undefined)
  }
}

export async function stopPlugin(pluginId: string): Promise<void> {
  const active = activePlugins.get(pluginId)
  activePlugins.delete(pluginId)
  if (!active) {
    return
  }
  try {
    await active.runtime.stop()
  } catch (error) {
    setPluginStatus(pluginId, { state: "error", message: readErrorMessage(error) })
  }
}

export function getPluginStatus(pluginId: string): PluginStatus {
  return pluginStatuses.get(pluginId) ?? { state: "disabled", message: null, updatedAt: null }
}

export function setPluginStatus(pluginId: string, status: PluginStatus): void {
  pluginStatuses.set(pluginId, {
    ...status,
    updatedAt: new Date().toISOString(),
  })
}

export function createPluginContext(pluginId: string, setting: PluginSettingRecord): PluginContext {
  return {
    async getState() {
      return readPluginState(pluginId)
    },
    pluginId,
    secrets: setting.secrets,
    async setState(state: JsonObject) {
      await writePluginState(pluginId, state)
    },
    setStatus(status) {
      setPluginStatus(pluginId, status)
    },
    settings: setting.settings,
    updateState(updater) {
      return updatePluginState(pluginId, updater)
    },
  }
}

async function dispatchProviderEvent(event: ProviderSocketEvent): Promise<void> {
  await Promise.all([...activePlugins.values()].map(async (active) => {
    try {
      await active.runtime.handleProviderEvent?.(event)
    } catch {
      // Plugins should never break the app event stream.
    }
  }))
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin failed."
}
