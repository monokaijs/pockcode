import { Code2, MessageSquare } from "lucide-react"
import type { MainMode } from "@/types/session"

export function ModeToggleButton({ mode, onClick }: { mode: MainMode; onClick: () => void }) {
  const editorMode = mode === "editor"
  return (
    <button
      aria-label={editorMode ? "Switch to chat" : "Switch to code"}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      title={editorMode ? "Chat" : "Code"}
      type="button"
      onClick={onClick}
    >
      {editorMode ? <MessageSquare className="size-4" /> : <Code2 className="size-4" />}
    </button>
  )
}
