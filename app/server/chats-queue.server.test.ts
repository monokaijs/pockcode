import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Chat, ChatRun, ProviderAccount } from "@prisma/client"
import type { ProviderChatMessageItem, ProviderRuntimeMessageInput } from "./providers/types.server"
import {
  deleteQueuedChatRun, executeMessage, interruptChatRun, isChatExecuting, listMessages,
  refreshChatStatusesForWorkspaces, reorderQueuedChatRuns, steerQueuedChatRun, updateQueuedChatRun,
} from "./chats.service"

const f = vi.hoisted(() => ({
  chat: {} as Chat, runs: [] as ChatRun[], history: [] as ProviderChatMessageItem[],
  send: vi.fn(), steer: vi.fn(), interrupt: vi.fn(), status: vi.fn(), account: vi.fn(), sync: vi.fn(), events: vi.fn(),
}))
vi.mock("./database.server", () => ({ ensureDatabase: async () => undefined }))
vi.mock("./socket.server", () => ({ publishProviderEvent: (event: unknown) => f.events(event) }))
vi.mock("./accounts.service", () => ({ requireConnectedAccount: (id: string) => f.account(id) }))
vi.mock("./providers/registry.server", () => ({ getProviderAdapter: () => ({
  sendMessage: (...args: unknown[]) => f.send(...args),
  steerMessage: (...args: unknown[]) => f.steer(...args),
  interrupt: (...args: unknown[]) => f.interrupt(...args),
  readChatStatus: (...args: unknown[]) => f.status(...args),
  syncThreadFromAccount: (...args: unknown[]) => f.sync(...args),
  loadChatMessages: async () => f.history,
}) }))
vi.mock("./prisma.server", () => {
  const matches = (run: ChatRun, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
    const actual = run[key as keyof ChatRun]
    if (value && typeof value === "object") {
      const condition = value as { in?: unknown[]; not?: unknown; gte?: Date }
      if (condition.in) return condition.in.includes(actual)
      if ("not" in condition) return actual !== condition.not
      if (condition.gte) return actual instanceof Date && actual >= condition.gte
    }
    return actual === value
  })
  const find = ({ where }: { where: Record<string, unknown> }) => f.runs.filter((run) => matches(run, where))
  return { prisma: {
    chat: {
      findUnique: async () => ({ ...f.chat }),
      findMany: async () => [{ ...f.chat }],
      update: async ({ data }: { data: Partial<Chat> }) => { Object.assign(f.chat, data); return { ...f.chat } },
    },
    chatRun: {
      create: async ({ data }: { data: Partial<ChatRun> }) => {
        const run = { id: `run-${f.runs.length}`, createdAt: new Date(Date.now() + f.runs.length), startedAt: null, endedAt: null,
          interruptRequestedAt: null, externalTurnId: null, error: null, ...data } as ChatRun
        f.runs.push(run)
        return { ...run }
      },
      findMany: async (query: { where: Record<string, unknown> }) => find(query).map((run) => ({ ...run })),
      findFirst: async (query: { where: Record<string, unknown> }) => find(query)[0] ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => f.runs.find((run) => run.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<ChatRun> }) => {
        const run = f.runs.find((item) => item.id === where.id)!
        Object.assign(run, data)
        return { ...run }
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<ChatRun> }) => {
        const runs = find({ where }); runs.forEach((run) => Object.assign(run, data)); return { count: runs.length }
      },
    },
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
  } }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const prompts: { input: ProviderRuntimeMessageInput; finish: () => void }[] = []
let chatIndex = 0
beforeEach(() => {
  vi.resetAllMocks()
  prompts.length = 0
  f.runs = []
  f.history = []
  f.chat = {
    id: `queue-chat-${chatIndex++}`, providerId: "codex", accountId: "account", autoRotateAccount: false,
    title: "Queue test", workingDirectory: "/project", externalThreadId: "thread", status: "IDLE",
    model: null, reasoningEffort: null, serviceTier: null, permissionMode: "default", collaborationMode: "default",
    createdAt: new Date(), updatedAt: new Date(), lastActivityAt: new Date(),
  }
  f.account.mockImplementation(async (id: string) => ({ id, providerId: "codex", status: "CONNECTED" }) as ProviderAccount)
  f.steer.mockResolvedValue({ turnId: "turn" })
  f.status.mockResolvedValue("IDLE")
  f.sync.mockResolvedValue(true)
  f.send.mockImplementation(async (_account: ProviderAccount, input: ProviderRuntimeMessageInput) => {
    const pending = deferred<{ threadId: string; turnId: string }>()
    prompts.push({ input, finish: () => pending.resolve({ threadId: "thread", turnId: `turn-${prompts.length}` }) })
    await input.onThreadReady?.("thread")
    await input.onTurnStarted?.(`turn-${prompts.length}`)
    return pending.promise
  })
})
afterEach(async () => {
  // Unwind every background turn before the next test reuses the mocked database.
  if (isChatExecuting(f.chat.id)) await interruptChatRun(f.chat.id)
  prompts.forEach((prompt) => prompt.finish())
  await vi.waitFor(() => expect(isChatExecuting(f.chat.id)).toBe(false))
})
async function start(content = "First") {
  const result = await executeMessage(f.chat.id, { content })
  await vi.waitFor(() => expect(f.runs[0]?.externalTurnId).toBeTruthy())
  return result
}
async function queued(content: string) {
  return executeMessage(f.chat.id, { content, delivery: "queue" })
}

