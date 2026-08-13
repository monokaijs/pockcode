import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { MessageContentBlocks, StructuredToolCallContent } from "./chat-content-blocks"

describe("ACP structured content rendering", () => {
  it("renders text, image, audio, links, and embedded resources", () => {
    const markup = renderToStaticMarkup(
      <MessageContentBlocks
        blocks={[
          { type: "text", text: "**Rendered text**" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
          { type: "resource_link", name: "Docs", uri: "https://example.com/docs" },
          { type: "resource", resource: { type: "text", uri: "file:///notes.md", mimeType: "text/markdown", text: "# Notes" } },
          { type: "resource", resource: { type: "blob", uri: "file:///data.bin", mimeType: "application/octet-stream", blob: "AAE=" } },
        ]}
      />,
    )

    expect(markup).toContain("<strong>Rendered text</strong>")
    expect(markup).toContain('src="data:image/png;base64,aW1hZ2U="')
    expect(markup).toContain("<audio")
    expect(markup).toContain("https://example.com/docs")
    expect(markup).toContain("Notes")
    expect(markup).toContain("Download file:///data.bin")
  })

  it("renders complete diffs, terminal references, locations, and raw values", () => {
    const markup = renderToStaticMarkup(
      <StructuredToolCallContent
        toolCall={{
          content: [
            { type: "diff", path: "/workspace/a.ts", oldText: "old", newText: "new" },
            { type: "terminal", terminalId: "terminal-1" },
          ],
          locations: [{ path: "/workspace/a.ts", line: 8 }],
          rawInput: { command: "pnpm test" },
          rawOutput: { exitCode: 0 },
          title: "Run tests",
          toolCallId: "tool-1",
        }}
      />,
    )

    expect(markup).toContain("/workspace/a.ts:8")
    expect(markup).toContain("Before")
    expect(markup).toContain("old")
    expect(markup).toContain("After")
    expect(markup).toContain("new")
    expect(markup).toContain("Terminal terminal-1")
    expect(markup).toContain("pnpm test")
    expect(markup).toContain("exitCode")
  })
})
