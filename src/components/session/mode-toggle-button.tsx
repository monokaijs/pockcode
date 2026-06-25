import { Code2, MessageSquare } from "lucide-react"
import type { MainMode } from "@/types/session"
import { Button } from "@/components/ui/button"

export function ModeToggleButton({ mode, onClick }: { mode: MainMode; onClick: () => void }) {
  const editorMode = mode === "editor"
  return (
    <Button
      aria-label={editorMode ? "Switch to chat" : "Switch to code"}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title={editorMode ? "Chat" : "Code"}
      type="button"
      onClick={onClick}
    >
      {editorMode ? <MessageSquare className="size-4" /> : <Code2 className="size-4" />}
    </Button>
  )
}
