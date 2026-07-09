import { useCallback, useEffect, useRef, useState } from "react"
import { Bell, BellOff, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { apiClient, type PushSubscriptionRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"

type PushPermissionState = NotificationPermission | "unsupported"

export function PushNotificationButton() {
  const [permission, setPermission] = useState<PushPermissionState>("unsupported")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const syncPromiseRef = useRef<Promise<void> | null>(null)

  const syncSubscription = useCallback(async (sendTest: boolean) => {
    if (syncPromiseRef.current) {
      return syncPromiseRef.current
    }
    setSyncing(true)
    const promise = syncPushSubscription(sendTest)
      .catch((syncError) => {
        setError(readErrorMessage(syncError, "Unable to enable notifications."))
        setDialogOpen(true)
      })
      .finally(() => {
        syncPromiseRef.current = null
        setSyncing(false)
      })
    syncPromiseRef.current = promise
    return promise
  }, [])

  useEffect(() => {
    setPermission(readNotificationPermission())

    let permissionStatus: PermissionStatus | null = null
    let cancelled = false
    let handlePermissionChange: (() => void) | null = null

    if (supportsPushNotifications() && navigator.permissions?.query) {
      navigator.permissions.query({ name: "notifications" }).then((status) => {
        if (cancelled) {
          return
        }
        permissionStatus = status
        handlePermissionChange = () => setPermission(readNotificationPermission())
        status.addEventListener("change", handlePermissionChange)
      }).catch(() => undefined)
    }

    return () => {
      cancelled = true
      if (permissionStatus && handlePermissionChange) {
        permissionStatus.removeEventListener("change", handlePermissionChange)
      }
    }
  }, [])

  useEffect(() => {
    if (permission !== "granted" || !supportsPushNotifications()) {
      return
    }
    void syncSubscription(false)
  }, [permission, syncSubscription])

  if (permission === "unsupported" || permission === "granted") {
    return null
  }

  const blocked = permission === "denied"

  const handleClick = () => {
    setError(null)
    if (blocked) {
      setDialogOpen(true)
      return
    }
    void requestPermission()
  }

  const requestPermission = async () => {
    if (!supportsPushNotifications()) {
      setPermission("unsupported")
      return
    }
    setSyncing(true)
    setError(null)
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result === "granted") {
        await syncSubscription(true)
        setDialogOpen(false)
      } else if (result === "denied") {
        setDialogOpen(true)
      }
    } catch (requestError) {
      setError(readErrorMessage(requestError, "Unable to request notification permission."))
      setDialogOpen(true)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={blocked ? "Notifications blocked" : "Enable notifications"}
              className={cn(
                "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                blocked && "text-warning hover:text-warning",
              )}
              disabled={syncing}
              type="button"
              onClick={handleClick}
            />
          }
        >
          {syncing ? <LoaderCircle className="size-4 animate-spin" /> : blocked ? <BellOff className="size-4" /> : <Bell className="size-4" />}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {blocked ? "Notifications blocked" : "Enable notifications"}
        </TooltipContent>
      </Tooltip>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{blocked ? "Notifications blocked" : "Notifications unavailable"}</DialogTitle>
            <DialogDescription>
              {blocked
                ? "The browser will not show the prompt again until notifications are allowed in this site's settings."
                : error ?? "Notifications could not be enabled for this browser."}
            </DialogDescription>
          </DialogHeader>
          {error && blocked ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Close</Button>
            <Button disabled={syncing} onClick={() => void requestPermission()}>
              {syncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Bell className="size-3.5" />}
              Try again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

async function syncPushSubscription(sendTest: boolean): Promise<void> {
  const keyResponse = await apiClient.push.publicKey()
  if (!keyResponse.supported || !keyResponse.publicKey) {
    throw new Error("Web Push is not available.")
  }
  const registration = await navigator.serviceWorker.ready
  const subscription = await readOrCreateSubscription(registration, keyResponse.publicKey)
  await apiClient.push.subscribe(subscriptionToRequest(subscription))
  if (sendTest) {
    await apiClient.push.test()
  }
}

async function readOrCreateSubscription(registration: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    return existing
  }
  return registration.pushManager.subscribe({
    applicationServerKey: urlBase64ToArrayBuffer(publicKey),
    userVisibleOnly: true,
  })
}

function subscriptionToRequest(subscription: PushSubscription): PushSubscriptionRequest {
  const json = subscription.toJSON()
  const endpoint = json.endpoint ?? subscription.endpoint
  const auth = json.keys?.auth
  const p256dh = json.keys?.p256dh
  if (!endpoint || !auth || !p256dh) {
    throw new Error("Browser returned an incomplete push subscription.")
  }
  return {
    endpoint,
    expirationTime: json.expirationTime ?? subscription.expirationTime,
    keys: { auth, p256dh },
  }
}

function supportsPushNotifications(): boolean {
  return typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator
}

function readNotificationPermission(): PushPermissionState {
  if (!supportsPushNotifications()) {
    return "unsupported"
  }
  return Notification.permission
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/gu, "+").replace(/_/gu, "/")
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }
  return buffer
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
