import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JsonObject } from "../types/json"
import type { runCodexAssistant } from "./providers/codex-assistant.server"

type RunOptions = Parameters<typeof runCodexAssistant>[1]
async function sendAgentMessage(options: RunOptions, content: string, callId: string) {
  await options.callTool("set_typing", { typing: true }, `${callId}-typing`)
  return options.callTool("send_agent_message", { content }, callId)
}
const f = vi.hoisted(() => ({
  saved: {} as JsonObject,
  collection: {} as JsonObject,
  run: vi.fn(), create: vi.fn(), execute: vi.fn(), write: vi.fn(), watched: vi.fn(), accounts: vi.fn(),
}))

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined) }))
vi.mock("./runtime-paths.server", () => ({ resolvePockcodeHome: () => "/assistant-test" }))
vi.mock("./socket.server", () => ({ publishProviderEvent: vi.fn() }))
vi.mock("./assistant-followups.server", () => ({ readAssistantWatchedRun: (...args: unknown[]) => f.watched(...args) }))
vi.mock("./plugins/storage.server", () => ({
  readPluginState: async (key: string) => structuredClone(key === "pockcode-assistants" ? f.collection : f.saved),
  writePluginState: async (key: string, state: JsonObject) => {
    f.write(key, state)
    if (key === "pockcode-assistants") {
      f.collection = structuredClone(state)
      f.saved = (f.collection.agents as JsonObject[]).find((agent) => agent.id === "pock") ?? {}
    } else { f.saved = structuredClone(state) }
  },
}))
vi.mock("./accounts.service", () => ({
  listAccounts: (...args: unknown[]) => f.accounts(...args),
  requireConnectedAccount: async () => ({ id: "account", providerId: "codex" }),
  readConnectedAccountLimits: vi.fn(),
}))
vi.mock("./account-failover.server", () => ({ isQuotaExhausted: () => false, selectFailoverAccount: vi.fn() }))
vi.mock("./providers/codex.server", () => ({ createCodexAssistantRuntime: vi.fn() }))
vi.mock("./providers/codex-assistant.server", () => ({ runCodexAssistant: (...args: unknown[]) => f.run(...args) }))
vi.mock("./workspace-history.service", () => ({ listWorkspaceHistory: async () => [{ id: "a", path: "/project-a", name: "Project A" }, { id: "b", path: "/project-b", name: "Project B" }] }))
vi.mock("./chats.service", () => ({
  createChat: (...args: unknown[]) => f.create(...args), executeMessage: (...args: unknown[]) => f.execute(...args),
  forkChat: vi.fn(), getChat: vi.fn(), interruptChatRun: vi.fn(), listChats: vi.fn(), listMessages: vi.fn(), updateChat: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  f.collection = {}
  f.saved = { messages: [], status: "idle", accountId: null, error: null }
  f.run.mockResolvedValue(undefined)
  f.accounts.mockResolvedValue([{ id: "account", providerId: "codex", status: "CONNECTED" }])
  f.watched.mockImplementation(async (_chatId: string, runId = "watched-run") => ({ runId, settled: false, status: "RUNNING", error: null, title: "Coding task", messages: [] }))
})

afterEach(() => vi.useRealTimers())

describe("assistant inbox", () => {
  it("acknowledges a client message ID once even when a send is retried", async () => {
    let finish!: () => void
    f.run.mockImplementation(async () => { await new Promise<void>((resolve) => { finish = resolve }) })
    const service = await import("./assistant.service")
    const request = { content: "Hello", clientMessageId: "client-message" }
    await Promise.all([service.sendAssistantMessage(request), service.sendAssistantMessage(request)])
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    expect((await service.readAssistantState()).messages).toHaveLength(1)
    expect((await service.readAssistantState()).messages[0].id).toBe(request.clientMessageId)
    finish()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    await service.sendAssistantMessage(request)
    expect(f.run).toHaveBeenCalledTimes(1)
  })

  it("records concurrent follow-ups without interruption and reads the entire stack in one next turn", async () => {
    const turns: { options: RunOptions; finish: () => void }[] = []
    f.run.mockImplementation(async (_runtime: unknown, options: RunOptions) => {
      await new Promise<void>((resolve) => { turns.push({ options, finish: resolve }) })
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Check Project A" })
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    const text = { id: "note", kind: "file" as const, name: "note.txt", mimeType: "text/plain", size: 5, dataUrl: "data:text/plain;base64,SGVsbG8=" }
    await Promise.all([
      service.sendAssistantMessage({ content: "Create a task for Project B", attachments: [text] }),
      service.sendAssistantMessage({ content: "Actually, just report the status of Project B" }),
    ])
    const waiting = await service.readAssistantState()
    expect(waiting.messages.filter((message) => message.delivery === "queued").map((message) => message.content)).toEqual([
      "Create a task for Project B", "Actually, just report the status of Project B",
    ])
    expect((f.saved.messages as typeof waiting.messages).filter((message) => message.delivery === "queued")).toHaveLength(2)
    expect(turns).toHaveLength(1)
    expect(turns[0].options.signal.aborted).toBe(false)
    expect(waiting.messages[0]).toMatchObject({ delivery: "processing", readAt: expect.any(String) })
    expect(waiting.messages.filter((message) => message.delivery === "queued").every((message) => !message.readAt)).toBe(true)
    expect(JSON.parse(turns[0].options.prompt).currentUserMessages.map((message: { content: string }) => message.content)).toEqual(["Check Project A"])

    // Saving follow-ups must not replace the live object being streamed by the worker.
    await sendAgentMessage(turns[0].options, "Project A is running.", "message-a")
    turns[0].finish()
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    const prompt = JSON.parse(turns[1].options.prompt)
    expect(prompt.currentUserMessages.map((message: { content: string }) => message.content)).toEqual([
      "Create a task for Project B", "Actually, just report the status of Project B",
    ])
    expect(prompt.currentUserMessages[0].attachments).toMatchObject([{ id: "note", content: "Hello" }])
    expect(prompt.conversationHistory.map((message: { content: string }) => message.content)).toEqual(["Check Project A", "Project A is running."])
    expect(turns[1].options.instructions).toContain("use later corrections")
    expect((await service.readAssistantState()).messages.filter((message) => message.delivery === "processing")).toHaveLength(2)
    expect((await service.readAssistantState()).messages.filter((message) => message.delivery === "processing").every((message) => !!message.readAt)).toBe(true)

    // A message received after the batch starts belongs to a subsequent batch.
    await service.sendAssistantMessage({ content: "Now check Project C" })
    await sendAgentMessage(turns[1].options, "Project B is idle.", "message-b")
    turns[1].finish()
    await vi.waitFor(() => expect(turns).toHaveLength(3))
    expect(JSON.parse(turns[2].options.prompt).currentUserMessages.map((message: { content: string }) => message.content)).toEqual(["Now check Project C"])
    await sendAgentMessage(turns[2].options, "Project C is idle.", "message-c")
    turns[2].finish()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect((await service.readAssistantState()).messages.filter((message) => message.role === "user").every((message) => message.delivery === "handled")).toBe(true)
  })

  it("serializes simultaneous sends to an idle agent and runs only one turn at a time", async () => {
    let finish!: () => void
    f.run.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve }) })
    const service = await import("./assistant.service")
    await Promise.all([
      service.sendAssistantMessage({ content: "First" }),
      service.sendAssistantMessage({ content: "Second" }),
      service.sendAssistantMessage({ content: "Third" }),
    ])
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    expect((await service.readAssistantState()).messages.filter((message) => message.role === "user")).toHaveLength(3)
    finish()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(JSON.parse((f.run.mock.calls[1][1] as RunOptions).prompt).currentUserMessages.map((message: { content: string }) => message.content)).toEqual(["Second", "Third"])
  })

  it("keeps waiting messages after a failed turn and resumes them with the next send", async () => {
    let fail!: () => void
    f.run.mockImplementationOnce(async () => { await new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("Connection lost")) }) })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "First" })
    await vi.waitFor(() => expect(fail).toBeDefined())
    await service.sendAssistantMessage({ content: "Follow up" })
    fail()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect(f.run).toHaveBeenCalledTimes(1)
    expect((await service.readAssistantState()).messages.at(-1)).toMatchObject({ content: "Follow up", delivery: "queued" })
    await service.sendAssistantMessage({ content: "Continue" })
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect(JSON.parse((f.run.mock.calls[1][1] as RunOptions).prompt).currentUserMessages.map((message: { content: string }) => message.content)).toEqual(["Follow up", "Continue"])
  })

  it("preserves queued messages across a restart without replaying the interrupted request", async () => {
    f.saved = { status: "running", accountId: "account", messages: [
      { id: "first", role: "user", content: "Already dispatched", createdAt: "2026-10-02T00:00:00Z", delivery: "processing" },
      { id: "reply", role: "assistant", content: "Task started.", createdAt: "2026-10-02T00:00:01Z" },
      { id: "next", role: "user", content: "Waiting request", createdAt: "2026-10-02T00:00:02Z", delivery: "queued" },
    ] }
    const service = await import("./assistant.service")
    const restored = await service.readAssistantState()
    expect(restored.status).toBe("idle")
    expect(restored.messages[0].delivery).toBe("handled")
    expect(restored.messages[2].delivery).toBe("queued")
    expect(f.run).not.toHaveBeenCalled()
    await service.sendAssistantMessage({ content: "Continue" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect(JSON.parse((f.run.mock.calls[0][1] as RunOptions).prompt).currentUserMessages.map((message: { content: string }) => message.content)).toEqual(["Waiting request", "Continue"])
  })

  it("restores legacy read messages without inventing read times or replaying them", async () => {
    f.saved = { status: "idle", messages: [
      { id: "legacy", role: "user", content: "Hello", createdAt: "2026-10-02T00:00:00Z" },
      { id: "reply", role: "assistant", content: "Hi!", createdAt: "2026-10-02T00:00:01Z" },
    ] }
    const service = await import("./assistant.service")
    const state = await service.readAssistantState()
    expect(state.messages[0].delivery).toBe("handled")
    expect(state.messages[0].readAt).toBeUndefined()
    expect(f.run).not.toHaveBeenCalled()
  })

  it("removes a rejected receipt if saving it fails", async () => {
    const service = await import("./assistant.service")
    await service.readAssistantState()
    f.write.mockImplementationOnce(() => { throw new Error("Disk full") })
    await expect(service.sendAssistantMessage({ content: "Unsaved" })).rejects.toThrow("Disk full")
    expect((await service.readAssistantState()).messages).toEqual([])
    expect(f.run).not.toHaveBeenCalled()
  })

  it("preserves the waiting batch when saving the turn transition fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    let finish!: () => void
    f.run.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve }) })
    try {
      const service = await import("./assistant.service")
      await service.sendAssistantMessage({ content: "First" })
      await vi.waitFor(() => expect(finish).toBeDefined())
      await service.sendAssistantMessage({ content: "Waiting" })
      f.write.mockImplementationOnce(() => { throw new Error("Disk full") })
      finish()
      await vi.waitFor(() => expect(log).toHaveBeenCalled())
      const state = await service.readAssistantState()
      expect(state.status).toBe("idle")
      expect(state.error).toContain("Unable to save")
      expect(state.messages.at(-1)).toMatchObject({ content: "Waiting", delivery: "queued" })
      expect((f.saved.messages as typeof state.messages).at(-1)?.delivery).toBe("queued")
      expect(f.run).toHaveBeenCalledTimes(1)
      await service.sendAssistantMessage({ content: "Continue" })
      await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
      expect(JSON.parse((f.run.mock.calls[1][1] as RunOptions).prompt).currentUserMessages.map((message: { content: string }) => message.content)).toEqual(["Waiting", "Continue"])
    } finally { log.mockRestore() }
  })

  it("cancels waiting messages on Stop and excludes cancelled requests from later prompts", async () => {
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Assistant stopped.")), { once: true })
      })
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Working" })
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    await service.sendAssistantMessage({ content: "Cancelled request" })
    await service.stopAssistant()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect((await service.readAssistantState()).messages.at(-1)?.delivery).toBe("cancelled")
    await service.sendAssistantMessage({ content: "New request" })
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect((f.run.mock.calls[1][1] as RunOptions).prompt).not.toContain("Cancelled request")
    expect(JSON.parse((f.run.mock.calls[1][1] as RunOptions).prompt).currentUserMessage).toBe("New request")
  })
})

