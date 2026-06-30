import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import type { IncomingMessage } from "node:http"
import { ensureParentDirectory, resolvePockcodeAuthPath } from "./runtime-paths.server"

const scrypt = promisify(scryptCallback)
const passwordKeyLength = 64
const passwordMinLength = 8
const scryptOptions = { N: 16_384, maxmem: 64 * 1024 * 1024, p: 1, r: 8 }

type PasswordRecord = {
  algorithm: "scrypt"
  createdAt: string
  key: string
  keyLength: number
  salt: string
  scrypt: typeof scryptOptions
}

type AuthConfig = {
  password: PasswordRecord
  version: 1
}

let authConfigCache: AuthConfig | null | undefined

export async function hasConfiguredPassword(): Promise<boolean> {
  return Boolean(await readAuthConfig())
}

export async function setupPassword(password: string): Promise<void> {
  const normalized = password.trim()
  if (normalized.length < passwordMinLength) {
    throw new Error(`Password must be at least ${passwordMinLength} characters.`)
  }
  if (await readAuthConfig()) {
    throw new Error("Pockcode password is already configured.")
  }

  const salt = randomBytes(16)
  const key = await scrypt(normalized, salt, passwordKeyLength, scryptOptions) as Buffer
  const config: AuthConfig = {
    version: 1,
    password: {
      algorithm: "scrypt",
      createdAt: new Date().toISOString(),
      key: key.toString("base64"),
      keyLength: passwordKeyLength,
      salt: salt.toString("base64"),
      scrypt: scryptOptions,
    },
  }
  const authPath = resolvePockcodeAuthPath()
  ensureParentDirectory(authPath)
  const tmpPath = `${authPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(tmpPath, authPath)
  authConfigCache = config
}

export async function verifyBasicAuthorization(header: string | string[] | undefined): Promise<boolean> {
  const value = Array.isArray(header) ? header[0] : header
  if (!value?.startsWith("Basic ")) {
    return false
  }

  let decoded = ""
  try {
    decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8")
  } catch {
    return false
  }
  const separatorIndex = decoded.indexOf(":")
  if (separatorIndex < 0) {
    return false
  }
  return verifyPassword(decoded.slice(separatorIndex + 1))
}

export function pockcodeAuthRealm(): string {
  return "pockcode"
}

export async function isRequestAuthorized(req: IncomingMessage): Promise<boolean> {
  return verifyBasicAuthorization(req.headers.authorization)
}

async function verifyPassword(password: string): Promise<boolean> {
  const config = await readAuthConfig()
  if (!config) {
    return false
  }
  const expectedKey = Buffer.from(config.password.key, "base64")
  const salt = Buffer.from(config.password.salt, "base64")
  const key = await scrypt(password, salt, config.password.keyLength, config.password.scrypt) as Buffer
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey)
}

async function readAuthConfig(): Promise<AuthConfig | null> {
  if (authConfigCache !== undefined) {
    return authConfigCache
  }
  const authPath = resolvePockcodeAuthPath()
  try {
    const value = JSON.parse(await readFile(authPath, "utf8")) as unknown
    authConfigCache = readConfig(value)
  } catch {
    authConfigCache = null
  }
  return authConfigCache
}

function readConfig(value: unknown): AuthConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const record = value as Partial<AuthConfig>
  const password = record.password
  if (
    record.version !== 1 ||
    !password ||
    password.algorithm !== "scrypt" ||
    typeof password.key !== "string" ||
    typeof password.salt !== "string" ||
    typeof password.keyLength !== "number" ||
    !password.scrypt ||
    typeof password.scrypt.N !== "number" ||
    typeof password.scrypt.r !== "number" ||
    typeof password.scrypt.p !== "number"
  ) {
    return null
  }
  return record as AuthConfig
}
