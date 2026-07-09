import { Check, ExternalLink, LoaderCircle, Plus, RefreshCw, Server, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { ProviderMark, ProviderStatusBadge } from "@/components/session/provider-icons"
import {
  apiClient,
  type McpServerResponse,
  type McpServerStatusItem,
  type ProviderAccountResponse,
} from "@/lib/api-client"
import { delay, readError } from "@/lib/session"
import { cn } from "@/lib/utils"
import {
  emptyMcpDraft,
  mcpDraftFromServer,
  mcpRequestFromDraft,
  parseLineList,
  type McpServerDraft,
} from "@/components/session/mcp-server-draft"

export function McpServersManagementDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [accounts, setAccounts] = useState<ProviderAccountResponse[]>([])
  const [draft, setDraft] = useState<McpServerDraft>(() => emptyMcpDraft())
  const [isLoading, setIsLoading] = useState(true)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [oauthing, setOauthing] = useState(false)
  const [refreshingStatus, setRefreshingStatus] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [servers, setServers] = useState<McpServerResponse[]>([])
  const [statusAccountId, setStatusAccountId] = useState("")
  const [statusItems, setStatusItems] = useState<McpServerStatusItem[]>([])
  const [syncing, setSyncing] = useState(false)
  const codexAccounts = accounts.filter((account) => account.providerId === "codex")
  const selectedServer = servers.find((server) => server.id === selectedId) ?? null
  const selectedStatus = selectedServer
    ? statusItems.find((item) => item.name === selectedServer.name)
    : null

  const loadMcpData = async (preferredSelectedId = selectedId) => {
    setIsLoading(true)
    setNotice(null)
    try {
      const [nextServers, nextAccounts] = await Promise.all([
        apiClient.mcpServers.list(),
        apiClient.providerAccounts.list(),
      ])
      setServers(nextServers)
      setAccounts(nextAccounts)
      const nextSelected = nextServers.find((server) => server.id === preferredSelectedId) ?? nextServers[0] ?? null
      setSelectedId(nextSelected?.id ?? null)
      setDraft(nextSelected ? mcpDraftFromServer(nextSelected) : emptyMcpDraft())
      const firstCodexAccountId = nextAccounts.find((account) => account.providerId === "codex")?.id ?? ""
      setStatusAccountId((current) => current || nextSelected?.installations[0]?.accountId || firstCodexAccountId)
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      void loadMcpData()
    }
  }, [open])

  const selectServer = (server: McpServerResponse) => {
    setSelectedId(server.id)
    setDraft(mcpDraftFromServer(server))
    setNotice(null)
  }

  const createNewServer = () => {
    setSelectedId(null)
    setDraft(emptyMcpDraft())
    setStatusItems([])
    setNotice(null)
  }

  const saveServer = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const body = mcpRequestFromDraft(draft)
      const saved = selectedServer
        ? await apiClient.mcpServers.update(selectedServer.id, body)
        : await apiClient.mcpServers.create(body)
      setSelectedId(saved.id)
      setDraft(mcpDraftFromServer(saved))
      await loadMcpData(saved.id)
      setNotice({ kind: "info", text: "Saved" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  const deleteServer = async () => {
    if (!selectedServer || !window.confirm("Delete MCP server?")) {
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      await apiClient.mcpServers.delete(selectedServer.id)
      setSelectedId(null)
      setDraft(emptyMcpDraft())
      await loadMcpData(null)
      setNotice({ kind: "info", text: "Deleted" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  const syncServer = async () => {
    if (!selectedServer) {
      await saveServer()
      return
    }
    setSyncing(true)
    setNotice(null)
    try {
      const synced = await apiClient.mcpServers.sync(selectedServer.id, { accountIds: draft.accountIds })
      setDraft(mcpDraftFromServer(synced))
      await loadMcpData()
      setNotice({ kind: "info", text: "Synced" })
      const accountId = statusAccountId || draft.accountIds[0]
      if (accountId) {
        await refreshStatus(accountId)
      }
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSyncing(false)
    }
  }

  const refreshStatus = async (accountId = statusAccountId || draft.accountIds[0] || codexAccounts[0]?.id || "") => {
    if (!accountId) {
      setNotice({ kind: "error", text: "Choose a Codex account." })
      return
    }
    setRefreshingStatus(true)
    setNotice(null)
    try {
      const response = await apiClient.mcpServers.status(accountId)
      setStatusAccountId(accountId)
      setStatusItems(response.data)
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setRefreshingStatus(false)
    }
  }

  const startOauthLogin = async () => {
    if (!selectedServer) {
      setNotice({ kind: "error", text: "Save this MCP server before OAuth login." })
      return
    }
    const accountId = statusAccountId || draft.accountIds[0] || codexAccounts[0]?.id
    if (!accountId) {
      setNotice({ kind: "error", text: "Choose a Codex account." })
      return
    }
    setOauthing(true)
    setNotice(null)
    try {
      const response = await apiClient.mcpServers.oauthLogin(selectedServer.id, {
        accountId,
        scopes: parseLineList(draft.scopesText),
      })
      window.open(response.authorizationUrl, "_blank", "noopener,noreferrer")
      await delay(800)
      await refreshStatus(accountId)
      setNotice({ kind: "info", text: "OAuth started" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setOauthing(false)
    }
  }

  const updateDraft = <K extends keyof McpServerDraft>(key: K, value: McpServerDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  if (!open) {
    return null
  }

  return (
    <div className="safe-area-overlay fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close MCP servers" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[86vh] w-full max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <Server className="size-4 shrink-0 text-info" />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">MCP Servers</h1>
          <button
            aria-label="Add MCP server"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add"
            type="button"
            onClick={createNewServer}
          >
            <Plus className="size-4" />
          </button>
          <button
            aria-label="Refresh MCP servers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
            type="button"
            onClick={() => void loadMcpData()}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </button>
          <button
            aria-label="Close MCP servers"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)] overflow-hidden">
          <aside className="min-h-0 overflow-auto border-r border-border p-2 ide-scrollbar">
            {isLoading ? (
              <div className="grid min-h-44 place-items-center text-[13px] text-muted-foreground">Loading</div>
            ) : servers.length ? (
              <div className="space-y-1">
                {servers.map((server) => {
                  const active = server.id === selectedId
                  const lastError = server.installations.find((installation) => installation.lastError)?.lastError
                  return (
                    <button
                      aria-pressed={active || undefined}
                      className={cn(
                        "grid w-full gap-1 rounded-md px-2 py-2 text-left hover:bg-accent",
                        active && "bg-accent",
                      )}
                      key={server.id}
                      type="button"
                      onClick={() => selectServer(server)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                          {server.displayName || server.name}
                        </span>
                        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {server.transport.type === "stdio" ? "stdio" : "http"}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">{server.name}</span>
                        <span className="ml-auto shrink-0">{server.installations.length}</span>
                      </span>
                      {lastError ? <span className="truncate text-[11px] text-destructive">{lastError}</span> : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="grid min-h-44 place-items-center text-[13px] text-muted-foreground">No MCP servers</div>
            )}
          </aside>

          <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
            {notice ? (
              <div
                className={cn(
                  "mb-3 rounded-md border px-3 py-2 text-[12px]",
                  notice.kind === "error"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-success/30 bg-success/10 text-success",
                )}
              >
                {notice.text}
              </div>
            ) : null}

            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <McpTextField label="Name" value={draft.name} onChange={(value) => updateDraft("name", value)} />
                <McpTextField label="Display" value={draft.displayName} onChange={(value) => updateDraft("displayName", value)} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-border">
                  {(["stdio", "streamable_http"] as const).map((type) => (
                    <button
                      className={cn(
                        "h-8 px-3 text-[12px] font-medium",
                        draft.transportType === type ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent",
                      )}
                      key={type}
                      type="button"
                      onClick={() => updateDraft("transportType", type)}
                    >
                      {type === "stdio" ? "stdio" : "HTTP"}
                    </button>
                  ))}
                </div>
                <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-[12px] text-foreground">
                  <input
                    checked={draft.enabled}
                    className="accent-primary"
                    type="checkbox"
                    onChange={(event) => updateDraft("enabled", event.currentTarget.checked)}
                  />
                  Enabled
                </label>
                <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-[12px] text-foreground">
                  <input
                    checked={draft.required}
                    className="accent-primary"
                    type="checkbox"
                    onChange={(event) => updateDraft("required", event.currentTarget.checked)}
                  />
                  Required
                </label>
              </div>

              {draft.transportType === "stdio" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <McpTextField label="Command" value={draft.command} onChange={(value) => updateDraft("command", value)} />
                  <McpTextField label="cwd" value={draft.cwd} onChange={(value) => updateDraft("cwd", value)} />
                  <McpTextArea label="Args" value={draft.argsText} onChange={(value) => updateDraft("argsText", value)} />
                  <McpTextArea label="Env" value={draft.envText} onChange={(value) => updateDraft("envText", value)} />
                  <McpTextArea label="Env vars" value={draft.envVarsText} onChange={(value) => updateDraft("envVarsText", value)} />
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  <McpTextField label="URL" value={draft.url} onChange={(value) => updateDraft("url", value)} />
                  <McpTextField label="Bearer env" value={draft.bearerTokenEnvVar} onChange={(value) => updateDraft("bearerTokenEnvVar", value)} />
                  <McpTextArea label="Headers" value={draft.httpHeadersText} onChange={(value) => updateDraft("httpHeadersText", value)} />
                  <McpTextArea label="Env headers" value={draft.envHttpHeadersText} onChange={(value) => updateDraft("envHttpHeadersText", value)} />
                  <McpTextField label="OAuth client" value={draft.oauthClientId} onChange={(value) => updateDraft("oauthClientId", value)} />
                  <McpTextField label="OAuth resource" value={draft.oauthResource} onChange={(value) => updateDraft("oauthResource", value)} />
                  <McpTextArea label="Scopes" value={draft.scopesText} onChange={(value) => updateDraft("scopesText", value)} />
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-3">
                <McpTextField label="Startup timeout" value={draft.startupTimeoutSec} onChange={(value) => updateDraft("startupTimeoutSec", value)} />
                <McpTextField label="Tool timeout" value={draft.toolTimeoutSec} onChange={(value) => updateDraft("toolTimeoutSec", value)} />
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Approval
                  <select
                    className="h-8 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary"
                    value={draft.defaultToolsApprovalMode}
                    onChange={(event) => updateDraft("defaultToolsApprovalMode", event.currentTarget.value as McpServerDraft["defaultToolsApprovalMode"])}
                  >
                    <option value="">Default</option>
                    <option value="auto">Auto</option>
                    <option value="prompt">Prompt</option>
                    <option value="approve">Approve</option>
                  </select>
                </label>
                <McpTextArea label="Enabled tools" value={draft.enabledToolsText} onChange={(value) => updateDraft("enabledToolsText", value)} />
                <McpTextArea label="Disabled tools" value={draft.disabledToolsText} onChange={(value) => updateDraft("disabledToolsText", value)} />
                <McpTextArea label="Tool approvals" value={draft.toolOverridesText} onChange={(value) => updateDraft("toolOverridesText", value)} />
              </div>

              <div className="grid gap-2">
                <div className="text-[12px] font-medium text-foreground">Accounts</div>
                {codexAccounts.length ? (
                  <div className="grid gap-1 md:grid-cols-2">
                    {codexAccounts.map((account) => (
                      <label
                        className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px] text-foreground"
                        key={account.id}
                      >
                        <input
                          checked={draft.accountIds.includes(account.id)}
                          className="accent-primary"
                          type="checkbox"
                          onChange={(event) => {
                            updateDraft(
                              "accountIds",
                              event.currentTarget.checked
                                ? [...draft.accountIds, account.id]
                                : draft.accountIds.filter((accountId) => accountId !== account.id),
                            )
                          }}
                        />
                        <ProviderMark icon="codex" className="size-3.5 shrink-0 text-info" />
                        <span className="min-w-0 flex-1 truncate">{account.displayName}</span>
                        <ProviderStatusBadge status={account.status} />
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-muted-foreground">No Codex accounts</div>
                )}
              </div>

              <div className="grid gap-2 border-t border-border pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-8 min-w-56 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary"
                    value={statusAccountId}
                    onChange={(event) => setStatusAccountId(event.currentTarget.value)}
                  >
                    <option value="">Account</option>
                    {codexAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.displayName}</option>
                    ))}
                  </select>
                  <button
                    className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-accent"
                    type="button"
                    onClick={() => void refreshStatus()}
                  >
                    <RefreshCw className={cn("size-3.5", refreshingStatus && "animate-spin")} />
                    Refresh
                  </button>
                  {selectedStatus ? (
                    <span className="text-[12px] text-muted-foreground">
                      {selectedStatus.authStatus} · {selectedStatus.toolCount} tools
                    </span>
                  ) : null}
                </div>
                {selectedStatus?.error || selectedStatus?.lastError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                    {selectedStatus.error || selectedStatus.lastError}
                  </div>
                ) : selectedStatus ? (
                  <div className="text-[12px] text-muted-foreground">
                    {selectedStatus.tools.slice(0, 12).join(", ") || "No tools reported"}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <footer className="flex min-h-12 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <button
            className="flex h-8 items-center gap-1.5 rounded-md border border-destructive/30 px-2 text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
            disabled={!selectedServer || saving}
            type="button"
            onClick={() => void deleteServer()}
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-accent disabled:opacity-50"
              disabled={!selectedServer || syncing}
              type="button"
              onClick={() => void syncServer()}
            >
              <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
              Sync
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-accent disabled:opacity-50"
              disabled={!selectedServer || draft.transportType !== "streamable_http" || oauthing}
              type="button"
              onClick={() => void startOauthLogin()}
            >
              <ExternalLink className="size-3.5" />
              OAuth
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
              disabled={saving}
              type="button"
              onClick={() => void saveServer()}
            >
              {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Save
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function McpTextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="grid gap-1 text-[12px] text-muted-foreground">
      {label}
      <input
        className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}

function McpTextArea({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="grid gap-1 text-[12px] text-muted-foreground">
      {label}
      <textarea
        className="min-h-20 resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}