describe("agent communication", () => {
  it("shows typing only on request and publishes distinct messages before the turn finishes", async () => {
    let options!: RunOptions
    let finish!: () => void
    f.run.mockImplementation(async (_runtime: unknown, next: RunOptions) => {
      options = next
      await new Promise<void>((resolve) => { finish = resolve })
    })
    const service = await import("./assistant.service")
    const { publishProviderEvent } = await import("./socket.server")
    await service.sendAssistantMessage({ content: "Hello" })
    await vi.waitFor(() => expect(options).toBeDefined())
    expect((await service.readAssistantState()).messages).toHaveLength(1)
    expect((await service.readAssistantState()).typing).toBe(false)

    await expect(options.callTool("send_agent_message", { content: "Hello" }, "missing-typing")).rejects.toThrow("set_typing(true)")
    expect((await service.readAssistantState()).messages).toHaveLength(1)

    // Ordinary model output never becomes a streamed response or an automatic recap.
    options.onText("A long internal response that should not appear.")
    expect((await service.readAssistantState()).messages).toHaveLength(1)
    await options.callTool("set_typing", { typing: true }, "typing-one")
    expect((await service.readAssistantState()).typing).toBe(true)
    const sent = await options.callTool("send_agent_message", { content: "I'll check that." }, "message-one")
    let state = await service.readAssistantState()
    expect(state).toMatchObject({ status: "running", typing: false })
    expect(state.messages.at(-1)).toMatchObject({ content: "I'll check that.", role: "assistant", assistantName: "Pock", inReplyTo: [state.messages[0].id] })
    expect(state.messages.at(-1)?.actions).toBeUndefined()
    expect((f.saved.messages as typeof state.messages).at(-1)?.content).toBe("I'll check that.")

    await options.callTool("set_typing", { typing: true }, "typing-two")
    await options.callTool("send_agent_message", { content: "Everything looks good." }, "message-two")
    state = await service.readAssistantState()
    expect(state.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["I'll check that.", "Everything looks good."])
    expect(state.typing).toBe(false)
    expect(state.status).toBe("running")
    // Provider redelivery must not send another bubble.
    expect(await options.callTool("send_agent_message", { content: "I'll check that." }, "message-one")).toEqual(sent)
    expect((await service.readAssistantState()).messages).toHaveLength(3)
    await options.callTool("set_typing", { typing: true }, "typing-end")
    finish()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    state = await service.readAssistantState()
    expect(state.typing).toBe(false)
    expect(state.messages).toHaveLength(3)
    const completed = vi.mocked(publishProviderEvent).mock.calls.at(-1)?.[0].payload as typeof state
    expect(completed).toMatchObject({ status: "idle", typing: false })
  })

  it("allows a silent turn without an empty bubble or fabricated Done response", async () => {
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Just remember this for our conversation." })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect((await service.readAssistantState()).messages).toHaveLength(1)
  })

  it("clears typing on failure, Stop, and restart", async () => {
    let options!: RunOptions
    let fail!: () => void
    f.run.mockImplementation(async (_runtime: unknown, next: RunOptions) => {
      options = next
      await new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error("Connection lost"))
        options.signal.addEventListener("abort", () => reject(new Error("Assistant stopped.")), { once: true })
      })
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "First" })
    await vi.waitFor(() => expect(options).toBeDefined())
    await options.callTool("set_typing", { typing: true }, "typing-first")
    fail()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect((await service.readAssistantState()).typing).toBe(false)
    await service.sendAssistantMessage({ content: "Second" })
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2))
    await options.callTool("set_typing", { typing: true }, "typing-second")
    expect((await service.stopAssistant()).typing).toBe(false)
    await expect(options.callTool("send_agent_message", { content: "Too late" }, "late-message")).rejects.toThrow("stopped")
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    f.saved.typing = true
    vi.resetModules()
    const restarted = await import("./assistant.service")
    expect((await restarted.readAssistantState()).typing).toBe(false)
  })
})

