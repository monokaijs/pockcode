import { describe, expect, it } from "vitest"
import { hasClaudeEnvironmentAuth, mapClaudeSdkMessage } from "./claude.server"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProviderAccount } from "@prisma/client"

function claudeAccount(settings: unknown): ProviderAccount {
  return {
    authState: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    displayName: "Claude",
    id: "account-1",
    lastAuthLoginId: null,
    lastAuthMode: null,
    lastAuthUrl: null,
    lastAuthUserCode: null,
    lastError: null,
    providerId: "claude",
    runtimeDefaults: {},
    settings,
    status: "DISCONNECTED",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as ProviderAccount
}

describe("hasClaudeEnvironmentAuth", () => {
  it("uses the account environment for Claude auth", () => {
    expect(hasClaudeEnvironmentAuth(claudeAccount({
      environment: { ANTHROPIC_API_KEY: "sk-ant-test" },
    }))).toBe(true)
  })

  it("ignores inherited process auth for account isolation", () => {
    const previous = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-process"
    try {
      expect(hasClaudeEnvironmentAuth(claudeAccount({ environment: {} }))).toBe(false)
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previous
      }
    }
  })
})

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
