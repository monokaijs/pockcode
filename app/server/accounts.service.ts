import { Prisma, type ProviderAccount } from "@prisma/client"
import type {
  AccountAuthMode,
  AuthenticateProviderAccountResponse,
  CreateProviderAccountRequest,
  ProviderAccountLimitsResponse,
  ProviderAccountResponse,
  ProviderLimitsResponse,
  ProviderModelListResponse,
  UpdateProviderAccountRequest,
} from "../types/providers"
import type { JsonObject } from "../types/json"
import { ensureDatabase } from "./database.server"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"
import { getProviderAdapter } from "./providers/registry.server"
import type { ProviderAdapter } from "./providers/types.server"

export async function listAccounts(): Promise<ProviderAccountResponse[]> {
  await ensureDatabase()
  const accounts = await prisma.providerAccount.findMany({ orderBy: { createdAt: "asc" } })
  const prepared = await Promise.all(accounts.map(refreshAccountConnection))
  return prepared.map(serializeAccount)
}

export async function createAccount(dto: CreateProviderAccountRequest): Promise<ProviderAccountResponse> {
  await ensureDatabase()
  const adapter = getProviderAdapter(dto.providerId)
  const account = await prisma.providerAccount.create({
    data: {
      providerId: dto.providerId,
      displayName: normalizedDisplayName(dto.displayName, adapter.definition.label),
      settings: { ...adapter.defaultAccountSettings(), ...(dto.settings ?? {}) } as Prisma.InputJsonObject,
      runtimeDefaults: { ...adapter.defaultRuntimeDefaults(), ...(dto.runtimeDefaults ?? {}) } as Prisma.InputJsonObject,
    },
  })
  await adapter.prepareAccount(account)
  return serializeAccount(account)
}

export async function getAccount(accountId: string): Promise<ProviderAccount> {
  await ensureDatabase()
  const account = await prisma.providerAccount.findUnique({ where: { id: accountId } })
  if (!account) {
    throw new HttpError(404, "Provider account not found.")
  }
  return refreshAccountConnection(account)
}

export async function updateAccount(accountId: string, dto: UpdateProviderAccountRequest): Promise<ProviderAccountResponse> {
  const account = await getAccount(accountId)
  const adapter = getProviderAdapter(account.providerId)
  adapter.stopAccountRuntime(account.id)
  const updated = await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      displayName: dto.displayName,
      settings: dto.settings === undefined ? undefined : (dto.settings as Prisma.InputJsonObject),
      runtimeDefaults: dto.runtimeDefaults === undefined ? undefined : (dto.runtimeDefaults as Prisma.InputJsonObject),
    },
  })
  await adapter.prepareAccount(updated)
  return serializeAccount(updated)
}

export async function deleteAccount(accountId: string): Promise<ProviderAccountResponse> {
  const account = await getAccount(accountId)
  const adapter = getProviderAdapter(account.providerId)
  adapter.stopAccountRuntime(account.id)
  await prisma.chat.updateMany({ where: { accountId }, data: { accountId: null } })
  await prisma.chatRun.updateMany({ where: { accountId }, data: { accountId: null } })
  await prisma.mcpServerInstallation.deleteMany({ where: { accountId } })
  const deleted = await prisma.providerAccount.delete({ where: { id: accountId } })
  return serializeAccount(deleted)
}

export async function authenticateAccount(accountId: string, mode: AccountAuthMode = "browser"): Promise<AuthenticateProviderAccountResponse> {
  const account = await getAccount(accountId)
  const adapter = getProviderAdapter(account.providerId)
  await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      status: "AUTHENTICATING",
      lastAuthUrl: null,
      lastAuthMode: mode,
      lastAuthLoginId: null,
      lastAuthUserCode: null,
      lastError: null,
    },
  })
  const response = await adapter.authenticate(account, mode)
  await prisma.providerAccount.update({
    where: { id: accountId },
    data: await accountAuthData(account, adapter, response),
  })
  return response
}

export async function cancelAuthentication(accountId: string): Promise<ProviderAccountResponse> {
  const account = await getAccount(accountId)
  const adapter = getProviderAdapter(account.providerId)
  await adapter.cancelAuthentication(account)
  const updated = await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      status: account.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
      lastAuthUrl: null,
      lastAuthMode: null,
      lastAuthLoginId: null,
      lastAuthUserCode: null,
      lastError: null,
    },
  })
  return serializeAccount(updated)
}

