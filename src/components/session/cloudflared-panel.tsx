import { Check, ChevronDown, Copy, ExternalLink, FileText, LoaderCircle, Plus, Server, Trash2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import {
  apiClient,
  type CloudflaredNamedTunnel,
  type CloudflaredStatusResponse,
  type CloudflaredTemporaryTunnel,
} from "@/lib/api-client"
import { readError } from "@/lib/session"
import { cn } from "@/lib/utils"

export type CloudflaredPanelState = ReturnType<typeof useCloudflaredPanelState>

export function useCloudflaredPanelState(enabled: boolean) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [status, setStatus] = useState<CloudflaredStatusResponse | null>(null)

  const refresh = useCallback(async () => {
    setBusyAction((current) => current ?? "refresh")
    setNotice(null)
    try {
      setStatus(await apiClient.cloudflared.status())
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setBusyAction((current) => current === "refresh" ? null : current)
    }
  }, [])

  useEffect(() => {
    if (enabled) {
      void refresh()
    }
  }, [enabled, refresh])

  const runAction = useCallback(async (
    action: string,
    request: () => Promise<CloudflaredStatusResponse>,
    success: string,
  ) => {
    setBusyAction(action)
    setNotice(null)
    try {
      setStatus(await request())
      setNotice({ kind: "info", text: success })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setBusyAction(null)
    }
  }, [])

  return {
    busyAction,
    deleteNamedTunnel: (id: string) => runAction(`delete:${id}`, () => apiClient.cloudflared.deleteNamedTunnel(id), "Tunnel deleted."),
    isBusy: Boolean(busyAction),
    isLoading: busyAction === "refresh" && !status,
    notice,
    refresh,
    startTemporary: (url: string) => runAction("start", () => apiClient.cloudflared.startTemporary(url), "Temporary tunnel started."),
    status,
    stopTemporary: (id: string) => runAction(`stop:${id}`, () => apiClient.cloudflared.stopTemporary(id), "Temporary tunnel stopped."),
  }
}

