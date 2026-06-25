import { realpathSync } from "node:fs"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { HttpError } from "./http.server"

const workspaceRoot = realpathSync(homedir())
const maxDirectoryEntries = 500
const maxTextFileBytes = 256 * 1024
const skippedDirectoryNames = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
])

type WorkspaceEntryType = "directory" | "file" | "symlink"

export type WorkspaceEntry = {
  content?: string
  error?: string
  name: string
  path: string
  type: WorkspaceEntryType
}

export type WorkspaceTreeEntry = WorkspaceEntry & {
  children?: WorkspaceTreeEntry[]
}

export type WorkspaceResource = WorkspaceEntry & {
  content: string
}

export async function listWorkspaceDirectory(inputPath: string | null, includeHidden: boolean) {
  const directoryPath = await resolveWorkspacePath(inputPath)
  const entries = await readDirectoryEntries(directoryPath)
  return {
    root: workspaceRoot,
    path: directoryPath,
    parentPath: path.dirname(directoryPath) === directoryPath ? null : path.dirname(directoryPath),
    entries: entries
      .filter((entry) => includeHidden || !isHiddenEntry(entry.name))
      .map((entry) => toWorkspaceEntry(directoryPath, entry.name, entry.isDirectory(), entry.isSymbolicLink()))
      .sort(sortWorkspaceEntries)
      .slice(0, maxDirectoryEntries),
  }
}

export async function readWorkspaceTree(inputPath: string | null, includeHidden: boolean): Promise<WorkspaceTreeEntry> {
  const directoryPath = await resolveWorkspacePath(inputPath)
  return readWorkspaceTreeDirectory(directoryPath, includeHidden)
}

export async function readWorkspaceResource(inputPath: string | null): Promise<WorkspaceResource> {
  const filePath = await resolveWorkspaceFilePath(inputPath)
  const name = path.basename(filePath)
  const stats = await readStats(filePath)

  if (stats.size > maxTextFileBytes) {
    return {
      content: `File too large to preview (${formatBytes(stats.size)}).`,
      name,
      path: filePath,
      type: "file",
    }
  }

  if (!isTextFileName(name)) {
    throw new HttpError(415, "Only text files can be opened.")
  }

  try {
    return {
      content: await readFile(filePath, "utf8"),
      name,
      path: filePath,
      type: "file",
    }
  } catch (error) {
    throw new HttpError(400, readError(error))
  }
}

export async function resolveWorkspaceDirectoryPath(inputPath: string | null): Promise<string> {
  return resolveWorkspacePath(inputPath)
}

async function resolveWorkspacePath(inputPath: string | null) {
  const requested = inputPath?.trim()
  const unresolvedPath = requested ? resolveUserPath(requested) : workspaceRoot
  const resolvedPath = await resolveRealPath(unresolvedPath)
  if (!isPathWithinWorkspaceRoot(resolvedPath)) {
    throw new HttpError(403, "Path is outside the file browser home.")
  }

  const stats = await readStats(resolvedPath)
  if (!stats.isDirectory()) {
    throw new HttpError(400, "Path is not a directory.")
  }
  return resolvedPath
}

async function resolveWorkspaceFilePath(inputPath: string | null) {
  const requested = inputPath?.trim()
  if (!requested) {
    throw new HttpError(400, "path is required.")
  }
  const resolvedPath = await resolveRealPath(resolveUserPath(requested))
  if (!isPathWithinWorkspaceRoot(resolvedPath)) {
    throw new HttpError(403, "Path is outside the file browser home.")
  }

  const stats = await readStats(resolvedPath)
  if (!stats.isFile()) {
    throw new HttpError(400, "Path is not a file.")
  }
  return resolvedPath
}

async function readWorkspaceTreeDirectory(directoryPath: string, includeHidden: boolean): Promise<WorkspaceTreeEntry> {
  const name = path.basename(directoryPath) || directoryPath
  const entry: WorkspaceTreeEntry = {
    name,
    path: directoryPath,
    type: "directory",
    children: [],
  }

  const children = await readTreeDirectoryEntries(directoryPath, entry)

  for (const child of children
    .filter((entry) => includeHidden || !isHiddenEntry(entry.name))
    .sort((left, right) => sortWorkspaceEntries(toWorkspaceEntry(directoryPath, left.name, left.isDirectory(), left.isSymbolicLink()), toWorkspaceEntry(directoryPath, right.name, right.isDirectory(), right.isSymbolicLink())))
    .slice(0, maxDirectoryEntries)) {
    if (child.isSymbolicLink()) {
      entry.children?.push(toWorkspaceEntry(directoryPath, child.name, false, true))
      continue
    }

    if (child.isDirectory()) {
      if (!skippedDirectoryNames.has(child.name)) {
        entry.children?.push(toWorkspaceEntry(directoryPath, child.name, true, false))
      }
      continue
    }

    entry.children?.push(toWorkspaceEntry(directoryPath, child.name, false, false))
  }

  return entry
}

function toWorkspaceEntry(parentPath: string, name: string, isDirectory: boolean, isSymlink: boolean): WorkspaceEntry {
  return {
    name,
    path: path.join(parentPath, name),
    type: isDirectory ? "directory" : isSymlink ? "symlink" : "file",
  }
}

function sortWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry) {
  if (left.type === "directory" && right.type !== "directory") {
    return -1
  }
  if (left.type !== "directory" && right.type === "directory") {
    return 1
  }
  return left.name.localeCompare(right.name)
}

function resolveUserPath(inputPath: string) {
  if (inputPath === "~") {
    return workspaceRoot
  }
  if (inputPath.startsWith("~/")) {
    return path.join(workspaceRoot, inputPath.slice(2))
  }
  if (path.isAbsolute(inputPath)) {
    return inputPath
  }
  return path.join(workspaceRoot, inputPath)
}

async function resolveRealPath(inputPath: string) {
  try {
    return await realpath(path.resolve(inputPath))
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new HttpError(400, "Directory path does not exist.")
    }
    throw new HttpError(400, readError(error))
  }
}

async function readStats(inputPath: string) {
  try {
    return await stat(inputPath)
  } catch (error) {
    throw new HttpError(400, readError(error))
  }
}

async function readDirectoryEntries(directoryPath: string) {
  try {
    return await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    throw new HttpError(400, readError(error))
  }
}

async function readTreeDirectoryEntries(directoryPath: string, entry: WorkspaceTreeEntry) {
  try {
    return await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    entry.error = readError(error)
    return []
  }
}

function isPathWithinWorkspaceRoot(inputPath: string) {
  const relativePath = path.relative(workspaceRoot, inputPath)
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}

function isHiddenEntry(name: string) {
  return name.startsWith(".")
}

function isTextFileName(name: string) {
  return /(?:\.([cm]?[jt]sx?|json|md|txt|css|html?|ya?ml|toml|rs|sh|env|gitignore|dockerignore)|^Makefile$|^Dockerfile$|^\.env)/i.test(name)
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Request failed."
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
