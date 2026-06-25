import type { ChatAttachmentRequest, ChatMessageResponse } from "@/lib/api-client"

export type FileNode = {
  children?: FileNode[]
  content?: string
  icon?: "docker" | "env" | "git" | "info" | "js" | "json" | "make" | "rust" | "shell" | "text"
  id: string
  language?: string
  name: string
  path?: string
  type: "folder" | "file"
}

export type MainMode = "chat" | "dialog" | "editor" | "schedule"

export type ManagementView = "instructions" | "mcpServers" | "providers"

export type MobileDrawer = "sessions" | "files" | null

export type PanelTab = "files" | "git"

export type SidebarTab = "chats" | "scheduler"

export type Workspace = {
  branch: string
  fileTree: FileNode[]
  id: string
  name: string
  path: string
  selectedFileId: string
}

export type FileSelectOptions = {
  column?: number
  lineNumber?: number
}

export type FileRevealTarget = FileSelectOptions & {
  fileId: string
  nonce: number
}

export type ChatFileLinkTarget = FileSelectOptions & {
  path: string
}

export type ChatComposerAccessMode = "askForApproval" | "fullAccess"

export type ChatComposerReasoningEffort = "extraHigh" | "high" | "low" | "medium"

export type ChatComposerServiceTier = "fast" | "standard"

export type ChatComposerAttachment = ChatAttachmentRequest & {
  id: string
}

export type ChatComposerSubmit = {
  attachments: ChatAttachmentRequest[]
  collaborationMode: string | null
  content: string
  delivery?: "queue" | "steer"
  goalObjective: string | null
  model: string | null
  permissionMode: ChatComposerAccessMode
  reasoningEffort: string | null
  serviceTier: string | null
}

export type UserInputQuestion = {
  header: string
  id: string
  isSecret: boolean
  options: { description: string; label: string }[]
  question: string
}

export type VisibleTreeItem = {
  level: number
  node: FileNode
  parentId?: string
}

export type ChatRenderEntry =
  | { type: "fileChange"; id: string; messages: ChatMessageResponse[] }
  | { type: "message"; message: ChatMessageResponse }
  | { type: "work"; completedAt?: string | null; finished: boolean; id: string; messages: ChatMessageResponse[]; startedAt?: string | null }

export type ParsedFileChange = {
  additions: number
  deletions: number
  path: string
}

export type MarkdownBlock =
  | { type: "blockquote"; lines: string[] }
  | { type: "code"; language: string; value: string }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "list"; items: string[]; ordered: boolean }
  | { type: "paragraph"; lines: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }

export type WorkRenderEntry =
  | { type: "actionGroup"; id: string; messages: ChatMessageResponse[] }
  | { type: "message"; message: ChatMessageResponse }

export type SessionRouteTarget = {
  chatId: string | null
  workspaceId: string | null
}

export type ProviderClientEvent = {
  payload: unknown
  threadId?: string
  type: string
}
