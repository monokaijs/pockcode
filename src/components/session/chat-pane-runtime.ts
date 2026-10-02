import { useEffect, useMemo, useState } from "react"
import type {
  ChatResponse,
  ProviderAccountResponse,
  ProviderDefinitionResponse,
} from "@/lib/api-client"
import {
  composerReasoningEffortValue,
  composerServiceTierValue,
  defaultRuntimeDefaultValue,
  defaultProviderModelOption,
  readComposerReasoningEffort,
  readComposerServiceTier,
  readRecordString,
} from "@/lib/session"
import type { ChatComposerReasoningEffort, ChatComposerServiceTier } from "@/types/session"
import type { AcpSessionConfig } from "@/lib/session"
import { useProviderModels } from "./use-provider-models"

type RuntimeSettingsChange = (chatId: string, settings: {
  model?: string | null
  reasoningEffort?: string | null
  serviceTier?: string | null
}) => Promise<void>

export function useChatPaneRuntimeSettings({
  account,
  chat,
  providerDefinition,
  sessionConfig,
  onRuntimeSettingsChange,
}: {
  account: ProviderAccountResponse | null
  chat: ChatResponse | null
  providerDefinition: ProviderDefinitionResponse | null
  sessionConfig?: AcpSessionConfig
  onRuntimeSettingsChange: RuntimeSettingsChange
}) {
  const [model, setModel] = useState("")
  const [reasoningEffort, setReasoningEffort] = useState<ChatComposerReasoningEffort>("medium")
  const [serviceTier, setServiceTier] = useState<ChatComposerServiceTier>("standard")
  const supportsModels = Boolean(account && providerDefinition?.capabilities.includes("models"))
  const supportsReasoningEffort = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "reasoningEffort"))
  const supportsServiceTier = Boolean(providerDefinition?.runtimeFields.some((field) => field.key === "serviceTier"))

  useEffect(() => {
    const defaultModel = readRecordString(account?.runtimeDefaults, "model") ||
      defaultRuntimeDefaultValue(account?.providerId, "model")
    const defaultReasoningEffort = readRecordString(account?.runtimeDefaults, "reasoningEffort") ||
      defaultRuntimeDefaultValue(account?.providerId, "reasoningEffort")
    const defaultServiceTier = readRecordString(account?.runtimeDefaults, "serviceTier") ||
      defaultRuntimeDefaultValue(account?.providerId, "serviceTier")
    setModel(sessionConfig?.model ?? chat?.model ?? defaultModel)
    setReasoningEffort(readComposerReasoningEffort(sessionConfig?.reasoningEffort ?? chat?.reasoningEffort ?? defaultReasoningEffort))
    setServiceTier(readComposerServiceTier(sessionConfig?.serviceTier ?? chat?.serviceTier ?? defaultServiceTier))
  }, [
    account?.id,
    account?.providerId,
    account?.runtimeDefaults,
    chat?.id,
    chat?.model,
    chat?.reasoningEffort,
    chat?.serviceTier,
    sessionConfig?.model,
    sessionConfig?.reasoningEffort,
    sessionConfig?.serviceTier,
  ])

  const { modelOptions: mergedModelOptions, refreshModels, modelsLoading, modelsError } = useProviderModels(account, supportsModels)
  const visibleModelOptions = useMemo(
    () => (
      model && !mergedModelOptions.some((option) => option.model === model || option.id === model)
        ? [{ id: model, model, displayName: model }, ...mergedModelOptions]
        : mergedModelOptions
    ).filter((option) => !option.hidden),
    [mergedModelOptions, model],
  )
  const selectedModelOption = visibleModelOptions.find((option) => option.model === model || option.id === model) ??
    defaultProviderModelOption(visibleModelOptions)

  const changeModel = (value: string) => {
    const previousModel = model
    const previousEffort = reasoningEffort
    const nextOption = visibleModelOptions.find((option) => option.model === value || option.id === value) ?? defaultProviderModelOption(visibleModelOptions)
    const supported = nextOption?.supportedReasoningEfforts
    const needsEffortChange = supported?.length && !supported.some((effort) => readComposerReasoningEffort(effort.reasoningEffort) === reasoningEffort)
    const nextEffort = needsEffortChange
      ? readComposerReasoningEffort(nextOption?.defaultReasoningEffort ?? supported[0].reasoningEffort)
      : reasoningEffort
    setModel(value)
    setReasoningEffort(nextEffort)
    if (chat && (chat.model ?? "") !== value) {
      void onRuntimeSettingsChange(chat.id, { model: value || null, ...(needsEffortChange ? { reasoningEffort: composerReasoningEffortValue(nextEffort) } : {}) }).catch(() => {
        setModel(previousModel)
        setReasoningEffort(previousEffort)
      })
    }
  }

  const changeReasoningEffort = (value: string) => {
    const previousReasoningEffort = reasoningEffort
    const nextReasoningEffort = readComposerReasoningEffort(value)
    setReasoningEffort(nextReasoningEffort)
    const nextReasoningEffortValue = composerReasoningEffortValue(nextReasoningEffort)
    if (chat && (chat.reasoningEffort ?? "") !== nextReasoningEffortValue) {
      void onRuntimeSettingsChange(chat.id, { reasoningEffort: nextReasoningEffortValue }).catch(() => {
        setReasoningEffort(previousReasoningEffort)
      })
    }
  }

  const changeServiceTier = (value: string) => {
    const previousServiceTier = serviceTier
    const nextServiceTier = readComposerServiceTier(value)
    setServiceTier(nextServiceTier)
    const nextServiceTierValue = composerServiceTierValue(nextServiceTier)
    if (chat && (chat.serviceTier ?? "") !== nextServiceTierValue) {
      void onRuntimeSettingsChange(chat.id, { serviceTier: nextServiceTierValue }).catch(() => {
        setServiceTier(previousServiceTier)
      })
    }
  }

  return {
    changeModel,
    changeReasoningEffort,
    changeServiceTier,
    model,
    refreshModels,
    modelsLoading,
    modelsError,
    reasoningEffort,
    selectedModelOption,
    serviceTier,
    supportsModels,
    supportsReasoningEffort,
    supportsServiceTier,
    visibleModelOptions,
  }
}
