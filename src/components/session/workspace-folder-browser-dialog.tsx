import { ArrowLeft, ChevronRight, FileText, Folder, FolderOpen, LoaderCircle, RefreshCw, X } from "lucide-react"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiClient, type BrowserEntry } from "@/lib/api-client"
import {
  directoryResponseToBrowserEntry,
  filterBrowserEntries,
  parentBrowserPath,
  pathInputFilter,
  readError,
  samePath,
  updateBrowserEntryChildren,
} from "@/lib/session"
import { cn } from "@/lib/utils"

export function WorkspaceFolderBrowserDialog({
  open,
  openWorkspacePaths,
  onClose,
  onSelect,
}: {
  open: boolean
  openWorkspacePaths: string[]
  onClose: () => void
  onSelect: (entry: BrowserEntry) => void
}) {
  const browser = useWorkspaceFolderBrowserDialog(open, openWorkspacePaths, onSelect)

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, open])

  if (!open) {
    return null
  }

  return (
    <div className="safe-area-overlay fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <button
        aria-label="Close folder browser"
        className="absolute inset-0 cursor-default"
        type="button"
        onClick={onClose}
      />
      <section className="relative grid h-[80vh] min-h-[560px] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <WorkspaceFolderBrowserHeader onClose={onClose} />
        <WorkspaceFolderBrowserBody browser={browser} />
        <WorkspaceFolderBrowserFooter browser={browser} onClose={onClose} />
      </section>
    </div>
  )
}

function useWorkspaceFolderBrowserDialog(
  open: boolean,
  openWorkspacePaths: string[],
  onSelect: (entry: BrowserEntry) => void,
) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null)
  const [pathInput, setPathInput] = useState("")
  const [rootEntry, setRootEntry] = useState<BrowserEntry | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<BrowserEntry | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const loadingDirectoryPathsRef = useRef<Set<string>>(new Set())

  const selectedAlreadyOpen = Boolean(
    selectedEntry && openWorkspacePaths.some((path) => samePath(path, selectedEntry.path)),
  )
  const canOpen = Boolean(selectedEntry && selectedEntry.type === "directory" && !selectedEntry.error && !isLoading)
  const pathFilter = rootEntry ? pathInputFilter(pathInput, rootEntry.path) : ""

  const setDirectoryLoading = (path: string, loading: boolean) => {
    const next = new Set(loadingDirectoryPathsRef.current)
    if (loading) {
      next.add(path)
    } else {
      next.delete(path)
    }
    loadingDirectoryPathsRef.current = next
    setLoadingDirectoryPaths(next)
  }

  const loadBrowserRoot = useCallback(async (path?: string, includeHidden = showHidden) => {
    const nextLoadingDirectoryPaths = new Set<string>()
    loadingDirectoryPathsRef.current = nextLoadingDirectoryPaths
    setLoadingDirectoryPaths(nextLoadingDirectoryPaths)
    setIsLoading(true)
    setNotice(null)
    try {
      const directory = await apiClient.workspaces.listDirectory(path, includeHidden)
      const entry = directoryResponseToBrowserEntry(directory)
      setRootEntry(entry)
      setSelectedEntry(entry)
      setPathInput(entry.path)
      setExpandedPaths(new Set([entry.path]))
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setIsLoading(false)
    }
  }, [showHidden])

  useEffect(() => {
    if (!open) {
      return
    }
    setExpandedPaths(new Set())
    setNotice(null)
    setPathInput("")
    setRootEntry(null)
    setSelectedEntry(null)
    setShowHidden(false)
    void loadBrowserRoot(undefined, false)
  }, [loadBrowserRoot, open])

  const selectEntry = (entry: BrowserEntry) => {
    if (entry.type !== "directory") {
      return
    }
    setSelectedEntry(entry)
    setNotice(entry.error ? { kind: "error", text: entry.error } : null)
  }

  const toggleDirectory = async (entry: BrowserEntry) => {
    selectEntry(entry)
    if (entry.type !== "directory" || entry.error || loadingDirectoryPathsRef.current.has(entry.path)) {
      return
    }

    if (expandedPaths.has(entry.path)) {
      setExpandedPaths((current) => {
        const next = new Set(current)
        next.delete(entry.path)
        return next
      })
      return
    }

    if (!entry.children) {
      setNotice(null)
      setDirectoryLoading(entry.path, true)
      try {
        const directory = await apiClient.workspaces.listDirectory(entry.path, showHidden)
        setRootEntry((current) => current ? updateBrowserEntryChildren(current, entry.path, directory.entries) : current)
      } catch (error) {
        setNotice({ kind: "error", text: readError(error) })
        return
      } finally {
        setDirectoryLoading(entry.path, false)
      }
    }

    setExpandedPaths((current) => new Set(current).add(entry.path))
  }

  const moveParent = () => {
    if (!rootEntry) {
      return
    }
    const parentPath = parentBrowserPath(rootEntry.path)
    if (parentPath) {
      void loadBrowserRoot(parentPath)
    }
  }

  const refreshBrowser = () => {
    void loadBrowserRoot(rootEntry?.path)
  }

  const openPathInput = () => {
    void loadBrowserRoot(pathInput.trim() || undefined)
  }

  const toggleHidden = (checked: boolean) => {
    setShowHidden(checked)
    void loadBrowserRoot(rootEntry?.path, checked)
  }

  const chooseSelectedFolder = async () => {
    if (!selectedEntry || selectedEntry.type !== "directory" || selectedEntry.error) {
      return
    }

    if (selectedAlreadyOpen) {
      onSelect(selectedEntry)
      return
    }

    setIsLoading(true)
    setNotice(null)
    try {
      onSelect(await apiClient.workspaces.readTree(selectedEntry.path, showHidden))
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setIsLoading(false)
    }
  }

  return {
    canOpen,
    chooseSelectedFolder,
    expandedPaths,
    isLoading,
    loadingDirectoryPaths,
    loadBrowserRoot,
    moveParent,
    notice,
    openPathInput,
    pathFilter,
    pathInput,
    refreshBrowser,
    rootEntry,
    selectEntry,
    selectedAlreadyOpen,
    selectedEntry,
    setPathInput,
    showHidden,
    toggleDirectory,
    toggleHidden,
  }
}

