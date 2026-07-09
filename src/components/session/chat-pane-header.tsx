import { Archive, LoaderCircle, Pencil, Send } from "lucide-react"
import { ModeToggleButton } from "@/components/session/mode-toggle-button"
import { ProviderMark } from "@/components/session/provider-icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { clampPercent, formatProviderQuota, quotaSortMinutes, quotaWindowLabel } from "@/lib/session"
import type { ProviderLimitsResponse } from "@/lib/api-client"
import { useChatPane } from "@/components/session/chat-pane-context"

export function ChatPaneHeader() {
  const pane = useChatPane()

  return (
    <header className="flex h-10 min-w-0 items-center gap-2 border-b border-border px-3">
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
        {pane.chat?.title ?? pane.workspace.name}
      </div>
      {pane.accountSwitchPhase ? (
        <span className="hidden shrink-0 items-center gap-1 rounded-md border border-info/30 bg-info/10 px-1.5 py-0.5 text-[11px] font-medium text-info sm:flex">
          {{
            completed: "Switching",
            failed: "Switch failed",
            hydratingTarget: "Hydrating",
            preparing: "Preparing",
            refreshingMessages: "Refreshing",
            syncingSource: "Syncing",
          }[pane.accountSwitchPhase] ?? "Switching"}
        </span>
      ) : null}
      {pane.chat ? <ChatHeaderActionsMenu /> : null}
      {pane.selectableAccounts.length ? <ChatAccountSelect /> : <ChatProvidersButton />}
      {pane.telegramDeepLink ? (
        <a
          aria-label="Subscribe in Telegram"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          href={pane.telegramDeepLink}
          rel="noreferrer"
          target="_blank"
          title="Subscribe in Telegram"
        >
          <Send className="size-3.5" />
        </a>
      ) : null}
      <ModeToggleButton mode="chat" onClick={pane.onToggleMode} />
    </header>
  )
}

