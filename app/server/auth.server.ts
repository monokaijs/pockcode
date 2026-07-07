import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import type { IncomingMessage } from "node:http"
import { ensureParentDirectory, resolvePockcodeAuthPath } from "./runtime-paths.server"

const scrypt = promisify(scryptCallback)
const passwordKeyLength = 64
const passwordMinLength = 8
const sessionCookieName = "pockcode_session"
const sessionMaxAgeSeconds = 60 * 60 * 24 * 14
const scryptOptions = { N: 16_384, maxmem: 64 * 1024 * 1024, p: 1, r: 8 }

type SessionPayload = {
  expiresAt: number
  nonce: string
  version: 1
}

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

export async function isRequestAuthorized(req: IncomingMessage): Promise<boolean> {
  return await verifySessionCookie(req.headers.cookie) || await verifyBasicAuthorization(req.headers.authorization)
}

export async function verifyPassword(password: string): Promise<boolean> {
  const config = await readAuthConfig()
  if (!config) {
    return false
  }
  const expectedKey = Buffer.from(config.password.key, "base64")
  const salt = Buffer.from(config.password.salt, "base64")
  const key = await scrypt(password, salt, config.password.keyLength, config.password.scrypt) as Buffer
  return key.length === expectedKey.length && timingSafeEqual(key, expectedKey)
}

export async function createSessionCookie(req: IncomingMessage): Promise<string> {
  const config = await readAuthConfig()
  if (!config) {
    throw new Error("Pockcode password is not configured.")
  }
  const payload: SessionPayload = {
    version: 1,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: Date.now() + sessionMaxAgeSeconds * 1000,
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = signSessionPayload(encodedPayload, config)
  return serializeCookie(sessionCookieName, `${encodedPayload}.${signature}`, {
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds,
    path: "/",
    sameSite: "Lax",
    secure: isHttpsRequest(req),
  })
}

export function clearSessionCookie(): string {
  return serializeCookie(sessionCookieName, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
  })
}

async function verifySessionCookie(header: string | string[] | undefined): Promise<boolean> {
  const token = readCookie(header, sessionCookieName)
  if (!token) {
    return false
  }
  const [encodedPayload, signature, extra] = token.split(".")
  if (!encodedPayload || !signature || extra !== undefined) {
    return false
  }

  const config = await readAuthConfig()
  if (!config) {
    return false
  }
  const expectedSignature = signSessionPayload(encodedPayload, config)
  const signatureBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<SessionPayload>
    return payload.version === 1 &&
      typeof payload.nonce === "string" &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt > Date.now()
  } catch {
    return false
  }
}

function signSessionPayload(encodedPayload: string, config: AuthConfig): string {
  return createHmac("sha256", sessionSecret(config))
    .update(encodedPayload)
    .digest("base64url")
}

function sessionSecret(config: AuthConfig): Buffer {
  return Buffer.concat([
    Buffer.from(config.password.key, "base64"),
    Buffer.from(config.password.salt, "base64"),
    Buffer.from(config.password.createdAt, "utf8"),
  ])
}

function readCookie(header: string | string[] | undefined, name: string): string | null {
  const value = Array.isArray(header) ? header.join(";") : header
  if (!value) {
    return null
  }
  for (const part of value.split(";")) {
    const separatorIndex = part.indexOf("=")
    if (separatorIndex < 0) {
      continue
    }
    const key = part.slice(0, separatorIndex).trim()
    if (key !== name) {
      continue
    }
    return part.slice(separatorIndex + 1).trim() || null
  }
  return null
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean
    maxAge?: number
    path?: string
    sameSite?: "Lax" | "Strict" | "None"
    secure?: boolean
  },
): string {
  const parts = [`${name}=${value}`]
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`)
  }
  if (options.path) {
    parts.push(`Path=${options.path}`)
  }
  if (options.httpOnly) {
    parts.push("HttpOnly")
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`)
  }
  if (options.secure) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

function isHttpsRequest(req: IncomingMessage): boolean {
  const forwardedProto = Array.isArray(req.headers["x-forwarded-proto"])
    ? req.headers["x-forwarded-proto"][0]
    : req.headers["x-forwarded-proto"]
  return forwardedProto?.split(",")[0]?.trim() === "https" ||
    (req.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted === true
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
