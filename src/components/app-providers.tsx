import type { ReactNode } from "react"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="pockcode-theme">
      <TooltipProvider>{children}</TooltipProvider>
    </ThemeProvider>
  )
}
