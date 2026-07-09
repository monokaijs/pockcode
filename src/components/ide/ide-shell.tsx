import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react"
import { useMemo, useState } from "react"
import { ActivityBar } from "@/components/ide/activity-bar"
import { AgentPanel } from "@/components/ide/agent-panel"
import { EditorArea } from "@/components/ide/editor-area"
import { ExplorerPanel } from "@/components/ide/explorer-panel"
import { GitPanel } from "@/components/ide/git-panel"
import { ProjectTabs } from "@/components/ide/project-tabs"
import { StatusBar } from "@/components/ide/status-bar"
import { TerminalPanel } from "@/components/ide/terminal-panel"
import { findFile, flattenFiles } from "@/lib/ide"
import { startHorizontalResize, startVerticalResize } from "@/lib/resize"
import type { ActivityId, AgentMessage, FileNode, Project } from "@/types/ide"

const ACTIVITY_BAR_WIDTH = 44
const DEFAULT_SIDE_PANEL_WIDTH = 280
const DEFAULT_AGENT_PANEL_WIDTH = 360
const DEFAULT_TERMINAL_HEIGHT = 250
const MIN_SIDE_PANEL_WIDTH = 220
const MAX_SIDE_PANEL_WIDTH = 440
const MIN_AGENT_PANEL_WIDTH = 280
const MAX_AGENT_PANEL_WIDTH = 560
const MIN_TERMINAL_HEIGHT = 150
const MAX_TERMINAL_HEIGHT = 520
const RESIZE_HANDLE_SIZE = 8

export function IdeShell({ projects }: { projects: Project[] }) {
  const ide = useIdeShellState(projects)

  if (!ide.activeProject) {
    return (
      <main className="app-safe-viewport grid place-items-center bg-background text-sm text-muted-foreground">
        No projects available.
      </main>
    )
  }

  return <IdeShellLayout ide={ide} projects={projects} />
}

