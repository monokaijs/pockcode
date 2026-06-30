import { useMemo, useRef } from "react"

export function useAppendAnimationIds(ids: string[], scopeKey: string | null, enabled = true): Set<string> {
  const stateRef = useRef<{ scopeKey: string | null; seenIds: Set<string> }>({
    scopeKey: null,
    seenIds: new Set(),
  })
  const idsKey = ids.join("\u0001")

  return useMemo(() => {
    if (!enabled) {
      return new Set<string>()
    }

    const state = stateRef.current
    if (state.scopeKey !== scopeKey) {
      stateRef.current = { scopeKey, seenIds: new Set(ids) }
      return new Set<string>()
    }

    const appendedIds = new Set(ids.filter((id) => !state.seenIds.has(id)))
    for (const id of ids) {
      state.seenIds.add(id)
    }
    return appendedIds
  }, [enabled, idsKey, scopeKey])
}
