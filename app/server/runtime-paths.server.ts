import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export function resolveHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return homedir()
  }
  if (inputPath.startsWith("~/")) {
    return join(homedir(), inputPath.slice(2))
  }
  return resolve(inputPath)
}

export function resolvePockcodeHome(): string {
  return resolveHomePath(process.env.POCKCODE_HOME?.trim() || "~/.pockcode")
}

export function resolvePockcodeDatabasePath(): string {
  return join(resolvePockcodeHome(), "pockcode.db")
}

export function sqliteDatabaseUrl(databasePath = resolvePockcodeDatabasePath()): string {
  return `file:${databasePath}?connection_limit=1&pool_timeout=30`
}

export function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
}

export function resolveProviderDataHome(providerId: string): string {
  return join(resolvePockcodeHome(), "providers", providerId)
}