describe("durable agent follow-ups", () => {
  it("cancels an executing background follow-up without allowing later messages or actions", async () => {
    f.saved.followUps = [{ id: "due", kind: "schedule", status: "waiting", instructions: "Check status", createdAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-01T00:01:00Z" }]
    let options!: RunOptions
    f.run.mockImplementationOnce(async (_runtime: unknown, next: RunOptions) => {
      options = next
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Assistant stopped.")), { once: true })
      })
    })
    const service = await import("./assistant.service")
    await service.processAssistantFollowUps()
    await vi.waitFor(() => expect(options).toBeDefined())
    await options.callTool("set_typing", { typing: true }, "typing")
    expect((await service.cancelAssistantFollowUp("pock", "due")).typing).toBe(false)
    expect(options.signal.aborted).toBe(true)
    await expect(options.callTool("send_agent_message", { content: "Too late" }, "late-message")).rejects.toThrow("stopped")
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect((await service.readAssistantState()).followUps![0].status).toBe("cancelled")
    expect((await service.readAssistantState()).messages).toEqual([])
    await service.processAssistantFollowUps()
    expect(f.run).toHaveBeenCalledTimes(1)
  })
  it("keeps a due event ready until a connected account becomes available", async () => {
    f.saved.followUps = [{ id: "due", kind: "schedule", status: "waiting", instructions: "Check status", createdAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-01T00:01:00Z" }]
    f.accounts.mockResolvedValueOnce([])
    const service = await import("./assistant.service")
    await service.processAssistantFollowUps()
    expect(f.run).not.toHaveBeenCalled()
    expect((await service.readAssistantState()).followUps![0].status).toBe("ready")
    await service.processAssistantFollowUps()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect(f.run).toHaveBeenCalledTimes(1)
    expect((await service.readAssistantState()).followUps![0].status).toBe("completed")
  })

  it("updates an existing watch's reporting instructions without creating a duplicate", async () => {
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      const first = await options.callTool("watch_chat", { chatId: "coding-chat", runId: "specific-run", instructions: "Report when done" }, "watch-first") as { id: string }
      const second = await options.callTool("watch_chat", { chatId: "coding-chat", runId: "specific-run", instructions: "Report only failures" }, "watch-update") as { id: string }
      expect(second.id).toBe(first.id)
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Watch this task, but only report failures" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect((await service.readAssistantState()).followUps).toMatchObject([{ instructions: "Report only failures", runId: "specific-run", status: "waiting" }])
    expect((await service.readAssistantState()).followUps).toHaveLength(1)
  })
  it("automatically watches a dispatched run and reports its result without another user message", async () => {
    f.create.mockResolvedValue({ id: "coding-chat", workingDirectory: "/project-a" })
    f.execute.mockResolvedValue({ runId: "specific-run", status: "QUEUED" })
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      const result = await options.callTool("create_chat", { workingDirectory: "/project-a", accountId: "account", title: "Fix tests", prompt: "Fix the tests" }, "dispatch") as { followUpId: string }
      expect(result.followUpId).toBeTruthy()
      await sendAgentMessage(options, "Started the task. I'll report back.", "started")
    })
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      const prompt = JSON.parse(options.prompt)
      expect(prompt.currentUserMessages).toEqual([])
      expect(prompt.backgroundEvents).toMatchObject([{ kind: "run", runId: "specific-run", chatId: "coding-chat", result: { status: "COMPLETED", messages: ["Fixed the tests; all checks passed."] } }])
      expect(prompt.originalUserMessages).toMatchObject([{ content: "Fix the tests and tell me when done" }])
      await sendAgentMessage(options, "The tests are fixed and all checks passed.", "finished")
    })
    const service = await import("./assistant.service")
    const { publishProviderEvent } = await import("./socket.server")
    await service.sendAssistantMessage({ content: "Fix the tests and tell me when done", timeZone: "Asia/Ho_Chi_Minh" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect((await service.readAssistantState()).followUps).toMatchObject([{ kind: "run", runId: "specific-run", status: "waiting" }])
    await service.processAssistantFollowUps()
    expect(f.run).toHaveBeenCalledTimes(1)
    f.watched.mockResolvedValue({ runId: "specific-run", settled: true, status: "COMPLETED", error: null, title: "Fix tests", messages: ["Fixed the tests; all checks passed."] })
    await Promise.all([service.processAssistantFollowUps(), service.processAssistantFollowUps()])
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    let state = await service.readAssistantState()
    expect(state.followUps).toMatchObject([{ status: "completed", lastDeliveredAt: expect.any(String) }])
    expect(state.messages.at(-1)).toMatchObject({ content: "The tests are fixed and all checks passed.", followUpIds: [state.followUps![0].id] })
    expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1)
    expect(vi.mocked(publishProviderEvent).mock.calls.map(([event]) => event).filter((event) => event.type === "assistant.message")).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ proactive: true, content: "The tests are fixed and all checks passed." }) })]))
    await service.processAssistantFollowUps()
    expect(f.run).toHaveBeenCalledTimes(2)
    vi.resetModules()
    const restarted = await import("./assistant.service")
    await restarted.processAssistantFollowUps()
    state = await restarted.readAssistantState()
    expect(state.followUps![0].status).toBe("completed")
    expect(f.run).toHaveBeenCalledTimes(2)
  })

  it("does not install a watch when the user opts out or dispatch fails", async () => {
    f.create.mockResolvedValue({ id: "coding-chat", workingDirectory: "/project-a" })
    f.execute.mockResolvedValueOnce({ runId: "quiet-run", status: "QUEUED" }).mockRejectedValueOnce(new Error("Disconnected"))
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      await options.callTool("create_chat", { workingDirectory: "/project-a", accountId: "account", title: "Quiet task", prompt: "Build", watch: false }, "quiet")
      await options.callTool("create_chat", { workingDirectory: "/project-a", accountId: "account", title: "Failed dispatch", prompt: "Build" }, "failed")
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Start without notifications" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect((await service.readAssistantState()).followUps).toEqual([])
    expect(f.watched).not.toHaveBeenCalled()
  })

  it("holds due events while busy and combines them with the next user batch", async () => {
    let finish!: () => void
    const dueAt = new Date(Date.now() + 60_000).toISOString()
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      await options.callTool("schedule_follow_up", { dueAt, instructions: "Check status, report only a problem" }, "schedule")
      await new Promise<void>((resolve) => { finish = resolve })
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Check again in one minute" })
    await vi.waitFor(() => expect(finish).toBeDefined())
    await service.processAssistantFollowUps(Date.parse(dueAt) + 1)
    expect((await service.readAssistantState()).followUps![0].status).toBe("ready")
    expect(f.run).toHaveBeenCalledTimes(1)
    await service.sendAssistantMessage({ content: "Actually include successful results too" })
    finish()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    const prompt = JSON.parse((f.run.mock.calls[1][1] as RunOptions).prompt)
    expect(prompt.backgroundEvents).toMatchObject([{ kind: "schedule", instructions: "Check status, report only a problem" }])
    expect(prompt.currentUserMessages).toMatchObject([{ content: "Actually include successful results too" }])
  })

  it("recovers overdue schedules after restart, permits silent checks, and schedules the next interval", async () => {
    f.saved.followUps = [{ id: "periodic", kind: "schedule", status: "waiting", instructions: "Report only problems", createdAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-01T00:01:00Z", intervalMinutes: 5 }]
    f.saved.accountId = "account"
    const service = await import("./assistant.service")
    await service.processAssistantFollowUps()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    const state = await service.readAssistantState()
    expect(state.messages).toEqual([])
    expect(state.followUps![0]).toMatchObject({ id: "periodic", status: "waiting", intervalMinutes: 5 })
    expect(Date.parse(state.followUps![0].dueAt!)).toBeGreaterThan(Date.now())
    await service.processAssistantFollowUps()
    expect(f.run).toHaveBeenCalledTimes(1)
  })

  it("scopes cancellation to the agent and never replays a interrupted background turn", async () => {
    f.saved = { ...f.saved, status: "running", accountId: "account", followUps: [
      { id: "interrupted", kind: "schedule", status: "processing", instructions: "Create a task", createdAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-01T00:01:00Z" },
      { id: "waiting", kind: "schedule", status: "waiting", instructions: "Check later", createdAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-01T00:01:00Z" },
    ] }
    const service = await import("./assistant.service")
    const other = await service.createAssistant({ name: "Other" })
    expect((await service.readAssistantState()).followUps![0]).toMatchObject({ status: "failed", error: expect.stringContaining("restarted") })
    await expect(service.cancelAssistantFollowUp(other.id, "waiting")).rejects.toMatchObject({ status: 404 })
    await service.cancelAssistantFollowUp("pock", "waiting")
    await service.processAssistantFollowUps()
    expect(f.run).not.toHaveBeenCalled()
    expect((await service.readAssistantState()).followUps![1].status).toBe("cancelled")
  })

  it("marks failed background deliveries for inspection instead of automatically repeating actions", async () => {
    f.saved.followUps = [{ id: "due", kind: "schedule", status: "waiting", instructions: "Check status", createdAt: "2026-10-01T00:00:00Z", dueAt: "2026-10-01T00:01:00Z" }]
    f.saved.accountId = "account"
    f.run.mockRejectedValueOnce(new Error("Account unavailable"))
    const service = await import("./assistant.service")
    await service.processAssistantFollowUps()
    await vi.waitFor(async () => expect((await service.readAssistantState()).status).toBe("idle"))
    expect((await service.readAssistantState()).followUps![0]).toMatchObject({ status: "failed", error: "Account unavailable" })
    await service.processAssistantFollowUps()
    expect(f.run).toHaveBeenCalledTimes(1)
  })
})

describe("global assistant profile and context", () => {
  it("persists attachments and supplies images and text files to the agent, including on follow-ups", async () => {
    const image = { id: "image", kind: "image" as const, name: "picture.png", mimeType: "image/png", size: 68, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }
    const text = { id: "file", kind: "file" as const, name: "notes.txt", mimeType: "text/plain", size: 13, dataUrl: `data:text/plain;base64,${Buffer.from("Project notes").toString("base64")}` }
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Look at these", attachments: [image, text] })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    const options = f.run.mock.calls[0][1] as RunOptions
    expect(options.images).toEqual([{ id: "image", name: "picture.png", url: image.dataUrl }])
    expect(JSON.parse(options.prompt).attachments[1]).toMatchObject({ content: "Project notes" })
    expect(options.prompt).not.toContain("base64")
    vi.resetModules()
    const restarted = await import("./assistant.service")
    expect((await restarted.readAssistantState()).messages[0].attachments).toMatchObject([image, text])
    await restarted.sendAssistantMessage({ content: "Explain the image again" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect((f.run.mock.calls[1][1] as RunOptions).images).toEqual(options.images)
  })

  it("persists uploads per agent and keeps image data out of model prompts", async () => {
    const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const service = await import("./assistant.service")
    const other = await service.createAssistant({ name: "Nova" })
    await service.updateAssistantAvatar(avatar, "pock")
    expect((await service.readAssistantState("pock")).profile.avatar).toBe(avatar)
    expect((await service.readAssistantState(other.id)).profile.avatar).toBeUndefined()
    vi.resetModules()
    const restarted = await import("./assistant.service")
    expect((await restarted.readAssistantState("pock")).profile.avatar).toBe(avatar)
    await restarted.sendAssistantMessage({ content: "Hello" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    const options = f.run.mock.calls[0][1] as RunOptions
    expect(JSON.parse(options.prompt).savedProfile).toMatchObject({ hasAvatar: true })
    expect(options.prompt).not.toContain(avatar)
  })

  it("rejects avatar uploads during a run and restores the profile if saving fails", async () => {
    const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const service = await import("./assistant.service")
    const previous = (await service.readAssistantState()).profile
    f.write.mockImplementationOnce(() => { throw new Error("Disk full") })
    await expect(service.updateAssistantAvatar(avatar, "pock")).rejects.toThrow("Disk full")
    expect((await service.readAssistantState()).profile).toEqual(previous)
    let finish!: () => void
    f.run.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve }) })
    await service.sendAssistantMessage({ content: "Hello" })
    await vi.waitFor(() => expect(finish).toBeDefined())
    await expect(service.updateAssistantAvatar(avatar, "pock")).rejects.toThrow("finish")
    finish()
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
  })

  it("lets an agent generate its own avatar and preserves it through profile updates", async () => {
    let toolResult: unknown
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      toolResult = await options.callTool("generate_avatar", { background: "#143", shapes: [{ type: "circle", cx: 256, cy: 256, r: 150, fill: "#7cb" }] }, "avatar")
      await options.callTool("update_profile", { name: "Nova" }, "rename")
      await sendAgentMessage(options, "I've saved my avatar.", "outgoing-0")
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Generate your own avatar" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    const profile = (await service.readAssistantState()).profile
    expect(profile.name).toBe("Nova")
    expect(profile.avatar).toMatch(/^data:image\/svg\+xml;base64,/u)
    expect(JSON.stringify(toolResult)).not.toContain("base64")
    expect(toolResult).toMatchObject({ avatarUpdated: true, width: 512, height: 512 })
    vi.resetModules()
    const restarted = await import("./assistant.service")
    expect((await restarted.readAssistantState()).profile.avatar).toBe(profile.avatar)
  })

  it("loads existing conversations with the default profile", async () => {
    f.saved.messages = [{ id: "old", role: "assistant", content: "Hello", createdAt: "2026-10-02T00:00:00Z" }]
    const service = await import("./assistant.service")
    const state = await service.readAssistantState()
    expect(state.profile.name).toBe("Pock")
    expect(state.profile.personality).toContain("concise")
    expect(state.messages[0].content).toBe("Hello")
  })

  it("persists name and personality changed through chat and uses them after a restart", async () => {
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      await options.callTool("update_profile", { name: "Nova", personality: "Warm, concise, and direct." }, "profile-update")
      await sendAgentMessage(options, "I'm Nova. I'll keep replies warm and concise.", "outgoing-1")
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Call yourself Nova and be warm, concise, and direct." })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect((await service.readAssistantState()).profile).toEqual({ name: "Nova", personality: "Warm, concise, and direct." })
    expect((await service.readAssistantState()).messages.at(-1)?.assistantName).toBe("Nova")

    vi.resetModules()
    const restarted = await import("./assistant.service")
    await restarted.sendAssistantMessage({ content: "What is your name?" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    const options = f.run.mock.calls[1][1] as RunOptions
    expect(JSON.parse(options.prompt).savedProfile).toEqual({ name: "Nova", personality: "Warm, concise, and direct." })
    expect(options.instructions).toContain("immediately adopt the returned name and style")
  })

  it("does not supply a selected project or chat to the global assistant", async () => {
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "What is running across my projects?" })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    const options = f.run.mock.calls[0][1] as RunOptions
    const prompt = JSON.parse(options.prompt)
    expect(prompt).not.toHaveProperty("selectedContext")
    expect(prompt).not.toHaveProperty("workingDirectory")
    expect(prompt).not.toHaveProperty("chatId")
    expect(options.cwd).toBe("/assistant-test/assistant/pock")
    expect(options.instructions).toContain("no default, selected, or pinned project")
  })

  it("dispatches tasks in multiple projects from one conversation", async () => {
    f.create.mockImplementation(async (request: { workingDirectory: string }) => ({ id: request.workingDirectory === "/project-a" ? "chat-a" : "chat-b", ...request }))
    f.execute.mockImplementation(async (chatId: string) => ({ runId: `run-${chatId}`, status: "QUEUED" }))
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      await options.callTool("create_chat", { workingDirectory: "/project-a", accountId: "account", title: "Review authentication", prompt: "Review authentication" }, "task-a")
      await options.callTool("create_chat", { workingDirectory: "/project-b", accountId: "account", title: "Fix tests", prompt: "Fix the failing tests" }, "task-b")
      await sendAgentMessage(options, "Started a task in each project.", "outgoing-2")
    })
    const service = await import("./assistant.service")
    await service.sendAssistantMessage({ content: "Review authentication in Project A and fix tests in Project B." })
    await vi.waitFor(() => expect(f.saved.status).toBe("idle"))
    expect(f.create.mock.calls.map(([request]) => request.workingDirectory)).toEqual(["/project-a", "/project-b"])
    expect(f.execute.mock.calls.map(([chatId]) => chatId)).toEqual(["chat-a", "chat-b"])
    const state = await service.readAssistantState()
    expect(state.messages.find((message) => message.actions?.length)?.actions?.map((action) => ({ status: action.status, workingDirectory: action.workingDirectory }))).toEqual([
      { status: "completed", workingDirectory: "/project-a" }, { status: "completed", workingDirectory: "/project-b" },
    ])
  })
})


