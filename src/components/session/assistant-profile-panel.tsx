import { Dialog } from "@base-ui/react/dialog"
import { useRef, useState } from "react"
import { Folder, ImagePlus, LoaderCircle, MessageCircle, Pencil, RefreshCw, Sparkles, X } from "lucide-react"
import type { AssistantState } from "../../../app/types/assistant"
import type { ProviderAccountResponse } from "@/lib/api-client"
import type { SessionShellState } from "@/components/session/session-shell"
import { PushNotificationButton } from "@/components/session/push-notification-button"
import { relativeTimeLabel } from "@/lib/session"
import { AgentAvatar } from "@/components/session/agent-avatar"
import { avatarFromFile } from "@/lib/agent-avatar"

export function AssistantProfilePanel({ open, onOpenChange, name, state, accounts, accountId, onAccountChange, disabled, onRefresh, onEditProfile, onAvatarChange, onGenerateAvatar, onCancelFollowUp, shell }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  state: AssistantState | null
  accounts: ProviderAccountResponse[]
  accountId: string
  onAccountChange: (id: string) => void
  disabled: boolean
  onRefresh: () => void
  onEditProfile: () => void
  onAvatarChange: (avatar: string) => Promise<void>
  onGenerateAvatar: () => void
  onCancelFollowUp: (id: string) => Promise<void>
  shell: SessionShellState
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [followUpError, setFollowUpError] = useState<string | null>(null)
  const [cancellingFollowUp, setCancellingFollowUp] = useState<string | null>(null)
  const running = state?.status === "running"
  const lastReply = state?.messages.slice().reverse().find((message) => message.role === "assistant")
  const chatIds = [...new Set(state?.messages.flatMap((message) => message.actions?.flatMap((action) => action.chatId ? [action.chatId] : []) ?? []).reverse() ?? [])]
  const recentChats = chatIds.flatMap((id) => {
    const chat = shell.chats.find((item) => item.id === id)
    return chat ? [chat] : []
  }).slice(0, 5)

  return (
    <Dialog.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <div className="assistant-identity absolute left-1/2 top-2 z-20 -translate-x-1/2">
        <Dialog.Trigger aria-label={`Open ${name} details`} className="flex max-w-56 flex-col items-center gap-1 rounded-xl px-3 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <AgentAvatar name={name} avatar={state?.profile.avatar} />
          <span className="max-w-full truncate text-[14px] font-medium">{name}</span>
        </Dialog.Trigger>
      </div>
      <Dialog.Portal>
        <Dialog.Popup className="assistant-profile-panel session-app fixed z-50 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-[22px] border border-border bg-popover p-4 text-sm text-popover-foreground shadow-2xl outline-none">
          <Dialog.Close aria-label="Close agent details" className="session-icon-button absolute right-3 top-3"><X className="size-3.5" /></Dialog.Close>
          <div className="flex items-center gap-3 pr-5">
            <div className="relative">
              <AgentAvatar name={name} avatar={state?.profile.avatar} className="size-16" />
              <button aria-label="Change agent avatar" disabled={disabled || uploading || !state} className="absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border border-border bg-background text-foreground hover:bg-accent disabled:opacity-40" type="button" onClick={() => fileInputRef.current?.click()}><Pencil className="size-3" /></button>
            </div>
            <div className="min-w-0">
              <Dialog.Title className="truncate font-semibold">{name}</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
                {running ? <span className="flex items-center gap-1.5"><LoaderCircle className="size-3 animate-spin" />Working now</span> : lastReply ? `Active ${relativeTimeLabel(lastReply.createdAt)}` : "Ready to chat"}
              </Dialog.Description>
            </div>
          </div>

          <input aria-label="Upload agent avatar" className="hidden" ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (!file || uploading) return
            setUploading(true)
            setAvatarError(null)
            try { await onAvatarChange(await avatarFromFile(file)) }
            catch (cause) { setAvatarError(cause instanceof Error ? cause.message : "Unable to update avatar.") }
            finally { setUploading(false) }
          }} />
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="flex h-9 items-center justify-center gap-2 rounded-xl bg-secondary text-[12px] hover:bg-accent disabled:opacity-40" disabled={disabled || uploading || !state} type="button" onClick={() => fileInputRef.current?.click()}>{uploading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}Upload image</button>
            <button className="flex h-9 items-center justify-center gap-2 rounded-xl bg-secondary text-[12px] hover:bg-accent disabled:opacity-40" disabled={disabled || uploading || !state || !accounts.length} type="button" onClick={() => { onOpenChange(false); onGenerateAvatar() }}><Sparkles className="size-3.5" />Generate for me</button>
          </div>
          {avatarError ? <p role="alert" className="mt-2 text-xs text-destructive">{avatarError}</p> : null}

          <div className="mt-5 grid grid-cols-2 gap-2">
            <button className="flex h-9 items-center justify-center gap-2 rounded-xl bg-secondary text-[13px] hover:bg-accent" type="button" onClick={() => { onOpenChange(false); shell.selectNavigationView("projects") }}><Folder className="size-4" />Projects</button>
            <button className="flex h-9 items-center justify-center gap-2 rounded-xl bg-secondary text-[13px] hover:bg-accent" type="button" onClick={onRefresh}><RefreshCw className="size-3.5" />Refresh</button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 py-1">
            <span className="text-[13px]">Desktop notifications</span><PushNotificationButton />
          </div>

          <label className="mt-5 block text-[12px] text-muted-foreground" htmlFor="assistant-account">Provider account</label>
          <select id="assistant-account" aria-label="Assistant account" className="mt-2 h-9 w-full rounded-xl border border-border bg-secondary px-3 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={disabled} value={accountId} onChange={(event) => onAccountChange(event.target.value)}>
            <option value="">{accounts.find((account) => account.id === state?.accountId)?.displayName ?? "Automatic account"}</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
          </select>

          {state?.profile.personality ? <details className="mt-5">
            <summary className="cursor-pointer text-[12px] text-muted-foreground">Personality</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5">{state.profile.personality}</p>
            <button className="mt-2 text-xs text-muted-foreground underline underline-offset-4" type="button" onClick={() => { onOpenChange(false); onEditProfile() }}>Edit profile in chat</button>
          </details> : null}
          {state?.followUps?.length ? <section className="mt-5" aria-label="Agent follow-ups">
            <h2 className="mb-2 text-[12px] font-normal text-muted-foreground">Watches and schedules</h2>
            {state.followUps.filter((followUp) => followUp.status !== "completed" && followUp.status !== "cancelled").map((followUp) => <div className="mb-2 rounded-xl border border-border p-2.5" key={followUp.id}>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-xs leading-5">{followUp.kind === "run" ? "Watching coding task" : "Scheduled follow-up"}<span className="ml-2 text-muted-foreground">{followUp.status}</span></span>
                <button aria-label="Cancel follow-up" className="session-icon-button shrink-0 disabled:opacity-40" disabled={Boolean(cancellingFollowUp)} type="button" onClick={() => {
                  setCancellingFollowUp(followUp.id); setFollowUpError(null)
                  void onCancelFollowUp(followUp.id).catch((cause) => setFollowUpError(cause instanceof Error ? cause.message : "Unable to cancel follow-up.")).finally(() => setCancellingFollowUp(null))
                }}><X className="size-3" /></button>
              </div>
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{followUp.instructions}</p>
              {followUp.dueAt ? <time className="mt-1 block text-[11px] text-muted-foreground" dateTime={followUp.dueAt}>{new Date(followUp.dueAt).toLocaleString()}{followUp.intervalMinutes ? ` · Every ${followUp.intervalMinutes} min` : ""}</time> : null}
              {followUp.error ? <p className="mt-1 text-xs text-destructive">{followUp.error}</p> : null}
            </div>)}
            <p className="text-[11px] leading-5 text-muted-foreground">Follow-ups run while PockCode is running, even with this browser closed.</p>
            {followUpError ? <p role="alert" className="mt-1 text-xs text-destructive">{followUpError}</p> : null}
          </section> : null}
          <section className="mt-5" aria-label="Recent agent activity">
            <h2 className="mb-2 text-[12px] font-normal text-muted-foreground">Recent activity</h2>
            {recentChats.length ? recentChats.map((chat) => <button className="flex w-full items-center gap-2 rounded-lg py-1.5 text-left text-[13px] hover:bg-accent" key={chat.id} type="button" onClick={() => { onOpenChange(false); void shell.openSidebarChat(chat) }}>
              <MessageCircle className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{chat.title}</span>{chat.status === "RUNNING" ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-success" /> : null}
            </button>) : <p className="py-1 text-[13px] text-muted-foreground">No coding tasks yet.</p>}
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
