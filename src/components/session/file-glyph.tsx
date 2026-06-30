import { FileText, HardDrive } from "lucide-react"
import type { FileNode } from "@/types/session"
import { cn } from "@/lib/utils"

export function FileGlyph({ icon }: { icon?: FileNode["icon"] }) {
  const className = "size-4 shrink-0"
  if (icon === "shell") return <span className="w-4 shrink-0 text-center text-sm font-bold text-success">$</span>
  if (icon === "js") return <span className="w-4 shrink-0 text-center text-[11px] font-bold text-ide-file-yellow">JS</span>
  if (icon === "json") return <span className="w-4 shrink-0 text-center text-sm font-bold text-ide-file-yellow">{"{}"}</span>
  if (icon === "make") return <span className="w-4 shrink-0 text-center text-sm font-bold text-warning">M</span>
  if (icon === "docker") return <HardDrive className={cn(className, "text-muted-foreground")} />
  if (icon === "info") return <span className="w-4 shrink-0 text-center text-sm text-ide-file-blue">i</span>
  return <FileText className={cn(className, "text-muted-foreground")} />
}
