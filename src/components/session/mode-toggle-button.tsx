import { Code2, MessageSquare } from "lucide-react"
import type { MainMode } from "@/types/session"

export function ModeToggleButton({ mode, onClick }: { mode: MainMode; onClick: () => void }) {
  const editorMode = mode === "editor"
  return (
    <button
      aria-label={editorMode ? "Switch to chat" : "Switch to code"}
      className="grid size-7 shrink-0 place-items-center rounded-md text-[#a0a0a0] hover:bg-[#252729] hover:text-[#d0d0d0]"
      title={editorMode ? "Chat" : "Code"}
      type="button"
      onClick={onClick}
    >
      {editorMode ? <MessageSquare className="size-4" /> : <Code2 className="size-4" />}
    </button>
  )
}
