import { describe, expect, it } from "vitest"
import {
  isToolMessage,
  isQueuedUserMessage,
  groupChatRenderEntries,
  matchingChatSlashCommands,
  parseChatSlashCommand,
  readChatAccountSwitchEvent,
  readUserInputQuestions,
  renderAssistantSegment,
  workDurationLabel,
} from "@/lib/session"
import type { ChatMessageResponse } from "@/lib/api-client"

describe("chat slash commands", () => {
  it("parses commands with arguments", () => {
    const parsed = parseChatSlashCommand("/review check untracked files")

    expect(parsed?.command.id).toBe("review")
    expect(parsed?.argument).toBe("check untracked files")
  })

  it("returns matching mandatory commands for palette filtering", () => {
    expect(matchingChatSlashCommands("/co").map((command) => command.id)).toContain("compact")
    expect(matchingChatSlashCommands("/plugins").map((command) => command.id)).toEqual(["plugins"])
  })

  it("ignores unknown commands", () => {
    expect(parseChatSlashCommand("/does-not-exist")).toBeNull()
  })
})

describe("chat account switch events", () => {
  it("reads valid switch progress payloads", () => {
    expect(readChatAccountSwitchEvent({
      chatId: "chat-1",
      fromAccountId: "account-old",
      phase: "hydratingTarget",
      toAccountId: "account-new",
    })).toEqual({
      chatId: "chat-1",
      error: null,
      fromAccountId: "account-old",
      phase: "hydratingTarget",
      toAccountId: "account-new",
    })
  })

  it("rejects unknown switch phases", () => {
    expect(readChatAccountSwitchEvent({
      chatId: "chat-1",
      phase: "halfway",
      toAccountId: "account-new",
    })).toBeNull()
  })
})

describe("tool message grouping", () => {
  it("treats new Codex parity message kinds as work activity", () => {
    const base = {
      chatId: "chat-1",
      completedAt: null,
      content: "Context compacted",
      createdAt: new Date(0).toISOString(),
      id: "message-1",
      itemId: null,
      metadata: null,
      rawPayload: null,
      requestId: null,
      role: "TOOL",
      runId: null,
      sequence: 1,
      status: "COMPLETED",
      turnId: null,
    } satisfies Omit<ChatMessageResponse, "kind">

    expect(isToolMessage({ ...base, kind: "COMPACTION" })).toBe(true)
    expect(isToolMessage({ ...base, kind: "REVIEW" })).toBe(true)
    expect(isToolMessage({ ...base, kind: "SUBAGENT_ACTIVITY" })).toBe(true)
    expect(isToolMessage({ ...base, kind: "WARNING" })).toBe(true)
  })

  it("renders Codex plan items as plan messages, not collapsed work activity", () => {
    const planMessage: ChatMessageResponse = {
      chatId: "chat-1",
      completedAt: new Date(1).toISOString(),
      content: "# Plan\n\n1. Inspect\n2. Implement",
      createdAt: new Date(0).toISOString(),
      id: "provider:chat-1:plan-1",
      itemId: "plan-1",
      kind: "PLAN",
      metadata: null,
      rawPayload: null,
      requestId: null,
      role: "ASSISTANT",
      runId: "run-1",
      sequence: 1,
      status: "COMPLETED",
      turnId: "turn-1",
    }

    expect(isToolMessage(planMessage)).toBe(false)
    expect(renderAssistantSegment([planMessage], null, false)).toEqual([{ type: "message", message: planMessage }])
  })

  it("keeps update-plan progress inside the surrounding work block", () => {
    const userMessage = chatMessage({
      content: "Implement this",
      createdAt: new Date(0).toISOString(),
      id: "user-1",
      role: "USER",
      sequence: 1,
    })
    const thinkingMessage = chatMessage({
      content: "I'll inspect the implementation first.",
      createdAt: new Date(1_000).toISOString(),
      id: "thinking-1",
      kind: "THINKING",
      role: "ASSISTANT",
      runId: "run-1",
      sequence: 2,
    })
    const planUpdateMessage = chatMessage({
      content: "",
      createdAt: new Date(2_000).toISOString(),
      id: "plan-1",
      kind: "PLAN",
      metadata: {
        planPresentation: "update",
        planSteps: [{ status: "inProgress", step: "Inspect implementation" }],
      },
      role: "ASSISTANT",
      runId: "run-1",
      sequence: 3,
    })
    const commandMessage = chatMessage({
      content: "- Ran `pwd`",
      createdAt: new Date(3_000).toISOString(),
      id: "command-1",
      kind: "COMMAND_EXECUTION",
      role: "TOOL",
      runId: "run-1",
      sequence: 4,
    })
    const finalMessage = chatMessage({
      content: "Done.",
      createdAt: new Date(4_000).toISOString(),
      id: "final-1",
      role: "ASSISTANT",
      runId: "run-1",
      sequence: 5,
    })

    expect(groupChatRenderEntries([
      userMessage,
      thinkingMessage,
      planUpdateMessage,
      commandMessage,
      finalMessage,
    ], false)).toEqual([
      { type: "message", message: userMessage },
      {
        type: "work",
        completedAt: commandMessage.completedAt,
        finished: true,
        id: "work:run-1",
        messages: [thinkingMessage, planUpdateMessage, commandMessage],
        startedAt: userMessage.createdAt,
      },
      { type: "message", message: finalMessage },
    ])
  })

  it("treats completed warning-only segments as finished work", () => {
    const userMessage = chatMessage({
      content: "Run something slow",
      createdAt: new Date(0).toISOString(),
      id: "user-1",
      role: "USER",
      sequence: 1,
    })
    const warningMessage = chatMessage({
      content: "Turn aborted",
      createdAt: new Date(14_285).toISOString(),
      id: "warning-1",
      kind: "WARNING",
      role: "TOOL",
      sequence: 2,
    })

    expect(renderAssistantSegment([warningMessage], userMessage, false)).toEqual([{
      type: "work",
      completedAt: warningMessage.completedAt,
      finished: true,
      id: "work:warning-1",
      messages: [warningMessage],
      startedAt: userMessage.createdAt,
    }])
  })

  it("uses the warning timestamp instead of now for aborted work duration", () => {
    const warningMessage = chatMessage({
      content: "Turn aborted",
      createdAt: new Date(14_285).toISOString(),
      id: "warning-1",
      kind: "WARNING",
      role: "TOOL",
      sequence: 1,
    })

    expect(workDurationLabel(
      [warningMessage],
      new Date(0).toISOString(),
      warningMessage.completedAt,
      true,
      1_000_000,
    )).toBe("14s")
  })
})