function ChatHeaderActionsMenu() {
  const pane = useChatPane()
  const actionsDisabled = !pane.chat || pane.running || pane.isSwitchingAccount || Boolean(pane.threadAction)
  const loading = pane.threadAction === "rename" || pane.threadAction === "archive"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="Chat actions"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={actionsDisabled}
            title="Chat actions"
            type="button"
          />
        }
      >
        {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem className="text-[12px]" disabled={actionsDisabled} onClick={() => void pane.renameChat()}>
          <Pencil className="size-3.5" />
          <span>Edit chat name</span>
        </DropdownMenuItem>
        <DropdownMenuItem className="text-[12px]" disabled={actionsDisabled} onClick={() => void pane.archiveChat()}>
          <Archive className="size-3.5" />
          <span>Archive chat</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChatProvidersButton() {
  const pane = useChatPane()

  return (
    <button
      className="h-7 rounded-md border border-border px-2 text-[12px] font-medium text-foreground hover:bg-accent"
      type="button"
      onClick={pane.onOpenProviders}
    >
      Providers
    </button>
  )
}

function ChatAccountSelect() {
  const pane = useChatPane()

  return (
    <>
      <Select
        className="min-w-0 shrink-0"
        disabled={pane.running || pane.isSwitchingAccount}
        value={pane.account?.id ?? ""}
        onValueChange={(value) => void pane.onSwitchAccount(value)}
      >
        <SelectTrigger
          aria-label="Provider account"
          className="h-7 w-auto max-w-[min(42vw,14rem)] border-transparent bg-transparent px-1.5 text-[12px] font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground dark:bg-transparent dark:hover:bg-accent"
          title={pane.account ? pane.account.displayName + " · " + pane.account.providerId : undefined}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {pane.isSwitchingAccount ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-info" />
            ) : (
              <ProviderMark icon={pane.providerDefinition?.icon} className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 truncate">{pane.account?.displayName ?? "Provider"}</span>
          </span>
        </SelectTrigger>
        <SelectContent align="end" className="border-border bg-popover text-foreground">
          {pane.selectableAccounts.map((entry) => {
            const quota = formatProviderQuota(pane.accountLimits[entry.id])
            return (
              <SelectItem
                className="text-[12px] text-foreground hover:bg-accent focus-visible:bg-accent"
                key={entry.id}
                label={entry.displayName + " · " + (quota ?? entry.providerId)}
                value={entry.id}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderMark icon={pane.providerIconById.get(entry.providerId)} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="min-w-0 truncate">{entry.displayName}</span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {entry.providerId}
                      {quota ? " · " + quota : ""}
                    </span>
                  </span>
                </span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      <ProviderQuotaProgress limits={pane.account ? pane.accountLimits[pane.account.id] : undefined} />
    </>
  )
}

type QuotaRing = {
  isWeekly: boolean
  label: string
  name: string
  remainingPercent: number
  resetsAt: number | null | undefined
  usedPercent: number
}

function ProviderQuotaProgress({ limits }: { limits: ProviderLimitsResponse | undefined }) {
  const rings = readQuotaRings(limits)
  if (!rings.length) {
    return null
  }

  const fiveHourRing = rings.find((ring) => !ring.isWeekly) ?? (rings.length > 1 ? rings[0] : undefined)
  const weeklyRing = rings.find((ring) => ring.isWeekly) ?? (rings.length > 1 ? rings.at(-1) : undefined)
  const title = rings
    .map((ring) => `${ring.name}: ${Math.round(ring.remainingPercent)}% remaining`)
    .join(" · ")

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={title}
            className="relative inline-flex size-5 shrink-0 items-center justify-center text-info outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            role="img"
            tabIndex={0}
          />
        }
      >
        {weeklyRing ? <QuotaRingCircle className="absolute inset-0" percent={weeklyRing.remainingPercent} /> : null}
        {fiveHourRing ? <QuotaPie className="absolute inset-0" percent={fiveHourRing.remainingPercent} /> : null}
      </TooltipTrigger>
      <TooltipContent align="end" className="grid w-56 max-w-56 gap-2 px-2.5 py-2 text-[11px] leading-4" side="bottom">
        <span className="font-semibold">Provider quota</span>
        <span className="grid gap-1">
          {rings.map((ring) => {
            const reset = formatQuotaReset(ring.resetsAt)
            return (
              <span className="grid grid-cols-[3.75rem_1fr] gap-x-2 gap-y-0.5" key={ring.label}>
                <span className="font-medium">{ring.name}</span>
                <span>{Math.round(ring.remainingPercent)}% left</span>
                <span />
                <span className="opacity-75">
                  {reset ? `resets ${reset}` : "quota remaining"}
                </span>
              </span>
            )
          })}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function QuotaRingCircle({
  className,
  percent,
}: {
  className?: string
  percent: number
}) {
  const radius = 8.25
  const strokeWidth = 3.5
  const circumference = 2 * Math.PI * radius
  const progress = clampPercent(percent)

  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 20 20">
      <circle
        cx="10"
        cy="10"
        fill="none"
        r={radius}
        stroke="currentColor"
        strokeOpacity="0.16"
        strokeWidth={strokeWidth}
      />
      <circle
        cx="10"
        cy="10"
        fill="none"
        r={radius}
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress / 100)}
        strokeLinecap="round"
        strokeWidth={strokeWidth}
        style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%" }}
      />
    </svg>
  )
}

function QuotaPie({ className, percent }: { className?: string; percent: number }) {
  const progress = clampPercent(percent)

  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 20 20">
      <circle cx="10" cy="10" fill="currentColor" fillOpacity="0.16" r="5.5" />
      {progress >= 100 ? (
        <circle cx="10" cy="10" fill="currentColor" r="5.5" />
      ) : progress > 0 ? (
        <path d={pieSlicePath(progress)} fill="currentColor" />
      ) : null}
    </svg>
  )
}

function pieSlicePath(percent: number): string {
  const radius = 5.5
  const center = 10
  const startAngle = -90
  const endAngle = startAngle + clampPercent(percent) * 3.6
  const start = pointOnCircle(center, center, radius, startAngle)
  const end = pointOnCircle(center, center, radius, endAngle)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  return `M ${center} ${center} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`
}

function pointOnCircle(cx: number, cy: number, radius: number, angleDegrees: number): { x: string; y: string } {
  const angleRadians = (angleDegrees * Math.PI) / 180
  return {
    x: (cx + radius * Math.cos(angleRadians)).toFixed(3),
    y: (cy + radius * Math.sin(angleRadians)).toFixed(3),
  }
}

function readQuotaRings(limits: ProviderLimitsResponse | undefined): QuotaRing[] {
  const rateLimits = limits?.rateLimits
  if (!rateLimits) {
    return []
  }

  return [
    { fallbackLabel: "5H", window: rateLimits.primary },
    { fallbackLabel: "W", window: rateLimits.secondary },
  ]
    .filter((entry): entry is { fallbackLabel: string; window: NonNullable<typeof entry.window> } => Boolean(entry.window))
    .sort((first, second) => quotaSortMinutes(first) - quotaSortMinutes(second))
    .map(({ fallbackLabel, window }) => {
      const usedPercent = clampPercent(window.usedPercent)
      const label = quotaWindowLabel(window.windowDurationMins, fallbackLabel)
      return {
        isWeekly: label === "W",
        label,
        name: quotaWindowName(label),
        remainingPercent: clampPercent(100 - usedPercent),
        resetsAt: window.resetsAt,
        usedPercent,
      }
    })
    .slice(0, 2)
}

function quotaWindowName(label: string): string {
  if (label === "W") {
    return "Weekly"
  }
  if (/^\d+H$/u.test(label)) {
    return `${label.slice(0, -1)} hours`
  }
  if (/^\d+M$/u.test(label)) {
    return `${label.slice(0, -1)} minutes`
  }
  return label
}

function formatQuotaReset(value: number | null | undefined): string | null {
  if (!value || !Number.isFinite(value)) {
    return null
  }
  const timestamp = value > 1_000_000_000_000 ? value : value * 1000
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp))
}
