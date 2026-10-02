import type { AuthenticateProviderAccountResponse } from "../../types/providers"
import type { JsonObject } from "../../types/json"
import { asJsonObject, readString } from "../json.server"
import { HttpError } from "../http.server"

export function readCodexAuthMode(value: unknown): "device" {
  if (value === undefined || value === null || value === "device") return "device"
  throw new HttpError(400, "Only device authentication is supported.")
}

export async function startCodexDeviceLogin(
  accountId: string,
  request: (params: JsonObject) => Promise<{ result?: unknown }>,
): Promise<AuthenticateProviderAccountResponse> {
  const response = await request({ type: "chatgptDeviceCode" })
  const result = asJsonObject(response.result)
  const verificationUrl = readString(result?.verificationUrl) ?? readString(result?.verification_uri)
  const userCode = readString(result?.userCode) ?? readString(result?.user_code)
  const loginId = readString(result?.loginId)
  if (result?.type !== "chatgptDeviceCode" || !verificationUrl || !userCode || !loginId) {
    throw new Error("Codex did not return complete device sign-in instructions.")
  }
  return {
    accountId,
    status: "AUTHENTICATING",
    authMode: "device",
    authUrl: verificationUrl,
    verificationUrl,
    userCode,
    loginId,
    message: "Open the device sign-in page and enter the code below.",
  }
}
