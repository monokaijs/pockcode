import { processDueMessageSchedules, syncMessageScheduleRunStatuses } from "./message-schedules.service"

const pollMs = 30_000
let started = false
let processing = false
let timer: ReturnType<typeof setInterval> | null = null

export function startMessageScheduleMonitor(): void {
  if (started) {
    void tick()
    return
  }
  started = true
  void tick()
  timer = setInterval(() => {
    void tick()
  }, pollMs)
  timer.unref?.()
}

export function stopMessageScheduleMonitor(): void {
  started = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function tick(): Promise<void> {
  if (processing) {
    return
  }
  processing = true
  try {
    await processDueMessageSchedules()
    await syncMessageScheduleRunStatuses()
  } catch (error) {
    console.error("Message schedule monitor failed.", error)
  } finally {
    processing = false
  }
}