type WorkspaceFolderBrowserState = ReturnType<typeof useWorkspaceFolderBrowserDialog>

function WorkspaceFolderBrowserHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="flex h-11 min-w-0 items-center gap-2 border-b border-border px-3">
      <Folder className="size-4 shrink-0 text-ide-folder" />
      <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">Open Folder</span>
      <button
        aria-label="Close folder browser"
        className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        type="button"
        onClick={onClose}
      >
        <X className="size-3.5" />
      </button>
    </header>
  )
}

function WorkspaceFolderBrowserBody({ browser }: { browser: WorkspaceFolderBrowserState }) {
  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <WorkspaceFolderBrowserToolbar browser={browser} />
      <div className="min-h-0 overflow-auto px-1.5 py-2 ide-scrollbar">
        {browser.isLoading && !browser.rootEntry ? (
          <div className="grid h-full place-items-center text-[12px] text-muted-foreground">Loading</div>
        ) : browser.rootEntry ? (
          <FolderBrowserTreeNode
            entry={browser.rootEntry}
            expandedPaths={browser.expandedPaths}
            filter={browser.pathFilter}
            level={1}
            loadingDirectoryPaths={browser.loadingDirectoryPaths}
            selectedPath={browser.selectedEntry?.path ?? ""}
            onSelect={browser.selectEntry}
            onToggle={browser.toggleDirectory}
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-muted-foreground">No folder</div>
        )}
      </div>
    </div>
  )
}

function WorkspaceFolderBrowserToolbar({ browser }: { browser: WorkspaceFolderBrowserState }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-2 py-2">
      <FolderBrowserIconButton label="Back" onClick={browser.moveParent}>
        <ArrowLeft className="size-4" />
      </FolderBrowserIconButton>
      <FolderBrowserIconButton label="Home" onClick={() => void browser.loadBrowserRoot()}>
        <Folder className="size-4" />
      </FolderBrowserIconButton>
      <FolderBrowserIconButton label="Refresh" onClick={browser.refreshBrowser}>
        <RefreshCw className={cn("size-4", browser.isLoading && "animate-spin")} />
      </FolderBrowserIconButton>
      <input
        autoCapitalize="none"
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        placeholder="~"
        spellCheck={false}
        value={browser.pathInput}
        onChange={(event) => browser.setPathInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            browser.openPathInput()
          }
        }}
      />
    </div>
  )
}

function WorkspaceFolderBrowserFooter({
  browser,
  onClose,
}: {
  browser: WorkspaceFolderBrowserState
  onClose: () => void
}) {
  return (
    <footer className="flex h-11 min-w-0 items-center gap-2 border-t border-border bg-secondary/30 px-2">
      <label className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
        <input
          checked={browser.showHidden}
          className="size-3.5 accent-primary"
          type="checkbox"
          onChange={(event) => browser.toggleHidden(event.target.checked)}
        />
        Hidden
      </label>
      <div className="min-w-0 flex-1">
      </div>
      <WorkspaceFolderBrowserNotice browser={browser} />
      <div className="flex shrink-0 justify-end gap-2">
        <button
          className="h-8 rounded-md border border-border px-3 text-[12px] font-medium text-foreground hover:bg-accent"
          type="button"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!browser.canOpen}
          type="button"
          onClick={browser.chooseSelectedFolder}
        >
          {browser.selectedAlreadyOpen ? "Focus" : "Open"}
        </button>
      </div>
    </footer>
  )
}

function WorkspaceFolderBrowserNotice({ browser }: { browser: WorkspaceFolderBrowserState }) {
  if (browser.notice) {
    return (
      <div
        className={cn(
          "max-w-64 shrink-0 truncate text-[11px]",
          browser.notice.kind === "error" ? "text-destructive" : "text-muted-foreground",
        )}
        title={browser.notice.text}
      >
        {browser.notice.text}
      </div>
    )
  }
  return browser.selectedAlreadyOpen ? (
    <div className="max-w-64 shrink-0 truncate text-[11px] text-muted-foreground">Already open</div>
  ) : null
}

