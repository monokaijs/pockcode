import { createContext, useContext } from "react"

export const SessionTitlebarActionsContext = createContext<HTMLDivElement | null>(null)

export function useSessionTitlebarActions() {
  return useContext(SessionTitlebarActionsContext)
}
