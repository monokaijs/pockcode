import { Archive, LoaderCircle, Pencil, Send } from "lucide-react"
import { ModeToggleButton } from "@/components/session/mode-toggle-button"
import { ProviderMark } from "@/components/session/provider-icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { formatProviderQuota } from "@/lib/session"
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
      {pane.accountQuota ? (
        <span className="hidden shrink-0 text-[11px] font-medium text-muted-foreground sm:inline">
          {pane.accountQuota}
        </span>
      ) : null}
      <Select
        className="min-w-0 shrink-0"
        disabled={pane.running || pane.isSwitchingAccount}
        value={pane.account?.id ?? ""}
        onValueChange={(value) => void pane.onSwitchAccount(value)}
      >
        <SelectTrigger
          aria-label="Provider account"
          className="h-7 w-[min(42vw,11rem)] border-border bg-secondary px-2 text-[12px] font-medium text-foreground hover:bg-accent"
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
    </>
  )
}
