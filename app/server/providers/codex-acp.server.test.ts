import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { codexAcpElicitationPayload, normalizeCodexAcpUpdates } from "./codex-acp.server"

describe("Codex ACP message normalization", () => {
  it("accumulates ACP message chunks by message id", () => {
    const messages = normalizeCodexAcpUpdates([
      messageChunk("agent_message_chunk", "answer-1", "Hello "),
      messageChunk("agent_message_chunk", "answer-1", "world"),
      messageChunk("agent_thought_chunk", "thought-1", "Checking the workspace"),
    ])

    expect(messages).toMatchObject([
      {
        content: "Hello world",
        itemId: "answer-1",
        kind: "CHAT",
        role: "ASSISTANT",
        status: "COMPLETED",
      },
      {
        content: "Checking the workspace",
        itemId: "thought-1",
        kind: "THINKING",
        role: "ASSISTANT",
        status: "COMPLETED",
      },
    ])
  })

  it("merges tool updates and preserves command output", () => {
    const messages = normalizeCodexAcpUpdates([
      {
        sessionUpdate: "tool_call",
        toolCallId: "command-1",
        title: "pnpm test",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pnpm test", cwd: "/workspace" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "command-1",
        status: "completed",
        rawOutput: { formatted_output: "21 tests passed", exit_code: 0 },
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      itemId: "command-1",
      kind: "COMMAND_EXECUTION",
      role: "TOOL",
      status: "COMPLETED",
    })
    expect(messages[0]?.content).toContain("~~~sh\npnpm test\n~~~")
    expect(messages[0]?.content).toContain("21 tests passed")
  })

  it("maps diffs, plans, and Codex subagent metadata", () => {
    const messages = normalizeCodexAcpUpdates([
      {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        title: "Editing files",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", path: "/workspace/app.ts", oldText: "one\n", newText: "one\ntwo\n" }],
      },
      {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "plan-1",
          entries: [{ content: "Implement ACP", priority: "high", status: "in_progress" }],
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "agent-1",
        title: "Start subagent researcher",
        kind: "other",
        status: "in_progress",
        _meta: { codex: { subagent: { threadId: "thread-2", path: "/researcher" } } },
      },
    ])

    expect(messages[0]).toMatchObject({ kind: "FILE_CHANGE", content: expect.stringContaining("`/workspace/app.ts`") })
    expect(messages[1]).toMatchObject({
      itemId: "plan:plan-1",
      kind: "PLAN",
      metadata: {
        planPresentation: "update",
        planSteps: [{ status: "inProgress", step: "Implement ACP" }],
      },
    })
    expect(messages[2]).toMatchObject({ kind: "SUBAGENT_ACTIVITY", itemId: "agent-1" })
  })

  it("keeps MCP executions generic and starts a new structured plan after each user turn", () => {
    const messages = normalizeCodexAcpUpdates([
      { sessionUpdate: "user_message_chunk", messageId: "user-1", content: { type: "text", text: "First" } },
      {
        sessionUpdate: "plan",
        entries: [{ content: "First plan", priority: "medium", status: "in_progress" }],
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "mcp-1",
        title: "mcp.github.search",
        kind: "execute",
        status: "completed",
        rawInput: { server: "github", tool: "search", arguments: { query: "ACP" } },
        _meta: { is_mcp_tool_call: true },
      },
      { sessionUpdate: "user_message_chunk", messageId: "user-2", content: { type: "text", text: "Second" } },
      {
        sessionUpdate: "plan",
        entries: [{ content: "Second plan", priority: "medium", status: "pending" }],
      },
    ])

    expect(messages.filter((message) => message.kind === "PLAN").map((message) => message.itemId)).toEqual([
      "plan:structured-1",
      "plan:structured-2",
    ])
    expect(messages.find((message) => message.itemId === "mcp-1")?.kind).toBe("TOOL_ACTIVITY")
  })

  it("adapts ACP form elicitations to Pockcode user-input questions", () => {
    const payload = codexAcpElicitationPayload({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a strategy",
      requestedSchema: {
        type: "object",
        properties: {
          strategy: {
            type: "string",
            title: "Strategy",
            description: "How should Codex continue?",
            oneOf: [
              { const: "fast", title: "Move fast" },
              { const: "safe", title: "Be careful" },
            ],
          },
        },
      },
    })

    expect(payload).toMatchObject({
      questions: [{
        header: "Strategy",
        id: "strategy",
        question: "How should Codex continue?",
        options: [
          { label: "Move fast", value: "fast" },
          { label: "Be careful", value: "safe" },
        ],
      }],
    })
  })

  it("preserves every ACP content block instead of flattening media and resources", () => {
    const messages = normalizeCodexAcpUpdates([
      { sessionUpdate: "agent_message_chunk", messageId: "media-1", content: { type: "text", text: "Result" } },
      { sessionUpdate: "agent_message_chunk", messageId: "media-1", content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } },
      { sessionUpdate: "agent_message_chunk", messageId: "media-1", content: { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" } },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "media-1",
        content: { type: "resource_link", name: "Report", uri: "https://example.com/report", mimeType: "text/html" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "media-1",
        content: { type: "resource", resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# Notes" } },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "media-1",
        content: { type: "resource", resource: { uri: "file:///archive.bin", mimeType: "application/octet-stream", blob: "AAE=" } },
      },
    ])

    expect(messages[0]?.blocks?.map((block) => block.type)).toEqual([
      "text", "image", "audio", "resource_link", "resource", "resource",
    ])
    expect(messages[0]?.content).toContain("[Audio: audio/wav]")
    expect(messages[0]?.blocks?.[1]).toMatchObject({ data: "aW1hZ2U=", mimeType: "image/png" })
  })

  it("preserves full tool content, locations, metadata, and streamed terminal output", () => {
    const messages = normalizeCodexAcpUpdates([
      {
        sessionUpdate: "tool_call",
        toolCallId: "terminal-1",
        title: "Run checks",
        kind: "execute",
        status: "in_progress",
        content: [
          { type: "terminal", terminalId: "terminal-1" },
          { type: "diff", path: "/workspace/a.ts", oldText: "old", newText: "new" },
          { type: "content", content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } },
        ],
        locations: [{ path: "/workspace/a.ts", line: 7 }],
        rawInput: { command: "pnpm test" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "terminal-1",
        _meta: { terminal_output_delta: { data: "first\n", terminal_id: "terminal-1" } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "terminal-1",
        status: "completed",
        _meta: { terminal_output_delta: { data: "second", terminal_id: "terminal-1" } },
      },
    ])

    expect(messages[0]?.toolCall).toMatchObject({
      content: [
        { type: "terminal", terminalId: "terminal-1" },
        { type: "diff", path: "/workspace/a.ts", oldText: "old", newText: "new" },
        { type: "content", content: { type: "image", mimeType: "image/png" } },
      ],
      locations: [{ path: "/workspace/a.ts", line: 7 }],
      rawOutput: { formatted_output: "first\nsecond" },
    })
  })

  it("handles every non-content session update and typed Codex failures", () => {
    const messages = normalizeCodexAcpUpdates([
      { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/review", description: "Review changes" }] },
      { sessionUpdate: "current_mode_update", currentModeId: "agent" },
      { sessionUpdate: "config_option_update", configOptions: [] },
      { sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: 0.01, currency: "USD" } },
      { sessionUpdate: "session_info_update", title: "ACP audit", updatedAt: "2026-08-13T00:00:00.000Z" },
      {
        sessionUpdate: "session_info_update",
        _meta: {
          jetbrains: {
            air: {
              sessionFailure: {
                id: "turn-1:error",
                phase: "active",
                category: "provider_error",
                safeMessage: "The provider failed.",
                retryable: true,
                revision: 1,
                turnId: "turn-1",
              },
            },
          },
        },
      },
    ])

    expect(messages.filter((message) => message.kind === "SESSION_UPDATE")).toHaveLength(5)
    expect(messages.at(-1)).toMatchObject({
      content: "The provider failed.",
      itemId: "turn-1:error",
      kind: "ERROR",
      status: "FAILED",
      turnId: "turn-1",
    })
  })

  it("maps ACP multi-select and validation metadata for the frontend form", () => {
    const payload = codexAcpElicitationPayload({
      mode: "form",
      sessionId: "session-1",
      message: "Configure the run",
      requestedSchema: {
        type: "object",
        required: ["targets"],
        properties: {
          targets: {
            type: "array",
            title: "Targets",
            minItems: 1,
            maxItems: 2,
            items: { type: "string", enum: ["web", "api", "worker"] },
          },
          retries: { type: "integer", title: "Retries", minimum: 0, maximum: 5, default: 2 },
        },
      },
    })

    expect(payload).toMatchObject({
      questions: [
        {
          id: "targets",
          multiple: true,
          required: true,
          minimumSelections: 1,
          maximumSelections: 2,
          options: [{ value: "web" }, { value: "api" }, { value: "worker" }],
        },
        { id: "retries", inputType: "number", defaultValue: 2, minimum: 0, maximum: 5, required: false },
      ],
    })
  })
})

function messageChunk(
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
  messageId: string,
  text: string,
): SessionUpdate {
  return { sessionUpdate, messageId, content: { type: "text", text } }
}
