import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { useMemo, useState } from "react"
import { FileGlyph } from "@/components/session/file-glyph"
import { flattenVisibleTree, treeItemElementId } from "@/lib/session"
import { cn } from "@/lib/utils"
import type { FileNode, VisibleTreeItem } from "@/types/session"

export function FileTreeView({
  expandedFolderIds,
  loadingFolderIds,
  nodes,
  selectedFileId,
  treeId,
  onFileSelect,
  onFolderToggle,
}: {
  expandedFolderIds: Set<string>
  loadingFolderIds: Set<string>
  nodes: FileNode[]
  selectedFileId: string
  treeId: string
  onFileSelect: (id: string) => void
  onFolderToggle: (id: string) => void
}) {
  const visibleItems = useMemo(
    () => flattenVisibleTree(nodes, expandedFolderIds),
    [expandedFolderIds, nodes],
  )
  const selectedIsVisible = visibleItems.some((item) => item.node.id === selectedFileId)
  const [focusedId, setFocusedId] = useState(selectedIsVisible ? selectedFileId : visibleItems[0]?.node.id)
  const activeFocusId = visibleItems.some((item) => item.node.id === focusedId)
    ? focusedId
    : selectedIsVisible
      ? selectedFileId
      : visibleItems[0]?.node.id

  const focusTreeItem = (id: string | undefined) => {
    if (!id) {
      return
    }
    setFocusedId(id)
    window.requestAnimationFrame(() => {
      document.getElementById(treeItemElementId(treeId, id))?.focus()
    })
  }

  const activateNode = (node: FileNode) => {
    if (node.type === "file") {
      onFileSelect(node.id)
      return
    }
    onFolderToggle(node.id)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, item: VisibleTreeItem) => {
    const currentIndex = visibleItems.findIndex((visibleItem) => visibleItem.node.id === item.node.id)
    const hasChildren = item.node.type === "folder" && (item.node.children === undefined || item.node.children.length > 0)
    const expanded = item.node.type === "folder" && expandedFolderIds.has(item.node.id)

    if (event.key === "ArrowDown") {
      event.preventDefault()
      focusTreeItem(visibleItems[Math.min(currentIndex + 1, visibleItems.length - 1)]?.node.id)
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      focusTreeItem(visibleItems[Math.max(currentIndex - 1, 0)]?.node.id)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focusTreeItem(visibleItems[0]?.node.id)
      return
    }

    if (event.key === "End") {
      event.preventDefault()
      focusTreeItem(visibleItems[visibleItems.length - 1]?.node.id)
      return
    }

    if (event.key === "ArrowRight" && item.node.type === "folder") {
      event.preventDefault()
      if (!hasChildren) {
        return
      }
      if (!expanded) {
        onFolderToggle(item.node.id)
        return
      }
      focusTreeItem(item.node.children?.[0]?.id)
      return
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault()
      if (item.node.type === "folder" && expanded) {
        onFolderToggle(item.node.id)
        return
      }
      focusTreeItem(item.parentId)
      return
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      activateNode(item.node)
    }
  }

  return (
    <div aria-label="Workspace files" role="tree">
      {visibleItems.map((item) => {
        const node = item.node
        const hasChildren = node.type === "folder" && (node.children === undefined || node.children.length > 0)
        const expanded = node.type === "folder" && expandedFolderIds.has(node.id)
        const loading = node.type === "folder" && loadingFolderIds.has(node.id)
        const selected = node.id === selectedFileId

        return (
          <div
            aria-busy={loading || undefined}
            aria-expanded={node.type === "folder" && hasChildren ? expanded : undefined}
            aria-level={item.level}
            aria-selected={selected}
            className={cn(
              "flex h-[26px] w-full min-w-0 cursor-default items-center gap-1.5 rounded-sm px-2 text-left text-[13px] font-medium text-foreground outline-none hover:bg-accent focus-visible:bg-accent",
              selected && "bg-accent text-foreground hover:bg-accent focus-visible:bg-accent",
            )}
            id={treeItemElementId(treeId, node.id)}
            key={node.id}
            role="treeitem"
            style={{ paddingLeft: 8 + (item.level - 1) * 14 }}
            tabIndex={node.id === activeFocusId ? 0 : -1}
            title={node.name}
            onClick={() => activateNode(node)}
            onFocus={() => setFocusedId(node.id)}
            onKeyDown={(event) => handleKeyDown(event, item)}
          >
            {node.type === "folder" ? (
              loading ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin text-info" />
              ) : hasChildren && expanded ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground", !hasChildren && "opacity-35")} />
              )
            ) : (
              <FileGlyph icon={node.icon} />
            )}
            <span className="min-w-0 truncate">{node.name}</span>
          </div>
        )
      })}
    </div>
  )
}
