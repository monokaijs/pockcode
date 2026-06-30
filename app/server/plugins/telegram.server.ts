import { randomBytes } from "node:crypto"
import { Bot, InlineKeyboard, type Context } from "grammy"
import type { ChatMessageResponse, ChatResponse, ProviderAccountResponse, ServerRequestResponseRequest } from "../../types/providers"
import type { JsonObject, JsonSerializable } from "../../types/json"
import { listAccountModels, listAccounts } from "../accounts.service"
import { executeMessage, getChat, listChats, listMessages, respondToServerRequest, serializeChat, updateChat } from "../chats.service"
import { listWorkspaceHistory } from "../workspace-history.service"
import type { ProviderSocketEvent } from "../socket.server"
import type { PluginContext, PluginRegistration, PluginRuntime } from "./types.server"

type TelegramOwner = {
  chatId: number
  displayName: string
  pairedAt: string
  userId: number
  username?: string | null
}

type TelegramSubscription = {
  messageId?: number | null
  subscribedAt: string
  tailStartedAt?: string | null
  telegramChatId: number
  workspacePath?: string | null
}

type TelegramPluginState = {
  botUsername: string | null
  owner: TelegramOwner | null
  pairingCode: string | null
  selectedChats: Record<string, string>
  subscriptions: Record<string, TelegramSubscription>
}

type CallbackPayload =
  | { type: "accountMenu"; chatId: string; page?: number }
  | { type: "chat"; chatId: string }
  | { type: "mode"; chatId: string; value: string }
  | { type: "model"; chatId: string; value: string }
  | { type: "modelMenu"; chatId: string; page?: number }
  | { type: "permission"; chatId: string; value: string }
  | { type: "permissionMenu"; chatId: string }
  | { type: "reasoning"; chatId: string; value: string }
  | { type: "reasoningMenu"; chatId: string }
  | { type: "reply"; chatId: string }
  | { type: "serviceTier"; chatId: string; value: string }
  | { type: "serviceTierMenu"; chatId: string }
  | { type: "setAccount"; accountId: string; chatId: string }
  | { type: "settings"; chatId: string }
  | { type: "serverRequest"; approved: boolean; chatId: string; message: ChatMessageResponse }
  | { type: "subscribe"; chatId: string }
  | { type: "subscriptions"; page?: number }
  | { answers: Record<string, { answers: string[] }>; chatId: string; message: ChatMessageResponse; type: "userInput" }
  | { type: "workspace"; page?: number; path: string }
  | { type: "workspaces"; page?: number }
  | { type: "main" }

type CallbackToken = {
  expiresAt: number
  payload: CallbackPayload
}

type PaginatedItems<T> = {
  items: T[]
  page: number
  total: number
  totalPages: number
}

const telegramPluginId = "telegram"
const callbackTtlMs = 60 * 60 * 1000
const telegramListPageSize = 4
const telegramMessageMaxLength = 3900
const telegramMessageTailLines = 20

export async function verifyTelegramBotToken(token: string): Promise<void> {
  if (!token.trim()) {
    throw new Error("Telegram bot token is required.")
  }
  try {
    await new Bot(token.trim()).api.getMe()
  } catch (error) {
    throw new Error(`Telegram bot token is invalid: ${readErrorMessage(error)}`)
  }
}

export const telegramPluginRegistration: PluginRegistration = {
  definition: {
    id: telegramPluginId,
    label: "Telegram",
    description: "Receive chat updates, browse workspaces, and reply from Telegram.",
    icon: "telegram",
    defaultSettings: {},
    settingsFields: [],
    secretFields: [
      {
        key: "botToken",
        label: "Bot token",
        placeholder: "123456:ABC...",
        required: true,
        secret: true,
        type: "secret",
      },
    ],
  },
  runtime: () => new TelegramPluginRuntime(),
  actions: {
    async clearOwner(context) {
      const pairingCode = createPairingCode()
      await context.updateState((state) => serializeTelegramState({
        botUsername: readTelegramState(state).botUsername,
        owner: null,
        pairingCode,
        selectedChats: {},
        subscriptions: {},
      }))
      return { message: "Telegram owner cleared." }
    },
    async refreshPairingCode(context) {
      const pairingCode = createPairingCode()
      await context.updateState((state) => serializeTelegramState({
        ...readTelegramState(state),
        pairingCode,
      }))
      return { message: "Pairing code refreshed." }
    },
  },
  summarizeState(state) {
    const telegramState = readTelegramState(state)
    return {
      ownerChatId: telegramState.owner?.chatId ?? null,
      ownerLabel: telegramState.owner?.displayName ?? null,
      ownerUserId: telegramState.owner?.userId ?? null,
      botUsername: telegramState.botUsername,
      pairingCode: telegramState.pairingCode,
      subscriptionCount: Object.keys(telegramState.subscriptions).length,
    }
  },
}

class TelegramPluginRuntime implements PluginRuntime {
  private bot: Bot | null = null
  private callbackTokens = new Map<string, CallbackToken>()
  private context: PluginContext | null = null
  private pollingPromise: Promise<void> | null = null
  private replyTargetsByTelegramMessageId = new Map<number, string>()
  private subscriptionTailUpdateQueue = new Map<string, Promise<TelegramPluginState>>()