function useIdeShellState(projects: Project[]) {
  const [activeProjectId, setActiveProjectId] = useState(projects[0]?.id ?? "")
  const [activeActivity, setActiveActivity] = useState<ActivityId>("files")
  const [agentPanelWidth, setAgentPanelWidth] = useState(DEFAULT_AGENT_PANEL_WIDTH)
  const [cursor, setCursor] = useState({ column: 1, line: 1 })
  const [editedContents, setEditedContents] = useState<Record<string, string>>({})
  const [openFileIdsByProject, setOpenFileIdsByProject] = useState(() =>
    Object.fromEntries(projects.map((project) => [project.id, project.initialOpenFileIds])),
  )
  const [activeFileIdByProject, setActiveFileIdByProject] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(projects.map((project) => [project.id, project.initialActiveFileId])),
  )
  const [activeTerminalIdByProject, setActiveTerminalIdByProject] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(projects.map((project) => [project.id, project.terminals[0]?.id ?? null])),
  )
  const [messagesByProject, setMessagesByProject] = useState<Record<string, AgentMessage[]>>(
    () => Object.fromEntries(projects.map((project) => [project.id, project.agentMessages])),
  )
  const [sidePanelWidth, setSidePanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH)
  const [terminalHeight, setTerminalHeight] = useState(DEFAULT_TERMINAL_HEIGHT)

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  )
  const activeFileId = activeProject ? activeFileIdByProject[activeProject.id] ?? null : null
  const openFileIds = activeProject ? openFileIdsByProject[activeProject.id] ?? [] : []
  const openFiles = useMemo(() => {
    if (!activeProject) {
      return []
    }
    return openFileIds
      .map((fileId) => findFile(activeProject.tree, fileId))
      .filter((file): file is FileNode => !!file)
  }, [activeProject, openFileIds])
  const activeFile = activeProject && activeFileId ? findFile(activeProject.tree, activeFileId) : null
  const activeFileContent = activeFile ? editedContents[activeFile.id] ?? activeFile.content ?? "" : ""
  const dirtyFileIds = useMemo(() => {
    if (!activeProject) {
      return new Set<string>()
    }
    const dirtyIds = new Set<string>()
    for (const file of flattenFiles(activeProject.tree)) {
      if (file.dirty || editedContents[file.id] !== undefined) {
        dirtyIds.add(file.id)
      }
    }
    return dirtyIds
  }, [activeProject, editedContents])
  const activeTerminalId = activeProject ? activeTerminalIdByProject[activeProject.id] ?? null : null
  const activeTerminal = activeProject
    ? activeProject.terminals.find((terminal) => terminal.id === activeTerminalId) ?? activeProject.terminals[0] ?? null
    : null
  const messages = activeProject ? messagesByProject[activeProject.id] ?? activeProject.agentMessages : []

  const selectProject = (projectId: string) => {
    setActiveProjectId(projectId)
    setCursor({ column: 1, line: 1 })
  }

  const selectFile = (fileId: string) => {
    if (!activeProject) {
      return
    }
    setOpenFileIdsByProject((current) => {
      const projectOpenFiles = current[activeProject.id] ?? []
      if (projectOpenFiles.includes(fileId)) {
        return current
      }
      return { ...current, [activeProject.id]: [...projectOpenFiles, fileId] }
    })
    setActiveFileIdByProject((current) => ({ ...current, [activeProject.id]: fileId }))
    setCursor({ column: 1, line: 1 })
  }

  const closeFile = (fileId: string) => {
    if (!activeProject) {
      return
    }
    const currentOpenFiles = openFileIdsByProject[activeProject.id] ?? []
    const nextOpenFiles = currentOpenFiles.filter((openFileId) => openFileId !== fileId)
    setOpenFileIdsByProject((current) => ({ ...current, [activeProject.id]: nextOpenFiles }))
    if (activeFileId === fileId) {
      const closedIndex = currentOpenFiles.indexOf(fileId)
      const nextActiveFileId = nextOpenFiles[Math.max(0, closedIndex - 1)] ?? nextOpenFiles[0] ?? null
      setActiveFileIdByProject((current) => ({ ...current, [activeProject.id]: nextActiveFileId }))
      setCursor({ column: 1, line: 1 })
    }
  }

  const updateFileContent = (fileId: string, value: string) => {
    if (!activeProject) {
      return
    }
    const sourceFile = findFile(activeProject.tree, fileId)
    setEditedContents((current) => {
      if (value === (sourceFile?.content ?? "")) {
        const next = { ...current }
        delete next[fileId]
        return next
      }
      return { ...current, [fileId]: value }
    })
  }

  const sendAgentMessage = (content: string) => {
    if (!activeProject) {
      return
    }
    const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    const userMessage: AgentMessage = { id: "user-" + activeProject.id + "-" + Date.now(), role: "user", content, timestamp }
    const assistantMessage: AgentMessage = {
      id: "assistant-" + activeProject.id + "-" + Date.now(),
      role: "assistant",
      title: "Queued response",
      content: "Agent execution is handled by the session shell provider flow.",
      meta: "queued",
      timestamp,
    }
    setMessagesByProject((current) => ({ ...current, [activeProject.id]: [...messages, userMessage, assistantMessage] }))
  }

  const startSidePanelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    startHorizontalResize(event, {
      initialWidth: sidePanelWidth,
      max: MAX_SIDE_PANEL_WIDTH,
      min: MIN_SIDE_PANEL_WIDTH,
      onResize: setSidePanelWidth,
      origin: "left",
    })
  }

  const startAgentPanelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    startHorizontalResize(event, {
      initialWidth: agentPanelWidth,
      max: MAX_AGENT_PANEL_WIDTH,
      min: MIN_AGENT_PANEL_WIDTH,
      onResize: setAgentPanelWidth,
      origin: "right",
    })
  }

  const startTerminalResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    startVerticalResize(event, {
      initialHeight: terminalHeight,
      max: maxTerminalHeight(),
      min: MIN_TERMINAL_HEIGHT,
      onResize: setTerminalHeight,
      origin: "top",
    })
  }

  return {
    activeActivity,
    activeFile,
    activeFileContent,
    activeFileId,
    activeProject,
    activeTerminal,
    agentPanelWidth,
    closeFile,
    cursor,
    dirtyFileIds,
    messages,
    openFiles,
    selectFile,
    selectProject,
    sendAgentMessage,
    setActiveActivity,
    setActiveTerminalIdByProject,
    setCursor,
    sidePanelWidth,
    startAgentPanelResize,
    startSidePanelResize,
    startTerminalResize,
    terminalHeight,
    updateFileContent,
  }
}

type IdeShellState = ReturnType<typeof useIdeShellState>

function IdeShellLayout({ ide, projects }: { ide: IdeShellState; projects: Project[] }) {
  if (!ide.activeProject) {
    return null
  }
  return (
    <div className="app-safe-viewport grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground">
      <ProjectTabs activeProjectId={ide.activeProject.id} projects={projects} onProjectChange={ide.selectProject} />
      <IdeWorkspaceGrid ide={ide} />
      <StatusBar
        activeFile={ide.activeFile}
        activeTerminal={ide.activeTerminal}
        cursorColumn={ide.cursor.column}
        cursorLine={ide.cursor.line}
        project={ide.activeProject}
      />
    </div>
  )
}

function IdeWorkspaceGrid({ ide }: { ide: IdeShellState }) {
  return (
    <div className="grid min-h-0 min-w-0 overflow-hidden" style={{ gridTemplateColumns: String(ACTIVITY_BAR_WIDTH) + "px minmax(0, 1fr)" }}>
      <div className="min-h-0 overflow-hidden">
        {ide.activeProject ? <ActivityBar activeActivity={ide.activeActivity} project={ide.activeProject} onActivityChange={ide.setActiveActivity} /> : null}
      </div>
      <IdePanelGrid ide={ide} />
    </div>
  )
}

