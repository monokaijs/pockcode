import { processAssistantFollowUps } from "./assistant.service"
import { onProviderEvent } from "./socket.server"

let timer: ReturnType<typeof setInterval> | null = null
let eventTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null
let processing = false
let rerun = false

export function startAssistantFollowUpMonitor(): void {
  if (timer) return
  unsubscribe = onProviderEvent((event) => {
    if (event.type !== "run.status" || eventTimer) return
    // Let the run finish its persistence and failover cleanup before reading its outcome.
    eventTimer = setTimeout(() => { eventTimer = null; void tick() }, 250)
    eventTimer.unref?.()
  })
  timer = setInterval(() => void tick(), 10_000)
  timer.unref?.()
  void tick()
}

export function stopAssistantFollowUpMonitor(): void {
  if (timer) clearInterval(timer)
  if (eventTimer) clearTimeout(eventTimer)
  timer = null
  eventTimer = null
  unsubscribe?.()
  unsubscribe = null
  rerun = false
}

async function tick(): Promise<void> {
  if (!timer) return
  if (processing) { rerun = true; return }
  processing = true
  try { await processAssistantFollowUps() }
  catch (error) { console.error("Agent follow-up monitor failed.", error) }
  finally {
    processing = false
    if (rerun && timer) { rerun = false; void tick() }
  }
}