describe("Codex chat queue and interrupts", () => {
  it("serializes simultaneous idle sends into one active turn and an ordered queue", async () => {
    await Promise.all([executeMessage(f.chat.id, { content: "First" }), executeMessage(f.chat.id, { content: "Second" })])
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1))
    expect(f.runs.map((run) => run.status)).toEqual(["RUNNING", "QUEUED"])
    prompts[0].finish()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    expect(prompts[1].input.content).toBe("Second")
  })

  it("applies edits, deletion, and reordering before dispatch, including newly appended messages", async () => {
    await start()
    const second = await queued("Second")
    const third = await queued("Third")
    await updateQueuedChatRun(f.chat.id, second.runId!, { content: "Second edited" })
    await reorderQueuedChatRuns(f.chat.id, { runIds: [third.runId!, second.runId!] })
    const fourth = await queued("Fourth")
    await deleteQueuedChatRun(f.chat.id, second.runId!)
    prompts[0].finish()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    expect(prompts[1].input.content).toBe("Third")
    prompts[1].finish()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3))
    expect(prompts[2].input.content).toBe("Fourth")
    expect(f.runs.find((run) => run.id === fourth.runId)?.status).toBe("RUNNING")
    await expect(deleteQueuedChatRun(f.chat.id, third.runId!)).rejects.toThrow("Queued message not found")
  })

  it("shows queued repeats even if identical input is already in provider history", async () => {
    await start("Repeat")
    f.history = [{ role: "USER", content: "Repeat", itemId: "old-user" }, { role: "ASSISTANT", content: "Old answer", itemId: "old-answer" }]
    const pending = await queued("Repeat")
    expect((await listMessages(f.chat.id)).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: pending.runId, content: "Repeat", status: "PENDING" }),
    ]))
  })

  it("does not mutate active runtime settings when adding a follow-up", async () => {
    await start()
    await executeMessage(f.chat.id, { content: "Next", permissionMode: "fullAccess", collaborationMode: "plan" })
    expect(f.chat).toMatchObject({ accountId: "account", permissionMode: "default", collaborationMode: "default" })
    prompts[0].finish()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    expect(prompts[1].input).toMatchObject({ permissionMode: "fullAccess", collaborationMode: "plan" })
  })

  it("delivers steering once and removes it from the queue", async () => {
    await start()
    const next = await queued("Change direction")
    await steerQueuedChatRun(f.chat.id, next.runId!)
    expect(f.steer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "account" }), expect.objectContaining({ content: "Change direction", turnId: "turn-1" }))
    expect(f.runs[1]?.status).toBe("COMPLETED")
    await expect(steerQueuedChatRun(f.chat.id, next.runId!)).rejects.toThrow("Queued message not found")
    prompts[0].finish()
    await vi.waitFor(() => expect(isChatExecuting(f.chat.id)).toBe(false))
    expect(f.send).toHaveBeenCalledOnce()
  })

  it("leaves a rejected steering message queued for retry", async () => {
    await start()
    const next = await queued("Keep this")
    f.steer.mockRejectedValue(new Error("No active turn"))
    await expect(steerQueuedChatRun(f.chat.id, next.runId!)).rejects.toThrow("No active turn")
    expect(f.runs[1]?.status).toBe("QUEUED")
  })

  it("stops the active turn, preserves waiting messages, and resumes FIFO on the next send", async () => {
    await start()
    await queued("Second")
    await interruptChatRun(f.chat.id)
    expect(prompts[0].input.signal?.aborted).toBe(true)
    prompts[0].finish()
    await vi.waitFor(() => expect(isChatExecuting(f.chat.id)).toBe(false))
    expect(f.runs.map((run) => run.status)).toEqual(["CANCELLED", "QUEUED"])
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.chat.status).toBe("IDLE")
    await queued("Third")
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    expect(prompts[1].input.content).toBe("Second")
  })

  it("queues a new send until the cancelled prompt has fully unwound", async () => {
    await start()
    await interruptChatRun(f.chat.id)
    await queued("Next")
    expect(f.send).toHaveBeenCalledOnce()
    prompts[0].finish()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    expect(prompts[1].input.content).toBe("Next")
  })

  it("does not resurrect an interrupted run when session readiness arrives late", async () => {
    const ready = deferred<void>()
    f.send.mockImplementation(async (_account: ProviderAccount, input: ProviderRuntimeMessageInput) => {
      await ready.promise
      await input.onThreadReady?.("late-thread")
      input.signal?.throwIfAborted()
      return { threadId: "late-thread", turnId: null }
    })
    await executeMessage(f.chat.id, { content: "First" })
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    await interruptChatRun(f.chat.id)
    ready.resolve()
    await vi.waitFor(() => expect(isChatExecuting(f.chat.id)).toBe(false))
    expect(f.runs[0]?.status).toBe("CANCELLED")
    expect(f.chat).toMatchObject({ status: "IDLE", externalThreadId: "late-thread" })
  })

  it("does not claim an external task was stopped when the interrupt fails", async () => {
    f.chat.status = "RUNNING"
    f.status.mockResolvedValue("RUNNING")
    f.interrupt.mockRejectedValue(new Error("Transport unavailable"))
    await expect(interruptChatRun(f.chat.id)).rejects.toThrow("Transport unavailable")
    expect(f.chat.status).toBe("RUNNING")
    expect(f.runs).toEqual([])
  })

  it("does not cancel live runs or their queue because a provider status read says idle", async () => {
    await start()
    await queued("Second")
    f.runs[0].startedAt = new Date(0)
    await refreshChatStatusesForWorkspaces(["/project"])
    expect(f.runs.map((run) => run.status)).toEqual(["RUNNING", "QUEUED"])
    expect(f.chat.status).toBe("RUNNING")
  })

  it("starts waiting messages when an external provider task becomes idle", async () => {
    f.chat.status = "RUNNING"
    await queued("External follow-up")
    // History synchronization may already have changed the chat's cached status.
    f.chat.status = "IDLE"
    await refreshChatStatusesForWorkspaces(["/project"])
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(prompts[0].input.content).toBe("External follow-up")
  })

  it("keeps a saved stopped queue paused after a server restart until another send", async () => {
    const stoppedAt = new Date(Date.now() - 60 * 60 * 1000)
    f.runs = [
      { id: "stopped", chatId: f.chat.id, providerId: "codex", accountId: "account", status: "CANCELLED", createdAt: new Date(0), startedAt: new Date(0), endedAt: stoppedAt, interruptRequestedAt: stoppedAt, request: { content: "Stopped" } },
      { id: "saved", chatId: f.chat.id, providerId: "codex", accountId: "account", status: "QUEUED", createdAt: new Date(1), startedAt: null, endedAt: null, interruptRequestedAt: null, request: { content: "Saved follow-up" } },
    ] as ChatRun[]
    await refreshChatStatusesForWorkspaces(["/project"])
    expect(f.send).not.toHaveBeenCalled()
    expect(f.runs[1].status).toBe("QUEUED")
    await queued("Resume")
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(prompts[0].input.content).toBe("Saved follow-up")
  })

  it("keeps the queue paused when a direct steer fails after Stop", async () => {
    await start()
    await queued("Second")
    await interruptChatRun(f.chat.id)
    await expect(executeMessage(f.chat.id, { content: "Cannot steer", delivery: "steer" })).rejects.toThrow("no steerable active turn")
    prompts[0].finish()
    await vi.waitFor(() => expect(isChatExecuting(f.chat.id)).toBe(false))
    expect(f.runs[1]?.status).toBe("QUEUED")
    expect(f.send).toHaveBeenCalledOnce()
  })

  it("settles account setup failures so a queued follow-up can still run", async () => {
    await start()
    await queued("Bad account setup")
    await queued("Third")
    f.account.mockImplementation(async (id: string) => {
      const run = f.runs.find((run) => run.status === "RUNNING")
      if ((run?.request as { content?: string })?.content === "Bad account setup") throw new Error("Account disconnected")
      return { id, providerId: "codex", status: "CONNECTED" } as ProviderAccount
    })
    prompts[0].finish()
    await vi.waitFor(() => expect(f.runs[1]?.status).toBe("FAILED"))
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    expect(prompts[1].input.content).toBe("Third")
  })
})