  async start(context: PluginContext): Promise<void> {
    this.context = context
    const token = readRecordString(context.secrets, "botToken")
    await verifyTelegramBotToken(token)
    await this.ensurePairingCode()
    const bot = new Bot(token)
    this.bot = bot
    this.installHandlers(bot)
    bot.catch((error) => {
      context.setStatus({ state: "error", message: error.error instanceof Error ? error.error.message : "Telegram bot failed." })
    })
    const me = await bot.api.getMe()
    await context.updateState((state) => serializeTelegramState({
      ...readTelegramState(state),
      botUsername: me.username ?? null,
    }))
    await bot.api.setMyCommands([
      { command: "start", description: "Pair or open Pockcode" },
      { command: "workspaces", description: "List workspaces" },
      { command: "subscriptions", description: "List chat subscriptions" },
      { command: "help", description: "Show actions" },
    ]).catch(() => undefined)
    await this.rememberSubscriptionReplyTargets()
    context.setStatus({ state: "running", message: `Connected as @${me.username ?? me.first_name}` })
    this.pollingPromise = this.runPolling(bot, context)
  }

  async stop(): Promise<void> {
    const bot = this.bot
    const pollingPromise = this.pollingPromise
    this.bot = null
    this.context = null
    this.pollingPromise = null
    this.callbackTokens.clear()
    this.replyTargetsByTelegramMessageId.clear()
    this.subscriptionTailUpdateQueue.clear()
    if (!bot) {
      return
    }
    try {
      if (bot.isRunning()) {
        await bot.stop()
      }
    } catch {
      // Polling shutdown can reject if another process already took over getUpdates.
    }
    await pollingPromise?.catch(() => undefined)
  }

  private async runPolling(bot: Bot, context: PluginContext): Promise<void> {
    try {
      await bot.start({ drop_pending_updates: true })
    } catch (error) {
      if (this.bot === bot) {
        this.bot = null
        context.setStatus({ state: "error", message: readTelegramPollingError(error) })
      }
    }
  }

  async handleProviderEvent(event: ProviderSocketEvent): Promise<void> {
    if (!this.bot || !this.context) {
      return
    }
    if (event.type === "message.created") {
      const message = readChatMessage(event.payload)
      if (message && shouldUpdateSubscriptionTailForMessage(message)) {
        await this.queueSubscribedChatTailUpdate(message.chatId)
      }
      return
    }
  }

  private installHandlers(bot: Bot): void {
    bot.command("start", (ctx) => this.handleStart(ctx))
    bot.command("help", (ctx) => this.showMainMenu(ctx))
    bot.command("workspaces", (ctx) => this.showWorkspaces(ctx))
    bot.command("subscriptions", (ctx) => this.showSubscriptions(ctx))
    bot.on("callback_query:data", (ctx) => this.handleCallback(ctx))
    bot.on("message:text", (ctx) => this.handleTextMessage(ctx))
  }

  private async handleStart(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? ""
    const payload = text.split(/\s+/)[1]?.trim()
    const subscribeChatId = readSubscribeStartPayload(payload)
    const from = ctx.from
    const chat = ctx.chat
    if (!from || !chat) {
      return
    }
    const state = await this.readState()
    if (!state.owner) {
      if (!payload || subscribeChatId || payload.toUpperCase() !== state.pairingCode?.toUpperCase()) {
        await ctx.reply("Open Pockcode Plugins and send /start followed by the current pairing code.")
        return
      }
      const owner: TelegramOwner = {
        chatId: chat.id,
        displayName: displayNameForTelegramUser(from),
        pairedAt: new Date().toISOString(),
        userId: from.id,
        username: from.username ?? null,
      }
      await this.writeState({ ...state, owner, pairingCode: null })
      await ctx.reply("Telegram is paired with Pockcode.", { reply_markup: this.mainKeyboard() })
      return
    }
    if (!this.isOwner(from.id, state)) {
      await ctx.reply("This bot is already paired.")
      return
    }
    const nextState = await this.rememberOwnerChat(ctx, state)
    if (subscribeChatId) {
      try {
        await this.subscribeChatForTelegramChat(ctx, subscribeChatId, nextState)
      } catch (error) {
        await ctx.reply(readErrorMessage(error), { reply_markup: this.mainKeyboard() })
      }
      return
    }
    await this.showMainMenu(ctx)
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const text = ctx.message?.text?.trim()
    if (!text || text.startsWith("/")) {
      return
    }
    const state = await this.requireOwner(ctx)
    if (!state) {
      return
    }
    const replyMessageId = ctx.message?.reply_to_message?.message_id
    const selectedChatId = replyMessageId ? this.replyTargetsByTelegramMessageId.get(replyMessageId) : null
    const chatId = selectedChatId ?? state.selectedChats[String(ctx.chat?.id ?? state.owner?.chatId ?? "")]
    if (!chatId) {
      await ctx.reply("Choose a chat first.", { reply_markup: this.mainKeyboard() })
      return
    }
    try {
      await executeMessage(chatId, { content: text })
      await ctx.reply("Sent to chat.")
    } catch (error) {
      await ctx.reply(readErrorMessage(error))
    }
  }

  private async handleCallback(ctx: Context): Promise<void> {
    const state = await this.requireOwner(ctx)
    if (!state) {
      await ctx.answerCallbackQuery().catch(() => undefined)
      return
    }
    const payload = this.readCallbackPayload(ctx.callbackQuery?.data)
    if (!payload) {
      await ctx.answerCallbackQuery({ text: "This action expired." }).catch(() => undefined)
      return
    }
    await ctx.answerCallbackQuery().catch(() => undefined)
    await this.rememberOwnerChat(ctx, state)
    try {
      await this.runCallback(ctx, payload)
    } catch (error) {
      await this.replyOrEdit(ctx, readErrorMessage(error), this.mainKeyboard())
    }
  }

