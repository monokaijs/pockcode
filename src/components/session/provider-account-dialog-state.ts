import { useEffect, useMemo, useState } from "react"
import {
  apiClient,
  type AccountAuthMode,
  type AuthenticateProviderAccountResponse,
  type ProviderAccountResponse,
  type ProviderDefinitionResponse,
  type ProviderModelListResponse,
} from "@/lib/api-client"
import {
  composerAccessModeValue,
  composerReasoningEffortValue,
  composerServiceTierValue,
  defaultModelOptionsForProvider,
  defaultRuntimeDefaultValue,
  delay,
  formatJson,
  mergeProviderModelOptions,
  parseJsonRecord,
  readClaudeConfigDirValue,
  readCodexHomeValue,
  readCodexPersonalityValue,
  readComposerAccessMode,
  readDefaultClaudeConfigDirValue,
  readComposerReasoningEffort,
  readComposerServiceTier,
  readDefaultCodexHomeValue,
  readError,
  readRecord,
  readRecordString,
  readSharedCodexHomeValue,
  withoutRecordKeys,
} from "@/lib/session"
import type { ChatComposerAccessMode, ChatComposerReasoningEffort, ChatComposerServiceTier } from "@/types/session"

type ProviderAccountNotice = { details?: Record<string, unknown> | null; kind: "error" | "info"; text: string }

