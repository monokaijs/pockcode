import { describe, expect, it, vi } from "vitest"
import { readCodexAuthMode, startCodexDeviceLogin } from "./codex-auth.server"

describe("Codex device authentication", () => {
  it("defaults to device authentication and rejects removed login modes", () => {
    expect(readCodexAuthMode(undefined)).toBe("device")
    expect(readCodexAuthMode("device")).toBe("device")
    for (const mode of ["browser", "local", "environment", "apiKey"]) {
      expect(() => readCodexAuthMode(mode)).toThrow("Only device authentication is supported")
    }
  })

  it("requests device login and returns the code and verification link", async () => {
    const request = vi.fn().mockResolvedValue({ result: {
      type: "chatgptDeviceCode",
      loginId: "login-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    } })
    const response = await startCodexDeviceLogin("account-1", request)
    expect(request).toHaveBeenCalledExactlyOnceWith({ type: "chatgptDeviceCode" })
    expect(response).toMatchObject({
      accountId: "account-1",
      status: "AUTHENTICATING",
      authMode: "device",
      loginId: "login-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    })
  })

  it("fails if device login is unsupported instead of falling back to browser login", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Device login unavailable"))
    await expect(startCodexDeviceLogin("account-1", request)).rejects.toThrow("Device login unavailable")
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("does not mark incomplete or browser login responses as connected", async () => {
    for (const result of [
      {},
      { type: "chatgpt", authUrl: "https://auth.openai.com/login" },
      { type: "chatgptDeviceCode", verificationUrl: "https://auth.openai.com/codex/device" },
    ]) {
      await expect(startCodexDeviceLogin("account-1", vi.fn().mockResolvedValue({ result })))
        .rejects.toThrow("complete device sign-in instructions")
    }
  })
})
