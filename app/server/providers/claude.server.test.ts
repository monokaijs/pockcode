import { describe, expect, it } from "vitest"
import { mapClaudeSdkMessage } from "./claude.server"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

describe("mapClaudeSdkMessage", () => {
  it("maps assistant text and thinking blocks", () => {
    const messages = mapClaudeSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Considering the change." },
          { type: "text", text: "Done." },
        ],
      },
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "turn-1",
    } as unknown as SDKMessage)

    expect(messages.map((message) => [message.kind, message.role, message.content])).toEqual([
      ["THINKING", "ASSISTANT", "Considering the change."],
      ["CHAT", "ASSISTANT", "Done."],
    ])
  })

  it("maps Bash tool use and result as command execution", () => {
    const toolNamesById = new Map<string, string>()
    const started = mapClaudeSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test" } }],
      },
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "turn-1",
    } as unknown as SDKMessage, { toolNamesById })
    const finished = mapClaudeSdkMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
      },
      parent_tool_use_id: null,
      session_id: "session-1",
      uuid: "result-1",
    } as unknown as SDKMessage, { toolNamesById })

    expect(started[0]).toMatchObject({
      content: "- run `pnpm test`",
      kind: "COMMAND_EXECUTION",
      role: "TOOL",
      status: "STREAMING",
    })
    expect(finished[0]).toMatchObject({
      kind: "COMMAND_EXECUTION",
      role: "TOOL",
      status: "COMPLETED",
    })
  })
})
