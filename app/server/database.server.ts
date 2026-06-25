import { randomUUID } from "node:crypto"
import { prisma } from "./prisma.server"

let ensurePromise: Promise<void> | null = null

export function ensureDatabase(): Promise<void> {
  ensurePromise ??= setupDatabase()
  return ensurePromise
}

async function setupDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON")
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL")
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 30000")
  for (const statement of schemaStatements) {
    await prisma.$executeRawUnsafe(statement)
  }
  await ensureWorkspaceHistoryIds()
}

async function ensureWorkspaceHistoryIds(): Promise<void> {
  const columns = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("WorkspaceHistory")`)
  if (!columns.some((column) => column.name === "id")) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "WorkspaceHistory" ADD COLUMN "id" TEXT`)
  }
  const rows = await prisma.$queryRawUnsafe<{ id: string | null; path: string }[]>(
    `SELECT "path", "id" FROM "WorkspaceHistory" WHERE "id" IS NULL OR "id" = ''`,
  )
  for (const row of rows) {
    await prisma.$executeRawUnsafe(`UPDATE "WorkspaceHistory" SET "id" = ? WHERE "path" = ?`, randomUUID(), row.path)
  }
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceHistory_id_key" ON "WorkspaceHistory"("id")`)
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS "ProviderSetting" (
    "providerId" TEXT NOT NULL PRIMARY KEY,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "ProviderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "runtimeDefaults" JSONB NOT NULL DEFAULT '{}',
    "authState" JSONB,
    "lastAuthUrl" TEXT,
    "lastAuthMode" TEXT,
    "lastAuthLoginId" TEXT,
    "lastAuthUserCode" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "ProviderAccount_providerId_idx" ON "ProviderAccount"("providerId")`,
  `CREATE INDEX IF NOT EXISTS "ProviderAccount_status_idx" ON "ProviderAccount"("status")`,
  `CREATE TABLE IF NOT EXISTS "McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "transport" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "startupTimeoutSec" REAL,
    "toolTimeoutSec" REAL,
    "toolPolicy" JSONB NOT NULL DEFAULT '{}',
    "adapterSettings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "McpServer_name_key" ON "McpServer"("name")`,
  `CREATE TABLE IF NOT EXISTS "McpServerInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpServerInstallation_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "McpServerInstallation_serverId_providerId_accountId_key" ON "McpServerInstallation"("serverId", "providerId", "accountId")`,
  `CREATE INDEX IF NOT EXISTS "McpServerInstallation_providerId_accountId_idx" ON "McpServerInstallation"("providerId", "accountId")`,
  `CREATE TABLE IF NOT EXISTS "Chat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT,
    "autoRotateAccount" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "workingDirectory" TEXT,
    "model" TEXT,
    "reasoningEffort" TEXT,
    "serviceTier" TEXT,
    "collaborationMode" TEXT NOT NULL DEFAULT 'default',
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "externalThreadId" TEXT,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Chat_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ProviderAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "Chat_providerId_idx" ON "Chat"("providerId")`,
  `CREATE INDEX IF NOT EXISTS "Chat_accountId_idx" ON "Chat"("accountId")`,
  `CREATE INDEX IF NOT EXISTS "Chat_updatedAt_idx" ON "Chat"("updatedAt")`,
  `CREATE INDEX IF NOT EXISTS "Chat_lastActivityAt_idx" ON "Chat"("lastActivityAt")`,
  `CREATE INDEX IF NOT EXISTS "Chat_externalThreadId_idx" ON "Chat"("externalThreadId")`,
  `CREATE TABLE IF NOT EXISTS "ChatRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "request" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "externalTurnId" TEXT,
    "interruptRequestedAt" DATETIME,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatRun_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ProviderAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "ChatRun_chatId_createdAt_idx" ON "ChatRun"("chatId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ChatRun_providerId_idx" ON "ChatRun"("providerId")`,
  `CREATE INDEX IF NOT EXISTS "ChatRun_accountId_idx" ON "ChatRun"("accountId")`,
  `CREATE INDEX IF NOT EXISTS "ChatRun_externalTurnId_idx" ON "ChatRun"("externalTurnId")`,
  `CREATE TABLE IF NOT EXISTS "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "runId" TEXT,
    "sequence" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CHAT',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "turnId" TEXT,
    "itemId" TEXT,
    "requestId" TEXT,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "rawPayload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChatRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_chatId_sequence_key" ON "ChatMessage"("chatId", "sequence")`,
  `CREATE INDEX IF NOT EXISTS "ChatMessage_chatId_sequence_idx" ON "ChatMessage"("chatId", "sequence")`,
  `CREATE INDEX IF NOT EXISTS "ChatMessage_chatId_turnId_idx" ON "ChatMessage"("chatId", "turnId")`,
  `CREATE INDEX IF NOT EXISTS "ChatMessage_chatId_itemId_idx" ON "ChatMessage"("chatId", "itemId")`,
  `CREATE INDEX IF NOT EXISTS "ChatMessage_requestId_idx" ON "ChatMessage"("requestId")`,
  `CREATE INDEX IF NOT EXISTS "ChatMessage_runId_idx" ON "ChatMessage"("runId")`,
  `CREATE TABLE IF NOT EXISTS "MessageSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "workingDirectory" TEXT NOT NULL,
    "chatId" TEXT,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT,
    "model" TEXT,
    "reasoningEffort" TEXT,
    "serviceTier" TEXT,
    "collaborationMode" TEXT NOT NULL DEFAULT 'default',
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "goalObjective" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "recurrence" JSONB NOT NULL DEFAULT '{}',
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "MessageSchedule_workingDirectory_idx" ON "MessageSchedule"("workingDirectory")`,
  `CREATE INDEX IF NOT EXISTS "MessageSchedule_status_nextRunAt_idx" ON "MessageSchedule"("status", "nextRunAt")`,
  `CREATE INDEX IF NOT EXISTS "MessageSchedule_chatId_idx" ON "MessageSchedule"("chatId")`,
  `CREATE INDEX IF NOT EXISTS "MessageSchedule_accountId_idx" ON "MessageSchedule"("accountId")`,
  `CREATE TABLE IF NOT EXISTS "MessageScheduleRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "chatId" TEXT,
    "chatRunId" TEXT,
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MessageSchedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "MessageScheduleRun_scheduleId_scheduledFor_idx" ON "MessageScheduleRun"("scheduleId", "scheduledFor")`,
  `CREATE INDEX IF NOT EXISTS "MessageScheduleRun_chatId_idx" ON "MessageScheduleRun"("chatId")`,
  `CREATE INDEX IF NOT EXISTS "MessageScheduleRun_chatRunId_idx" ON "MessageScheduleRun"("chatRunId")`,
  `CREATE INDEX IF NOT EXISTS "MessageScheduleRun_status_idx" ON "MessageScheduleRun"("status")`,
  `CREATE TABLE IF NOT EXISTS "WorkspaceHistory" (
    "id" TEXT,
    "path" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "lastOpenedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "WorkspaceHistory_lastOpenedAt_idx" ON "WorkspaceHistory"("lastOpenedAt")`,
]
