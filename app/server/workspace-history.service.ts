import { randomUUID } from "node:crypto"
import type { WorkspaceHistoryResponse } from "../types/providers"
import { ensureDatabase } from "./database.server"
import { prisma } from "./prisma.server"
import { readWorkspaceTree } from "./workspaces.server"

type WorkspaceHistoryRow = {
  createdAt: Date | string
  id: string
  lastOpenedAt: Date | string
  name: string
  path: string
  updatedAt: Date | string
}

export async function listWorkspaceHistory(): Promise<WorkspaceHistoryResponse[]> {
  await ensureDatabase()
  const rows = await prisma.$queryRaw<WorkspaceHistoryRow[]>`
    SELECT "id", "path", "name", "lastOpenedAt", "createdAt", "updatedAt"
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
    INSERT INTO "WorkspaceHistory" ("id", "path", "name", "lastOpenedAt", "createdAt", "updatedAt")
    VALUES (${id}, ${tree.path}, ${tree.name}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT("path") DO UPDATE SET
      "name" = excluded."name",
      "lastOpenedAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
  `
  return readWorkspaceHistory(tree.path)
}

export async function deleteWorkspaceHistory(inputPath: string): Promise<{ path: string }> {
  await ensureDatabase()
  await prisma.$executeRaw`DELETE FROM "WorkspaceHistory" WHERE "path" = ${inputPath}`
  return { path: inputPath }
}

async function readWorkspaceHistory(path: string): Promise<WorkspaceHistoryResponse> {
  const rows = await prisma.$queryRaw<WorkspaceHistoryRow[]>`
    SELECT "id", "path", "name", "lastOpenedAt", "createdAt", "updatedAt"
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
