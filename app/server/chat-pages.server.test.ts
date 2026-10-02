import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listChatPage } from "./chat-pages.server"

const fixture = vi.hoisted(() => ({ db: null as PrismaClient | null }))
vi.mock("./prisma.server", () => ({ get prisma() { return fixture.db! } }))
vi.mock("./database.server", () => ({ ensureDatabase: async () => undefined }))
vi.mock("./chats.service", () => ({
  overlayCachedChatStates: async (chats: unknown[]) => chats,
  serializeChat: (chat: unknown) => chat,
}))
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pockcode-chat-pages-test-"))
  fixture.db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } })
  await fixture.db.$executeRawUnsafe(`CREATE TABLE "Chat" (
    "id" TEXT PRIMARY KEY, "providerId" TEXT NOT NULL, "accountId" TEXT,
    "autoRotateAccount" BOOLEAN NOT NULL DEFAULT false, "title" TEXT NOT NULL, "workingDirectory" TEXT,
    "model" TEXT, "reasoningEffort" TEXT, "serviceTier" TEXT, "collaborationMode" TEXT NOT NULL DEFAULT 'default',
    "permissionMode" TEXT NOT NULL DEFAULT 'default', "status" TEXT NOT NULL DEFAULT 'IDLE', "externalThreadId" TEXT,
    "lastActivityAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
  )`)
})
afterAll(async () => { await fixture.db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }) })
beforeEach(async () => {
  await fixture.db!.chat.deleteMany()
  for (let i = 1; i <= 6; i++) {
    await fixture.db!.chat.create({ data: { id: `alpha-${i}`, title: `Alpha task ${i}`, providerId: "codex", workingDirectory: "/alpha", lastActivityAt: new Date(i * 1000), updatedAt: new Date(i * 1000) } })
  }
  await fixture.db!.chat.create({ data: { id: "beta", title: "Beta task", providerId: "codex", workingDirectory: "/beta", lastActivityAt: new Date(9000) } })
  await fixture.db!.chat.create({ data: { id: "archived", title: "Archived", providerId: "codex", workingDirectory: "/alpha", status: "ARCHIVED", lastActivityAt: new Date(10000) } })
})

describe("bounded chat pagination", () => {
  it("returns the latest four chats in a project, followed by older chats", async () => {
    const first = await listChatPage({ workingDirectory: "/alpha" })
    expect(first.data.map((chat) => chat.id)).toEqual(["alpha-6", "alpha-5", "alpha-4", "alpha-3"])
    expect(first.nextCursor).toBeTruthy()
    const second = await listChatPage({ workingDirectory: "/alpha", cursor: first.nextCursor })
    expect(second.data.map((chat) => chat.id)).toEqual(["alpha-2", "alpha-1"])
    expect(second.nextCursor).toBeNull()
  })

  it("does not skip older chats when a previous page is archived", async () => {
    const first = await listChatPage({ workingDirectory: "/alpha" })
    await fixture.db!.chat.update({ where: { id: "alpha-6" }, data: { status: "ARCHIVED" } })
    expect((await listChatPage({ workingDirectory: "/alpha", cursor: first.nextCursor })).data.map((chat) => chat.id)).toEqual(["alpha-2", "alpha-1"])
    expect((await listChatPage({ workingDirectory: "/alpha" })).data.map((chat) => chat.id)).toEqual(["alpha-5", "alpha-4", "alpha-3", "alpha-2"])
  })

  it("uses stable boundaries when activity and update timestamps tie", async () => {
    await fixture.db!.chat.updateMany({ where: { workingDirectory: "/alpha" }, data: { lastActivityAt: new Date(1000), updatedAt: new Date(1000) } })
    const first = await listChatPage({ workingDirectory: "/alpha" })
    const second = await listChatPage({ workingDirectory: "/alpha", cursor: first.nextCursor })
    expect([...first.data, ...second.data].map((chat) => chat.id)).toEqual(["alpha-6", "alpha-5", "alpha-4", "alpha-3", "alpha-2", "alpha-1"])
  })

  it("deduplicates provider threads before applying the page limit", async () => {
    await fixture.db!.chat.updateMany({ where: { id: { in: ["alpha-6", "alpha-5"] } }, data: { accountId: "account", externalThreadId: "thread" } })
    await fixture.db!.chat.update({ where: { id: "alpha-5" }, data: { status: "RUNNING" } })
    expect((await listChatPage({ workingDirectory: "/alpha" })).data.map((chat) => chat.id)).toEqual(["alpha-5", "alpha-4", "alpha-3", "alpha-2"])
  })

  it("searches globally and treats SQL wildcard characters literally", async () => {
    expect((await listChatPage({ query: "beta" })).data.map((chat) => chat.id)).toEqual(["beta"])
    expect((await listChatPage({ query: "%_" })).data).toEqual([])
    await fixture.db!.chat.update({ where: { id: "alpha-3" }, data: { title: "Literal %_ example" } })
    expect((await listChatPage({ query: "%_" })).data.map((chat) => chat.id)).toEqual(["alpha-3"])
  })

  it("rejects malformed cursors and invalid page sizes", async () => {
    await expect(listChatPage({ cursor: "garbage" })).rejects.toMatchObject({ status: 400 })
    await expect(listChatPage({ limit: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(listChatPage({ limit: 101 })).rejects.toMatchObject({ status: 400 })
    await expect(listChatPage({ limit: 1.5 })).rejects.toMatchObject({ status: 400 })
  })
})
