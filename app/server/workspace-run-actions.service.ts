import { randomUUID } from "node:crypto"
import type {
  CreateWorkspaceRunActionRequest,
  UpdateWorkspaceRunActionRequest,
  WorkspaceChatRunConfig,
  WorkspaceRunActionConfig,
  WorkspaceRunActionKind,
  WorkspaceRunActionResponse,
  WorkspaceTerminalRunConfig,
} from "../types/run-actions"
import { ensureDatabase } from "./database.server"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"
import { resolveWorkspaceDirectoryPath } from "./workspaces.server"

type WorkspaceRunActionRow = {
  config: unknown
  createdAt: Date | string
  id: string
  kind: string
  name: string
  updatedAt: Date | string
  workspacePath: string
}

export async function listWorkspaceRunActions(workspacePathInput: string | null): Promise<WorkspaceRunActionResponse[]> {
  await ensureDatabase()
  const workspacePath = await resolveWorkspaceDirectoryPath(workspacePathInput)
  const rows = await prisma.$queryRaw<WorkspaceRunActionRow[]>`
    SELECT "id", "workspacePath", "name", "kind", "config", "createdAt", "updatedAt"
    FROM "WorkspaceRunAction"
    WHERE "workspacePath" = ${workspacePath}
    ORDER BY "updatedAt" DESC, "createdAt" DESC
  `
  return rows.map(serializeWorkspaceRunAction)
}

export async function createWorkspaceRunAction(dto: CreateWorkspaceRunActionRequest): Promise<WorkspaceRunActionResponse> {
  await ensureDatabase()
  const workspacePath = await resolveWorkspaceDirectoryPath(dto.workspacePath)
  const id = randomUUID()
  const config = normalizeRunActionConfig(dto.kind, dto.config)
  await prisma.$executeRaw`
    INSERT INTO "WorkspaceRunAction" ("id", "workspacePath", "name", "kind", "config", "createdAt", "updatedAt")
    VALUES (${id}, ${workspacePath}, ${normalizeRunActionName(dto.name)}, ${dto.kind}, ${JSON.stringify(config)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `
  return getWorkspaceRunAction(id)
}

export async function updateWorkspaceRunAction(
  actionId: string,
  dto: UpdateWorkspaceRunActionRequest,
): Promise<WorkspaceRunActionResponse> {
  await ensureDatabase()
  const current = await getWorkspaceRunAction(actionId)
  const kind = dto.kind ?? current.kind
  const config = normalizeRunActionConfig(kind, dto.config ?? current.config)
  const name = dto.name === undefined ? current.name : normalizeRunActionName(dto.name)
  await prisma.$executeRaw`
    UPDATE "WorkspaceRunAction"
    SET "name" = ${name}, "kind" = ${kind}, "config" = ${JSON.stringify(config)}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${actionId}
  `
  return getWorkspaceRunAction(actionId)
}

export async function deleteWorkspaceRunAction(actionId: string): Promise<{ id: string }> {
  await ensureDatabase()
  await prisma.$executeRaw`
    DELETE FROM "WorkspaceRunAction"
    WHERE "id" = ${actionId}
  `
  return { id: actionId }
}

async function getWorkspaceRunAction(actionId: string): Promise<WorkspaceRunActionResponse> {
  const rows = await prisma.$queryRaw<WorkspaceRunActionRow[]>`
    SELECT "id", "workspacePath", "name", "kind", "config", "createdAt", "updatedAt"
    FROM "WorkspaceRunAction"
    WHERE "id" = ${actionId}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) {
    throw new HttpError(404, "Run action not found.")
  }
  return serializeWorkspaceRunAction(row)
}

function serializeWorkspaceRunAction(row: WorkspaceRunActionRow): WorkspaceRunActionResponse {
  const kind = readRunActionKind(row.kind)
  return {
    config: normalizeRunActionConfig(kind, readJsonConfig(row.config)),
    createdAt: toIsoString(row.createdAt),
    id: row.id,
    kind,
    name: row.name,
    updatedAt: toIsoString(row.updatedAt),
    workspacePath: row.workspacePath,
  }
}

function normalizeRunActionName(value: string): string {
  const name = value.trim()
  if (!name) {
    throw new HttpError(400, "name is required.")
  }
  if (name.length > 120) {
    throw new HttpError(400, "name must be 120 characters or fewer.")
  }
  return name
}

function normalizeRunActionConfig(
  kind: WorkspaceRunActionKind,
  value: WorkspaceRunActionConfig | Record<string, unknown>,
): WorkspaceRunActionConfig {
  const record = readRecord(value)
  if (kind === "terminal") {
    const command = readString(record.command)
    if (!command) {
      throw new HttpError(400, "Terminal run actions require a command.")
    }
    return {
      command,
      cwd: readNullableString(record.cwd),
      keepOpen: record.keepOpen === true,
      shell: readNullableString(record.shell),
    } satisfies WorkspaceTerminalRunConfig
  }

  const message = readString(record.message)
  if (!message) {
    throw new HttpError(400, "Chat run actions require a message.")
  }
  return {
    message,
    target: record.target === "new" ? "new" : "current",
  } satisfies WorkspaceChatRunConfig
}

function readRunActionKind(value: unknown): WorkspaceRunActionKind {
  if (value === "chat" || value === "terminal") {
    return value
  }
  throw new HttpError(500, "Saved run action has an invalid kind.")
}

function readJsonConfig(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return readRecord(JSON.parse(value) as unknown)
    } catch {
      return {}
    }
  }
  return readRecord(value)
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function readNullableString(value: unknown): string | null {
  const text = readString(value)
  return text || null
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
