import { afterEach, describe, expect, it, vi } from "vitest"
import { CodexAcpRuntime } from "./codex-acp.server"
import type { ProviderRuntimeMessageInput, ProviderRuntimeSteerInput } from "./types.server"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
const runtimes: CodexAcpRuntime[] = []
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.shutdown()))

// Fake the SDK connection boundary while exercising session setup and the public controls.
function fixture() {
  const prompt = deferred<{ stopReason: string }>()
  const connection = {
    loadSession: vi.fn(async () => ({})),
    setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
    prompt: vi.fn(() => prompt.promise),
    cancel: vi.fn(async () => undefined),
    extMethod: vi.fn(async () => ({ outcome: "injected" })),
  }
  const runtime = new CodexAcpRuntime({ accountId: "account", codexHome: "/fake", environment: {} })
  Object.assign(runtime, { initializePromise: Promise.resolve(), connection })
  runtimes.push(runtime)
  const controller = new AbortController()
  const onMessage = vi.fn()
  const input: ProviderRuntimeMessageInput = {
    collaborationMode: "default", content: "First", permissionMode: "default", threadId: "session", workingDirectory: "/fake",
    onMessage, signal: controller.signal,
  }
  const steerInput: ProviderRuntimeSteerInput = { content: "Follow up", threadId: "session", turnId: "turn", workingDirectory: "/fake" }
  return { runtime, connection, prompt, input, controller, onMessage, steerInput }
}

describe("ACP controls", () => {
  it("does not send a prompt cancelled during session configuration", async () => {
    const f = fixture()
    const config = deferred<{ configOptions: [] }>()
    f.connection.setSessionConfigOption.mockImplementationOnce(() => config.promise)
    const result = f.runtime.sendMessage(f.input)
    const rejection = expect(result).rejects.toThrow()
    await vi.waitFor(() => expect(f.connection.setSessionConfigOption).toHaveBeenCalledOnce())
    f.controller.abort()
    config.resolve({ configOptions: [] })
    await rejection
    expect(f.connection.prompt).not.toHaveBeenCalled()
    expect(f.connection.cancel).toHaveBeenCalledWith({ sessionId: "session" })
  })

  it("cancels an active prompt through ACP and detaches cancellation after it ends", async () => {
    const f = fixture()
    const result = f.runtime.sendMessage(f.input)
    await vi.waitFor(() => expect(f.connection.prompt).toHaveBeenCalledOnce())
    f.controller.abort()
    await vi.waitFor(() => expect(f.connection.cancel).toHaveBeenCalledOnce())
    f.prompt.resolve({ stopReason: "cancelled" })
    await result
    expect(f.connection.cancel).toHaveBeenCalledWith({ sessionId: "session" })
  })

  it("surfaces steering's failed outcome without failing the original prompt", async () => {
    const f = fixture()
    f.connection.extMethod.mockResolvedValue({ outcome: "failed" })
    const result = f.runtime.sendMessage(f.input)
    await vi.waitFor(() => expect(f.connection.prompt).toHaveBeenCalledOnce())
    await expect(f.runtime.steer(f.steerInput)).rejects.toThrow("could not apply")
    f.prompt.resolve({ stopReason: "end_turn" })
    await expect(result).resolves.toMatchObject({ threadId: "session" })
  })

  it("keeps a fallback steering turn attached to the original run until it completes", async () => {
    const f = fixture()
    const completion = deferred<void>()
    const accepted = deferred<{ outcome: string }>()
    f.connection.extMethod.mockImplementation(() => accepted.promise)
    const waitForSteeringTurn = vi.fn(() => completion.promise)
    const result = f.runtime.sendMessage({ ...f.input, waitForSteeringTurn })
    const settled = vi.fn()
    void result.then(settled)
    await vi.waitFor(() => expect(f.connection.prompt).toHaveBeenCalledOnce())
    const steered = f.runtime.steer(f.steerInput)
    f.prompt.resolve({ stopReason: "end_turn" })
    accepted.resolve({ outcome: "startedNewTurn" })
    await steered
    expect(waitForSteeringTurn).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    completion.resolve()
    await result
    expect(settled).toHaveBeenCalledOnce()
  })

  it("retains the original run while a steering request is in flight", async () => {
    const f = fixture()
    const accepted = deferred<{ outcome: string }>()
    f.connection.extMethod.mockImplementation(() => accepted.promise)
    const result = f.runtime.sendMessage(f.input)
    const settled = vi.fn()
    void result.then(settled)
    await vi.waitFor(() => expect(f.connection.prompt).toHaveBeenCalledOnce())
    const steered = f.runtime.steer(f.steerInput)
    f.prompt.resolve({ stopReason: "end_turn" })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    accepted.resolve({ outcome: "injected" })
    await steered
    await result
  })

  it("rejects a steer after the live prompt has settled", async () => {
    const f = fixture()
    const result = f.runtime.sendMessage(f.input)
    await vi.waitFor(() => expect(f.connection.prompt).toHaveBeenCalledOnce())
    f.prompt.resolve({ stopReason: "end_turn" })
    await result
    await expect(f.runtime.steer(f.steerInput)).rejects.toThrow("no live Codex prompt")
    expect(f.connection.extMethod).not.toHaveBeenCalled()
  })

  it("does not report successful cancellation for an unknown session", async () => {
    const f = fixture()
    await expect(f.runtime.interrupt("unknown")).rejects.toThrow("not connected")
    expect(f.connection.cancel).not.toHaveBeenCalled()
  })
})