function FolderBrowserTreeNode({
  entry,
  expandedPaths,
  filter,
  level,
  loadingDirectoryPaths,
  selectedPath,
  onSelect,
  onToggle,
}: {
  entry: BrowserEntry
  expandedPaths: Set<string>
  filter: string
  level: number
  loadingDirectoryPaths: Set<string>
  selectedPath: string
  onSelect: (entry: BrowserEntry) => void
  onToggle: (entry: BrowserEntry) => void
}) {
  const expanded = expandedPaths.has(entry.path)
  const loading = loadingDirectoryPaths.has(entry.path)
  const selected = samePath(selectedPath, entry.path)
  const children = useMemo(
    () => filterBrowserEntries(entry.children ?? [], filter),
    [entry.children, filter],
  )
  const directories = children.filter((child) => child.type === "directory")
  const nonDirectories = children.filter((child) => child.type !== "directory")

  return (
    <div className="min-w-0">
      <FolderBrowserDirectoryRow
        entry={entry}
        expanded={expanded}
        level={level}
        loading={loading}
        selected={selected}
        onSelect={onSelect}
        onToggle={onToggle}
      />

      {expanded ? (
        <div className="min-w-0">
          {entry.error ? (
            <div
              className="h-7 truncate px-2 text-[12px] leading-7 text-destructive"
              style={{ paddingLeft: 24 + level * 16 }}
            >
              {entry.error}
            </div>
          ) : null}

          {!entry.error && directories.map((child) => (
            <FolderBrowserTreeNode
              entry={child}
              expandedPaths={expandedPaths}
              filter={filter}
              key={child.path}
              level={level + 1}
              loadingDirectoryPaths={loadingDirectoryPaths}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}

          {!entry.error && nonDirectories.map((child) => (
            <FolderBrowserNonDirectoryRow entry={child} key={child.path} level={level + 1} />
          ))}

          {!entry.error && !children.length ? (
            <div
              className="h-7 truncate px-2 text-[12px] leading-7 text-muted-foreground"
              style={{ paddingLeft: 24 + level * 16 }}
            >
              {filter.trim() ? "No match" : "Empty"}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function FolderBrowserDirectoryRow({
  entry,
  expanded,
  level,
  loading,
  selected,
  onSelect,
  onToggle,
}: {
  entry: BrowserEntry
  expanded: boolean
  level: number
  loading: boolean
  selected: boolean
  onSelect: (entry: BrowserEntry) => void
  onToggle: (entry: BrowserEntry) => void
}) {
  const canExpand = entry.type === "directory"

  return (
    <div
      aria-busy={loading || undefined}
      className={cn(
        "group grid h-7 min-w-0 grid-cols-[1.5rem_1rem_minmax(0,1fr)_auto] items-center gap-1 rounded-sm px-1 text-[13px] font-medium",
        selected ? "bg-accent text-foreground" : "text-foreground hover:bg-accent",
      )}
      style={{ paddingLeft: 4 + (level - 1) * 16 }}
    >
      <button
        aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
        className={cn(
          "grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
          !canExpand && "pointer-events-none opacity-35",
          loading && "cursor-wait opacity-70",
        )}
        disabled={loading}
        type="button"
        onClick={() => onToggle(entry)}
      >
        <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
      </button>
      {loading ? (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-info" />
      ) : expanded ? (
        <FolderOpen className="size-4 shrink-0 text-ide-folder" />
      ) : (
        <Folder className="size-4 shrink-0 text-ide-folder" />
      )}
      <button
        className="min-w-0 truncate text-left"
        title={entry.path}
        type="button"
        onClick={() => onSelect(entry)}
        onDoubleClick={() => onToggle(entry)}
      >
        {entry.name}
      </button>
      {entry.error ? (
        <span className="grid size-5 shrink-0 place-items-center rounded bg-destructive/10 text-destructive" title="Blocked">
          <X className="size-3" />
        </span>
      ) : null}
    </div>
  )
}

function FolderBrowserNonDirectoryRow({
  entry,
  level,
}: {
  entry: BrowserEntry
  level: number
}) {
  return (
    <div
      className="grid h-7 min-w-0 grid-cols-[1.5rem_1rem_minmax(0,1fr)_auto] items-center gap-1 rounded-sm px-1 text-[13px] text-muted-foreground"
      style={{ paddingLeft: 4 + (level - 1) * 16 }}
      title={`${entry.path} is not a folder`}
    >
      <span />
      <FileText className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{entry.name}</span>
      <span className="size-5 shrink-0" />
    </div>
  )
}

function FolderBrowserIconButton({
  children,
  label,
  onClick,
  pressed,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  pressed?: boolean
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        pressed && "bg-accent text-foreground",
      )}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
