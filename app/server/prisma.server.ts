import "dotenv/config"
import { PrismaClient } from "@prisma/client"
import { ensureParentDirectory, resolvePockcodeDatabasePath, sqliteDatabaseUrl } from "./runtime-paths.server"

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient
}

const databasePath = resolvePockcodeDatabasePath()
process.env.DATABASE_URL = sqliteDatabaseUrl(databasePath)
ensureParentDirectory(databasePath)

const cachedPrisma = globalForPrisma.prisma

export const prisma =
  cachedPrisma && hasCurrentPrismaDelegates(cachedPrisma)
    ? cachedPrisma
    : createPrismaClient()

if (cachedPrisma && cachedPrisma !== prisma) {
  void cachedPrisma.$disconnect().catch(() => undefined)
}

function createPrismaClient(): PrismaClient {
  return (
  new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  })
  )
}

function hasCurrentPrismaDelegates(client: PrismaClient): boolean {
  const maybeClient = client as PrismaClient & {
    mcpServer?: unknown
    mcpServerInstallation?: unknown
  }
  return Boolean(maybeClient.mcpServer && maybeClient.mcpServerInstallation)
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
