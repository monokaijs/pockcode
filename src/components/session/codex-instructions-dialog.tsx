import { FileText, RefreshCw, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { apiClient } from "@/lib/api-client"
import { readError } from "@/lib/session"
import { cn } from "@/lib/utils"

export function CodexInstructionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const loadRequestIdRef = useRef(0)

  const loadInstructions = async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    setIsLoading(true)
    setNotice(null)
    try {
      const response = await apiClient.providers.codexInstructions()
      if (loadRequestIdRef.current !== requestId) {
        return
      }
      setDraft(response.instructions)
    } catch (error) {
      if (loadRequestIdRef.current !== requestId) {
        return
      }
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false)
      }
    }
  }

  useEffect(() => {
    if (open) {
      void loadInstructions()
    }
  }, [open])

  const saveInstructions = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const response = await apiClient.providers.updateCodexInstructions({ instructions: draft })
      setDraft(response.instructions)
      setNotice({ kind: "info", text: `Saved to ${response.paths.length} Codex homes` })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div className="safe-area-overlay fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close instructions" className="absolute inset-0 cursor-default" type="button" onClick={onClose} />
      <section className="relative grid max-h-[82vh] min-h-72 w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
          <FileText className="size-4 shrink-0 text-info" />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Instructions</h1>
          <button
            aria-label="Reload instructions"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
            type="button"
            onClick={() => void loadInstructions()}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </button>
          <button
            aria-label="Close instructions"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-auto p-3 ide-scrollbar">
          {notice ? (
            <div
              className={cn(
                "mb-3 rounded-md border px-3 py-2 text-[12px]",
                notice.kind === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-info/20 bg-info/10 text-info",
              )}
            >
              {notice.text}
            </div>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">AGENTS.md</span>
            <textarea
              className="h-[min(52vh,28rem)] w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-[12px] leading-5 text-foreground outline-none focus:border-primary disabled:opacity-65"
              disabled={isLoading}
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
        </div>

        <footer className="flex h-11 items-center justify-end gap-2 border-t border-border px-3">
          <button
            className="h-8 rounded-md border border-border px-3 text-[12px] font-medium text-foreground hover:bg-accent"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
            disabled={isLoading || saving}
            type="button"
            onClick={() => void saveInstructions()}
          >
            {saving ? "Saving" : "Save"}
          </button>
        </footer>
      </section>
    </div>
  )
}
