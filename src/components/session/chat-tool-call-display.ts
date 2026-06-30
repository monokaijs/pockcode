import { FileText, Search, Terminal, Wrench, type LucideIcon } from "lucide-react"
import type { ChatMessageResponse } from "@/lib/api-client"
import { firstToolAction, parseFileChangeMessage, stripInlineCode } from "@/lib/session"

export function toolCallIcon(message: ChatMessageResponse): LucideIcon {
  if (message.kind === "FILE_CHANGE") {
    return FileText
  }
  if (message.kind === "COMMAND_EXECUTION") {
    const action = firstToolAction(message.content)
    if (action?.startsWith("read ") || action?.startsWith("list ")) {
      return FileText
    }
    if (action?.startsWith("search")) {
      return Search
    }
    return Terminal
  }
  if (message.content.toLowerCase().startsWith("web search")) {
    return Search
  }
  return Wrench
}

export function toolCallTitle(message: ChatMessageResponse): string {
  if (message.status === "STREAMING") {
    if (message.kind === "FILE_CHANGE") {
      const files = parseFileChangeMessage(message)
      if (files.length === 1) {
        return `Editing ${files[0].path}`
      }
      return files.length ? `Editing ${files.length} files` : "Editing files"
    }

    if (message.kind === "COMMAND_EXECUTION") {
      const action = firstToolAction(message.content)
      if (action?.startsWith("read ")) {
        return `Reading ${action.slice("read ".length)}`
      }
      if (action?.startsWith("list ")) {
        return `Reading ${action.slice("list ".length)}`
      }
      if (action?.startsWith("search")) {
        const detail = action.slice("search".length).trim()
        return detail ? `Searching ${detail}` : "Searching code"
      }
      const command = message.content.match(/~~~sh\n([\s\S]*?)\n~~~/u)?.[1]?.split(/\r?\n/u)[0]?.trim()
      return command ? `Running ${command}` : "Running command"
    }

    const firstLine = stripInlineCode(message.content.split(/\r?\n/u)[0]?.trim() || "tool")
      .replace(/\s+(inProgress|completed|failed|declined)$/u, "")
      .trim()
    const query = message.content.match(/~~~text\n([\s\S]*?)\n~~~/u)?.[1]?.split(/\r?\n/u)[0]?.trim()
    if (firstLine.toLowerCase().startsWith("web search")) {
      return query ? `Searching web for ${query}` : "Searching web"
    }
    if (firstLine.startsWith("MCP tool ")) {
      return `Using ${firstLine.slice("MCP tool ".length)}`
    }
    if (firstLine.startsWith("Tool ")) {
      return `Using ${firstLine.slice("Tool ".length)}`
    }
    if (firstLine.toLowerCase().startsWith("image generation")) {
      return "Generating image"
    }
    return `Using ${firstLine}`
  }

  if (message.kind === "FILE_CHANGE") {
    const files = parseFileChangeMessage(message)
    if (files.length === 1) {
      return `Edited ${files[0].path}`
    }
    return files.length ? `Edited ${files.length} files` : "Edited files"
  }

  if (message.kind === "COMMAND_EXECUTION") {
    const action = firstToolAction(message.content)
    if (action?.startsWith("read ")) {
      return `Read ${action.slice("read ".length)}`
    }
    if (action?.startsWith("list ")) {
      return `Listed ${action.slice("list ".length)}`
    }
    if (action?.startsWith("search")) {
      return "Searched code"
    }
    const command = message.content.match(/~~~sh\n([\s\S]*?)\n~~~/u)?.[1]?.split(/\r?\n/u)[0]?.trim()
    return command ? `Ran ${command}` : "Ran command"
  }

  return stripInlineCode(message.content.split(/\r?\n/u)[0]?.trim() || "Used tool")
}
