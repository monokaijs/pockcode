import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderAccount } from "@prisma/client"
import { expect, it, vi } from "vitest"
import { createCodexAssistantRuntime } from "./codex.server"
import { runCodexAssistant } from "./codex-assistant.server"

vi.mock("../prisma.server", () => ({ prisma: {} }))
vi.mock("../database.server", () => ({ ensureDatabase: vi.fn() }))

it("continues after a numeric tool request through the real subprocess transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "pockcode-tool-id-"))
  const script = join(root, "server.mjs")
  await writeFile(script, `
    import { createInterface } from "node:readline";
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialized") return;
      if (request.method === "initialize" || request.method === "config/read") {
        send({ id: request.id, result: {} });
      } else if (request.method === "thread/start") {
        send({ id: request.id, result: { thread: { id: "manager" } } });
      } else if (request.method === "turn/start") {
        send({ id: request.id, result: { turn: { id: "turn" } } });
        send({ id: 42, method: "item/tool/call", params: { threadId: "manager", tool: "update_profile", callId: "rename", arguments: { name: "Alice" } } });
      } else if ("result" in request) {
        if (request.id !== 42) {
          send({ method: "turn/completed", params: { threadId: "manager", turn: { status: "failed", error: { message: "Tool response changed the request ID type" } } } });
          return;
        }
        send({ method: "item/agentMessage/delta", params: { threadId: "manager", delta: "I'm Alice." } });
        send({ method: "turn/completed", params: { threadId: "manager", turn: { status: "completed" } } });
      }
    });
  `)
  const account = { id: "test", settings: { command: process.execPath, args: [script], codexHome: join(root, "home") }, runtimeDefaults: {} } as unknown as ProviderAccount
  const runtime = createCodexAssistantRuntime(account, root)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  const onText = vi.fn()
  const callTool = vi.fn(async () => ({ profile: { name: "Alice" } }))
  try {
    await runCodexAssistant(runtime, {
      cwd: root, prompt: "Call yourself Alice", instructions: "Manage profile",
      tools: [{ type: "function", name: "update_profile", description: "Rename", inputSchema: { type: "object" } }],
      signal: controller.signal, onText, callTool,
    })
    expect(callTool).toHaveBeenCalledExactlyOnceWith("update_profile", { name: "Alice" }, "rename")
    expect(onText).toHaveBeenCalledWith("I'm Alice.")
  } finally {
    clearTimeout(timer)
    runtime.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