describe("queued messages", () => {
  it("detects confirmed and optimistic queued user messages", () => {
    expect(isQueuedUserMessage(chatMessage({
      id: "queued-1",
      role: "USER",
      runId: "run-queued",
      status: "PENDING",
    }))).toBe(true)

    expect(isQueuedUserMessage(chatMessage({
      id: "queued-optimistic",
      metadata: { delivery: "queue", optimistic: true },
      role: "USER",
      status: "PENDING",
    }))).toBe(true)

    expect(isQueuedUserMessage(chatMessage({
      id: "plain-optimistic",
      metadata: { optimistic: true },
      role: "USER",
      status: "PENDING",
    }))).toBe(false)
  })

  it("keeps active work running when queued messages are rendered separately", () => {
    const userMessage = chatMessage({
      content: "Start a long task",
      id: "user-1",
      role: "USER",
      sequence: 1,
    })
    const streamingMessage = chatMessage({
      content: "Writing files",
      id: "assistant-1",
      role: "ASSISTANT",
      sequence: 2,
      status: "STREAMING",
    })
    const queuedMessage = chatMessage({
      content: "Next task",
      id: "queued-1",
      role: "USER",
      runId: "run-queued",
      sequence: 3,
      status: "PENDING",
    })

    const transcriptMessages = [userMessage, streamingMessage, queuedMessage].filter((message) => !isQueuedUserMessage(message))

    expect(groupChatRenderEntries(transcriptMessages, true)).toEqual([
      { type: "message", message: userMessage },
      {
        type: "work",
        completedAt: streamingMessage.createdAt,
        finished: false,
        id: "work:assistant-1",
        messages: [streamingMessage],
        startedAt: userMessage.createdAt,
      },
    ])
  })
})

describe("user input prompts", () => {
  it("reads nested request_user_input questions", () => {
    expect(readUserInputQuestions({
      arguments: {
        questions: [{
          id: "choice",
          is_secret: true,
          options: ["Use defaults", { description: "Custom path", label: "Configure" }],
          question: "How should Codex continue?",
        }],
      },
    })).toEqual([{
      header: "",
      id: "choice",
      isSecret: true,
      options: [
        { description: "", label: "Use defaults" },
        { description: "Custom path", label: "Configure" },
      ],
      question: "How should Codex continue?",
    }])
  })

  it("falls back to a visible free-form prompt", () => {
    expect(readUserInputQuestions({ prompt: "Tell Codex what to do next." })).toEqual([{
      header: "",
      id: "answer",
      isSecret: false,
      options: [],
      question: "Tell Codex what to do next.",
    }])
  })
})

function chatMessage(overrides: Partial<ChatMessageResponse>): ChatMessageResponse {
  const createdAt = overrides.createdAt ?? new Date(0).toISOString()
  const status = overrides.status ?? "COMPLETED"
  return {
    chatId: "chat-1",
    completedAt: overrides.completedAt ?? (status === "COMPLETED" || status === "FAILED" ? createdAt : null),
    content: overrides.content ?? "",
    createdAt,
    id: overrides.id ?? "message-1",
    itemId: overrides.itemId ?? null,
    kind: overrides.kind ?? "CHAT",
    metadata: overrides.metadata ?? null,
    rawPayload: overrides.rawPayload ?? null,
    requestId: overrides.requestId ?? null,
    role: overrides.role ?? "ASSISTANT",
    runId: overrides.runId ?? null,
    sequence: overrides.sequence ?? 1,
    status,
    turnId: overrides.turnId ?? null,
  }
}
