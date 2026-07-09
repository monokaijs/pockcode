import { Dock, PictureInPicture2, X } from "lucide-react"
import Editor, { type OnMount } from "@monaco-editor/react"
import type { ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { FileGlyph } from "@/components/session/file-glyph"
import { ModeToggleButton } from "@/components/session/mode-toggle-button"
import { useTheme } from "@/components/theme-provider"
import { configureMonacoLanguageDefaults, type MonacoApi } from "@/lib/monaco"
import { definePockcodeMonacoTheme, pockcodeMonacoThemeName } from "@/lib/theme-colors"
import { fileLanguage, findFilePath, monacoLanguageFor } from "@/lib/session"
import { cn } from "@/lib/utils"
import type { FileNode, FileRevealTarget, FileSelectOptions, Workspace } from "@/types/session"

export function FileEditorPane({
  content,
  file,
  openFiles,
  revealTarget,
  workspace,
  onFileClose,
  onContentChange,
  onFileSelect,
  onOpenDialog,
  onToggleMode,
}: {
  content: string
  file: FileNode
  openFiles: FileNode[]
  revealTarget: FileRevealTarget | null
  workspace: Workspace
  onFileClose: (id: string) => void
  onContentChange: (id: string, value: string) => void
  onFileSelect: (id: string, options?: FileSelectOptions) => void
  onOpenDialog: () => void
  onToggleMode: () => void
}) {
  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-10 min-w-0 items-stretch border-b border-border bg-secondary/40 text-[12px] font-medium text-muted-foreground">
        <div className="flex min-w-0 flex-1 overflow-x-auto ide-scrollbar">
          {openFiles.map((openFile) => {
            const active = openFile.id === file.id
            const path = findFilePath(workspace.fileTree, openFile.id)?.join(" / ") ?? openFile.name

            return (
              <div
                className={cn(
                  "group relative flex h-full min-w-32 max-w-48 shrink-0 items-center border-l border-border",
                  active ? "bg-accent text-foreground" : "bg-secondary/40 text-muted-foreground hover:bg-accent/50",
                )}
                key={openFile.id}
                title={path}
              >
                {active ? <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" /> : null}
                <button
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left"
                  type="button"
                  onClick={() => onFileSelect(openFile.id)}
                >
                  <FileGlyph icon={openFile.icon} />
                  <span className="min-w-0 truncate">{openFile.name}</span>
                </button>
                <button
                  aria-label={`Close ${openFile.name}`}
                  className={cn(
                    "mr-1 grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  type="button"
                  onClick={() => onFileClose(openFile.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-border px-2">
          <ModeToggleButton mode="editor" onClick={onToggleMode} />
        </div>
      </div>
      <FileViewer
        content={content}
        file={file}
        revealTarget={revealTarget}
        workspace={workspace}
        onContentChange={onContentChange}
        footerAction={
          <button
            aria-label="Open current file in dialog"
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Open current file in dialog"
            type="button"
            onClick={onOpenDialog}
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
        }
      />
    </section>
  )
}

export function FileDialog({
  content,
  file,
  revealTarget,
  workspace,
  onClose,
  onContentChange,
  onOpenInMain,
}: {
  content: string
  file: FileNode
  revealTarget: FileRevealTarget | null
  workspace: Workspace
  onClose: () => void
  onContentChange: (id: string, value: string) => void
  onOpenInMain: () => void
}) {
  const path = findFilePath(workspace.fileTree, file.id)?.join(" / ") ?? file.name

  return (
    <div className="safe-area-overlay safe-area-overlay-lg fixed inset-0 z-50 grid place-items-center bg-black/65 p-6" role="dialog" aria-modal="true">
      <div className="grid h-[72vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex h-11 min-w-0 items-center gap-2 px-3 text-[12px] font-medium text-muted-foreground">
          <FileGlyph icon={file.icon} />
          <span className="min-w-0 truncate text-foreground">{path}</span>
          <button
            aria-label="Close file dialog"
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <FileViewer
          content={content}
          file={file}
          revealTarget={revealTarget}
          workspace={workspace}
          onContentChange={onContentChange}
          footerAction={
            <button
              aria-label="Collapse file to main editor"
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Collapse to main editor"
              type="button"
              onClick={onOpenInMain}
            >
              <Dock className="size-3.5" />
            </button>
          }
        />
      </div>
    </div>
  )
}

function FileViewer({
  content,
  file,
  footerAction,
  revealTarget,
  workspace,
  onContentChange,
}: {
  content: string
  file: FileNode
  footerAction?: ReactNode
  revealTarget?: FileRevealTarget | null
  workspace: Workspace
  onContentChange: (id: string, value: string) => void
}) {
  const language = file.language ?? fileLanguage(file.name)
  const monacoLanguage = file.language ?? monacoLanguageFor(file.name)
  const editorPath = file.path ?? `${workspace.id}/${file.id.replace(/[:/]/g, "_")}/${file.name}`
  const lines = content.split("\n")
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const [monacoApi, setMonacoApi] = useState<MonacoApi | null>(null)
  const { resolvedTheme } = useTheme()
  const monacoThemeName = pockcodeMonacoThemeName(resolvedTheme)

  const revealLine = useCallback((target: FileRevealTarget) => {
    const editor = editorRef.current
    if (!editor || target.fileId !== file.id) {
      return
    }
    const lineCount = editor.getModel()?.getLineCount() ?? lines.length
    const lineNumber = clamp(target.lineNumber ?? 1, 1, Math.max(1, lineCount))
    const column = clamp(target.column ?? 1, 1, editor.getModel()?.getLineMaxColumn(lineNumber) ?? 1)
    editor.setPosition({ lineNumber, column })
    editor.revealLineInCenter(lineNumber)
    editor.focus()
  }, [file.id, lines.length])

  useEffect(() => {
    if (!revealTarget) {
      return
    }
    const frame = window.requestAnimationFrame(() => revealLine(revealTarget))
    return () => window.cancelAnimationFrame(frame)
  }, [revealLine, revealTarget?.nonce])

  useEffect(() => {
    if (!monacoApi) {
      return
    }
    monacoApi.editor.setTheme(definePockcodeMonacoTheme(monacoApi, resolvedTheme))
  }, [monacoApi, resolvedTheme])

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-card">
      <div className="min-h-0 overflow-hidden">
        <Editor
          height="100%"
          language={monacoLanguage}
          path={editorPath}
          theme={monacoThemeName}
          value={content}
          beforeMount={(monaco) => {
            configureMonacoLanguageDefaults(monaco)
            definePockcodeMonacoTheme(monaco, resolvedTheme)
          }}
          onChange={(value) => onContentChange(file.id, value ?? "")}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            setMonacoApi(monaco)
            if (revealTarget) {
              window.requestAnimationFrame(() => revealLine(revealTarget))
            }
          }}
          options={{
            automaticLayout: true,
            bracketPairColorization: { enabled: true },
            contextmenu: true,
            cursorBlinking: "smooth",
            fixedOverflowWidgets: true,
            fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: 12,
            guides: { bracketPairs: true, indentation: true },
            lineHeight: 20,
            minimap: { enabled: false },
            overviewRulerBorder: false,
            padding: { bottom: 12, top: 12 },
            renderLineHighlight: "all",
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            tabSize: 2,
            wordWrap: "off",
          }}
        />
      </div>
      <div className="flex h-8 items-center gap-2 border-t border-border px-3 text-[11px] font-medium text-muted-foreground">
        <span>{language}</span>
        <span className="h-3 w-px bg-border" />
        <span>{lines.length} lines</span>
        {footerAction ? <div className="ml-auto">{footerAction}</div> : null}
      </div>
    </div>
  )
}


function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
