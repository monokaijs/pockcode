import { beforeEach, describe, expect, it, vi } from "vitest"
import { listAccounts, readAccountLimits } from "./accounts.service"
import { isQuotaExhausted, remainingAccountCapacity, selectFailoverAccount } from "./account-failover.server"

vi.mock("./accounts.service", () => ({ listAccounts: vi.fn(), readAccountLimits: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

describe("quota recovery", () => {
  it("only recognizes exhausted quota, not authentication, network, or temporary throttling", () => {
    for (const message of ["usageLimitExceeded", "You've hit your usage limit", "Quota exhausted", "insufficient_quota", "Weekly limit reached"]) expect(isQuotaExhausted(new Error(message))).toBe(true)
    for (const message of ["429: rate limit exceeded, retry in 1 second", "Unauthorized", "ECONNRESET", "Server overloaded", "contextWindowExceeded"]) expect(isQuotaExhausted(new Error(message))).toBe(false)
  })

  it("uses the most constrained active window and treats expired windows as reset", () => {
    const now = 2_000_000_000_000
    expect(remainingAccountCapacity({ rateLimits: { primary: { usedPercent: 5 }, secondary: { usedPercent: 100, resetsAt: now / 1000 + 60 } } }, now)).toBe(0)
    expect(remainingAccountCapacity({ rateLimits: { primary: { usedPercent: 100, resetsAt: now / 1000 - 1 }, secondary: { usedPercent: 40 } } }, now)).toBe(60)
    expect(remainingAccountCapacity({ rateLimits: { primary: { usedPercent: 100, resetsAt: now - 1 } } }, now)).toBe(100)
    expect(remainingAccountCapacity({})).toBeNull()
    expect(remainingAccountCapacity({ rateLimits: { primary: { usedPercent: NaN } } })).toBeNull()
  })

  it("selects verified capacity, excluding exhausted, disconnected, incompatible and already attempted accounts", async () => {
    vi.mocked(listAccounts).mockResolvedValue([
      { id: "source", providerId: "codex", status: "CONNECTED" },
      { id: "small", providerId: "codex", status: "CONNECTED" },
      { id: "best", providerId: "codex", status: "CONNECTED" },
      { id: "unknown", providerId: "codex", status: "CONNECTED" },
      { id: "empty", providerId: "codex", status: "CONNECTED" },
      { id: "offline", providerId: "codex", status: "DISCONNECTED" },
      { id: "other", providerId: "claude", status: "CONNECTED" },
    ] as Awaited<ReturnType<typeof listAccounts>>)
    vi.mocked(readAccountLimits).mockImplementation(async (id) => {
      if (id === "unknown") throw new Error("Offline")
      return { rateLimits: { primary: { usedPercent: id === "best" ? 10 : id === "small" ? 70 : 100 } } }
    })
    expect(await selectFailoverAccount("codex", new Set(["source"]))).toBe("best")
    expect(vi.mocked(readAccountLimits).mock.calls.flat()).not.toContain("offline")
    expect(await selectFailoverAccount("codex", new Set(["source", "best", "small"]))).toBeNull()
  })
})
