import type { Chat } from "@prisma/client"
import type { ChatPageResponse } from "../types/providers"
import { ensureDatabase } from "./database.server"
import { overlayCachedChatStates, serializeChat } from "./chats.service"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"

type Cursor = { activity: number; updated: number; id: string }

function readCursor(value?: string | null): Cursor | null {
  if (!value) return null
  try {
    if (value.length > 500 || !/^[\w-]+$/u.test(value)) throw new Error()
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor
    if (!parsed || !Number.isSafeInteger(parsed.activity) || !Number.isSafeInteger(parsed.updated) || !Number.isFinite(new Date(parsed.activity).getTime()) || !Number.isFinite(new Date(parsed.updated).getTime()) || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 200) throw new Error()
    return parsed
  } catch { throw new HttpError(400, "Invalid chat cursor.") }
}

export async function listChatPage({ workingDirectory, cursor: value, limit = 4, query = "" }: { workingDirectory?: string | null; cursor?: string | null; limit?: number; query?: string }): Promise<ChatPageResponse> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "Chat page limit must be between 1 and 100.")
  if (query.length > 200) throw new HttpError(400, "Search must be 200 characters or fewer.")
  const cursor = readCursor(value)
  const activity = cursor ? new Date(cursor.activity) : null
  const updated = cursor ? new Date(cursor.updated) : null
  const path = workingDirectory?.trim() || null
  await ensureDatabase()
  // Pick one canonical row per provider thread before applying the page boundary.
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH visible AS (
      SELECT "id", "lastActivityAt", "updatedAt", "title",
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN "accountId" IS NOT NULL AND "externalThreadId" IS NOT NULL
            THEN "providerId" || ':' || "accountId" || ':' || "externalThreadId" ELSE "id" END
          ORDER BY CASE WHEN "status" = 'RUNNING' THEN 0 ELSE 1 END,
            "lastActivityAt" DESC, "updatedAt" DESC, "id" DESC
        ) AS position
      FROM "Chat"
      WHERE "providerId" = 'codex' AND "status" != 'ARCHIVED'
        AND (${path} IS NULL OR "workingDirectory" = ${path})
    )
    SELECT "id" FROM visible
    WHERE position = 1 AND instr(lower("title"), lower(${query.trim()})) > 0
      AND (${cursor === null} OR "lastActivityAt" < ${activity}
        OR ("lastActivityAt" = ${activity} AND "updatedAt" < ${updated})
        OR ("lastActivityAt" = ${activity} AND "updatedAt" = ${updated} AND "id" < ${cursor?.id ?? null}))
    ORDER BY "lastActivityAt" DESC, "updatedAt" DESC, "id" DESC
    LIMIT ${limit + 1}
  `
  const ids = rows.slice(0, limit).map((row) => row.id)
  const chats = await prisma.chat.findMany({ where: { id: { in: ids } } })
  const byId = new Map(chats.map((chat: Chat) => [chat.id, chat]))
  const page = ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : [])
  const last = page.at(-1)
  return {
    data: (await overlayCachedChatStates(page)).map((chat) => serializeChat(chat)),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ activity: last.lastActivityAt.getTime(), updated: last.updatedAt.getTime(), id: last.id } satisfies Cursor)).toString("base64url") : null,
  }
}
