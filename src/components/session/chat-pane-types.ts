import type {
  ChatAccountSwitchPhase,
  ChatMessageResponse,
  ChatResponse,
  ProviderAccountResponse,
  ProviderDefinitionResponse,
} from "@/lib/api-client"
import type { ChatComposerAccessMode, ChatComposerSubmit, Workspace } from "@/types/session"

export type ChatPaneProps = {
  accounts: ProviderAccountResponse[]
  chat: ChatResponse | null
  error: string | null
  isLoading: boolean
  isMessagesLoading: boolean
  isSwitchingAccount: boolean
  accountSwitchPhase: ChatAccountSwitchPhase | null
  messages: ChatMessageResponse[]
  preferredAccountId: string | null
  providerDefinitions: ProviderDefinitionResponse[]
  workspace: Workspace
  onArchiveChat: (chatId: string) => Promise<void>
  onCompactChat: (chatId: string) => Promise<void>
  onDeleteQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onEditQueuedMessage: (chatId: string, runId: string, content: string) => Promise<void>
  onFileLinkOpen: (href: string) => boolean
  onForkChat: (chatId: string, lastTurnId?: string | null) => Promise<void>
  onNewChat: () => void
  onOpenMcpServers: () => void
  onOpenProviders: () => void
  onOpenPlugins: () => void
  onRefreshChat: (chatId: string) => Promise<void>
  onRenameChat: (chatId: string, title: string) => Promise<void>
  onReviewChat: (chatId: string, instructions?: string | null) => Promise<void>
  onToggleMode: () => void
  onReorderQueuedMessages: (chatId: string, runIds: string[]) => Promise<void>
  onPermissionModeChange: (chatId: string, permissionMode: ChatComposerAccessMode) => Promise<void>
  onRuntimeSettingsChange: (chatId: string, settings: { model?: string | null; reasoningEffort?: string | null; serviceTier?: string | null }) => Promise<void>
  onSendMessage: (input: ChatComposerSubmit) => Promise<void>
  onSteerQueuedMessage: (chatId: string, runId: string) => Promise<void>
  onSwitchAccount: (accountId: string) => Promise<void>
  onStopChat: () => Promise<void>
}
