import "dotenv/config"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export async function setupSqliteDatabase() {
  const databasePath = resolvePockcodeDatabasePath()
  process.env.DATABASE_URL = sqliteDatabaseUrl(databasePath)
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 })
  const { PrismaClient } = await import("@prisma/client")
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
  try {
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON")
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL")
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 30000")
  } finally {
    await prisma.$disconnect()
  }
}

function resolvePockcodeDatabasePath() {
  return join(resolveHomePath(process.env.POCKCODE_HOME?.trim() || "~/.pockcode"), "pockcode.db")
}

function resolveHomePath(inputPath) {
  if (inputPath === "~") {
    return homedir()
  }
  if (inputPath.startsWith("~/")) {
    return join(homedir(), inputPath.slice(2))
  }
  return resolve(inputPath)
}

function sqliteDatabaseUrl(databasePath) {
  return `file:${databasePath}?connection_limit=1&pool_timeout=30`
}
