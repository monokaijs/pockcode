import { beforeEach, describe, expect, it, vi } from "vitest"
import { executeAssistantTool } from "./assistant-tools.server"
import { createChat, executeMessage, getChat, updateChat } from "./chats.service"
import { listWorkspaceHistory } from "./workspace-history.service"
import { selectFailoverAccount } from "./account-failover.server"
import { defaultAssistantProfile } from "./assistant-profile.server"

vi.mock("./accounts.service", () => ({ listAccounts: vi.fn(), readConnectedAccountLimits: vi.fn() }))
vi.mock("./chats.service", () => ({ createChat: vi.fn(), executeMessage: vi.fn(), forkChat: vi.fn(), getChat: vi.fn(), interruptChatRun: vi.fn(), listChats: vi.fn(), listMessages: vi.fn(), updateChat: vi.fn() }))
vi.mock("./workspace-history.service", () => ({ listWorkspaceHistory: vi.fn() }))
vi.mock("./account-failover.server", () => ({ selectFailoverAccount: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

describe("assistant application actions", () => {
  it("requires a future timezone-qualified schedule and a bounded whole-number interval", async () => {
    const scheduleFollowUp = vi.fn(async (request) => ({ id: "schedule", kind: "schedule", status: "waiting", createdAt: new Date().toISOString(), ...request }))
    const context = { getProfile: () => ({ ...defaultAssistantProfile }), saveProfile: vi.fn(), scheduleFollowUp }
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(await executeAssistantTool("schedule_follow_up", { dueAt: future, instructions: "Check status", intervalMinutes: 5 }, context)).toMatchObject({ id: "schedule", dueAt: future, intervalMinutes: 5 })
    for (const dueAt of ["invalid", future.replace("Z", ""), "2020-01-01T00:00:00Z"]) {
      await expect(executeAssistantTool("schedule_follow_up", { dueAt, instructions: "Check" }, context)).rejects.toThrow("future ISO")
    }
    for (const intervalMinutes of [0, -1, 1.5, 525601, "5"]) {
      await expect(executeAssistantTool("schedule_follow_up", { dueAt: future, instructions: "Check", intervalMinutes }, context)).rejects.toThrow("whole number")
    }
    expect(scheduleFollowUp).toHaveBeenCalledTimes(1)
  })
  it("validates typing and short outgoing messages before publishing them", async () => {
    const setTyping = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({ messageId: "outgoing" }))
    const context = { getProfile: () => ({ ...defaultAssistantProfile }), saveProfile: vi.fn(), setTyping, sendMessage }
    expect(await executeAssistantTool("set_typing", { typing: true }, context)).toEqual({ typing: true })
    expect(await executeAssistantTool("set_typing", { typing: false }, context)).toEqual({ typing: false })
    expect(await executeAssistantTool("send_agent_message", { content: "  Hello.  " }, context)).toEqual({ messageId: "outgoing" })
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Hello.")
    for (const args of [{}, { typing: "true" }, { typing: true, chatId: "other" }]) {
      await expect(executeAssistantTool("set_typing", args, context)).rejects.toThrow()
    }
    for (const content of ["", "   ", "x".repeat(1201), 123]) {
      await expect(executeAssistantTool("send_agent_message", { content }, context)).rejects.toThrow()
    }
    await expect(executeAssistantTool("send_agent_message", { content: "Hello", chatId: "other" }, context)).rejects.toThrow()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(setTyping).toHaveBeenCalledTimes(2)
    expect(executeMessage).not.toHaveBeenCalled()
  })
  it("saves a partial assistant profile update without changing chats or other preferences", async () => {
    const saveProfile = vi.fn(async () => undefined)
    const context = { getProfile: () => ({ ...defaultAssistantProfile }), saveProfile }
    expect(await executeAssistantTool("update_profile", { name: "  Nova  " }, context)).toEqual({ profile: { ...defaultAssistantProfile, name: "Nova" } })
    expect(saveProfile).toHaveBeenCalledExactlyOnceWith({ ...defaultAssistantProfile, name: "Nova" })
    expect(updateChat).not.toHaveBeenCalled()
    expect(await executeAssistantTool("get_profile", {}, context)).toEqual({ profile: defaultAssistantProfile, defaults: defaultAssistantProfile })
  })

  it("rejects empty or invalid profile changes before saving", async () => {
    const saveProfile = vi.fn(async () => undefined)
    const context = { getProfile: () => ({ ...defaultAssistantProfile }), saveProfile }
    for (const args of [{}, { name: "   " }, { name: 1 }, { name: "x".repeat(81) }, { personality: "x".repeat(2001) }, { permissionMode: "fullAccess" }]) {
      await expect(executeAssistantTool("update_profile", args, context)).rejects.toThrow()
    }
    expect(saveProfile).not.toHaveBeenCalled()
  })
  it("rejects unknown tools, bad argument types, and arbitrary project paths before mutation", async () => {
    await expect(executeAssistantTool("delete_everything", {})).rejects.toThrow("Unknown")
    await expect(executeAssistantTool("set_failover", { chatId: "one", enabled: "true" })).rejects.toThrow("boolean")
    await expect(executeAssistantTool("send_message", { chatId: "one", content: "Do work", permissionMode: "fullAccess" })).rejects.toThrow("Unexpected")
    vi.mocked(listWorkspaceHistory).mockResolvedValue([])
    await expect(executeAssistantTool("create_chat", { workingDirectory: "/private", accountId: "one", title: "Test" })).rejects.toThrow("Open this project")
    expect(createChat).not.toHaveBeenCalled()
    expect(updateChat).not.toHaveBeenCalled()
  })

  it("keeps a created chat identifiable when the initial prompt fails to dispatch", async () => {
    vi.mocked(listWorkspaceHistory).mockResolvedValue([{ path: "/project" }] as Awaited<ReturnType<typeof listWorkspaceHistory>>)
    vi.mocked(createChat).mockResolvedValue({ id: "created", workingDirectory: "/project" } as Awaited<ReturnType<typeof createChat>>)
    vi.mocked(executeMessage).mockRejectedValue(new Error("Account disconnected"))
    expect(await executeAssistantTool("create_chat", { workingDirectory: "/project", accountId: "one", title: "Test", prompt: "Build", autoRotateAccount: true })).toMatchObject({ chatId: "created", dispatchError: "Account disconnected" })
    expect(createChat).toHaveBeenCalledWith({ workingDirectory: "/project", accountId: "one", title: "Test", autoRotateAccount: true })
  })

  it("does not silently stop a running chat to move it", async () => {
    vi.mocked(getChat).mockResolvedValue({ status: "RUNNING" } as Awaited<ReturnType<typeof getChat>>)
    await expect(executeAssistantTool("move_chat", { chatId: "one" })).rejects.toThrow("explicitly ask to stop")
    expect(updateChat).not.toHaveBeenCalled()
  })

  it("moves an idle conversation through the existing history-preserving service", async () => {
    vi.mocked(getChat).mockResolvedValue({ id: "one", status: "IDLE", accountId: "exhausted", providerId: "codex", workingDirectory: "/project" } as Awaited<ReturnType<typeof getChat>>)
    vi.mocked(selectFailoverAccount).mockResolvedValue("available")
    await executeAssistantTool("move_chat", { chatId: "one" })
    expect(selectFailoverAccount).toHaveBeenCalledWith("codex", new Set(["exhausted"]))
    expect(updateChat).toHaveBeenCalledExactlyOnceWith("one", { accountId: "available" })
  })
})
