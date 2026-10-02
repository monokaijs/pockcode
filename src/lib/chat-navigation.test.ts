import { describe, expect, it } from "vitest"
import type { ChatMessageResponse } from "@/lib/api-client"
import { chatNavigationItems } from "./chat-navigation"

function message(id: string, overrides: Partial<ChatMessageResponse>): ChatMessageResponse {
  return { id, chatId: "chat", content: "", createdAt: "2026-10-02T00:00:00Z", kind: "CHAT", role: "ASSISTANT", sequence: 1, status: "COMPLETED", ...overrides }
}

describe("chat navigation", () => {
  it("pairs prompts with their final response, excluding tool output and queued prompts", () => {
    const items = chatNavigationItems([
      message("before", { content: "An earlier response" }),
      message("first", { role: "USER", content: "**Fix** the [layout](https://example.com)." }),
      message("tool", { kind: "COMMAND_EXECUTION", content: "Large tool output" }),
      message("thinking", { content: "Thinking", metadata: { acpMessagePhase: "commentary" } }),
      message("reply", { content: "# Fixed\n- Kept the aspect ratio." }),
      message("second", { role: "USER", content: "Add navigation" }),
      message("queued", { role: "USER", status: "PENDING", runId: "next", content: "Queued work" }),
      message("stream", { status: "STREAMING", content: "Adding it" }),
    ])

    expect(items).toEqual([
      { id: "first", prompt: "Fix the layout.", response: "Fixed Kept the aspect ratio." },
      { id: "second", prompt: "Add navigation", response: "Adding it" },
    ])
  })

  it("previews structured text and attachments, and leaves unanswered turns empty", () => {
    expect(chatNavigationItems([
      message("text", { role: "USER", blocks: [{ type: "text", text: "Review this" }, { type: "resource_link", name: "notes.md", uri: "file:///notes.md" }] }),
      message("plan", { kind: "PLAN", content: "1. Review the notes" }),
      message("image", { role: "USER", blocks: [{ type: "image", data: "AA==", mimeType: "image/png" }] }),
    ])).toEqual([
      { id: "text", prompt: "Review this notes.md", response: "1. Review the notes" },
      { id: "image", prompt: "Attached content", response: "" },
    ])
  })

  it("skips imported context updates and displays the question from encoded replies", () => {
    expect(chatNavigationItems([
      message("context", { role: "USER", content: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }),
      message("prompt", { role: "USER", content: "Fix the pixels" }),
      message("environment", { role: "USER", content: "<environment_context>workspace metadata</environment_context>" }),
      message("reply", { content: "The fix is installed" }),
      message("answer", { role: "USER", content: '<send_user_message_question_reply> [{"question":"Please reopen LoL","answer":"Done"}] </send_user_message_question_reply>' }),
      message("verified", { content: "Fixed and verified" }),
    ])).toEqual([
      { id: "prompt", prompt: "Fix the pixels", response: "The fix is installed" },
      { id: "answer", prompt: "Please reopen LoL", response: "Fixed and verified" },
    ])
  })
})
