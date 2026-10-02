import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startAssistantFollowUpMonitor, stopAssistantFollowUpMonitor } from "./assistant-follow-up-monitor.server"
import type { ProviderSocketEvent } from "./socket.server"

const f = vi.hoisted(() => ({ process: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }))
vi.mock("./assistant.service", () => ({ processAssistantFollowUps: (...args: unknown[]) => f.process(...args) }))
vi.mock("./socket.server", () => ({ onProviderEvent: (...args: unknown[]) => f.subscribe(...args) }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  f.process.mockResolvedValue(undefined)
  f.subscribe.mockReturnValue(f.unsubscribe)
})
afterEach(() => { stopAssistantFollowUpMonitor(); vi.useRealTimers() })

describe("server-side agent wake-ups", () => {
  it("reconciles on startup, responds to run events, polls without sockets, and stops cleanly", async () => {
    startAssistantFollowUpMonitor()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.process).toHaveBeenCalledTimes(1)
    startAssistantFollowUpMonitor()
    expect(f.subscribe).toHaveBeenCalledTimes(1)
    const event = f.subscribe.mock.calls[0][0] as (event: ProviderSocketEvent) => void
    event({ type: "assistant.updated", payload: {} })
    await vi.advanceTimersByTimeAsync(250)
    expect(f.process).toHaveBeenCalledTimes(1)
    event({ type: "run.status", payload: { status: "COMPLETED", runId: "run" }, threadId: "chat" })
    await vi.advanceTimersByTimeAsync(250)
    expect(f.process).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.process).toHaveBeenCalledTimes(3)
    stopAssistantFollowUpMonitor()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.process).toHaveBeenCalledTimes(3)
  })

  it("serializes overlapping checks and reconciles an event arriving during a poll", async () => {
    let release!: () => void
    f.process.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    startAssistantFollowUpMonitor()
    const event = f.subscribe.mock.calls[0][0] as (event: ProviderSocketEvent) => void
    event({ type: "run.status", payload: {} })
    await vi.advanceTimersByTimeAsync(250)
    expect(f.process).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.process).toHaveBeenCalledTimes(2)
  })
})