  private async runCallback(ctx: Context, payload: CallbackPayload): Promise<void> {
    if (payload.type === "main") {
      await this.showMainMenu(ctx)
      return
    }
    if (payload.type === "workspaces") {
      await this.showWorkspaces(ctx, payload.page)
      return
    }
    if (payload.type === "workspace") {
      await this.showWorkspaceChats(ctx, payload.path, payload.page)
      return
    }
    if (payload.type === "subscriptions") {
      await this.showSubscriptions(ctx, payload.page)
      return
    }
    if (payload.type === "chat") {
      await this.showChat(ctx, payload.chatId)
      return
    }
    if (payload.type === "subscribe") {
      await this.toggleSubscription(ctx, payload.chatId)
      return
    }
    if (payload.type === "reply") {
      await this.selectReplyChat(ctx, payload.chatId)
      return
    }
    if (payload.type === "settings") {
      await this.showChatSettings(ctx, payload.chatId)
      return
    }
    if (payload.type === "accountMenu") {
      await this.showAccountMenu(ctx, payload.chatId, payload.page)
      return
    }
    if (payload.type === "setAccount") {
      await this.updateChatSetting(ctx, payload.chatId, { accountId: payload.accountId }, "Provider account updated.")
      return
    }
    if (payload.type === "modelMenu") {
      await this.showModelMenu(ctx, payload.chatId, payload.page)
      return
    }
    if (payload.type === "model") {
      await this.updateChatSetting(ctx, payload.chatId, { model: payload.value }, "Model updated.")
      return
    }
    if (payload.type === "reasoningMenu") {
      await this.showReasoningMenu(ctx, payload.chatId)
      return
    }
    if (payload.type === "reasoning") {
      await this.updateChatSetting(ctx, payload.chatId, { reasoningEffort: payload.value }, "Reasoning updated.")
      return
    }
    if (payload.type === "serviceTierMenu") {
      await this.showServiceTierMenu(ctx, payload.chatId)
      return
    }
    if (payload.type === "serviceTier") {
      await this.updateChatSetting(ctx, payload.chatId, { serviceTier: payload.value }, "Speed updated.")
      return
    }
    if (payload.type === "permissionMenu") {
      await this.showPermissionMenu(ctx, payload.chatId)
      return
    }
    if (payload.type === "permission") {
      await this.updateChatSetting(ctx, payload.chatId, { permissionMode: payload.value }, "Security mode updated.")
      return
    }
    if (payload.type === "mode") {
      await this.updateChatSetting(ctx, payload.chatId, { collaborationMode: payload.value }, "Mode updated.")
      return
    }
    if (payload.type === "serverRequest") {
      await this.respondToServerRequest(ctx, payload)
      return
    }
    if (payload.type === "userInput") {
      await this.respondToUserInput(ctx, payload)
    }
  }

  private async showMainMenu(ctx: Context): Promise<void> {
    const state = await this.requireOwner(ctx)
    if (!state) {
      return
    }
    await this.replyOrEdit(ctx, "Pockcode Telegram", this.mainKeyboard())
  }

  private async showWorkspaces(ctx: Context, requestedPage = 0): Promise<void> {
    const state = await this.requireOwner(ctx)
    if (!state) {
      return
    }
    const workspaces = await listWorkspaceHistory()
    const page = paginatedItems(workspaces, requestedPage)
    const keyboard = new InlineKeyboard()
    for (const workspace of page.items) {
      keyboard.text(workspace.name, this.callbackData({ type: "workspace", path: workspace.path })).row()
    }
    this.addPaginationControls(keyboard, page, (nextPage) => ({ type: "workspaces", page: nextPage }))
    keyboard.text("Subscriptions", this.callbackData({ type: "subscriptions" })).text("Back", this.callbackData({ type: "main" }))
    await this.replyOrEdit(ctx, workspaces.length ? listTitle("Workspaces", page) : "No workspaces yet.", keyboard)
  }

  private async showWorkspaceChats(ctx: Context, workspacePath: string, requestedPage = 0): Promise<void> {
    const chats = await listChats(workspacePath)
    const page = paginatedItems(chats, requestedPage)
    const keyboard = new InlineKeyboard()
    for (const chat of page.items) {
      keyboard.text(compactLabel(chat.title, 36), this.callbackData({ type: "chat", chatId: chat.id })).row()
    }
    this.addPaginationControls(keyboard, page, (nextPage) => ({ type: "workspace", path: workspacePath, page: nextPage }))
    keyboard.text("Workspaces", this.callbackData({ type: "workspaces" })).text("Back", this.callbackData({ type: "main" }))
    await this.replyOrEdit(ctx, chats.length ? `${listTitle("Chats", page)}\n${workspacePath}` : `No chats\n${workspacePath}`, keyboard)
  }

  private async showSubscriptions(ctx: Context, requestedPage = 0): Promise<void> {
    const state = await this.readState()
    const keyboard = new InlineKeyboard()
    const chatIds = Object.keys(state.subscriptions)
    const page = paginatedItems(chatIds, requestedPage)
    for (const chatId of page.items) {
      const chat = await this.readChatResponse(chatId).catch(() => null)
      keyboard.text(compactLabel(chat?.title ?? chatId, 36), this.callbackData({ type: "chat", chatId })).row()
    }
    this.addPaginationControls(keyboard, page, (nextPage) => ({ type: "subscriptions", page: nextPage }))
    keyboard.text("Workspaces", this.callbackData({ type: "workspaces" })).text("Back", this.callbackData({ type: "main" }))
    await this.replyOrEdit(ctx, chatIds.length ? listTitle("Subscriptions", page) : "No subscriptions.", keyboard)
  }

  private async showChat(ctx: Context, chatId: string): Promise<void> {
    const chat = await this.readChatResponse(chatId)
    const state = await this.readState()
    await this.writeState({
      ...state,
      selectedChats: { ...state.selectedChats, [String(ctx.chat?.id ?? state.owner?.chatId ?? "")]: chatId },
    })
    const messages = await listMessages(chatId, 5).catch(() => ({ data: [] }))
    const recent = messages.data
      .filter(isAssistantChatMessage)
      .slice(-3)
      .map(formatAssistantTailBlock)
      .join("\n\n")
    await this.replyOrEdit(ctx, [
      chat.title,
      chat.workingDirectory ?? "",
      `Status: ${chat.status}`,
      `Model: ${chat.model ?? "default"}`,
      `Security: ${chat.permissionMode}`,
      recent ? `\nRecent\n${recent}` : "",
    ].filter(Boolean).join("\n"), this.chatKeyboard(chat, state))
  }

