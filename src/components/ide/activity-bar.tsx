import { Files, GitBranch } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ActivityId, Project } from "@/types/ide"
import { Button } from "@/components/ui/button"

type ActivityItem = {
  id: ActivityId
  label: string
  icon: typeof Files
}

const activityItems: ActivityItem[] = [
  { id: "files", label: "Explorer", icon: Files },
  { id: "git", label: "Source Control", icon: GitBranch },
]

export function ActivityBar({
  activeActivity,
  project,
  onActivityChange,
}: {
  activeActivity: ActivityId
  project: Project
  onActivityChange: (activity: ActivityId) => void
}) {
  return (
    <aside className="flex h-full w-11 shrink-0 flex-col items-center border-r bg-background py-2">
      <div className="flex flex-1 flex-col gap-1">
        {activityItems.map((item) => {
          const Icon = item.icon
          const active = item.id === activeActivity
          return (
            <Button
              aria-label={item.label}
              className={cn(
                "relative grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                active && "bg-muted text-foreground",
              )}
              key={item.id}
              title={item.label}
              type="button"
              onClick={() => onActivityChange(item.id)}
            >
              <Icon className="size-4.5" />
              {item.id === "git" && project.gitChanges.length ? (
                <span className="absolute right-1 top-1 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-3 text-primary-foreground">
                  {project.gitChanges.length}
                </span>
              ) : null}
            </Button>
          )
        })}
      </div>
      <div className="mb-1 grid size-7 place-items-center rounded-full border bg-background text-[10px] font-semibold text-muted-foreground">
        PC
      </div>
    </aside>
  )
}
