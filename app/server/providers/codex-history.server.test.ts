import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { codexProviderAdapter } from "./codex.server"

const f = vi.hoisted(() => ({ home: "" }))
vi.mock("../database.server", () => ({ ensureDatabase: async () => undefined }))
vi.mock("../prisma.server", () => ({ prisma: {} }))
vi.mock("../runtime-paths.server", async (original) => {
  const actual = await original<typeof import("../runtime-paths.server")>()
  return { ...actual, resolveHomePath: (path: string) => path === "~/.codex" ? f.home : actual.resolveHomePath(path) }
})

afterEach(async () => {
  if (f.home) await rm(f.home, { recursive: true, force: true })
  f.home = ""
})

describe("local Codex transcript history", () => {
  it("reads user and assistant messages from the shared home without starting an account runtime", async () => {
    f.home = await mkdtemp(join(tmpdir(), "pockcode-history-"))
    const directory = join(f.home, "sessions", "2026", "10", "02")
    await mkdir(directory, { recursive: true })
    const threadId = "01a0f93f-5152-7810-941c-4148a3482c44"
    const records = [
      { type: "session_meta", payload: { id: threadId, cwd: "/project" } },
      { type: "response_item", timestamp: "2026-10-02T03:54:32Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the chat" }] } },
      { type: "response_item", timestamp: "2026-10-02T03:54:33Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The saved response" }] } },
    ]
    await writeFile(join(directory, `rollout-2026-10-02T03-54-31-${threadId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n"))

    expect(await codexProviderAdapter.loadLocalChatMessages!(threadId)).toMatchObject([
      { role: "USER", content: "Fix the chat" },
      { role: "ASSISTANT", content: "The saved response" },
    ])
  })
})
