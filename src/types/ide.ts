export type ActivityId = "files" | "git"

export type FileNode = {
  children?: FileNode[]
  content?: string
  dirty?: boolean
  id: string
  language?: string
  name: string
  path: string
  type: "file" | "folder"
}

export type GitChange = {
  additions: number
  deletions: number
  path: string
  status: "modified" | "added" | "deleted" | "renamed" | "untracked"
}

export type AgentMessage = {
  content: string
  id: string
  meta?: string
  role: "user" | "assistant" | "system" | "tool"
  timestamp: string
  title?: string
}

export type TerminalSession = {
  cwd: string
  id: string
  lines: string[]
  name: string
  status: "running" | "idle" | "exited"
}

export type StatusState = {
  branch: string
  diagnostics: {
    errors: number
    warnings: number
  }
  encoding: string
  formatter: string
  indentation: string
}

export type Project = {
  agentMessages: AgentMessage[]
  gitChanges: GitChange[]
  id: string
  initialActiveFileId: string
  initialOpenFileIds: string[]
  name: string
  path: string
  status: StatusState
  terminals: TerminalSession[]
  tree: FileNode[]
}
