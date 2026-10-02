import { describe, expect, it } from "vitest"
import { assistantAttachmentContext, assistantVisualAttachments, readAssistantAttachments } from "./assistant-attachments.server"
import type { AssistantMessage } from "../types/assistant"

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const image = () => readAssistantAttachments([{ id: "image", name: "picture.png", dataUrl: png, size: 999, kind: "file" }])[0]
const file = (content: string, mime = "text/plain") => ({ id: "file", name: "notes.txt", dataUrl: `data:${mime};base64,${Buffer.from(content).toString("base64")}` })

describe("assistant attachments", () => {
  it("validates uploaded bytes and derives image kind, size, and MIME type", () => {
    expect(image()).toMatchObject({ kind: "image", mimeType: "image/png", size: Buffer.from(png.split(",")[1], "base64").length })
    expect(readAssistantAttachments(undefined)).toEqual([])
    expect(() => readAssistantAttachments([{ id: "image", name: "picture.png", dataUrl: png.replace("image/png", "image/jpeg") }])).toThrow("valid")
    expect(() => readAssistantAttachments([{ id: "file", name: "notes", dataUrl: "https://example.com/file" }])).toThrow("Invalid attachment")
    expect(() => readAssistantAttachments([file("notes"), file("notes")])).toThrow("Duplicate")
  })

  it("rejects excessive count, per-file size, and total bytes", () => {
    expect(() => readAssistantAttachments(Array.from({ length: 11 }, (_, id) => ({ ...file("notes"), id: String(id) })))).toThrow("10 files")
    const large = { ...file(""), dataUrl: "data:text/plain;base64," + Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }
    expect(() => readAssistantAttachments([large])).toThrow("5 MB")
    const chunk = "data:text/plain;base64," + Buffer.alloc(4 * 1024 * 1024).toString("base64")
    expect(() => readAssistantAttachments([1, 2, 3].map((id) => ({ id: String(id), name: "file", dataUrl: chunk })))).toThrow("10 MB")
  })

  it("passes text contents to the model without image base64, and identifies unreadable binary files", () => {
    const parsed = readAssistantAttachments([file("Project notes"), image()])
    expect(assistantAttachmentContext(parsed)[0]).toMatchObject({ content: "Project notes", truncated: false })
    expect(assistantAttachmentContext(parsed)[1]).not.toHaveProperty("dataUrl")
    expect(assistantAttachmentContext(readAssistantAttachments([file("\u0000\u0001", "application/octet-stream")]))[0]).toHaveProperty("note")
    expect(assistantAttachmentContext(readAssistantAttachments([file("a".repeat(60_001))]))[0]).toMatchObject({ content: "a".repeat(60_000), truncated: true })
    const budget = { remaining: 5 }
    expect(assistantAttachmentContext(readAssistantAttachments([file("notes")]), budget)[0]).toMatchObject({ content: "notes", truncated: false })
    expect(assistantAttachmentContext(readAssistantAttachments([file("more notes")]), budget)[0]).toMatchObject({ content: "", truncated: true })
  })

  it("prioritizes current images and retains recent images for follow-up questions within the limits", () => {
    const history: AssistantMessage[] = Array.from({ length: 11 }, (_, index) => ({ id: `message-${index}`, role: "user", content: "Image", createdAt: new Date().toISOString(), attachments: [{ ...image(), id: `image-${index}`, size: 1024 * 1024 }] }))
    const current = { ...image(), id: "current", size: 2 * 1024 * 1024 }
    const selected = assistantVisualAttachments(history, [current])
    expect(selected.map(({ id }) => id)).toEqual(["current", "image-10", "image-9", "image-8", "image-7", "image-6", "image-5", "image-4", "image-3"])
    expect(assistantVisualAttachments([], [current, current])).toHaveLength(1)
  })
})
