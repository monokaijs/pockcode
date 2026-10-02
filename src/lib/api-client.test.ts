import { afterEach, describe, expect, it, vi } from "vitest"
import { apiClient } from "./api-client"

afterEach(() => vi.unstubAllGlobals())

describe("Codex account requests", () => {
  it("shares concurrent model requests and fetches again on the next refresh", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [] })))
    vi.stubGlobal("fetch", fetchMock)
    const first = apiClient.providerAccounts.models("account-1")
    const second = apiClient.providerAccounts.models("account-1")
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await apiClient.providerAccounts.models("account-1")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" })
  })

  it("keeps model requests isolated by account", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [] })))
    vi.stubGlobal("fetch", fetchMock)
    await Promise.all([
      apiClient.providerAccounts.models("account-1"),
      apiClient.providerAccounts.models("account-2"),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/provider-accounts/account-1/models",
      "/api/provider-accounts/account-2/models",
    ])
  })

  it("allows model discovery to retry after a failed request", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
    vi.stubGlobal("fetch", fetchMock)
    await expect(apiClient.providerAccounts.models("account-1")).rejects.toThrow("Offline")
    await expect(apiClient.providerAccounts.models("account-1")).resolves.toEqual({ data: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("always sends device authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "AUTHENTICATING" })))
    vi.stubGlobal("fetch", fetchMock)
    await apiClient.providerAccounts.authenticate("account-1")
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/provider-accounts/account-1/authenticate", {
      body: JSON.stringify({ mode: "device" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  })
})


describe("agent requests", () => {
  it("cancels a follow-up only in the selected agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "agent/one" })))
    vi.stubGlobal("fetch", fetchMock)
    await apiClient.assistant.cancelFollowUp("agent/one", "watch-id")
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/assistants/agent%2Fone/cancel-follow-up", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ followUpId: "watch-id" }),
    })
  })
  it("routes reads, messages, and stops to the selected agent", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: "agent/one" })))
    vi.stubGlobal("fetch", fetchMock)
    await apiClient.assistant.read("agent/one")
    await apiClient.assistant.send("agent/one", { content: "Hello", accountId: "account-1" })
    await apiClient.assistant.stop("agent/two")
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/assistants/agent%2Fone", "/api/assistants/agent%2Fone/messages", "/api/assistants/agent%2Ftwo/stop",
    ])
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ content: "Hello", accountId: "account-1" }) })
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST" })
  })

  it("lists agents and creates a profile without requiring a project", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({})))
    vi.stubGlobal("fetch", fetchMock)
    await apiClient.assistant.list()
    await apiClient.assistant.create({ name: "Nova", personality: "Warm." })
    expect(fetchMock.mock.calls[0]).toEqual(["/api/assistants", { cache: "no-store" }])
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ name: "Nova", personality: "Warm." }) })
  })

  it("uploads an avatar to the selected agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "agent/one" })))
    vi.stubGlobal("fetch", fetchMock)
    await apiClient.assistant.updateAvatar("agent/one", "data:image/webp;base64,test")
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/assistants/agent%2Fone/avatar", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatar: "data:image/webp;base64,test" }),
    })
  })
})
