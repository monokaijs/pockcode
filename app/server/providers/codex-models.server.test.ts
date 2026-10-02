import { describe, expect, it, vi } from "vitest"
import { listCodexModels } from "./codex-models.server"

describe("Codex model discovery", () => {
  it("fetches every page and preserves live defaults and capabilities", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ result: {
        data: [{ id: "fast", model: "fast", displayName: "Fast" }],
        nextCursor: "page-2",
      } })
      .mockResolvedValueOnce({ result: {
        data: [{
          id: "future-codex",
          model: "future-codex",
          displayName: "Future Codex",
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Think deeply" }],
          inputModalities: ["text", "image"],
          supportsPersonality: true,
          serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
          upgradeInfo: { upgrade: "future-upgrade" },
        }, { id: "hidden", hidden: true }],
        nextCursor: null,
      } })

    const response = await listCodexModels(request)

    expect(request.mock.calls).toEqual([
      [{ includeHidden: false, limit: 100 }],
      [{ includeHidden: false, limit: 100, cursor: "page-2" }],
    ])
    expect(response.data.map((model) => model.model)).toEqual(["fast", "future-codex"])
    expect(response.data[1]).toMatchObject({
      isDefault: true,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Think deeply" }],
      inputModalities: ["text", "image"],
      supportsPersonality: true,
      serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
      upgradeInfo: { upgrade: "future-upgrade" },
    })
    expect(response.nextCursor).toBeNull()
  })

  it("fetches changed catalogs on subsequent calls without keeping removed models", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ result: { data: [{ id: "old-model" }] } })
      .mockResolvedValueOnce({ result: { data: [{ id: "new-model", is_default: true }] } })
      .mockResolvedValueOnce({ result: { data: [] } })

    expect((await listCodexModels(request)).data.map((model) => model.model)).toEqual(["old-model"])
    expect((await listCodexModels(request)).data).toMatchObject([{ model: "new-model", isDefault: true }])
    expect((await listCodexModels(request)).data).toEqual([])
  })

  it("propagates discovery failures instead of returning invented model options", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Catalog unavailable"))
    await expect(listCodexModels(request)).rejects.toThrow("Catalog unavailable")
  })

  it("stops if the runtime repeats a pagination cursor", async () => {
    const request = vi.fn().mockResolvedValue({ result: { data: [], nextCursor: "repeated" } })
    await expect(listCodexModels(request)).rejects.toThrow("repeated model catalog cursor")
    expect(request).toHaveBeenCalledTimes(2)
  })
})