describe("independent global agents", () => {
  it("migrates the original profile and history only once", async () => {
    f.saved.profile = { name: "Existing Pock", personality: "Direct." }
    f.saved.messages = [{ id: "old", role: "user", content: "Saved request", createdAt: "2026-10-02T00:00:00Z" }]
    const service = await import("./assistant.service")
    expect(await service.listAssistants()).toMatchObject([{ id: "pock", profile: { name: "Existing Pock" } }])
    expect((await service.readAssistantState("pock")).messages[0].content).toBe("Saved request")
    const added = await service.createAssistant({ name: "Nova" })
    vi.resetModules()
    const restarted = await import("./assistant.service")
    expect((await restarted.listAssistants()).map((agent) => agent.id)).toEqual(["pock", added.id])
    expect((await restarted.readAssistantState("pock")).messages).toHaveLength(1)
  })

  it("keeps each agent's profile and conversation separate across restarts", async () => {
    const service = await import("./assistant.service")
    const first = await service.createAssistant({ name: "Nova", personality: "Warm." })
    const second = await service.createAssistant({ name: "Atlas", personality: "Analytical." })
    f.run.mockImplementationOnce(async (_runtime: unknown, options: RunOptions) => {
      await options.callTool("update_profile", { name: "Nia", personality: "Brief." }, "rename")
      await sendAgentMessage(options, "I'm Nia.", "outgoing-3")
    })
    await service.sendAssistantMessage({ content: "Call yourself Nia and be brief." }, first.id)
    await vi.waitFor(async () => expect((await service.readAssistantState(first.id)).status).toBe("idle"))
    await service.sendAssistantMessage({ content: "Hello Atlas." }, second.id)
    await vi.waitFor(async () => expect((await service.readAssistantState(second.id)).status).toBe("idle"))
    const options = f.run.mock.calls[1][1] as RunOptions
    expect(JSON.parse(options.prompt).conversationHistory).toEqual([])
    expect(JSON.parse(options.prompt).savedProfile.name).toBe("Atlas")
    expect(options.cwd).toBe(`/assistant-test/assistant/${second.id}`)
    vi.resetModules()
    const restarted = await import("./assistant.service")
    expect((await restarted.readAssistantState(first.id)).profile).toEqual({ name: "Nia", personality: "Brief." })
    expect((await restarted.readAssistantState(second.id)).profile).toEqual({ name: "Atlas", personality: "Analytical." })
    expect((await restarted.readAssistantState(first.id)).messages[0].content).toContain("Nia")
    expect((await restarted.readAssistantState(second.id)).messages[0].content).toBe("Hello Atlas.")
    expect((await restarted.readAssistantState("pock")).messages).toEqual([])
    expect(await restarted.listAssistants()).toHaveLength(3)
    expect((await restarted.listAssistants())[0]).not.toHaveProperty("messages")
  })

  it("runs agents concurrently and stops only the requested agent", async () => {
    const service = await import("./assistant.service")
    const first = await service.createAssistant({ name: "Nova" })
    const second = await service.createAssistant({ name: "Atlas" })
    const runs = new Map<string, { options: RunOptions; finish: () => void }>()
    f.run.mockImplementation(async (_runtime: unknown, options: RunOptions) => {
      await new Promise<void>((resolve, reject) => {
        runs.set(options.cwd, { options, finish: resolve })
        options.signal.addEventListener("abort", () => reject(new Error("Assistant stopped.")), { once: true })
      })
    })
    await Promise.all([
      service.sendAssistantMessage({ content: "First request" }, first.id),
      service.sendAssistantMessage({ content: "Second request" }, second.id),
    ])
    await vi.waitFor(() => expect(runs.size).toBe(2))
    const queued = await service.sendAssistantMessage({ content: "Follow up" }, first.id)
    expect(queued.messages.at(-1)).toMatchObject({ content: "Follow up", delivery: "queued" })
    await service.stopAssistant(first.id)
    await vi.waitFor(async () => expect((await service.readAssistantState(first.id)).status).toBe("idle"))
    expect((await service.readAssistantState(first.id)).error).toBe("Assistant stopped.")
    expect((await service.readAssistantState(first.id)).messages.at(-1)?.delivery).toBe("cancelled")
    expect((await service.readAssistantState(second.id)).status).toBe("running")
    const secondRun = runs.get(`/assistant-test/assistant/${second.id}`)!
    expect(secondRun.options.signal.aborted).toBe(false)
    await sendAgentMessage(secondRun.options, "Second completed.", "outgoing-completed")
    secondRun.finish()
    await vi.waitFor(async () => expect((await service.readAssistantState(second.id)).status).toBe("idle"))
    await vi.waitFor(() => {
      const saved = f.collection.agents as JsonObject[]
      expect(saved.find((agent) => agent.id === first.id)?.status).toBe("idle")
      expect(saved.find((agent) => agent.id === second.id)?.status).toBe("idle")
    })
    expect((await service.readAssistantState(second.id)).messages.at(-1)?.content).toBe("Second completed.")
  })

  it("rejects unknown agents and invalid profiles without changing Pock", async () => {
    const service = await import("./assistant.service")
    await expect(service.readAssistantState("missing")).rejects.toMatchObject({ status: 404 })
    await expect(service.sendAssistantMessage({ content: "Hello" }, "missing")).rejects.toMatchObject({ status: 404 })
    await expect(service.stopAssistant("missing")).rejects.toMatchObject({ status: 404 })
    await expect(service.createAssistant({ name: " " })).rejects.toMatchObject({ status: 400 })
    expect(await service.listAssistants()).toHaveLength(1)
    expect((await service.readAssistantState()).messages).toEqual([])
  })
})
