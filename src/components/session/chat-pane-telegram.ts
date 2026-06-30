import { useEffect, useState } from "react"
import { apiClient } from "@/lib/api-client"
import { readRecord, readRecordString } from "@/lib/session"

export function useTelegramDeepLink(chatId: string | null | undefined): string | null {
  const [telegramDeepLink, setTelegramDeepLink] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const loadTelegramDeepLink = () => {
      setTelegramDeepLink(null)
      if (!chatId) {
        return
      }
      apiClient.plugins.list()
        .then((plugins) => {
          if (cancelled) {
            return
          }
          const telegram = plugins.find((plugin) => plugin.id === "telegram" && plugin.enabled)
          const botUsername = readRecordString(readRecord(telegram?.stateSummary), "botUsername")
          setTelegramDeepLink(botUsername ? `https://t.me/${botUsername}?start=${encodeURIComponent("sub_" + chatId)}` : null)
        })
        .catch(() => {
          if (!cancelled) {
            setTelegramDeepLink(null)
          }
        })
    }
    loadTelegramDeepLink()
    window.addEventListener("pockcode:plugins-changed", loadTelegramDeepLink)
    return () => {
      cancelled = true
      window.removeEventListener("pockcode:plugins-changed", loadTelegramDeepLink)
    }
  }, [chatId])

  return telegramDeepLink
}
