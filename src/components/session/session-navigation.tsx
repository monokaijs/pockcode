import { ChartNoAxesColumn, Clock3, FolderClosed, House, LogOut, PanelsTopLeft, Settings2, UserRound } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ProviderMark } from "@/components/session/provider-icons"
import type { SessionShellState } from "@/components/session/session-shell"
import { cn } from "@/lib/utils"

const destinations = [
  { id: "home", label: "Home", icon: House },
  { id: "tasks", label: "Tasks board", icon: PanelsTopLeft },
  { id: "scheduled", label: "Scheduled", icon: Clock3 },
  { id: "projects", label: "Projects", icon: FolderClosed },
] as const

export function SessionNavigation({ shell }: { shell: SessionShellState }) {
  const initials = shell.userName.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "U"

  return (
    <nav aria-label="Main navigation" className="session-navigation flex min-h-0 flex-col items-center gap-2 border-r border-sidebar-border px-1.5">
      {destinations.map(({ id, label, icon: Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-lg"
              aria-current={shell.navigationView === id ? "page" : undefined}
              aria-label={label}
              className={cn("grid size-9 shrink-0 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground", shell.navigationView === id && "bg-sidebar-accent text-foreground")}
              type="button"
              onClick={() => shell.selectNavigationView(id)}
            />
          }>
            <Icon className="size-[18px]" strokeWidth={1.6} />
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={10}>{label}</TooltipContent>
        </Tooltip>
      ))}

      <div className="mt-auto pt-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="User menu"
            className="grid size-6 place-items-center rounded-full bg-emerald-500 text-[10px] font-medium text-white outline-offset-4 transition-opacity hover:opacity-85"
          >
            {initials}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 p-1.5" side="right" sideOffset={12}>
            <DropdownMenuItem className="gap-2.5 px-2 py-2.5" onClick={() => shell.selectNavigationView("settings")}>
              <UserRound className="size-4 text-muted-foreground" />
              <span className="truncate font-medium">{shell.userName}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2.5 px-2 py-2" onClick={() => shell.selectNavigationView("usage")}>
              <ChartNoAxesColumn className="size-4 text-muted-foreground" />Usage
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5 px-2 py-2" onClick={() => shell.selectManagementView("providers")}>
              <ProviderMark icon="codex" className="size-4 text-muted-foreground" />Providers
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5 px-2 py-2" onClick={() => shell.selectNavigationView("settings")}>
              <Settings2 className="size-4 text-muted-foreground" />Settings
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5 px-2 py-2" onClick={() => {
              const form = document.createElement("form")
              form.method = "POST"
              form.action = "/auth/logout"
              document.body.append(form)
              form.submit()
            }}>
              <LogOut className="size-4 text-muted-foreground" />Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  )
}
