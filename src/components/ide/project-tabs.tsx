import { Folder, Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Project } from "@/types/ide"

export function ProjectTabs({
  activeProjectId,
  projects,
  onProjectChange,
}: {
  activeProjectId: string
  projects: Project[]
  onProjectChange: (projectId: string) => void
}) {
  return (
    <header className="flex h-10 min-w-0 items-center border-b bg-[#0d0e11] px-2">
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto ide-scrollbar">
        {projects.map((project) => {
          const active = project.id === activeProjectId
          return (
            <button
              className={cn(
                "group flex h-7 min-w-0 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-left text-xs transition-colors",
                active
                  ? "bg-secondary text-secondary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              key={project.id}
              title={project.path}
              type="button"
              onClick={() => onProjectChange(project.id)}
            >
              <Folder className={cn("size-3.5 shrink-0", active && "text-primary")} />
              <span className="min-w-0 truncate font-medium">{project.name}</span>
              <X className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
            </button>
          )
        })}
        <button className="ml-1 size-7 shrink-0" size="icon-sm" title="Open workspace" variant="ghost">
          <Plus className="size-4" />
        </button>
      </div>
    </header>
  )
}