  private async showChatSettings(ctx: Context, chatId: string): Promise<void> {
    const chat = await this.readChatResponse(chatId)
    const keyboard = new InlineKeyboard()
      .text("Account", this.callbackData({ type: "accountMenu", chatId }))
      .text("Model", this.callbackData({ type: "modelMenu", chatId }))
      .row()
      .text("Reasoning", this.callbackData({ type: "reasoningMenu", chatId }))
      .text("Speed", this.callbackData({ type: "serviceTierMenu", chatId }))
      .row()
      .text(chat.collaborationMode === "plan" ? "Mode: Plan" : "Mode: Default", this.callbackData({ type: "mode", chatId, value: chat.collaborationMode === "plan" ? "default" : "plan" }))
      .row()
      .text("Security", this.callbackData({ type: "permissionMenu", chatId }))
      .text("Back", this.callbackData({ type: "chat", chatId }))
    await this.replyOrEdit(ctx, [
      "Chat settings",
      `Account: ${chat.accountId ?? "none"}`,
      `Model: ${chat.model ?? "default"}`,
      `Reasoning: ${chat.reasoningEffort ?? "default"}`,
      `Speed: ${chat.serviceTier ?? "default"}`,
      `Mode: ${chat.collaborationMode}`,
      `Security: ${chat.permissionMode}`,
    ].join("\n"), keyboard)
  }

  private async showAccountMenu(ctx: Context, chatId: string, requestedPage = 0): Promise<void> {
    const chat = await this.readChatResponse(chatId)
    const accounts = (await listAccounts()).filter((account) => account.status === "CONNECTED" && account.providerId === chat.providerId)
    const page = paginatedItems(accounts, requestedPage)
    const keyboard = new InlineKeyboard()
    for (const account of page.items) {
      keyboard.text(`${account.id === chat.accountId ? "* " : ""}${account.displayName}`, this.callbackData({ type: "setAccount", chatId, accountId: account.id })).row()
    }
    this.addPaginationControls(keyboard, page, (nextPage) => ({ type: "accountMenu", chatId, page: nextPage }))
    keyboard.text("Back", this.callbackData({ type: "settings", chatId }))
    await this.replyOrEdit(ctx, accounts.length ? listTitle("Provider accounts", page) : "No connected accounts for this provider.", keyboard)
  }

  private async showModelMenu(ctx: Context, chatId: string, requestedPage = 0): Promise<void> {
    const chat = await this.readChatResponse(chatId)
    const accountId = chat.accountId
    const keyboard = new InlineKeyboard()
    let page: PaginatedItems<{ displayName: string; model: string }> | null = null
    if (accountId) {
      const response = await listAccountModels(accountId).catch(() => ({ data: [] }))
      page = paginatedItems(response.data.filter((item) => !item.hidden), requestedPage)
      for (const option of page.items) {
        keyboard.text(option.displayName, this.callbackData({ type: "model", chatId, value: option.model })).row()
      }
      this.addPaginationControls(keyboard, page, (nextPage) => ({ type: "modelMenu", chatId, page: nextPage }))
    }
    keyboard.text("Back", this.callbackData({ type: "settings", chatId }))
    await this.replyOrEdit(ctx, accountId ? (page && page.total ? listTitle("Models", page) : "No models.") : "Choose a provider account first.", keyboard)
  }

  private async showReasoningMenu(ctx: Context, chatId: string): Promise<void> {
    const keyboard = new InlineKeyboard()
    for (const option of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
      keyboard.text(option, this.callbackData({ type: "reasoning", chatId, value: option })).row()
    }
    keyboard.text("Back", this.callbackData({ type: "settings", chatId }))
    await this.replyOrEdit(ctx, "Reasoning", keyboard)
  }

