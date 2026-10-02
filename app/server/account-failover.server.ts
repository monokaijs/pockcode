import type { ProviderLimitsResponse } from "../types/providers"
import { listAccounts, readAccountLimits } from "./accounts.service"

// Temporary throttling, auth errors, and network errors must not trigger migration.
export function isQuotaExhausted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /usage[_ ]?limit[_ ]?exceeded|quota[_ ]?(?:exhausted|exceeded)|insufficient_quota|(?:usage|weekly|daily) limit (?:reached|exceeded)|(?:you(?:'ve| have) (?:hit|reached)|exceeded) your (?:usage )?limit|out of (?:credits|quota)/i.test(message)
}

export function remainingAccountCapacity(limits: ProviderLimitsResponse, now = Date.now()): number | null {
  const snapshot = limits.rateLimits
  if (!snapshot) return null
  const windows = [snapshot.primary, snapshot.secondary].filter((window) => window != null)
  if (!windows.length) return snapshot.credits?.unlimited ? 100 : null
  if (windows.some((window) => !Number.isFinite(window.usedPercent))) return null
  return Math.min(...windows.map((window) => {
    const reset = window.resetsAt
    const resetMs = reset ? (reset > 1e12 ? reset : reset * 1000) : null
    return resetMs && resetMs <= now ? 100 : Math.max(0, Math.min(100, 100 - window.usedPercent))
  }))
}

export async function selectFailoverAccount(providerId: string, excludedIds: Set<string>): Promise<string | null> {
  const accounts = (await listAccounts()).filter((account) =>
    account.providerId === providerId && account.status === "CONNECTED" && !excludedIds.has(account.id),
  )
  const candidates = await Promise.all(accounts.map(async (account) => {
    const limits = await readAccountLimits(account.id).catch(() => null)
    return { id: account.id, capacity: limits ? remainingAccountCapacity(limits) : null }
  }))
  return candidates.filter((item) => item.capacity !== null && item.capacity > 0)
    .sort((a, b) => b.capacity! - a.capacity!)[0]?.id ?? null
}
