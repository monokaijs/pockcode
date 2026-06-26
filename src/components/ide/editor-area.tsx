import Editor, { type OnMount } from "@monaco-editor/react"
import { Circle, FileCode, PanelRightClose, X } from "lucide-react"
import { useEffect, useState } from "react"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import type { MonacoApi } from "@/lib/lsp-client"
import { definePockcodeMonacoTheme, pockcodeMonacoThemeName } from "@/lib/theme-colors"
import { cn } from "@/lib/utils"
import type { FileNode, Project } from "@/types/ide"

export function EditorArea({
  activeFile,
  activeFileContent,
  dirtyFileIds,
  openFiles,
  onCloseFile,
  onCursorChange,
  onFileContentChange,
  onFileSelect,
}: {
  activeFile: FileNode | null
  activeFileContent: string
  dirtyFileIds: Set<string>
  openFiles: FileNode[]
  project: Project
  onCloseFile: (fileId: string) => void
  onCursorChange: (line: number, column: number) => void
  onFileContentChange: (fileId: string, value: string) => void
  onFileSelect: (fileId: string) => void
}) {
  const { resolvedTheme } = useTheme()
  const [monacoApi, setMonacoApi] = useState<MonacoApi | null>(null)
  const monacoThemeName = pockcodeMonacoThemeName(resolvedTheme)

  useEffect(() => {
    if (!monacoApi) {
      return
    }
    monacoApi.editor.setTheme(definePockcodeMonacoTheme(monacoApi, resolvedTheme))
  }, [monacoApi, resolvedTheme])

  const handleMount: OnMount = (editor, monaco) => {
    setMonacoApi(monaco)
    monaco.editor.setTheme(definePockcodeMonacoTheme(monaco, resolvedTheme))
    const position = editor.getPosition()
    if (position) {
      onCursorChange(position.lineNumber, position.column)
    }
    editor.onDidChangeCursorPosition((event) => {
      onCursorChange(event.position.lineNumber, event.position.column)
    })
  }

  return (
    <section className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background">
      <div className="flex h-9 min-w-0 items-stretch border-b border-border bg-card">
        <div className="flex min-w-0 flex-1 overflow-x-auto ide-scrollbar">
          {openFiles.map((file) => {
            const active = file.id === activeFile?.id
            const dirty = dirtyFileIds.has(file.id) || !!file.dirty
            return (
              <div
                className={cn(
                  "group relative flex h-9 min-w-36 max-w-56 shrink-0 items-center border-r border-border text-xs",
                  active ? "bg-background text-foreground" : "bg-card text-muted-foreground hover:bg-accent/50",
                )}
                key={file.id}
              >
                {active ? <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" /> : null}
                <button
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 pt-0.5 text-left"
                  title={file.path}
                  type="button"
                  onClick={() => onFileSelect(file.id)}
                >
                  <FileCode className={cn("size-3.5 shrink-0", fileIconColor(file.name))} />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  {dirty ? <Circle className="size-2 shrink-0 fill-primary text-primary" /> : null}
                </button>
                <button
                  aria-label={`Close ${file.name}`}
                  className={cn(
                    "mr-1 grid size-5 shrink-0 place-items-center rounded-sm hover:bg-muted",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  type="button"
                  onClick={() => onCloseFile(file.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        <Button className="mr-1 self-center" size="icon-xs" title="Split editor" variant="ghost">
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 min-w-0">
        {activeFile ? (
          <Editor
            key={activeFile.id}
            defaultLanguage={activeFile.language ?? "plaintext"}
            language={activeFile.language ?? "plaintext"}
            options={{
              automaticLayout: true,
              cursorBlinking: "smooth",
              fixedOverflowWidgets: true,
              fontFamily:
                "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
              fontSize: 13,
              lineHeight: 21,
              minimap: { enabled: false },
              padding: { bottom: 24, top: 16 },
              renderLineHighlight: "all",
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              tabSize: 2,
            }}
            path={activeFile.path}
            theme={monacoThemeName}
            value={activeFileContent}
            beforeMount={(monaco) => {
              definePockcodeMonacoTheme(monaco, resolvedTheme)
            }}
            onChange={(value) => onFileContentChange(activeFile.id, value ?? "")}
            onMount={handleMount}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Select a file from the explorer.
          </div>
        )}
      </div>
    </section>
  )
}

function fileIconColor(name: string): string {
  if (name.endsWith(".ts") || name.endsWith(".tsx")) {
    return "text-ide-file-blue"
  }
  if (name.endsWith(".json")) {
    return "text-ide-file-yellow"
  }
  if (name.endsWith(".md")) {
    return "text-ide-file-blue"
  }
  if (name.endsWith(".css")) {
    return "text-ide-file-purple"
  }
  return "text-muted-foreground"
}