  private async showServiceTierMenu(ctx: Context, chatId: string): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("standard", this.callbackData({ type: "serviceTier", chatId, value: "standard" }))
      .row()
      .text("fast", this.callbackData({ type: "serviceTier", chatId, value: "fast" }))
      .row()
      .text("Back", this.callbackData({ type: "settings", chatId }))
    await this.replyOrEdit(ctx, "Speed", keyboard)
  }

  private async showPermissionMenu(ctx: Context, chatId: string): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("Ask for approval", this.callbackData({ type: "permission", chatId, value: "askForApproval" }))
      .row()
      .text("Full access", this.callbackData({ type: "permission", chatId, value: "fullAccess" }))
      .row()
      .text("Back", this.callbackData({ type: "settings", chatId }))
    await this.replyOrEdit(ctx, "Security mode", keyboard)
  }

  private async updateChatSetting(
    ctx: Context,
    chatId: string,
    data: Parameters<typeof updateChat>[1],
    message: string,
  ): Promise<void> {
    await updateChat(chatId, data)
    await this.replyOrEdit(ctx, message, new InlineKeyboard().text("Back", this.callbackData({ type: "settings", chatId })))
  }

  private async toggleSubscription(ctx: Context, chatId: string): Promise<void> {
    const state = await this.readState()
    const subscriptions = { ...state.subscriptions }
    const existingSubscription = subscriptions[chatId]
    if (existingSubscription) {
      delete subscriptions[chatId]
      await this.writeState({ ...state, subscriptions })
      if (existingSubscription.messageId) {
        this.replyTargetsByTelegramMessageId.delete(existingSubscription.messageId)
      }
      await this.replyOrEdit(
        ctx,
        "Unsubscribed.",
        new InlineKeyboard().text("Subscribe", this.callbackData({ type: "subscribe", chatId })),
      )
    } else {
      await this.subscribeChatForTelegramChat(ctx, chatId, state)
    }
  }

  private async subscribeChatForTelegramChat(ctx: Context, chatId: string, state: TelegramPluginState): Promise<TelegramPluginState> {
    const chat = await this.readChatResponse(chatId)
    const telegramChatId = ctx.chat?.id ?? state.owner?.chatId ?? 0
    const startedAt = state.subscriptions[chatId]?.tailStartedAt ?? new Date().toISOString()
    const nextState = {
      ...state,
      selectedChats: { ...state.selectedChats, [String(telegramChatId)]: chatId },
      subscriptions: {
        ...state.subscriptions,
        [chatId]: {
          messageId: state.subscriptions[chatId]?.messageId ?? null,
          subscribedAt: state.subscriptions[chatId]?.subscribedAt ?? startedAt,
          tailStartedAt: startedAt,
          telegramChatId,
          workspacePath: chat.workingDirectory ?? null,
        },
      },
    }
    await this.writeState(nextState)
    return this.queueSubscribedChatTailUpdate(chatId, nextState, ctx, chat)
  }

  private async selectReplyChat(ctx: Context, chatId: string): Promise<void> {
    const state = await this.readState()
    await this.writeState({
      ...state,
      selectedChats: { ...state.selectedChats, [String(ctx.chat?.id ?? state.owner?.chatId ?? "")]: chatId },
    })
    await this.replyOrEdit(ctx, "Send a Telegram message now, or reply to a chat update.", new InlineKeyboard().text("Back", this.callbackData({ type: "chat", chatId })))
  }

  private async respondToServerRequest(ctx: Context, payload: Extract<CallbackPayload, { type: "serverRequest" }>): Promise<void> {
    const requestId = payload.message.requestId
    if (!requestId) {
      await this.replyOrEdit(ctx, "Request is missing an id.", this.mainKeyboard())
      return
    }
    await respondToServerRequest(payload.chatId, requestId, serverRequestResponseFor(payload.message, payload.approved))
    await this.replyOrEdit(ctx, payload.approved ? "Approved." : "Declined.", new InlineKeyboard().text("Chat", this.callbackData({ type: "chat", chatId: payload.chatId })))
  }

  private async respondToUserInput(ctx: Context, payload: Extract<CallbackPayload, { type: "userInput" }>): Promise<void> {
    const requestId = payload.message.requestId
    if (!requestId) {
      await this.replyOrEdit(ctx, "Request is missing an id.", this.mainKeyboard())
      return
    }
    await respondToServerRequest(payload.chatId, requestId, {
      kind: "userInput",
      result: { answers: payload.answers } as ServerRequestResponseRequest["result"],
    })
    await this.replyOrEdit(ctx, "Submitted.", new InlineKeyboard().text("Chat", this.callbackData({ type: "chat", chatId: payload.chatId })))
  }

  private async updateSubscribedChatTail(
    chatId: string,
    state?: TelegramPluginState,
    ctx?: Context,
    chat?: ChatResponse,
  ): Promise<TelegramPluginState> {
    const currentState = state ?? await this.readState()
    const subscription = currentState.subscriptions[chatId]
    if (!subscription) {
      return currentState
    }
    const targetChatId = subscription.telegramChatId || currentState.owner?.chatId
    if (!targetChatId || !this.bot) {
      return currentState
    }
    let activeState = currentState
    let activeSubscription = subscription
    const tailStartedAt = activeSubscription.tailStartedAt ?? new Date().toISOString()
    if (!activeSubscription.tailStartedAt) {
      activeSubscription = { ...activeSubscription, tailStartedAt }
      activeState = {
        ...currentState,
        subscriptions: {
          ...currentState.subscriptions,
          [chatId]: activeSubscription,
        },
      }
      await this.writeState(activeState)
    }
    const text = await this.formatSubscribedChatTail(chatId, tailStartedAt, chat)
    const messageId = await this.sendOrEditSubscriptionMessage(
      ctx,
      targetChatId,
      subscription.messageId ?? null,
      text,
      this.subscriptionTailKeyboard(chatId),
    )
    this.replyTargetsByTelegramMessageId.set(messageId, chatId)
    if (messageId === subscription.messageId) {
      return activeState
    }
    const latestState = await this.readState()
    const latestSubscription = latestState.subscriptions[chatId]
    if (!latestSubscription) {
      return latestState
    }
    const nextState = {
      ...latestState,
      subscriptions: {
        ...latestState.subscriptions,
        [chatId]: { ...latestSubscription, messageId },
      },
    }
    await this.writeState(nextState)
    return nextState
  }

  private async queueSubscribedChatTailUpdate(
    chatId: string,
    state?: TelegramPluginState,
    ctx?: Context,
    chat?: ChatResponse,
  ): Promise<TelegramPluginState> {
    const previous = this.subscriptionTailUpdateQueue.get(chatId)
    const queued = (async () => {
      await previous?.catch(() => undefined)
      return this.updateSubscribedChatTail(chatId, previous ? undefined : state, ctx, chat)
    })()
    this.subscriptionTailUpdateQueue.set(chatId, queued)
    try {
      return await queued
    } finally {
      if (this.subscriptionTailUpdateQueue.get(chatId) === queued) {
        this.subscriptionTailUpdateQueue.delete(chatId)
      }
    }
  }

  private async sendOrEditSubscriptionMessage(
    ctx: Context | undefined,
    telegramChatId: number,
    messageId: number | null,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<number> {
    const bot = this.bot
    if (!bot) {
      throw new Error("Telegram bot is not running.")
    }
    const messageText = fitTelegramMessage(text, telegramMessageMaxLength)
    const callbackMessage = ctx?.callbackQuery?.message
    const callbackMessageId = typeof callbackMessage?.chat.id === "number" && callbackMessage.chat.id === telegramChatId
      ? callbackMessage.message_id
      : null
    const editableMessageId = messageId ?? callbackMessageId
    if (editableMessageId) {
      try {
        await bot.api.editMessageText(telegramChatId, editableMessageId, messageText, { reply_markup: keyboard })
        return editableMessageId
      } catch (error) {
        if (readErrorMessage(error).toLowerCase().includes("message is not modified")) {
          return editableMessageId
        }
        if (messageId) {
          await bot.api.deleteMessage(telegramChatId, messageId).catch(() => undefined)
        }
      }
    }
    const sent = await bot.api.sendMessage(telegramChatId, messageText, { reply_markup: keyboard })
    return sent.message_id
  }

  private async formatSubscribedChatTail(chatId: string, since: string, chat?: ChatResponse): Promise<string> {
    const chatResponse = chat ?? await this.readChatResponse(chatId)
    const messages = await listMessages(chatId, 50).catch(() => ({ data: [] }))
    const blocks = messages.data
      .filter((message) => isAssistantChatMessage(message) && isMessageAtOrAfter(message, since))
      .map(formatAssistantTailBlock)
    const tail = tailLines(blocks.flatMap((block, index) => [
      ...(index > 0 ? [""] : []),
      ...block.split("\n"),
    ]), telegramMessageTailLines).join("\n").trim()
    return [
      compactLabel(chatResponse.title, 80),
      tail || "(no assistant messages yet)",
    ].join("\n")
  }

  private async replyOrEdit(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const options = keyboard ? { reply_markup: keyboard } : undefined
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, options)
        return
      } catch {
        // Fall through to reply when Telegram refuses to edit the source message.
      }
    }
    await ctx.reply(text, options)
  }

  private chatKeyboard(chat: ChatResponse, state: TelegramPluginState): InlineKeyboard {
    const subscribed = Boolean(state.subscriptions[chat.id])
    return new InlineKeyboard()
      .text(subscribed ? "Unsubscribe" : "Subscribe", this.callbackData({ type: "subscribe", chatId: chat.id }))
      .text("Reply", this.callbackData({ type: "reply", chatId: chat.id }))
      .row()
      .text("Settings", this.callbackData({ type: "settings", chatId: chat.id }))
      .text("Chats", this.callbackData({ type: "workspace", path: chat.workingDirectory ?? "" }))
  }

  private subscriptionTailKeyboard(chatId: string): InlineKeyboard {
    return new InlineKeyboard().text("Unsubscribe", this.callbackData({ type: "subscribe", chatId }))
  }

  private mainKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("Workspaces", this.callbackData({ type: "workspaces" }))
      .text("Subscriptions", this.callbackData({ type: "subscriptions" }))
  }

  private addPaginationControls<T>(
    keyboard: InlineKeyboard,
    page: PaginatedItems<T>,
    payloadForPage: (page: number) => CallbackPayload,
  ): void {
    if (page.totalPages <= 1) {
      return
    }
    if (page.page > 0) {
      keyboard.text("Prev", this.callbackData(payloadForPage(page.page - 1)))
    }
    if (page.page < page.totalPages - 1) {
      keyboard.text("Next", this.callbackData(payloadForPage(page.page + 1)))
    }
    keyboard.row()
  }

  private serverRequestKeyboard(message: ChatMessageResponse): InlineKeyboard {
    if (message.kind === "USER_INPUT_PROMPT") {
      const question = readUserInputQuestions(message.rawPayload)[0]
      const keyboard = new InlineKeyboard()
      if (question) {
        for (const option of question.options.slice(0, 8)) {
          keyboard.text(option.label, this.callbackData({
            answers: { [question.id]: { answers: [option.label] } },
            chatId: message.chatId,
            message,
            type: "userInput",
          })).row()
        }
      }
      keyboard.text("Submit empty", this.callbackData({ answers: {}, chatId: message.chatId, message, type: "userInput" }))
      keyboard.text("Chat", this.callbackData({ type: "chat", chatId: message.chatId }))
      return keyboard
    }
    return new InlineKeyboard()
      .text("Approve", this.callbackData({ type: "serverRequest", chatId: message.chatId, message, approved: true }))
      .text("Decline", this.callbackData({ type: "serverRequest", chatId: message.chatId, message, approved: false }))
      .row()
      .text("Chat", this.callbackData({ type: "chat", chatId: message.chatId }))
  }

  private callbackData(payload: CallbackPayload): string {
    const direct = directCallbackData(payload)
    if (direct && direct.length <= 64) {
      return direct
    }
    this.collectExpiredCallbackTokens()
    const token = randomToken(8)
    this.callbackTokens.set(token, {
      expiresAt: Date.now() + callbackTtlMs,
      payload,
    })
    return `t:${token}`
  }

  private readCallbackPayload(data: string | undefined): CallbackPayload | null {
    if (!data) {
      return null
    }
    if (data.startsWith("t:")) {
      const token = this.callbackTokens.get(data.slice(2))
      if (!token || token.expiresAt < Date.now()) {
        return null
      }
      return token.payload
    }
    if (data === "m") {
      return { type: "main" }
    }
    if (data === "wl") {
      return { type: "workspaces" }
    }
    if (data === "subs") {
      return { type: "subscriptions" }
    }
    if (data.startsWith("c:")) {
      return { type: "chat", chatId: data.slice(2) }
    }
    return null
  }

  private collectExpiredCallbackTokens(): void {
    const now = Date.now()
    for (const [token, value] of this.callbackTokens) {
      if (value.expiresAt < now) {
        this.callbackTokens.delete(token)
      }
    }
  }

  private async requireOwner(ctx: Context): Promise<TelegramPluginState | null> {
    const from = ctx.from
    if (!from) {
      return null
    }
    const state = await this.readState()
    if (!state.owner) {
      await ctx.reply("Open Pockcode Plugins and pair this bot with /start <code>.").catch(() => undefined)
      return null
    }
    if (!this.isOwner(from.id, state)) {
      await ctx.reply("Only the paired Telegram owner can control Pockcode.").catch(() => undefined)
      return null
    }
    return state
  }

  private isOwner(userId: number, state: TelegramPluginState): boolean {
    return state.owner?.userId === userId
  }

  private async rememberOwnerChat(ctx: Context, state: TelegramPluginState): Promise<TelegramPluginState> {
    if (!ctx.chat || !state.owner || state.owner.chatId === ctx.chat.id) {
      return state
    }
    const nextState = {
      ...state,
      owner: { ...state.owner, chatId: ctx.chat.id },
    }
    await this.writeState(nextState)
    return nextState
  }

  private async ensurePairingCode(): Promise<void> {
    const state = await this.readState()
    if (!state.owner && !state.pairingCode) {
      await this.writeState({ ...state, pairingCode: createPairingCode() })
    }
  }

  private async readState(): Promise<TelegramPluginState> {
    return this.context ? readTelegramState(await this.context.getState()) : emptyTelegramState()
  }

  private async writeState(state: TelegramPluginState): Promise<void> {
    await this.context?.setState(serializeTelegramState(state))
  }

  private async rememberSubscriptionReplyTargets(): Promise<void> {
    const state = await this.readState()
    for (const [chatId, subscription] of Object.entries(state.subscriptions)) {
      if (subscription.messageId) {
        this.replyTargetsByTelegramMessageId.set(subscription.messageId, chatId)
      }
    }
  }

  private async readChatResponse(chatId: string): Promise<ChatResponse> {
    return serializeChat(await getChat(chatId))
  }
}

