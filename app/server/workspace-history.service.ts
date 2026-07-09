import { randomUUID } from "node:crypto"
import type { WorkspaceHistoryResponse } from "../types/providers"
import { ensureDatabase } from "./database.server"
import { prisma } from "./prisma.server"
import { readWorkspaceTree } from "./workspaces.server"

type WorkspaceHistoryRow = {
  createdAt: Date | string
  id: string
  isOpen: boolean | number | string
  lastOpenedAt: Date | string
  name: string
  path: string
  updatedAt: Date | string
}

export async function listWorkspaceHistory(): Promise<WorkspaceHistoryResponse[]> {
  await ensureDatabase()
  const rows = await prisma.$queryRaw<WorkspaceHistoryRow[]>`
    SELECT "id", "path", "name", "isOpen", "lastOpenedAt", "createdAt", "updatedAt"
    FROM "WorkspaceHistory"
    ORDER BY "lastOpenedAt" DESC
  `
  return rows.map(serializeWorkspaceHistory)
}

export async function saveWorkspaceHistory(inputPath: string): Promise<WorkspaceHistoryResponse> {
  await ensureDatabase()
  const tree = await readWorkspaceTree(inputPath, false)
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "WorkspaceHistory" ("id", "path", "name", "isOpen", "lastOpenedAt", "createdAt", "updatedAt")
    VALUES (${id}, ${tree.path}, ${tree.name}, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT("path") DO UPDATE SET
      "name" = excluded."name",
      "isOpen" = true,
      "lastOpenedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
  `
  return readWorkspaceHistory(tree.path)
}

export async function closeWorkspaceHistory(inputPath: string): Promise<{ path: string }> {
  await ensureDatabase()
  await prisma.$executeRaw`
    UPDATE "WorkspaceHistory"
    SET "isOpen" = false, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "path" = ${inputPath}
  `
  return { path: inputPath }
}

async function readWorkspaceHistory(path: string): Promise<WorkspaceHistoryResponse> {
  const rows = await prisma.$queryRaw<WorkspaceHistoryRow[]>`
    SELECT "id", "path", "name", "isOpen", "lastOpenedAt", "createdAt", "updatedAt"
    FROM "WorkspaceHistory"
    WHERE "path" = ${path}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) {
    throw new Error("Workspace history was not saved.")
  }
  return serializeWorkspaceHistory(row)
}

function serializeWorkspaceHistory(row: WorkspaceHistoryRow): WorkspaceHistoryResponse {
  return {
    id: row.id,
    isOpen: readBoolean(row.isOpen),
    path: row.path,
    name: row.name,
    lastOpenedAt: toIsoString(row.lastOpenedAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function readBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}
