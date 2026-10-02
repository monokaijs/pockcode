import type { JsonObject, JsonSerializable } from "../../types/json"

type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown }
export type AssistantRuntime = {
  request(method: string, params?: JsonObject, timeoutMs?: number): Promise<RpcMessage>
  respondToServerRequest(id: string | number, result: JsonSerializable): Promise<void>
  onEvent(handler: (event: RpcMessage) => void): () => void
  shutdown(): void
}

export type AssistantTool = { type: "function"; name: string; description: string; inputSchema: JsonObject }

export async function runCodexAssistant(runtime: AssistantRuntime, options: {
  cwd: string
  prompt: string
  images?: { id: string; name: string; url: string }[]
  instructions: string
  tools: AssistantTool[]
  signal: AbortSignal
  onText(content: string): void
  callTool(name: string, args: unknown, callId: string): Promise<unknown>
}): Promise<void> {
  let threadId: string | null = null
  let calls = 0
  const callResults = new Map<string, { success: boolean; result: unknown }>()
  let toolQueue = Promise.resolve()
  let settled = false
  let resolveCompletion!: () => void
  let rejectCompletion!: (error: Error) => void
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
  // Initialization may fail before we reach the completion await.
  void completion.catch(() => undefined)
  const fail = (error: Error) => { if (!settled) { settled = true; rejectCompletion(error) } }
  const abort = () => { fail(new Error("Assistant stopped.")); runtime.shutdown() }
  const timeout = setTimeout(() => { fail(new Error("Assistant timed out. Completed actions are saved.")); runtime.shutdown() }, 10 * 60_000)
  options.signal.addEventListener("abort", abort, { once: true })
  const unsubscribe = runtime.onEvent((event) => {
    const params = record(event.params)
    if (!threadId || params.threadId !== threadId || settled) return
    if (event.id !== undefined && event.method === "item/tool/call") {
      const requestId = event.id
      // Serialize mutations even if the model asks for parallel tool execution.
      toolQueue = toolQueue.then(async () => {
        if (options.signal.aborted || settled) return
        let success = true
        let result: unknown
        const callId = String(params.callId ?? event.id)
        const previous = callResults.get(callId)
        try {
          if (previous) {
            success = previous.success
            result = previous.result
          } else {
            if (++calls > 24) throw new Error("Action limit reached. Ask the user to continue.")
            const name = String(params.tool ?? "")
            if (!options.tools.some((tool) => tool.name === name)) throw new Error("Unknown assistant tool.")
            result = await options.callTool(name, params.arguments, callId)
          }
        } catch (error) {
          success = false
          result = { error: error instanceof Error ? error.message : "Action failed." }
        }
        callResults.set(callId, { success, result })
        if (options.signal.aborted || settled) return
        await runtime.respondToServerRequest(requestId, {
          success, contentItems: [{ type: "inputText", text: JSON.stringify(result ?? null) }],
        })
      }).catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
    } else if (event.id !== undefined && event.method) {
      // This assistant has only application tools; never grant shell, file, or MCP approvals.
      void runtime.respondToServerRequest(event.id, { decision: "decline" }).catch((error) => fail(error))
    } else if (event.method === "item/agentMessage/delta") {
      if (typeof params.delta === "string") options.onText(params.delta)
    } else if (event.method === "turn/completed") {
      const turn = record(params.turn)
      if (turn.status === "failed") {
        fail(new Error(String(record(turn.error).message ?? "Assistant run failed.")))
      } else if (turn.status === "interrupted") {
        fail(new Error("Assistant stopped."))
      } else {
        settled = true
        resolveCompletion()
      }
    }
  })
  try {
    if (options.signal.aborted) throw new Error("Assistant stopped.")
    // Disable every configured MCP server, including tools that normally skip approval.
    const configuration = await runtime.request("config/read", { includeLayers: false })
    const servers = record(record(record(configuration.result).config).mcp_servers)
    const overrides: JsonObject = {
      "features.shell_tool": false, "features.apply_patch_tool": false,
      "features.multi_agent": false, web_search: "disabled",
    }
    // Whole-table overrides preserve names containing dots; the runtime splits dotted keys literally.
    // Resolved config contains null defaults that cannot be round-tripped as TOML.
    // Disabled placeholders avoid copying transport credentials into the thread request.
    overrides.mcp_servers = Object.fromEntries(Object.keys(servers).map((name) => [name, {
      command: process.execPath, enabled: false,
    }])) as JsonObject
    const response = await runtime.request("thread/start", {
      cwd: options.cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: options.instructions,
      developerInstructions: "Only use the supplied PockCode tools. Do not use shell, filesystem, web, MCP, or agent delegation tools.",
      dynamicTools: options.tools as unknown as JsonSerializable,
      config: overrides,
    })
    const thread = record(record(response.result).thread)
    threadId = typeof thread.id === "string" ? thread.id : null
    if (!threadId) throw new Error("Codex did not create the assistant thread.")
    if (options.signal.aborted) throw new Error("Assistant stopped.")
    const input: JsonObject[] = [{ type: "text", text: options.prompt }]
    for (const { id, name, url } of options.images ?? []) {
      input.push({ type: "text", text: `Attached image: ${JSON.stringify({ id, name })}` }, { type: "image", url })
    }
    await runtime.request("turn/start", {
      threadId, input,
      approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
    })
    await completion
    await toolQueue
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener("abort", abort)
    unsubscribe()
    runtime.shutdown()
    // Finish an already dispatched application action before accepting another user request.
    await toolQueue
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