export async function completeAuthentication(accountId: string, redirectUrl: string): Promise<AuthenticateProviderAccountResponse> {
  const account = await getAccount(accountId)
  const response = await getProviderAdapter(account.providerId).completeAuthentication(account, redirectUrl)
  const adapter = getProviderAdapter(account.providerId)
  await prisma.providerAccount.update({
    where: { id: accountId },
    data: await accountAuthData(account, adapter, response),
  })
  return response
}

export async function listAccountModels(accountId: string): Promise<ProviderModelListResponse> {
  const account = await requireConnectedAccount(accountId)
  return getProviderAdapter(account.providerId).listModels(account)
}

export async function readAccountLimits(accountId: string): Promise<ProviderLimitsResponse> {
  const account = await requireConnectedAccount(accountId)
  return getProviderAdapter(account.providerId).readLimits(account)
}

export async function readConnectedAccountLimits(): Promise<ProviderAccountLimitsResponse> {
  await ensureDatabase()
  const accounts = await prisma.providerAccount.findMany({
    orderBy: { createdAt: "asc" },
    where: { status: "CONNECTED" },
  })
  const data: Record<string, ProviderLimitsResponse> = {}
  const errors: Record<string, string> = {}
  for (const account of accounts) {
    try {
      data[account.id] = await getProviderAdapter(account.providerId).readLimits(account)
    } catch (error) {
      errors[account.id] = error instanceof Error ? error.message : "Unable to load limits."
    }
  }
  return {
    data,
    ...(Object.keys(errors).length ? { errors } : {}),
  }
}

export async function requireConnectedAccount(accountId: string): Promise<ProviderAccount> {
  const account = await getAccount(accountId)
  if (account.status !== "CONNECTED") {
    throw new HttpError(400, "Authenticate the provider account before using it.")
  }
  return account
}

export function serializeAccount(account: ProviderAccount): ProviderAccountResponse {
  return {
    id: account.id,
    providerId: account.providerId,
    displayName: account.displayName,
    status: account.status,
    settings: account.settings as JsonObject,
    runtimeDefaults: account.runtimeDefaults as JsonObject,
    authState: (account.authState as JsonObject | null) ?? null,
    lastAuthUrl: account.lastAuthUrl,
    lastAuthMode:
      account.lastAuthMode === "browser" || account.lastAuthMode === "device" || account.lastAuthMode === "local"
        ? account.lastAuthMode
        : null,
    lastAuthLoginId: account.lastAuthLoginId,
    lastAuthUserCode: account.lastAuthUserCode,
    lastError: account.lastError,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  }
}

async function refreshAccountConnection(account: ProviderAccount): Promise<ProviderAccount> {
  const adapter = getProviderAdapter(account.providerId)
  await adapter.prepareAccount(account)

  if (!adapter.isAccountConnected || !(await adapter.isAccountConnected(account))) {
    return account
  }

  if (account.status === "CONNECTED" && !usesDefaultDisplayName(account.displayName, adapter.definition.label)) {
    return account
  }

  return prisma.providerAccount.update({
    where: { id: account.id },
    data: {
      displayName: await connectedDisplayName(account, adapter),
      status: "CONNECTED",
      lastAuthUrl: null,
      lastAuthMode: null,
      lastAuthLoginId: null,
      lastAuthUserCode: null,
      lastError: null,
    },
  })
}

async function accountAuthData(
  account: ProviderAccount,
  adapter: ProviderAdapter,
  response: AuthenticateProviderAccountResponse,
): Promise<Prisma.ProviderAccountUpdateInput> {
  const accountForResponse =
    response.authState === undefined ? account : ({ ...account, authState: response.authState } as ProviderAccount)

  return {
    ...(response.status === "CONNECTED" ? { displayName: await connectedDisplayName(accountForResponse, adapter) } : {}),
    ...(response.authState === undefined ? {} : { authState: response.authState as Prisma.InputJsonObject }),
    status: response.status,
    lastAuthUrl: response.authUrl,
    lastAuthMode: response.authMode,
    lastAuthLoginId: response.loginId,
    lastAuthUserCode: response.userCode,
    lastError: response.status === "ERROR" ? response.message ?? "Authentication failed." : null,
  }
}

async function connectedDisplayName(account: ProviderAccount, adapter: ProviderAdapter): Promise<string | undefined> {
  if (!usesDefaultDisplayName(account.displayName, adapter.definition.label)) {
    return undefined
  }
  return (await adapter.readAccountAlias?.(account)) ?? undefined
}

function usesDefaultDisplayName(displayName: string, providerLabel: string): boolean {
  return displayName.trim() === normalizedDisplayName(undefined, providerLabel)
}

function normalizedDisplayName(displayName: string | undefined, providerLabel: string): string {
  return displayName?.trim() || `${providerLabel} account`
}
