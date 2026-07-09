export type WorkspaceRunActionKind = "chat" | "terminal"

export type WorkspaceTerminalRunConfig = {
  command: string
  cwd?: string | null
  keepOpen?: boolean
  shell?: string | null
}

export type WorkspaceChatRunConfig = {
  message: string
  target: "current" | "new"
}

export type WorkspaceRunActionConfig = WorkspaceChatRunConfig | WorkspaceTerminalRunConfig

export type WorkspaceRunActionResponse = {
  config: WorkspaceRunActionConfig
  createdAt: string
  id: string
  kind: WorkspaceRunActionKind
  name: string
  updatedAt: string
  workspacePath: string
}

export type CreateWorkspaceRunActionRequest = {
  config: WorkspaceRunActionConfig
  kind: WorkspaceRunActionKind
  name: string
  workspacePath: string
}

export type UpdateWorkspaceRunActionRequest = {
  config?: WorkspaceRunActionConfig
  kind?: WorkspaceRunActionKind
  name?: string
}
