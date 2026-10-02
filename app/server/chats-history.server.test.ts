import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Chat } from "@prisma/client"
import { listMessages } from "./chats.service"

const f = vi.hoisted(() => ({
  chat: {} as Chat,
  connectedAccount: vi.fn(),
  localMessages: vi.fn(),
  accountMessages: vi.fn(),
}))

vi.mock("./database.server", () => ({ ensureDatabase: async () => undefined }))
vi.mock("./socket.server", () => ({ publishProviderEvent: vi.fn() }))
vi.mock("./accounts.service", () => ({ requireConnectedAccount: f.connectedAccount }))
vi.mock("./providers/registry.server", () => ({ getProviderAdapter: () => ({
  loadLocalChatMessages: f.localMessages,
  loadChatMessages: f.accountMessages,
}) }))
vi.mock("./prisma.server", () => ({ prisma: {
  chat: { findUnique: async () => f.chat },
  chatRun: { findMany: async () => [] },
} }))

beforeEach(() => {
  vi.resetAllMocks()
  f.chat = { id: "chat", providerId: "codex", accountId: null, externalThreadId: "local-thread" } as Chat
  f.localMessages.mockResolvedValue([{ role: "ASSISTANT", content: "Saved local response", itemId: "local-answer" }])
  f.accountMessages.mockResolvedValue([{ role: "ASSISTANT", content: "Account response", itemId: "account-answer" }])
  f.connectedAccount.mockResolvedValue({ id: "account", providerId: "codex" })
})

describe("saved chat history", () => {
  it("loads local responses for a chat without a linked account", async () => {
    const page = await listMessages("chat")
    expect(page.data).toMatchObject([{ role: "ASSISTANT", content: "Saved local response", chatId: "chat" }])
    expect(f.localMessages).toHaveBeenCalledWith("local-thread")
    expect(f.connectedAccount).not.toHaveBeenCalled()
    expect(f.accountMessages).not.toHaveBeenCalled()
  })

  it("keeps saved local responses readable when the linked account disconnects", async () => {
    f.chat.accountId = "account"
    f.connectedAccount.mockRejectedValue(new Error("Account disconnected"))
    expect((await listMessages("chat")).data[0]?.content).toBe("Saved local response")
    expect(f.accountMessages).not.toHaveBeenCalled()
  })

  it("uses account history when the linked account is connected", async () => {
    f.chat.accountId = "account"
    expect((await listMessages("chat")).data[0]?.content).toBe("Account response")
    expect(f.localMessages).not.toHaveBeenCalled()
  })

  it("leaves a new chat with no provider thread empty", async () => {
    f.chat.externalThreadId = null
    expect((await listMessages("chat")).data).toEqual([])
    expect(f.localMessages).not.toHaveBeenCalled()
  })
})
