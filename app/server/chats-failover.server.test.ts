import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Chat, ChatRun, ProviderAccount } from "@prisma/client"
import { executeMessage, updateChat } from "./chats.service"

const f = vi.hoisted(() => ({
  chat: {} as Chat,
  run: null as ChatRun | null,
  send: vi.fn(), move: vi.fn(), select: vi.fn(), events: vi.fn(),
  createRun: vi.fn(),
}))

vi.mock("./database.server", () => ({ ensureDatabase: async () => undefined }))
vi.mock("./socket.server", () => ({ publishProviderEvent: (event: unknown) => f.events(event) }))
vi.mock("./accounts.service", () => ({ requireConnectedAccount: async (id: string) => ({ id, providerId: "codex", status: "CONNECTED" }) as ProviderAccount }))
vi.mock("./account-failover.server", async (original) => {
  const actual = await original<typeof import("./account-failover.server")>()
  return { ...actual, selectFailoverAccount: (...args: unknown[]) => f.select(...args) }
})
vi.mock("./providers/registry.server", () => ({ getProviderAdapter: () => ({
  sendMessage: (...args: unknown[]) => f.send(...args),
  moveThreadToAccount: (...args: unknown[]) => f.move(...args),
  syncThreadFromAccount: async () => true,
  loadChatMessages: async () => [],
}) }))
vi.mock("./prisma.server", () => ({ prisma: {
  chat: {
    findUnique: async () => ({ ...f.chat }),
    update: async ({ data }: { data: Partial<Chat> }) => { Object.assign(f.chat, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))); return { ...f.chat } },
    updateMany: async () => ({ count: 0 }),
  },
  chatRun: {
    create: async ({ data }: { data: Partial<ChatRun> }) => {
      f.createRun(data)
      f.run = { id: "run", createdAt: new Date(), startedAt: null, endedAt: null, interruptRequestedAt: null, externalTurnId: null, error: null, ...data } as ChatRun
      return { ...f.run }
    },
    update: async ({ data }: { data: Partial<ChatRun> }) => { Object.assign(f.run!, data); return { ...f.run } },
    updateMany: async () => ({ count: 0 }),
    findUnique: async () => f.run ? { ...f.run } : null,
    findFirst: async () => null,
    findMany: async ({ where }: { where: { status: string | { in: string[] } } }) => {
      if (!f.run) return []
      const status = where.status
      return (typeof status === "string" ? f.run.status === status : status.in.includes(f.run.status)) ? [{ ...f.run }] : []
    },
  },
} }))

beforeEach(() => {
  vi.clearAllMocks()
  f.run = null
  f.chat = {
    id: "chat", providerId: "codex", accountId: "source", autoRotateAccount: true,
    title: "Fix tests", workingDirectory: "/project", externalThreadId: "preserved-thread",
    status: "IDLE", model: null, reasoningEffort: null, serviceTier: null,
    permissionMode: "default", collaborationMode: "default", createdAt: new Date(), updatedAt: new Date(), lastActivityAt: new Date(),
  }
  f.move.mockResolvedValue(true)
  f.select.mockImplementation(async (_provider, excluded: Set<string>) => excluded.has("target") ? null : "target")
  f.send.mockImplementation(async (account: ProviderAccount) => {
    if (account.id === "source") throw new Error("You've hit your usage limit")
    return { threadId: "preserved-thread", turnId: "target-turn" }
  })
})

describe("running chat account recovery", () => {
  it("allows recovery policy changes while coding is running, retaining the runtime settings", async () => {
    f.chat.status = "RUNNING"
    f.chat.autoRotateAccount = false
    const chat = await updateChat("chat", { autoRotateAccount: true })
    expect(chat).toMatchObject({ status: "RUNNING", autoRotateAccount: true, permissionMode: "default", accountId: "source" })
    await expect(updateChat("chat", { accountId: "target" })).rejects.toThrow("Wait for the current run")
  })
  it("migrates the existing thread and continues the same run with its original permissions", async () => {
    const dispatched = await executeMessage("chat", { content: "Fix the failing tests" })
    await vi.waitFor(() => expect(f.run?.status).toBe("COMPLETED"))
    expect(dispatched.runId).toBe("run")
    expect(f.createRun).toHaveBeenCalledOnce()
    expect(f.chat).toMatchObject({ accountId: "target", externalThreadId: "preserved-thread", status: "IDLE" })
    expect(f.move).toHaveBeenCalledWith(expect.objectContaining({ threadId: "preserved-thread", fromAccount: expect.objectContaining({ id: "source" }), toAccount: expect.objectContaining({ id: "target" }) }))
    expect(f.send.mock.calls[1][1]).toMatchObject({ threadId: "preserved-thread", permissionMode: "default", content: expect.stringContaining("Check what already completed") })
    expect(f.events).toHaveBeenCalledWith(expect.objectContaining({ type: "run.accountFailover" }))
  })

  it("leaves opt-out chats failed on the original account", async () => {
    f.chat.autoRotateAccount = false
    await executeMessage("chat", { content: "Fix tests" })
    await vi.waitFor(() => expect(f.run?.status).toBe("FAILED"))
    expect(f.select).not.toHaveBeenCalled()
    expect(f.chat.accountId).toBe("source")
  })

  it("does not migrate on network failure", async () => {
    f.send.mockRejectedValue(new Error("ECONNRESET"))
    await executeMessage("chat", { content: "Fix tests" })
    await vi.waitFor(() => expect(f.run?.status).toBe("FAILED"))
    expect(f.select).not.toHaveBeenCalled()
  })

  it("stops after every available account has been tried", async () => {
    f.send.mockRejectedValue(new Error("usageLimitExceeded"))
    await executeMessage("chat", { content: "Fix tests" })
    await vi.waitFor(() => expect(f.run?.error).toContain("No other connected account"))
    expect(f.run?.status).toBe("FAILED")
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.chat.status).toBe("IDLE")
  })

  it("does not dispatch another turn when history migration fails", async () => {
    f.move.mockRejectedValue(new Error("Cannot preserve history"))
    await executeMessage("chat", { content: "Fix tests" })
    await vi.waitFor(() => expect(f.run?.error).toContain("Account failover failed"))
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.chat).toMatchObject({ status: "IDLE", accountId: "source" })
  })
})
