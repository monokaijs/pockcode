import { Plug, RefreshCw, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import { apiClient, type PluginResponse } from "@/lib/api-client"
import { readError, readRecord, readRecordString } from "@/lib/session"
import { cn } from "@/lib/utils"

export function PluginsManagementDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, { botToken: string; enabled: boolean }>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [plugins, setPlugins] = useState<PluginResponse[]>([])
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null

  const loadPlugins = async () => {
    setIsLoading(true)
    setNotice(null)
    try {
      const response = await apiClient.plugins.list()
      setPlugins(response)
      setDrafts(Object.fromEntries(response.map((plugin) => [plugin.id, pluginDraftFromResponse(plugin)])))
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      void loadPlugins()
    }
  }, [open])

  const updateDraft = (pluginId: string, patch: Partial<{ botToken: string; enabled: boolean }>) => {
    setDrafts((current) => ({
      ...current,
      [pluginId]: { ...(current[pluginId] ?? { botToken: "", enabled: false }), ...patch },
    }))
  }

  const savePlugin = async (plugin: PluginResponse) => {
    const draft = drafts[plugin.id] ?? { botToken: "", enabled: plugin.enabled }
    setSavingId(plugin.id)
    setNotice(null)
    try {
      const updated = await apiClient.plugins.update(plugin.id, {
        enabled: draft.enabled,
        secrets: { botToken: draft.botToken.trim() },
      })
      setPlugins((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
      updateDraft(plugin.id, pluginDraftFromResponse(updated))
      window.dispatchEvent(new Event("pockcode:plugins-changed"))
      setNotice({ kind: "info", text: "Saved" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSavingId(null)
    }
  }

  const runAction = async (plugin: PluginResponse, action: string) => {
    setSavingId(plugin.id)
    setNotice(null)
    try {
      const response = await apiClient.plugins.action(plugin.id, action)
      setPlugins((current) => current.map((entry) => entry.id === response.plugin.id ? response.plugin : entry))
      window.dispatchEvent(new Event("pockcode:plugins-changed"))
      setNotice({ kind: "info", text: response.message ?? "Updated" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSavingId(null)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div className="safe-area-overlay fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close plugins" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[82vh] min-h-72 w-full max-w-lg grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <Plug className="size-4 shrink-0 text-info" />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Plugins</h1>
          <button
            aria-label="Refresh plugins"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
            type="button"
            onClick={() => void loadPlugins()}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </button>
          <button
            aria-label="Close plugins"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
          {notice ? (
            <div
              className={cn(
                "mb-3 rounded-md border px-3 py-2 text-[12px]",
                notice.kind === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-info/20 bg-info/10 text-info",
              )}
            >
              {notice.text}
            </div>
          ) : null}

          {isLoading ? (
            <div className="grid h-full min-h-44 place-items-center text-[13px] text-muted-foreground">Loading</div>
          ) : plugins.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {plugins.map((plugin) => (
                <PluginListCard
                  key={plugin.id}
                  plugin={plugin}
                  onSelect={() => setSelectedPluginId(plugin.id)}
                />
              ))}
            </div>
          ) : (
            <div className="grid h-full min-h-44 place-items-center text-[13px] text-muted-foreground">No plugins</div>
          )}
        </div>
      </section>
      <PluginConfigDialog
        draft={selectedPlugin ? drafts[selectedPlugin.id] ?? { botToken: "", enabled: selectedPlugin.enabled } : null}
        plugin={selectedPlugin}
        saving={selectedPlugin ? savingId === selectedPlugin.id : false}
        onAction={(action) => {
          if (selectedPlugin) {
            void runAction(selectedPlugin, action)
          }
        }}
        onClose={() => setSelectedPluginId(null)}
        onDraftChange={(patch) => {
          if (selectedPlugin) {
            updateDraft(selectedPlugin.id, patch)
          }
        }}
        onSave={() => {
          if (selectedPlugin) {
            void savePlugin(selectedPlugin)
          }
        }}
      />
    </div>
  )
}

function PluginListCard({ plugin, onSelect }: { plugin: PluginResponse; onSelect: () => void }) {
  const statusLabel = plugin.enabled ? plugin.status.state : "disabled"

  return (
    <button
      className="grid aspect-square min-w-0 place-items-center rounded-md border border-border bg-secondary/30 p-3 text-center hover:bg-accent/70"
      type="button"
      onClick={onSelect}
    >
      <div className="grid min-w-0 place-items-center gap-2">
        <span className="grid size-12 place-items-center rounded-md bg-info/15 text-info">
          <PluginIcon icon={plugin.icon} className="size-6" />
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{plugin.label}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", pluginStatusClass(statusLabel))}>
          {statusLabel}
        </span>
      </div>
    </button>
  )
}

function pluginDraftFromResponse(plugin: PluginResponse): { botToken: string; enabled: boolean } {
  return {
    botToken: readRecordString(plugin.secrets, "botToken"),
    enabled: plugin.enabled,
  }
}

function PluginIcon({ className, icon }: { className?: string; icon: string }) {
  if (icon === "telegram") {
    return <TelegramIcon className={className} />
  }
  return <Plug className={className} />
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="currentColor"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M21.8 3.5 18.6 20c-.2 1.2-.9 1.5-1.9.9l-5.1-3.8-2.5 2.4c-.3.3-.5.5-1 .5l.4-5.2 9.5-8.6c.4-.4-.1-.6-.6-.2L5.7 13.4.6 11.8c-1.1-.4-1.1-1.1.2-1.6L20.7 2.5c.9-.3 1.7.2 1.1 1Z" />
    </svg>
  )
}

function PluginConfigDialog({
  draft,
  plugin,
  saving,
  onAction,
  onClose,
  onDraftChange,
  onSave,
}: {
  draft: { botToken: string; enabled: boolean } | null
  plugin: PluginResponse | null
  saving: boolean
  onAction: (action: string) => void
  onClose: () => void
  onDraftChange: (patch: Partial<{ botToken: string; enabled: boolean }>) => void
  onSave: () => void
}) {
  if (!plugin || !draft) {
    return null
  }

  const summary = readRecord(plugin.stateSummary)
  const pairingCode = readRecordString(summary, "pairingCode")
  const ownerLabel = readRecordString(summary, "ownerLabel")
  const ownerUserId = summary.ownerUserId
  const subscriptionCount = typeof summary.subscriptionCount === "number" ? summary.subscriptionCount : 0
  const tokenConfigured = plugin.secretConfigured.botToken

  return (
    <div className="safe-area-overlay fixed inset-0 z-[60] grid place-items-center bg-black/55 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close plugin settings" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[84vh] w-full max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <PluginIcon icon={plugin.icon} className="size-4 shrink-0 text-info" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{plugin.label}</h2>
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", pluginStatusClass(plugin.status.state))}>
            {plugin.status.state}
          </span>
          <button
            aria-label="Close plugin settings"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
          <div className="mb-3 flex items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-foreground">{draft.enabled ? "Enabled" : "Disabled"}</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{plugin.status.message || plugin.description}</div>
            </div>
            <Switch
              aria-label={draft.enabled ? "Disable plugin" : "Enable plugin"}
              checked={draft.enabled}
              size="sm"
              onCheckedChange={(enabled) => onDraftChange({ enabled })}
            />
          </div>

          <div className="grid gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Bot token</span>
              <input
                className="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
                placeholder={tokenConfigured ? "Configured" : "123456:ABC..."}
                type="text"
                value={draft.botToken}
                onChange={(event) => onDraftChange({ botToken: event.target.value })}
              />
            </label>

            <div className="grid gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-[12px]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">Pairing</span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">{ownerLabel ? "paired" : pairingCode || "not ready"}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">Owner</span>
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {ownerLabel ? `${ownerLabel}${typeof ownerUserId === "number" ? ` (${ownerUserId})` : ""}` : "none"}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">Subscriptions</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{subscriptionCount}</span>
              </div>
            </div>
          </div>
        </div>

        <footer className="flex min-h-11 flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-1.5">
          <button
            className="h-8 rounded-md border border-border px-3 text-[12px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55"
            disabled={saving}
            type="button"
            onClick={() => onAction("refreshPairingCode")}
          >
            Refresh code
          </button>
          <button
            className="h-8 rounded-md border border-destructive/30 px-3 text-[12px] font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-55"
            disabled={saving || !ownerLabel}
            type="button"
            onClick={() => onAction("clearOwner")}
          >
            Clear owner
          </button>
          <button
            className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
            disabled={saving}
            type="button"
            onClick={onSave}
          >
            {saving ? "Saving" : "Save"}
          </button>
        </footer>
      </section>
    </div>
  )
}

function pluginStatusClass(status: PluginResponse["status"]["state"]): string {
  if (status === "running") {
    return "bg-success/10 text-success"
  }
  if (status === "starting") {
    return "bg-warning/10 text-warning"
  }
  if (status === "error") {
    return "bg-destructive/10 text-destructive"
  }
  return "bg-muted text-muted-foreground"
}