function directCallbackData(payload: CallbackPayload): string | null {
  if (payload.type === "main") {
    return "m"
  }
  if (payload.type === "workspaces" && !payload.page) {
    return "wl"
  }
  if (payload.type === "subscriptions" && !payload.page) {
    return "subs"
  }
  if (payload.type === "chat") {
    return `c:${payload.chatId}`
  }
  return null
}

function paginatedItems<T>(items: T[], requestedPage: number | undefined): PaginatedItems<T> {
  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / telegramListPageSize))
  const parsedPage = typeof requestedPage === "number" && Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0
  const page = Math.min(Math.max(parsedPage, 0), totalPages - 1)
  const start = page * telegramListPageSize
  return {
    items: items.slice(start, start + telegramListPageSize),
    page,
    total,
    totalPages,
  }
}

function listTitle<T>(title: string, page: PaginatedItems<T>): string {
  return page.totalPages > 1
    ? `${title}\nPage ${page.page + 1}/${page.totalPages}`
    : title
}

function readTelegramState(value: unknown): TelegramPluginState {
  const record = readRecord(value)
  return {
    botUsername: readRecordString(record, "botUsername") || null,
    owner: readOwner(record.owner),
    pairingCode: readRecordString(record, "pairingCode") || null,
    selectedChats: readStringRecord(record.selectedChats),
    subscriptions: readSubscriptions(record.subscriptions),
  }
}

