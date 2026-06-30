import { useEffect, useMemo, useState } from "react"
import type {
  ChatResponse,
  ProviderAccountResponse,
  ProviderDefinitionResponse,
  ProviderModelListResponse,
} from "@/lib/api-client"
import {
  composerReasoningEffortValue,
  composerServiceTierValue,
  defaultRuntimeDefaultValue,
  mergeProviderModelOptions,
  readComposerReasoningEffort,
  readComposerServiceTier,
  readRecordString,
} from "@/lib/session"
import type { ChatComposerReasoningEffort, ChatComposerServiceTier } from "@/types/session"
import { apiClient } from "@/lib/api-client"

type RuntimeSettingsChange = (chatId: string, settings: {
  model?: string | null
  reasoningEffort?: string | null
  serviceTier?: string | null
}) => Promise<void>

export function useChatPaneRuntimeSettings({
  account,
  chat,
  providerDefinition,
  onRuntimeSettingsChange,
}: {
  account: ProviderAccountResponse | null
  chat: ChatResponse | null
  providerDefinition: ProviderDefinitionResponse | null
  onRuntimeSettingsChange: RuntimeSettingsChange
}) {
  const [model, setModel] = useState("")
  const [modelOptions, setModelOptions] = useState<ProviderModelListResponse["data"]>([])
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
    setModel(chat?.model ?? defaultModel)
    setReasoningEffort(readComposerReasoningEffort(chat?.reasoningEffort ?? defaultReasoningEffort))
    setServiceTier(readComposerServiceTier(chat?.serviceTier ?? defaultServiceTier))
  }, [
    account?.id,
    account?.providerId,
    account?.runtimeDefaults,
    chat?.id,
    chat?.model,
    chat?.reasoningEffort,
    chat?.serviceTier,
  ])

  useEffect(() => {
    let cancelled = false
    setModelOptions([])
    if (!account || !supportsModels) {
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
          setModelOptions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [account?.id, supportsModels])

  const mergedModelOptions = mergeProviderModelOptions(account?.providerId, modelOptions)
  const visibleModelOptions = useMemo(
    () => (
      model && !mergedModelOptions.some((option) => option.model === model || option.id === model)
        ? [{ id: model, model, displayName: model }, ...mergedModelOptions]
        : mergedModelOptions
    ).filter((option) => !option.hidden),
    [mergedModelOptions, model],
  )
  const selectedModelOption = visibleModelOptions.find((option) => option.model === model || option.id === model) ??
    visibleModelOptions[0] ??
    null

  const changeModel = (value: string) => {
    const previousModel = model
    setModel(value)
    if (chat && (chat.model ?? "") !== value) {
      void onRuntimeSettingsChange(chat.id, { model: value || null }).catch(() => setModel(previousModel))
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
    reasoningEffort,
    selectedModelOption,
    serviceTier,
    supportsModels,
    supportsReasoningEffort,
    supportsServiceTier,
    visibleModelOptions,
  }
}