function IdePanelGrid({ ide }: { ide: IdeShellState }) {
  return (
    <div
      className="grid min-h-0 min-w-0 overflow-hidden rounded-tl-xl border-l border-t border-border bg-background"
      style={{
        gridTemplateColumns:
          String(ide.sidePanelWidth) + "px " +
          String(RESIZE_HANDLE_SIZE) + "px minmax(0, 1fr) " +
          String(RESIZE_HANDLE_SIZE) + "px " +
          String(ide.agentPanelWidth) + "px",
        gridTemplateRows: "minmax(0, 1fr) " + String(RESIZE_HANDLE_SIZE) + "px " + String(ide.terminalHeight) + "px",
      }}
    >
      <IdeSidePanel ide={ide} />
      <IdeSideResizeHandle ide={ide} />
      <IdeEditorPanel ide={ide} />
      <IdeAgentResizeHandle ide={ide} />
      <IdeAgentPanel ide={ide} />
      <IdeTerminalResizeHandle ide={ide} />
      <IdeTerminalPanel ide={ide} />
    </div>
  )
}

function IdeSidePanel({ ide }: { ide: IdeShellState }) {
  if (!ide.activeProject) {
    return null
  }
  return (
    <div className="min-h-0 min-w-0 overflow-hidden" style={{ gridColumn: "1", gridRow: "1" }}>
      {ide.activeActivity === "files" ? (
        <ExplorerPanel
          activeFileId={ide.activeFileId}
          dirtyFileIds={ide.dirtyFileIds}
          key={ide.activeProject.id + ":files"}
          project={ide.activeProject}
          onFileSelect={ide.selectFile}
        />
      ) : (
        <GitPanel key={ide.activeProject.id + ":git"} project={ide.activeProject} />
      )}
    </div>
  )
}

function IdeSideResizeHandle({ ide }: { ide: IdeShellState }) {
  return (
    <IdeResizeHandle
      label="side panel"
      orientation="vertical"
      style={{ gridColumn: "2", gridRow: "1" }}
      onPointerDown={ide.startSidePanelResize}
    />
  )
}

function IdeEditorPanel({ ide }: { ide: IdeShellState }) {
  if (!ide.activeProject) {
    return null
  }
  return (
    <div className="min-h-0 min-w-0 overflow-hidden" style={{ gridColumn: "3", gridRow: "1" }}>
      <EditorArea
        activeFile={ide.activeFile}
        activeFileContent={ide.activeFileContent}
        dirtyFileIds={ide.dirtyFileIds}
        openFiles={ide.openFiles}
        project={ide.activeProject}
        onCloseFile={ide.closeFile}
        onCursorChange={(line, column) => ide.setCursor({ column, line })}
        onFileContentChange={ide.updateFileContent}
        onFileSelect={ide.selectFile}
      />
    </div>
  )
}

function IdeAgentPanel({ ide }: { ide: IdeShellState }) {
  if (!ide.activeProject) {
    return null
  }
  return (
    <div className="min-h-0 min-w-0 overflow-hidden" style={{ gridColumn: "5", gridRow: "1 / -1" }}>
      <AgentPanel messages={ide.messages} project={ide.activeProject} onSendMessage={ide.sendAgentMessage} />
    </div>
  )
}

function IdeAgentResizeHandle({ ide }: { ide: IdeShellState }) {
  return (
    <IdeResizeHandle
      label="AI panel"
      orientation="vertical"
      style={{ gridColumn: "4", gridRow: "1 / -1" }}
      onPointerDown={ide.startAgentPanelResize}
    />
  )
}

function IdeTerminalPanel({ ide }: { ide: IdeShellState }) {
  if (!ide.activeProject) {
    return null
  }
  return (
    <div className="min-h-0 min-w-0 overflow-hidden" style={{ gridColumn: "1 / 4", gridRow: "3" }}>
      <TerminalPanel
        activeTerminalId={ide.activeTerminal?.id ?? null}
        terminals={ide.activeProject.terminals}
        onTerminalChange={(terminalId) =>
          ide.setActiveTerminalIdByProject((current) => ({ ...current, [ide.activeProject!.id]: terminalId }))
        }
      />
    </div>
  )
}

function IdeTerminalResizeHandle({ ide }: { ide: IdeShellState }) {
  return (
    <IdeResizeHandle
      label="terminal panel"
      orientation="horizontal"
      style={{ gridColumn: "1 / 4", gridRow: "2" }}
      onPointerDown={ide.startTerminalResize}
    />
  )
}

function IdeResizeHandle({
  label,
  orientation,
  style,
  onPointerDown,
}: {
  label: string
  orientation: "horizontal" | "vertical"
  style: CSSProperties
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      aria-label={`Resize ${label}`}
      className={[
        "relative z-20 min-h-0 min-w-0 bg-transparent outline-none after:absolute after:bg-transparent hover:after:bg-primary/30 focus-visible:after:bg-primary/60",
        orientation === "vertical"
          ? "h-full w-full cursor-col-resize after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2"
          : "h-full w-full cursor-row-resize after:left-1/2 after:top-1/2 after:h-px after:w-12 after:-translate-x-1/2 after:-translate-y-1/2",
      ].join(" ")}
      style={style}
      type="button"
      onPointerDown={onPointerDown}
    />
  )
}

function maxTerminalHeight() {
  if (typeof window === "undefined") {
    return MAX_TERMINAL_HEIGHT
  }
  return Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight - 180))
}
