import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { HttpError } from "./http.server"

const execFileAsync = promisify(execFile)
const workspaceRoot = realpathSync(homedir())

export type GitFileChange = {
  indexStatus: string
  originalPath?: string
  path: string
  staged: boolean
  status: "added" | "deleted" | "modified" | "renamed" | "untracked"
  workingTreeStatus: string
}

export type GitCommitEntry = {
  author: string
  hash: string
  refs: string
  subject: string
}

export type GitStatusResponse = {
  ahead: number
  behind: number
  branch: string
  changes: GitFileChange[]
  commits: GitCommitEntry[]
  isRepository: boolean
  message?: string
  upstream?: string
}

export async function readGitStatus(inputPath: string | undefined): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  const repository = await isGitRepository(cwd)
  if (!repository) {
    return {
      ahead: 0,
      behind: 0,
      branch: "No repository",
      changes: [],
      commits: [],
      isRepository: false,
      message: "This workspace is not initialized as a Git repository.",
    }
  }

  const status = await runGit(cwd, ["status", "--short", "--branch"])
  const commits = await readGitLog(cwd)
  return {
    ...parseGitStatus(status.stdout),
    commits,
    isRepository: true,
  }
}

export async function initGitRepository(inputPath: string | undefined): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  await runGit(cwd, ["init"])
  return readGitStatus(cwd)
}

export async function stageGitPaths(inputPath: string | undefined, paths: string[]): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  await ensureGitRepository(cwd)
  await runGit(cwd, ["add", "--", ...(paths.length ? paths : ["."])])
  return readGitStatus(cwd)
}

export async function unstageGitPaths(inputPath: string | undefined, paths: string[]): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  await ensureGitRepository(cwd)
  await runGit(cwd, ["restore", "--staged", "--", ...(paths.length ? paths : ["."])])
  return readGitStatus(cwd)
}

export async function discardGitPaths(inputPath: string | undefined, paths: string[]): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  await ensureGitRepository(cwd)
  const targets = paths.length ? paths : ["."]
  await runGit(cwd, ["restore", "--staged", "--worktree", "--", ...targets]).catch(() => undefined)
  await runGit(cwd, ["clean", "-f", "--", ...targets]).catch(() => undefined)
  return readGitStatus(cwd)
}

export async function commitGitChanges(inputPath: string | undefined, message: string): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  await ensureGitRepository(cwd)
  if (!message.trim()) {
    throw new HttpError(400, "Commit message is required.")
  }
  await runGit(cwd, ["commit", "-m", message.trim()])
  return readGitStatus(cwd)
}

export async function pullGitRepository(inputPath: string | undefined): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  await ensureGitRepository(cwd)
  await runGit(cwd, ["pull", "--ff-only"])
  return readGitStatus(cwd)
}

export async function pushGitRepository(inputPath: string | undefined): Promise<GitStatusResponse> {
  const cwd = await resolveWorkspacePath(inputPath)
  await ensureGitRepository(cwd)
  await runGit(cwd, ["push"])
  return readGitStatus(cwd)
}

async function ensureGitRepository(cwd: string): Promise<void> {
  if (!await isGitRepository(cwd)) {
    throw new HttpError(400, "This workspace is not initialized as a Git repository.")
  }
}

async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])
    return result.stdout.trim() === "true"
  } catch {
    return false
  }
}

function parseGitStatus(output: string): Omit<GitStatusResponse, "commits" | "isRepository" | "message"> {
  const lines = output.split(/\r?\n/).filter(Boolean)
  const branchLine = lines[0]?.startsWith("## ") ? lines.shift() ?? "" : ""
  const branch = parseBranchLine(branchLine)
  return {
    ...branch,
    changes: lines.map(parseStatusLine).filter((change): change is GitFileChange => Boolean(change)),
  }
}

function parseBranchLine(line: string): Pick<GitStatusResponse, "ahead" | "behind" | "branch" | "upstream"> {
  const text = line.replace(/^##\s+/, "")
  const [left, tracking = ""] = text.split("...")
  const branch = left || "HEAD"
  const upstream = tracking.replace(/\s+\[.*\]$/, "") || undefined
  const ahead = Number.parseInt(tracking.match(/ahead (\d+)/)?.[1] ?? "0", 10)
  const behind = Number.parseInt(tracking.match(/behind (\d+)/)?.[1] ?? "0", 10)
  return { ahead, behind, branch, upstream }
}

function parseStatusLine(line: string): GitFileChange | null {
  const indexStatus = line[0] ?? " "
  const workingTreeStatus = line[1] ?? " "
  const rawPath = line.slice(3)
  if (!rawPath) {
    return null
  }
  const [originalPath, pathName] = rawPath.includes(" -> ")
    ? rawPath.split(" -> ", 2)
    : [undefined, rawPath]
  const statusCode = indexStatus !== " " && indexStatus !== "?" ? indexStatus : workingTreeStatus
  return {
    indexStatus,
    originalPath,
    path: pathName,
    staged: indexStatus !== " " && indexStatus !== "?",
    status: statusFromCode(statusCode),
    workingTreeStatus,
  }
}

function statusFromCode(code: string): GitFileChange["status"] {
  if (code === "?") return "untracked"
  if (code === "A") return "added"
  if (code === "D") return "deleted"
  if (code === "R") return "renamed"
  return "modified"
}

async function readGitLog(cwd: string): Promise<GitCommitEntry[]> {
  try {
    const result = await runGit(cwd, ["log", "--date-order", "--decorate=short", "--pretty=format:%h%x09%D%x09%s%x09%an", "-n", "16"])
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash = "", refs = "", subject = "", author = ""] = line.split("\t")
      return { author, hash, refs, subject }
    })
  } catch {
    return []
  }
}

async function runGit(cwd: string, args: string[]) {
  try {
    return await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git command failed."
    throw new HttpError(400, message.replace(/^Command failed: git [^\n]+\n?/, "").trim() || "Git command failed.")
  }
}

async function resolveWorkspacePath(inputPath: string | undefined) {
  const requested = inputPath?.trim()
  if (!requested) {
    throw new HttpError(400, "path is required.")
  }
  const resolvedPath = await resolveRealPath(resolveUserPath(requested))
  if (!isPathWithinWorkspaceRoot(resolvedPath)) {
    throw new HttpError(403, "Path is outside the file browser home.")
  }
  const stats = await stat(resolvedPath)
  if (!stats.isDirectory()) {
    throw new HttpError(400, "Path is not a directory.")
  }
  return resolvedPath
}

async function resolveRealPath(inputPath: string) {
  try {
    return await realpath(path.resolve(inputPath))
  } catch {
    throw new HttpError(400, "Directory path does not exist.")
  }
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

function isPathWithinWorkspaceRoot(inputPath: string) {
  const relativePath = path.relative(workspaceRoot, inputPath)
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}