function emptyTelegramState(): TelegramPluginState {
  return { botUsername: null, owner: null, pairingCode: null, selectedChats: {}, subscriptions: {} }
}

function serializeTelegramState(state: TelegramPluginState): JsonObject {
  return {
    botUsername: state.botUsername,
    owner: state.owner as unknown as JsonSerializable,
    pairingCode: state.pairingCode,
    selectedChats: state.selectedChats,
    subscriptions: state.subscriptions as unknown as JsonSerializable,
  }
}

function readSubscribeStartPayload(value: string | undefined): string | null {
  if (!value?.startsWith("sub_")) {
    return null
  }
  const chatId = value.slice(4).trim()
  return chatId || null
}

function readOwner(value: unknown): TelegramOwner | null {
  const record = readRecord(value)
  const userId = readNumber(record.userId)
  const chatId = readNumber(record.chatId)
  if (!userId || !chatId) {
    return null
  }
  return {
    chatId,
    displayName: readRecordString(record, "displayName") || String(userId),
    pairedAt: readRecordString(record, "pairedAt") || new Date().toISOString(),
    userId,
    username: readRecordString(record, "username") || null,
  }
}

function readSubscriptions(value: unknown): Record<string, TelegramSubscription> {
  const record = readRecord(value)
  const subscriptions: Record<string, TelegramSubscription> = {}
  for (const [chatId, subscriptionValue] of Object.entries(record)) {
    const subscription = readRecord(subscriptionValue)
    const telegramChatId = readNumber(subscription.telegramChatId)
    if (!telegramChatId) {
      continue
    }
    subscriptions[chatId] = {
      messageId: readNumber(subscription.messageId),
      subscribedAt: readRecordString(subscription, "subscribedAt") || new Date().toISOString(),
      tailStartedAt: readRecordString(subscription, "tailStartedAt") || null,
      telegramChatId,
      workspacePath: readRecordString(subscription, "workspacePath") || null,
    }
  }
  return subscriptions
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = readRecord(value)
  const result: Record<string, string> = {}
  for (const [key, recordValue] of Object.entries(record)) {
    if (typeof recordValue === "string") {
      result[key] = recordValue
    }
  }
  return result
}

