import { describe, expect, it, vi } from "vitest"
import { runCodexAssistant, type AssistantRuntime } from "./codex-assistant.server"

function fixture() {
  let handler: Parameters<AssistantRuntime["onEvent"]>[0] = () => undefined
  const runtime: AssistantRuntime = {
    request: vi.fn(async (method: string) => method === "thread/start" ? { result: { thread: { id: "manager" } } } : method === "config/read" ? { result: { config: { mcp_servers: { "private.tools": {} } } } } : {}),
    respondToServerRequest: vi.fn(async () => undefined),
    onEvent: vi.fn((listener) => { handler = listener; return vi.fn() }),
    shutdown: vi.fn(),
  }
  const controller = new AbortController()
  const options = {
    cwd: "/assistant", prompt: "Manage my chats", instructions: "Only manage chats",
    tools: [{ type: "function" as const, name: "create_chat", description: "Create", inputSchema: { type: "object" } }],
    signal: controller.signal, onText: vi.fn(), callTool: vi.fn(async () => ({ chatId: "new-chat" })),
  }
  const emit = (event: Parameters<typeof handler>[0]) => handler(event)
  const toolCall = (id = "request-1", callId = "call-1", threadId = "manager") => emit({ id, method: "item/tool/call", params: { threadId, tool: "create_chat", arguments: { title: "Test" }, callId } })
  const finish = (status = "completed", error?: { message: string }) => emit({ method: "turn/completed", params: { threadId: "manager", turn: { id: "turn", status, error } } })
  const started = async () => vi.waitFor(() => expect(runtime.request).toHaveBeenCalledWith("turn/start", expect.anything()))
  return { runtime, options, controller, emit, toolCall, finish, started }
}

describe("Codex management assistant protocol", () => {
  it("sends labeled image inputs alongside the user's message", async () => {
    const f = fixture()
    const run = runCodexAssistant(f.runtime, { ...f.options, images: [{ id: "image", name: "diagram.png", url: "data:image/png;base64,aW1hZ2U=" }] })
    await f.started()
    expect(f.runtime.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ input: [
      { type: "text", text: "Manage my chats" },
      { type: "text", text: 'Attached image: {"id":"image","name":"diagram.png"}' },
      { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
    ] }))
    f.finish()
    await run
  })

  it("preserves numeric request IDs so the model can continue after a tool result", async () => {
    const f = fixture()
    f.runtime.respondToServerRequest = vi.fn(async (id) => {
      // The server matches IDs by both value and type; "42" cannot answer 42.
      if (id !== 42) return
      f.emit({ method: "item/agentMessage/delta", params: { threadId: "manager", delta: "I'm Alice." } })
      f.finish()
    })
    const timer = setTimeout(() => f.controller.abort(), 500)
    try {
      const run = runCodexAssistant(f.runtime, f.options)
      await f.started()
      f.emit({ id: 42, method: "item/tool/call", params: { threadId: "manager", tool: "create_chat", arguments: {}, callId: "rename" } })
      await run
      expect(f.runtime.respondToServerRequest).toHaveBeenCalledWith(42, expect.objectContaining({ success: true }))
      expect(f.options.onText).toHaveBeenCalledWith("I'm Alice.")
    } finally { clearTimeout(timer) }
  })

  it("streams replies and executes a repeated call ID once, ignoring other threads", async () => {
    const f = fixture()
    const run = runCodexAssistant(f.runtime, f.options)
    await f.started()
    f.toolCall("foreign", "call-foreign", "coding-thread")
    f.toolCall()
    f.toolCall("request-2")
    await vi.waitFor(() => expect(f.runtime.respondToServerRequest).toHaveBeenCalledTimes(2))
    f.emit({ method: "item/agentMessage/delta", params: { threadId: "manager", delta: "Chat created." } })
    f.finish()
    await run
    expect(f.options.callTool).toHaveBeenCalledTimes(1)
    expect(f.options.onText).toHaveBeenCalledWith("Chat created.")
    expect(f.runtime.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
      config: expect.objectContaining({ mcp_servers: { "private.tools": { command: process.execPath, enabled: false } }, "features.shell_tool": false }),
    }))
    expect(f.runtime.shutdown).toHaveBeenCalledOnce()
  })

  it("returns tool failures to the model without claiming an action succeeded", async () => {
    const f = fixture()
    f.options.callTool.mockRejectedValueOnce(new Error("No capacity"))
    const run = runCodexAssistant(f.runtime, f.options)
    await f.started()
    f.toolCall()
    await vi.waitFor(() => expect(f.runtime.respondToServerRequest).toHaveBeenCalledWith("request-1", { success: false, contentItems: [{ type: "inputText", text: '{"error":"No capacity"}' }] }))
    f.finish()
    await run
  })

  it("preserves numeric request IDs when declining unavailable approvals", async () => {
    const f = fixture()
    const run = runCodexAssistant(f.runtime, f.options)
    await f.started()
    f.emit({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "manager" } })
    await vi.waitFor(() => expect(f.runtime.respondToServerRequest).toHaveBeenCalledWith(7, { decision: "decline" }))
    f.finish()
    await run
  })

  it("serializes application mutations even when tool calls arrive together", async () => {
    const f = fixture()
    let release!: () => void
    f.options.callTool.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ chatId: "first" }) }))
    const run = runCodexAssistant(f.runtime, f.options)
    await f.started()
    f.toolCall()
    f.toolCall("request-2", "call-2")
    await vi.waitFor(() => expect(f.options.callTool).toHaveBeenCalledTimes(1))
    release()
    await vi.waitFor(() => expect(f.runtime.respondToServerRequest).toHaveBeenCalledTimes(2))
    f.finish()
    await run
  })

  it("stopping waits for an already dispatched action and never restarts the closed runtime", async () => {
    const f = fixture()
    let release!: () => void
    f.options.callTool.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ chatId: "saved" }) }))
    const run = runCodexAssistant(f.runtime, f.options)
    const assertion = expect(run).rejects.toThrow("Assistant stopped")
    await f.started()
    f.toolCall()
    await vi.waitFor(() => expect(f.options.callTool).toHaveBeenCalledOnce())
    f.controller.abort()
    release()
    await assertion
    expect(f.runtime.respondToServerRequest).not.toHaveBeenCalled()
  })

  it("surfaces quota failure and cleans up listeners and runtime", async () => {
    const f = fixture()
    const run = runCodexAssistant(f.runtime, f.options)
    const assertion = expect(run).rejects.toThrow("usageLimitExceeded")
    await f.started()
    f.finish("failed", { message: "usageLimitExceeded" })
    await assertion
    expect(f.runtime.shutdown).toHaveBeenCalledOnce()
  })
})
