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
})

function messageChunk(
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
  messageId: string,
  text: string,
): SessionUpdate {
  return { sessionUpdate, messageId, content: { type: "text", text } }
}
