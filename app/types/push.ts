export type PushSubscriptionRequest = {
  endpoint: string
  expirationTime?: number | null
  keys: {
    auth: string
    p256dh: string
  }
}

export type PushSubscriptionResponse = {
  createdAt: string
  endpoint: string
  updatedAt: string
}

export type PushPublicKeyResponse = {
  publicKey: string | null
  supported: boolean
}

export type PushTestResponse = {
  sent: number
}
