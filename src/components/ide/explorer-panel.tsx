import {
  ChevronRight,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { FileNode, Project } from "@/types/ide"

export function ExplorerPanel({
  activeFileId,
  dirtyFileIds,
  project,
  onFileSelect,
}: {
  activeFileId: string | null
  dirtyFileIds: Set<string>
  project: Project
  onFileSelect: (fileId: string) => void
}) {
  const initialExpanded = useMemo(() => collectFolderIds(project.tree), [project.tree])
  const [expanded, setExpanded] = useState(() => new Set(initialExpanded))

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-border bg-card text-foreground">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-foreground">
          Explorer
        </div>
        <div className="mt-1 truncate text-sm font-semibold" title={project.path}>
          {project.name}
        </div>
      </div>
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Files
        </span>
        <Button className="text-foreground hover:bg-accent" size="xs" variant="ghost">
          New File
        </Button>
      </div>
      <div className="min-h-0 overflow-auto py-1 ide-scrollbar">
        {project.tree.map((node) => (
          <TreeRow
            activeFileId={activeFileId}
            dirtyFileIds={dirtyFileIds}
            expanded={expanded}
            key={node.id}
            node={node}
            onFileSelect={onFileSelect}
            onToggle={(folderId) => {
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(folderId)) {
                  next.delete(folderId)
                } else {
                  next.add(folderId)
                }
                return next
              })
            }}
          />
        ))}
      </div>
    </section>
  )
}

function TreeRow({
  activeFileId,
  dirtyFileIds,
  expanded,
  level = 0,
  node,
  onFileSelect,
  onToggle,
}: {
  activeFileId: string | null
  dirtyFileIds: Set<string>
  expanded: Set<string>
  level?: number
  node: FileNode
  onFileSelect: (fileId: string) => void
  onToggle: (folderId: string) => void
}) {
  const isFolder = node.type === "folder"
  const isExpanded = expanded.has(node.id)
  const active = node.id === activeFileId
  const dirty = dirtyFileIds.has(node.id) || !!node.dirty
  const FileIcon = fileIcon(node.name)

  return (
    <div>
      <Button
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs text-foreground hover:bg-accent",
          active && "bg-accent text-white hover:bg-accent",
        )}
        style={{ paddingLeft: 8 + level * 14 }}
        title={node.path}
        type="button"
        onClick={() => (isFolder ? onToggle(node.id) : onFileSelect(node.id))}
      >
        {isFolder ? (
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-foreground transition-transform", isExpanded && "rotate-90")}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isFolder ? (
          isExpanded ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )
        ) : (
          <FileIcon className={cn("size-4 shrink-0", fileIconColor(node.name))} />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
      </Button>
      {isFolder && isExpanded
        ? node.children?.map((child) => (
            <TreeRow
              activeFileId={activeFileId}
              dirtyFileIds={dirtyFileIds}
              expanded={expanded}
              key={child.id}
              level={level + 1}
              node={child}
              onFileSelect={onFileSelect}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  )
}

function collectFolderIds(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type !== "folder") {
      return []
    }
    return [node.id, ...collectFolderIds(node.children ?? [])]
  })
}

function fileIcon(name: string) {
  if (name.endsWith(".json")) {
    return FileJson
  }
  if (name.endsWith(".md") || name.endsWith(".css")) {
    return FileText
  }
  return FileCode
}

function fileIconColor(name: string): string {
  if (name.endsWith(".ts") || name.endsWith(".tsx")) {
    return "text-primary"
  }
  if (name.endsWith(".json")) {
    return "text-destructive"
  }
  if (name.endsWith(".md")) {
    return "text-primary"
  }
  if (name.endsWith(".css")) {
    return "text-muted-foreground"
  }
  return "text-muted-foreground"
}
