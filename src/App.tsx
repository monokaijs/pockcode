import { AppProviders } from "@/components/app-providers"
import { SessionShell } from "@/components/session/session-shell"

export default function App() {
  return (
    <AppProviders>
      <SessionShell />
    </AppProviders>
  )
}