export function useProviderAccountDialogState(
  account: ProviderAccountResponse | null,
  provider: ProviderDefinitionResponse | null,
  onAccountChange: (account: ProviderAccountResponse) => void,
  onAccountDelete: (accountId: string) => void,
  onReload: () => Promise<void>,
) {
  const [authenticating, setAuthenticating] = useState(false)
  const [authMenuOpen, setAuthMenuOpen] = useState(false)
  const [claudeConfigDir, setClaudeConfigDir] = useState("")
  const [codexHome, setCodexHome] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<ChatComposerAccessMode>("askForApproval")
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<ChatComposerReasoningEffort>("medium")
  const [defaultServiceTier, setDefaultServiceTier] = useState<ChatComposerServiceTier>("standard")
  const [deleting, setDeleting] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [modelOptions, setModelOptions] = useState<ProviderModelListResponse["data"]>([])
  const [notice, setNotice] = useState<ProviderAccountNotice | null>(null)
  const [personality, setPersonality] = useState<"friendly" | "pragmatic">("pragmatic")
  const [runtimeDefaultsJson, setRuntimeDefaultsJson] = useState("{}")
  const [saving, setSaving] = useState(false)
  const [settingsJson, setSettingsJson] = useState("{}")
  const hasDefaultModelField = Boolean(provider?.capabilities.includes("models") && provider.runtimeFields.some((field) => field.key === "model"))
  const hasDefaultPermissionField = Boolean(provider?.runtimeFields.some((field) => field.key === "permissionMode"))
  const hasDefaultReasoningField = Boolean(provider?.runtimeFields.some((field) => field.key === "reasoningEffort"))
  const hasDefaultServiceTierField = Boolean(provider?.runtimeFields.some((field) => field.key === "serviceTier"))
  const runtimeDefaultStructuredKeys = useMemo(
    () => [
      hasDefaultModelField ? "model" : null,
      hasDefaultPermissionField ? "permissionMode" : null,
      hasDefaultReasoningField ? "reasoningEffort" : null,
      hasDefaultServiceTierField ? "serviceTier" : null,
    ].filter((key): key is string => Boolean(key)),
    [hasDefaultModelField, hasDefaultPermissionField, hasDefaultReasoningField, hasDefaultServiceTierField],
  )

  useEffect(() => {
    if (!account || !provider) {
      return
    }
    setAuthMenuOpen(false)
    setClaudeConfigDir(readClaudeConfigDirValue(account, provider))
    setCodexHome(readCodexHomeValue(account, provider))
    setDefaultModel(readRecordString(account.runtimeDefaults, "model") || defaultRuntimeDefaultValue(provider.id, "model") || (defaultModelOptionsForProvider(provider.id)[0]?.model ?? ""))
    setDefaultPermissionMode(readComposerAccessMode(readRecordString(account.runtimeDefaults, "permissionMode") || defaultRuntimeDefaultValue(provider.id, "permissionMode")))
    setDefaultReasoningEffort(readComposerReasoningEffort(readRecordString(account.runtimeDefaults, "reasoningEffort") || defaultRuntimeDefaultValue(provider.id, "reasoningEffort")))
    setDefaultServiceTier(readComposerServiceTier(readRecordString(account.runtimeDefaults, "serviceTier") || defaultRuntimeDefaultValue(provider.id, "serviceTier")))
    setDisplayName(account.displayName)
    setPersonality(readCodexPersonalityValue(account.settings))
    setRuntimeDefaultsJson(formatJson(withoutRecordKeys(account.runtimeDefaults, runtimeDefaultStructuredKeys)))
    setSettingsJson(formatJson(withoutRecordKeys(account.settings, ["claudeConfigDir", "codexHome", "personality"])))
    setNotice(readAccountErrorNotice(account))
  }, [account, provider, runtimeDefaultStructuredKeys])

  useEffect(() => {
    let cancelled = false
    setModelOptions(defaultModelOptionsForProvider(provider?.id))
    if (!account || !hasDefaultModelField || account.status !== "CONNECTED") {
      return
    }
    apiClient.providerAccounts.models(account.id)
      .then((response) => {
        if (!cancelled) {
          setModelOptions(response.data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions(defaultModelOptionsForProvider(provider?.id))
        }
      })
    return () => {
      cancelled = true
    }
  }, [account?.id, account?.status, hasDefaultModelField, provider?.id])

  const usingSharedCodexHome = account ? readRecordString(account.authState, "codexHomeMode") === "shared" : false
  const defaultClaudeConfigDir = account && provider ? readDefaultClaudeConfigDirValue(account, provider) : ""
  const defaultCodexHome = account && provider ? readDefaultCodexHomeValue(account, provider) : ""
  const sharedCodexHome = provider ? readSharedCodexHomeValue(provider) : ""

  function readConfigDraft() {
    if (!account || !provider) {
      throw new Error("No provider account selected.")
    }
    const settings = parseJsonRecord(settingsJson, "Settings") as ProviderAccountResponse["settings"]
    const runtimeDefaults = parseJsonRecord(runtimeDefaultsJson, "Runtime defaults") as ProviderAccountResponse["runtimeDefaults"]
    const codexHomePath = usingSharedCodexHome ? "" : codexHome.trim()
    if (codexHomePath === "~/.codex" || codexHomePath === sharedCodexHome) {
      throw new Error(`Use Local account to use ${sharedCodexHome}.`)
    }
    if (codexHomePath && codexHomePath !== defaultCodexHome) {
      settings.codexHome = codexHomePath
    } else {
      delete settings.codexHome
    }
    if (provider.id === "codex") {
      settings.personality = personality
    }
    if (provider.id === "claude") {
      const configDirPath = claudeConfigDir.trim()
      if (configDirPath && configDirPath !== defaultClaudeConfigDir) {
        settings.claudeConfigDir = configDirPath
      } else {
        delete settings.claudeConfigDir
      }
    }
    if (hasDefaultModelField) {
      const nextDefaultModel = defaultModel || selectedDefaultModelOption?.model || defaultRuntimeDefaultValue(provider.id, "model")
      if (!nextDefaultModel) {
        throw new Error("Choose a default model.")
      }
      runtimeDefaults.model = nextDefaultModel
    }
    if (hasDefaultPermissionField) {
      runtimeDefaults.permissionMode = composerAccessModeValue(defaultPermissionMode)
    }
    if (hasDefaultReasoningField) {
      runtimeDefaults.reasoningEffort = composerReasoningEffortValue(defaultReasoningEffort)
    }
    if (hasDefaultServiceTierField) {
      runtimeDefaults.serviceTier = composerServiceTierValue(defaultServiceTier)
    }
    return { displayName, runtimeDefaults, settings }
  }

  async function saveDraftConfig() {
    if (!account) {
      throw new Error("No provider account selected.")
    }
    const updated = await apiClient.providerAccounts.update(account.id, readConfigDraft())
    onAccountChange(updated)
    return updated
  }

  async function authenticate(mode: AccountAuthMode = provider?.authModes?.[0]?.mode ?? "browser") {
    setAuthenticating(true)
    setAuthMenuOpen(false)
    setNotice(null)
    try {
      const updated = await saveDraftConfig()
      const response = await apiClient.providerAccounts.authenticate(updated.id, mode)
      if (response.authUrl) {
        window.open(response.authUrl, "_blank", "noopener,noreferrer")
      }
      if (response.status === "ERROR") {
        const failedAccount = accountFromAuthResponse(updated, response)
        onAccountChange(failedAccount)
        setNotice(readAccountErrorNotice(failedAccount, response.message ?? "Authentication failed."))
        return
      }
      const refreshed = await refreshAccount()
      if (response.status === "CONNECTED" || refreshed?.status === "CONNECTED") {
        setNotice({ kind: "info", text: response.message ?? "Connected" })
        await onReload()
        return
      }
      setNotice({ kind: "info", text: response.message ?? "Authentication started." })
      await pollConnectedAccount()
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setAuthenticating(false)
    }
  }

  async function refreshAccount() {
    if (!account) {
      await onReload()
      return null
    }
    const accounts = await apiClient.providerAccounts.list()
    const refreshed = accounts.find((entry) => entry.id === account.id) ?? null
    if (refreshed) {
      onAccountChange(refreshed)
    } else {
      await onReload()
    }
    return refreshed
  }

  async function pollConnectedAccount() {
    for (let index = 0; index < 60; index += 1) {
      await delay(1000)
      const refreshed = await refreshAccount()
      if (refreshed?.status === "CONNECTED") {
        setNotice({ kind: "info", text: "Connected" })
        await onReload()
        return
      }
      if (refreshed?.status === "ERROR") {
        setNotice(readAccountErrorNotice(refreshed, "Authentication failed."))
        return
      }
    }
  }

  async function saveConfig() {
    if (!account) {
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const updated = await apiClient.providerAccounts.update(account.id, {
        ...readConfigDraft(),
      })
      onAccountChange(updated)
      setNotice({ kind: "info", text: "Saved" })
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setSaving(false)
    }
  }

  async function deleteProviderAccount() {
    if (!account) {
      return
    }
    if (!window.confirm("Delete provider account?")) {
      return
    }
    setDeleting(true)
    setNotice(null)
    try {
      await apiClient.providerAccounts.delete(account.id)
      onAccountDelete(account.id)
    } catch (error) {
      setNotice({ kind: "error", text: readError(error) })
    } finally {
      setDeleting(false)
    }
  }

  const connected = account?.status === "CONNECTED"
  const hasClaudeConfigDirField = Boolean(provider?.accountFields.some((field) => field.key === "claudeConfigDir"))
  const hasCodexHomeField = Boolean(provider?.accountFields.some((field) => field.key === "codexHome"))
  const visibleModelOptions = mergeProviderModelOptions(provider?.id, modelOptions).filter((option) => !option.hidden)
  const selectedDefaultModelOption = visibleModelOptions.find((option) => option.model === defaultModel || option.id === defaultModel) ?? visibleModelOptions[0] ?? null

  return {
    authenticating,
    authMenuOpen,
    authenticate,
    claudeConfigDir,
    codexHome,
    connected,
    defaultModel,
    defaultPermissionMode,
    defaultReasoningEffort,
    defaultServiceTier,
    deleteProviderAccount,
    deleting,
    displayName,
    hasClaudeConfigDirField,
    hasCodexHomeField,
    hasDefaultModelField,
    hasDefaultPermissionField,
    hasDefaultReasoningField,
    hasDefaultServiceTierField,
    modelOptions: visibleModelOptions,
    notice,
    personality,
    runtimeDefaultsJson,
    saveConfig,
    saving,
    setAuthMenuOpen,
    setClaudeConfigDir,
    setCodexHome,
    setDefaultModel,
    setDefaultPermissionMode,
    setDefaultReasoningEffort,
    setDefaultServiceTier,
    setDisplayName,
    setPersonality,
    setRuntimeDefaultsJson,
    setSettingsJson,
    selectedDefaultModelOption,
    settingsJson,
    usingSharedCodexHome,
  }
}

export type ProviderAccountDialogState = ReturnType<typeof useProviderAccountDialogState>

function readAccountErrorNotice(
  account: ProviderAccountResponse | null | undefined,
  fallback = "Authentication failed.",
): ProviderAccountNotice | null {
  if (!account || account.status !== "ERROR") {
    return null
  }
  return {
    details: readAuthDiagnostics(account.authState),
    kind: "error",
    text: account.lastError || fallback,
  }
}

function readAuthDiagnostics(authState: unknown): Record<string, unknown> | null {
  const diagnostics = readRecord(readRecord(authState).authDiagnostics)
  return Object.keys(diagnostics).length ? diagnostics : null
}

function accountFromAuthResponse(
  account: ProviderAccountResponse,
  response: AuthenticateProviderAccountResponse,
): ProviderAccountResponse {
  return {
    ...account,
    authState: response.authState ?? account.authState,
    lastAuthLoginId: response.loginId ?? null,
    lastAuthMode: response.authMode ?? null,
    lastAuthUrl: response.authUrl ?? null,
    lastAuthUserCode: response.userCode ?? null,
    lastError: response.status === "ERROR" ? response.message ?? "Authentication failed." : null,
    status: response.status,
  }
}
