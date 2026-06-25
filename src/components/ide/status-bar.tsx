import { Bot, CircleAlert, GitBranch, Radio, Terminal } from "lucide-react"
import { languageLabel } from "@/lib/ide"
import type { FileNode, Project, TerminalSession } from "@/types/ide"

export function StatusBar({
  activeFile,
  activeTerminal,
  cursorColumn,
  cursorLine,
  project,
}: {
  activeFile: FileNode | null
  activeTerminal: TerminalSession | null
  cursorColumn: number
  cursorLine: number
  project: Project
}) {
  return (
    <footer className="flex h-6 min-w-0 items-center gap-3 overflow-hidden border-t bg-primary px-2 text-[11px] font-medium text-primary-foreground">
      <span className="inline-flex shrink-0 items-center gap-1">
        <GitBranch className="size-3.5" /> {project.status.branch}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1">
        <CircleAlert className="size-3.5" /> {project.status.diagnostics.errors} errors, {project.status.diagnostics.warnings} warnings
      </span>
      <span className="hidden min-w-0 truncate md:inline">{project.path}</span>
      <span className="ml-auto hidden shrink-0 items-center gap-1 md:inline-flex">
        <Bot className="size-3.5" /> Agent ready
      </span>
      <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
        <Terminal className="size-3.5" /> {activeTerminal?.name ?? "terminal"}
      </span>
      <span className="shrink-0">Ln {cursorLine}, Col {cursorColumn}</span>
      <span className="hidden shrink-0 sm:inline">{activeFile ? languageLabel(activeFile.language) : "Plain Text"}</span>
      <span className="hidden shrink-0 lg:inline">{project.status.indentation}</span>
      <span className="hidden shrink-0 lg:inline">{project.status.encoding}</span>
      <span className="inline-flex shrink-0 items-center gap-1">
        <Radio className="size-3.5" /> Local
      </span>
    </footer>
  )
}
