import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ChatComposer } from "./chat-composer"
import { ChatPaneStateContext } from "./chat-pane-context"
import type { ChatPaneState } from "./chat-pane-state"

function render(overrides: Partial<ChatPaneState>) {
  const pane = {
    attachments: [], queuedMessages: [], slashMatches: [], draft: "", running: false,
    canSend: false, showStopAction: false, ...overrides,
  } as unknown as ChatPaneState
  return renderToStaticMarkup(<ChatPaneStateContext value={pane}><ChatComposer /></ChatPaneStateContext>)
}

describe("chat composer delivery controls", () => {
  it("keeps Stop available alongside queue and steering when there is a draft", () => {
    const markup = render({ running: true, draft: "Follow up", canSend: true })
    expect(markup).toContain('aria-label="Stop chat"')
    expect(markup).toContain('aria-label="Queue message"')
    expect(markup).toContain('aria-label="Steer message"')
  })

  it("shows a single Stop action when running without a draft", () => {
    const markup = render({ running: true, showStopAction: true })
    expect(markup.match(/aria-label="Stop chat"/g)).toHaveLength(1)
    expect(markup).not.toContain('aria-label="Queue message"')
    expect(markup).not.toContain('aria-label="Steer message"')
  })

  it("disables Stop while an interrupt request is pending", () => {
    expect(render({ running: true, showStopAction: true, stopping: true })).toMatch(/aria-label="Stop chat"[^>]*disabled/)
  })

  it("shows the normal send action when idle", () => {
    const markup = render({ draft: "Hello", canSend: true })
    expect(markup).toContain('aria-label="Send message"')
    expect(markup).not.toContain('aria-label="Stop chat"')
    expect(markup).not.toContain('aria-label="Steer message"')
  })
})
