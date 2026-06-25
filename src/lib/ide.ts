import type { FileNode } from "@/types/ide"

export function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "file") {
      return [node]
    }
    return flattenFiles(node.children ?? [])
  })
}

export function findFile(nodes: FileNode[], fileId: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === fileId && node.type === "file") {
      return node
    }
    if (node.children) {
      const match = findFile(node.children, fileId)
      if (match) {
        return match
      }
    }
  }
  return null
}

export function getFileExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".")
  return index >= 0 ? fileName.slice(index + 1) : "txt"
}

export function languageLabel(language?: string): string {
  if (!language) {
    return "Plain Text"
  }
  const labels: Record<string, string> = {
    css: "CSS",
    html: "HTML",
    javascript: "JavaScript",
    json: "JSON",
    markdown: "Markdown",
    shell: "Shell",
    typescript: "TypeScript",
  }
  return labels[language] ?? language
}