function readChatMessage(value: unknown): ChatMessageResponse | null {
  const record = readRecord(value)
  const chatId = readRecordString(record, "chatId")
  const id = readRecordString(record, "id")
  const role = readRecordString(record, "role")
  if (!chatId || !id || !isMessageRole(role)) {
    return null
  }
  return {
    chatId,
    completedAt: readRecordString(record, "completedAt") || null,
    content: readRecordString(record, "content"),
    createdAt: readRecordString(record, "createdAt") || new Date().toISOString(),
    id,
    itemId: readRecordString(record, "itemId") || null,
    kind: readMessageKind(readRecordString(record, "kind")),
    metadata: readRecord(record.metadata) as JsonSerializable,
    rawPayload: readRecord(record.rawPayload) as JsonSerializable,
    requestId: readRecordString(record, "requestId") || null,
    role,
    runId: readRecordString(record, "runId") || null,
    sequence: readNumber(record.sequence) ?? 0,
    status: readMessageStatus(readRecordString(record, "status")),
    turnId: readRecordString(record, "turnId") || null,
  }
}

function serverRequestResponseFor(message: ChatMessageResponse, approved: boolean): ServerRequestResponseRequest {
  const method = readRecordString(readRecord(message.metadata), "serverRequestMethod")
  if (method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      result: {
        permissions: approved ? grantedPermissionsFromRequest(message) : {},
        scope: "turn",
      } as ServerRequestResponseRequest["result"],
    }
  }
  if (method === "item/tool/requestUserInput") {
    return {
      kind: "userInput",
      result: { answers: {} },
    }
  }
  return {
    decision: approved ? "accept" : "decline",
    kind: "approval",
    result: { decision: approved ? "accept" : "decline" },
  }
}

function grantedPermissionsFromRequest(message: ChatMessageResponse): Record<string, unknown> {
  const requested = readRecord(readRecord(message.rawPayload).permissions)
  const granted: Record<string, unknown> = {}
  const network = readRecord(requested.network)
  const fileSystem = readRecord(requested.fileSystem)
  if (Object.keys(network).length) {
    granted.network = network
  }
  if (Object.keys(fileSystem).length) {
    granted.fileSystem = fileSystem
  }
  return granted
}

function readUserInputQuestions(value: unknown): { id: string; options: { label: string }[] }[] {
  const questions = readRecord(value).questions
  if (!Array.isArray(questions)) {
    return []
  }
  return questions.flatMap((questionValue) => {
    const question = readRecord(questionValue)
    const id = readRecordString(question, "id")
    if (!id) {
      return []
    }
    return [{ id, options: readUserInputOptions(question.options) }]
  })
}

function readUserInputOptions(value: unknown): { label: string }[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((optionValue) => {
    const label = readRecordString(optionValue, "label")
    return label ? [{ label }] : []
  })
}

function formatAssistantTailBlock(message: ChatMessageResponse): string {
  const content = normalizeTailText(message.content) || "(empty)"
  return `Assistant:\n${content}`
}

function isAssistantChatMessage(message: ChatMessageResponse): boolean {
  return message.role === "ASSISTANT" && message.kind === "CHAT"
}

function shouldUpdateSubscriptionTailForMessage(message: ChatMessageResponse): boolean {
  return isAssistantChatMessage(message)
}

function isMessageAtOrAfter(message: ChatMessageResponse, since: string): boolean {
  if (message.status === "STREAMING") {
    return true
  }
  const messageTime = Date.parse(message.createdAt)
  const completedTime = Date.parse(message.completedAt ?? "")
  const sinceTime = Date.parse(since)
  if (!Number.isFinite(sinceTime)) {
    return true
  }
  if (Number.isFinite(completedTime) && completedTime >= sinceTime) {
    return true
  }
  return Number.isFinite(messageTime) ? messageTime >= sinceTime : true
}

function tailLines(lines: string[], maxLines: number): string[] {
  return lines.slice(-maxLines)
}

function normalizeTailText(value: string): string {
  return value.trim().replace(/\r\n?/gu, "\n").replace(/\n{3,}/g, "\n\n")
}

function fitTelegramMessage(value: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return "...\n" + normalized.slice(-(maxLength - 4))
}

function compactLabel(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ")
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized || "Untitled"
}

function displayNameForTelegramUser(user: NonNullable<Context["from"]>): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id)
}

function createPairingCode(): string {
  return randomToken(4).toUpperCase()
}

function randomToken(bytes: number): string {
  const length = Math.max(8, bytes)
  let token = ""
  while (token.length < length) {
    token += randomBytes(bytes).toString("base64url").replace(/[^a-z0-9]/giu, "")
  }
  return token.slice(0, length)
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readRecordString(value: unknown, key: string): string {
  const record = readRecord(value)
  const recordValue = record[key]
  return typeof recordValue === "string" ? recordValue.trim() : ""
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isMessageRole(value: string): value is ChatMessageResponse["role"] {
  return value === "USER" || value === "ASSISTANT" || value === "SYSTEM" || value === "TOOL"
}

function readMessageKind(value: string): ChatMessageResponse["kind"] {
  return (
    value === "THINKING" ||
    value === "TOOL_ACTIVITY" ||
    value === "COMMAND_EXECUTION" ||
    value === "FILE_CHANGE" ||
    value === "PLAN" ||
    value === "APPROVAL" ||
    value === "USER_INPUT_PROMPT" ||
    value === "ERROR"
  ) ? value : "CHAT"
}

function readMessageStatus(value: string): ChatMessageResponse["status"] {
  return value === "PENDING" || value === "STREAMING" || value === "FAILED" ? value : "COMPLETED"
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Telegram action failed."
}

function readTelegramPollingError(error: unknown): string {
  const message = readErrorMessage(error)
  return message.includes("409")
    ? "Telegram polling conflict. Stop the other bot instance, then restart this plugin."
    : message || "Telegram polling stopped."
}
