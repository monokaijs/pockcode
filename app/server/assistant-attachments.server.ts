import { assistantAttachmentLimits, type AssistantAttachment, type AssistantMessage } from "../types/assistant"
import { HttpError, readRecordField, readStringField } from "./http.server"

export function readAssistantAttachments(value: unknown): AssistantAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > assistantAttachmentLimits.count) throw new HttpError(400, "Attach up to 10 files per message.")
  let total = 0
  const ids = new Set<string>()
  return value.map((entry) => {
    const file = readRecordField(entry, "attachment")
    if (!file) throw new HttpError(400, "Invalid attachment.")
    const id = readStringField(file.id, "attachment id", { required: true, maxLength: 100 })
    if (ids.has(id)) throw new HttpError(400, "Duplicate attachment.")
    ids.add(id)
    const name = readStringField(file.name, "attachment name", { required: true, maxLength: 240 })
    if (typeof file.dataUrl !== "string" || file.dataUrl.length > Math.ceil(assistantAttachmentLimits.fileBytes / 3) * 4 + 150) throw new HttpError(400, "Choose files smaller than 5 MB each.")
    const match = file.dataUrl.match(/^data:([a-z\d.+-]+\/[a-z\d.+-]+);base64,([A-Za-z\d+/]*={0,2})$/iu)
    if (!match) throw new HttpError(400, "Invalid attachment data.")
    const bytes = Buffer.from(match[2], "base64")
    if (bytes.toString("base64") !== match[2]) throw new HttpError(400, "Invalid attachment data.")
    if (bytes.length > assistantAttachmentLimits.fileBytes) throw new HttpError(400, "Choose files smaller than 5 MB each.")
    total += bytes.length
    if (total > assistantAttachmentLimits.totalBytes) throw new HttpError(400, "Attachments must total less than 10 MB.")
    const mimeType = match[1].toLowerCase()
    const kind = mimeType.startsWith("image/") && mimeType !== "image/svg+xml" ? "image" : "file"
    if (kind === "image") {
      const valid = mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : mimeType === "image/webp" ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
            : mimeType === "image/gif" && /^(GIF87a|GIF89a)$/u.test(bytes.toString("ascii", 0, 6))
      if (!valid) throw new HttpError(400, "Choose a valid PNG, JPEG, WebP, or GIF image.")
    }
    return { id, kind, name, mimeType, size: bytes.length, dataUrl: `data:${mimeType};base64,${match[2]}` }
  })
}

export function assistantAttachmentContext(files: AssistantAttachment[] = [], budget = { remaining: 60_000 }) {
  return files.map(({ id, name, mimeType, size, kind, dataUrl }) => {
    if (kind === "image") return { id, name, mimeType, size, kind }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(dataUrl.split(",")[1], "base64"))
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content)) throw new Error("Binary file")
      const excerpt = content.slice(0, budget.remaining)
      budget.remaining -= excerpt.length
      return { id, name, mimeType, size, kind, content: excerpt, truncated: content.length > excerpt.length }
    } catch {
      return { id, name, mimeType, size, kind, note: "This binary attachment is saved, but its contents cannot be read in this conversation. Do not claim to have inspected it; ask for an image or text export if needed." }
    }
  })
}

export function assistantVisualAttachments(history: AssistantMessage[], current: AssistantAttachment[] = []): AssistantAttachment[] {
  const candidates = [...current, ...history.slice().reverse().flatMap((message) => message.attachments ?? [])]
  const selected: AssistantAttachment[] = []
  const ids = new Set<string>()
  let bytes = 0
  for (const file of candidates) {
    if (file.kind !== "image" || ids.has(file.id) || selected.length >= assistantAttachmentLimits.count || bytes + file.size > assistantAttachmentLimits.totalBytes) continue
    selected.push(file)
    ids.add(file.id)
    bytes += file.size
  }
  return selected
}
