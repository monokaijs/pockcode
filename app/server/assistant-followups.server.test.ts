import { beforeEach, describe, expect, it, vi } from "vitest"
import { readAssistantWatchedRun } from "./assistant-followups.server"

const f = vi.hoisted(() => ({ find: vi.fn(), messages: vi.fn(), executing: vi.fn(), chatExecuting: vi.fn(), refresh: vi.fn() }))
vi.mock("./database.server", () => ({ ensureDatabase: vi.fn() }))
vi.mock("./prisma.server", () => ({ prisma: { chatRun: { findFirst: (...args: unknown[]) => f.find(...args) } } }))
vi.mock("./chats.service", () => ({ listMessages: (...args: unknown[]) => f.messages(...args), isChatRunExecuting: (...args: unknown[]) => f.executing(...args), isChatExecuting: (...args: unknown[]) => f.chatExecuting(...args), refreshChatStatusesForWorkspaces: (...args: unknown[]) => f.refresh(...args) }))

beforeEach(() => {
  vi.resetAllMocks()
  f.find.mockResolvedValue({ id: "original-run", status: "COMPLETED", externalTurnId: "original-turn", error: null, chat: { title: "Fix tests" } })
  f.messages.mockResolvedValue({ data: [] })
  f.executing.mockReturnValue(false)
  f.chatExecuting.mockReturnValue(false)
})

describe("exact coding run observations", () => {
  it("does not reconcile a queued run behind another live turn in the same chat", async () => {
    f.find.mockResolvedValue({ id: "queued-run", status: "QUEUED", createdAt: new Date(Date.now() - 180_000), error: null, chat: { title: "Fix tests", workingDirectory: "/project" } })
    f.chatExecuting.mockReturnValue(true)
    expect(await readAssistantWatchedRun("chat", "queued-run")).toMatchObject({ settled: false, status: "QUEUED" })
    expect(f.refresh).not.toHaveBeenCalled()
  })
  it("reconciles a stale run after restart without requiring a browser workspace subscription", async () => {
    f.find.mockResolvedValueOnce({ id: "original-run", status: "RUNNING", startedAt: new Date(Date.now() - 180_000), externalTurnId: "original-turn", error: null, chat: { title: "Fix tests", workingDirectory: "/project" } })
      .mockResolvedValueOnce({ id: "original-run", status: "CANCELLED", externalTurnId: "original-turn", error: null, chat: { title: "Fix tests", workingDirectory: "/project" } })
    expect(await readAssistantWatchedRun("chat", "original-run")).toMatchObject({ settled: true, status: "CANCELLED" })
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith(["/project"])
  })
  it("queries the specified run in its chat and excludes later turns and reasoning from its report", async () => {
    f.messages.mockResolvedValue({ data: [
      { role: "ASSISTANT", kind: "CHAT", turnId: "original-turn", content: "Fixed the tests." },
      { role: "ASSISTANT", kind: "CHAT", runId: "original-run", content: "All checks passed." },
      { role: "ASSISTANT", kind: "THINKING", turnId: "original-turn", content: "Private reasoning." },
      { role: "USER", kind: "CHAT", turnId: "original-turn", content: "User instructions." },
      { role: "ASSISTANT", kind: "CHAT", turnId: "later-turn", content: "An unrelated later task." },
    ] })
    expect(await readAssistantWatchedRun("chat", "original-run")).toMatchObject({ settled: true, status: "COMPLETED", messages: ["Fixed the tests.", "All checks passed."] })
    expect(f.find).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: "chat", id: "original-run" } }))
  })

  it("does not treat a transient failure during live account recovery as a final result", async () => {
    f.find.mockResolvedValue({ id: "original-run", status: "FAILED", externalTurnId: "original-turn", error: "Quota exhausted", chat: { title: "Fix tests" } })
    f.executing.mockReturnValue(true)
    expect(await readAssistantWatchedRun("chat", "original-run")).toMatchObject({ settled: false, status: "FAILED", messages: [] })
    expect(f.messages).not.toHaveBeenCalled()
  })

  it("recognizes final failures and cancellations and keeps registration independent of history retrieval", async () => {
    for (const status of ["FAILED", "CANCELLED"]) {
      f.find.mockResolvedValue({ id: "original-run", status, error: "Stopped", chat: { title: "Fix tests" } })
      expect(await readAssistantWatchedRun("chat", "original-run", false)).toMatchObject({ settled: true, status, error: "Stopped" })
    }
    expect(f.messages).not.toHaveBeenCalled()
    f.find.mockResolvedValue(null)
    expect(await readAssistantWatchedRun("wrong-chat", "original-run")).toBeNull()
  })
})
