import { ensureDatabase } from "./database.server"
import { prisma } from "./prisma.server"
import { isChatExecuting, isChatRunExecuting, listMessages, refreshChatStatusesForWorkspaces } from "./chats.service"

export async function readAssistantWatchedRun(chatId: string, runId?: string, includeMessages = true) {
  await ensureDatabase()
  const query = {
    where: { chatId, ...(runId ? { id: runId } : {}) }, orderBy: { createdAt: "desc" },
    include: { chat: { select: { title: true, workingDirectory: true } } },
  } as const
  let run = await prisma.chatRun.findFirst(query)
  if (!run) return null
  // A server restart can leave RUNNING rows with no local execution. Reconcile their
  // provider state even when no browser is watching the workspace.
  if (includeMessages && (run.status === "RUNNING" || run.status === "QUEUED") && !isChatExecuting(chatId) && run.chat.workingDirectory && Date.now() - (run.startedAt ?? run.createdAt).getTime() > 120_000) {
    await refreshChatStatusesForWorkspaces([run.chat.workingDirectory])
    run = await prisma.chatRun.findFirst({ ...query, where: { chatId, id: run.id } })
    if (!run) return null
  }
  // Quota recovery temporarily marks a run FAILED before continuing on another account.
  // Never report that intermediate state as a final outcome.
  const settled = ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) && !isChatRunExecuting(run.id)
  let messages: string[] = []
  if (settled && includeMessages) {
    const history = await listMessages(chatId)
    messages = history.data.filter((message) => message.role === "ASSISTANT" && message.kind === "CHAT" && message.content && (
      message.runId === run.id || (run.externalTurnId && message.turnId === run.externalTurnId)
    )).slice(-5).map((message) => message.content.slice(-6000))
  }
  return { runId: run.id, settled, status: run.status, error: run.error, title: run.chat.title, messages }
}