export function CloudflaredPanelSummary({ cloudflaredPanel }: { cloudflaredPanel: CloudflaredPanelState }) {
  const [originUrl, setOriginUrl] = useState("http://localhost:5173")
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [logTunnelId, setLogTunnelId] = useState<string | null>(null)
  const status = cloudflaredPanel.status
  const canStartTemporary = Boolean(status?.installed && originUrl.trim() && !cloudflaredPanel.isBusy)
  const logTunnel = status?.temporaryTunnels.find((tunnel) => tunnel.id === logTunnelId) ?? null

  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      window.setTimeout(() => setCopiedUrl((current) => current === url ? null : current), 1400)
    } catch {
      setCopiedUrl(null)
    }
  }, [])

  if (!status) {
    return (
      <div className="grid h-40 min-w-0 place-items-center text-[12px] text-muted-foreground">
        Loading tunnels
      </div>
    )
  }

  if (!status.installed) {
    return (
      <div className="grid min-w-0 max-w-full gap-3 px-3 py-4 text-[13px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2 text-foreground">
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">cloudflared</span>
        </div>
        <p className="min-w-0 whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {status.message ?? "cloudflared is not available on PATH."}
        </p>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={cloudflaredPanel.isBusy}
          type="button"
          onClick={() => void cloudflaredPanel.refresh()}
        >
          Refresh
        </button>
        {cloudflaredPanel.notice ? <CloudflaredNotice notice={cloudflaredPanel.notice} /> : null}
      </div>
    )
  }

  return (
    <div className="grid min-w-0 max-w-full gap-3 text-[13px] text-muted-foreground">
      <section className="grid min-w-0 gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-2 px-1.5 text-foreground">
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">cloudflared</span>
          {status.version ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={status.version}>
              {status.version}
            </span>
          ) : null}
        </div>

        <form
          className="grid min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (canStartTemporary) {
              void cloudflaredPanel.startTemporary(originUrl)
            }
          }}
        >
          <input
            aria-label="Local service URL"
            className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
            placeholder="http://localhost:3000"
            value={originUrl}
            onChange={(event) => setOriginUrl(event.target.value)}
          />
          <button
            className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!canStartTemporary}
            type="submit"
          >
            {cloudflaredPanel.busyAction === "start" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Temporary Tunnel
          </button>
        </form>

        {cloudflaredPanel.notice ? <CloudflaredNotice notice={cloudflaredPanel.notice} /> : null}
      </section>

      <section className="min-w-0 border-t border-border pt-2">
        <div className="flex h-7 min-w-0 items-center gap-2 px-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ChevronDown className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Temporary</span>
          <span className="grid min-w-5 place-items-center rounded-full bg-secondary px-1 text-[10px] leading-5 text-secondary-foreground">
            {status.temporaryTunnels.length}
          </span>
        </div>
        {status.temporaryTunnels.length ? (
          <div className="grid min-w-0 gap-1">
            {status.temporaryTunnels.map((tunnel) => (
              <TemporaryTunnelRow
                copied={Boolean(tunnel.publicUrl && copiedUrl === tunnel.publicUrl)}
                key={tunnel.id}
                stopping={cloudflaredPanel.busyAction === `stop:${tunnel.id}`}
                tunnel={tunnel}
                onCopy={copyUrl}
                onViewLogs={tunnel.logs.length ? () => setLogTunnelId(tunnel.id) : undefined}
                onStop={() => void cloudflaredPanel.stopTemporary(tunnel.id)}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-[12px] text-muted-foreground">No temporary tunnels</div>
        )}
      </section>

      <section className="min-w-0 border-t border-border pt-2">
        <div className="flex h-7 min-w-0 items-center gap-2 px-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ChevronDown className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Named Tunnels</span>
          <span className="grid min-w-5 place-items-center rounded-full bg-secondary px-1 text-[10px] leading-5 text-secondary-foreground">
            {status.namedTunnels.length}
          </span>
        </div>
        {status.namedTunnelsError ? (
          <CloudflaredNotice notice={{ kind: status.namedTunnelsAuthRequired ? "info" : "error", text: status.namedTunnelsError }} />
        ) : status.namedTunnels.length ? (
          <div className="grid min-w-0 gap-1">
            {status.namedTunnels.map((tunnel) => (
              <NamedTunnelRow
                deleting={cloudflaredPanel.busyAction === `delete:${tunnel.id}`}
                key={tunnel.id}
                tunnel={tunnel}
                onDelete={() => void cloudflaredPanel.deleteNamedTunnel(tunnel.id)}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-[12px] text-muted-foreground">No named tunnels</div>
        )}
      </section>
      <CloudflaredTunnelLogsDialog tunnel={logTunnel} onClose={() => setLogTunnelId(null)} />
    </div>
  )
}

function TemporaryTunnelRow({
  copied,
  stopping,
  tunnel,
  onCopy,
  onViewLogs,
  onStop,
}: {
  copied: boolean
  stopping: boolean
  tunnel: CloudflaredTemporaryTunnel
  onCopy: (url: string) => void
  onViewLogs?: () => void
  onStop: () => void
}) {
  const canStop = tunnel.status === "running" || tunnel.status === "starting"

  return (
    <div className="grid min-w-0 gap-1 rounded-md px-2 py-1.5 text-[12px] hover:bg-accent/70">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", tunnelStatusDotColor(tunnel.status))} />
        <span className="min-w-0 flex-1 truncate text-foreground" title={tunnel.publicUrl ?? tunnel.originUrl}>
          {tunnel.publicUrl ?? tunnel.originUrl}
        </span>
        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", temporaryTunnelStatusClass(tunnel.status))}>
          {temporaryTunnelStatusLabel(tunnel.status)}
        </span>
      </div>
      <div className="min-w-0 truncate pl-4 text-[11px]" title={tunnel.originUrl}>
        {tunnel.originUrl}
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-4">
        {tunnel.publicUrl ? (
          <>
            <a
              className="min-w-0 flex-1 truncate text-info underline decoration-info/40 underline-offset-2 hover:text-info"
              href={tunnel.publicUrl}
              rel="noreferrer"
              target="_blank"
            >
              {tunnel.publicUrl}
            </a>
            <button
              aria-label="Copy tunnel URL"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
              title="Copy tunnel URL"
              type="button"
              onClick={() => onCopy(tunnel.publicUrl ?? "")}
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </button>
            <a
              aria-label="Open tunnel"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
              href={tunnel.publicUrl}
              rel="noreferrer"
              target="_blank"
              title="Open tunnel"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">Waiting for public URL</span>
        )}
        {onViewLogs ? (
          <button
            aria-label="View tunnel logs"
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
            title="View tunnel logs"
            type="button"
            onClick={onViewLogs}
          >
            <FileText className="size-3.5" />
          </button>
        ) : null}
        <button
          aria-label="Stop temporary tunnel"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canStop || stopping}
          title="Stop temporary tunnel"
          type="button"
          onClick={onStop}
        >
          {stopping ? <LoaderCircle className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
        </button>
      </div>
    </div>
  )
}

function CloudflaredTunnelLogsDialog({
  tunnel,
  onClose,
}: {
  tunnel: CloudflaredTemporaryTunnel | null
  onClose: () => void
}) {
  if (!tunnel) {
    return null
  }

  const logs = tunnel.logs.map((line) => line.trim()).filter(Boolean)
  const title = tunnel.publicUrl ?? tunnel.originUrl

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-labelledby="cloudflared-logs-title" aria-modal="true">
      <button aria-label="Close tunnel logs" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[82vh] min-h-72 w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-12 min-w-0 items-center gap-2 border-b border-border px-3">
          <FileText className="size-4 shrink-0 text-info" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground" id="cloudflared-logs-title">Tunnel logs</div>
            <div className="truncate text-[11px] text-muted-foreground" title={title}>{title}</div>
          </div>
          <button
            aria-label="Close tunnel logs"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
          {logs.length ? (
            <pre className="min-h-full whitespace-pre-wrap break-words rounded-md bg-background p-3 font-mono text-[11px] leading-4 text-muted-foreground">{logs.join("\n")}</pre>
          ) : (
            <div className="grid h-full place-items-center rounded-md bg-background p-4 text-center text-[12px] text-muted-foreground">
              No logs yet
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function NamedTunnelRow({
  deleting,
  tunnel,
  onDelete,
}: {
  deleting: boolean
  tunnel: CloudflaredNamedTunnel
  onDelete: () => void
}) {
  return (
    <div className="group grid min-w-0 gap-1 rounded-md px-2 py-1.5 text-[12px] hover:bg-accent/70">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", namedTunnelStatusDotColor(tunnel.status))} />
        <span className="min-w-0 flex-1 truncate text-foreground" title={tunnel.name}>{tunnel.name}</span>
        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground">
          {tunnel.connectionCount}
        </span>
        <button
          aria-label="Delete named tunnel"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-100 hover:bg-background hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
          disabled={deleting}
          title="Delete named tunnel"
          type="button"
          onClick={() => {
            if (window.confirm(`Delete ${tunnel.name}?`)) {
              onDelete()
            }
          }}
        >
          {deleting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-4 text-[11px]">
        <span className="min-w-0 truncate" title={tunnel.id}>{shortTunnelId(tunnel.id)}</span>
        <span className="shrink-0 text-muted-foreground">{formatTunnelDate(tunnel.createdAt)}</span>
      </div>
    </div>
  )
}

function CloudflaredNotice({ notice }: { notice: { kind: "error" | "info"; text: string } }) {
  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden whitespace-pre-wrap rounded-md px-2 py-1 text-[11px] leading-4 [overflow-wrap:anywhere]", notice.kind === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")} title={notice.text}>
      {notice.text}
    </div>
  )
}

function temporaryTunnelStatusLabel(status: CloudflaredTemporaryTunnel["status"]) {
  const labels: Record<CloudflaredTemporaryTunnel["status"], string> = {
    exited: "Exited",
    running: "Live",
    starting: "Starting",
    stopped: "Stopped",
  }
  return labels[status]
}

function temporaryTunnelStatusClass(status: CloudflaredTemporaryTunnel["status"]) {
  if (status === "running") return "bg-success/10 text-success"
  if (status === "starting") return "bg-info/10 text-info"
  if (status === "stopped") return "bg-muted text-muted-foreground"
  return "bg-destructive/10 text-destructive"
}

function tunnelStatusDotColor(status: CloudflaredTemporaryTunnel["status"]) {
  if (status === "running") return "bg-success"
  if (status === "starting") return "bg-info"
  if (status === "stopped") return "bg-muted-foreground"
  return "bg-destructive"
}

function namedTunnelStatusDotColor(status: CloudflaredNamedTunnel["status"]) {
  if (status === "active") return "bg-success"
  if (status === "inactive") return "bg-muted-foreground"
  return "bg-warning"
}

function shortTunnelId(id: string) {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id
}

function formatTunnelDate(value: string | undefined) {
  if (!value) {
    return "Unknown"
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp))
}
