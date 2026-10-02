import { HttpError, readRecordField } from "./http.server"

const maxAvatarLength = 1_000_000
const colorPattern = /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|none)$/iu
const geometry: Record<string, string[]> = {
  circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx"], line: ["x1", "y1", "x2", "y2"],
  path: ["d"], polygon: ["points"],
}

export function readUploadedAvatar(value: unknown): string {
  if (typeof value !== "string" || value.length > maxAvatarLength) throw new HttpError(400, "Choose an avatar image smaller than 750 KB.")
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u)
  if (!match) throw new HttpError(400, "Choose a PNG, JPEG, or WebP avatar.")
  const bytes = Buffer.from(match[2], "base64")
  const valid = match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === "jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
  if (!valid || bytes.toString("base64") !== match[2]) throw new HttpError(400, "The avatar image is invalid.")
  return value
}

export function readSavedAvatar(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > maxAvatarLength) return undefined
  if (/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    const svg = Buffer.from(value.split(",")[1], "base64").toString("utf8")
    if (svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" data-pockcode-avatar="v1"') && !/[<](?:script|foreignObject|image|use|style)\b|\bon\w+\s*=|(?:href|url)\s*[(=]/iu.test(svg)) return value
    return undefined
  }
  try { return readUploadedAvatar(value) } catch { return undefined }
}

export function generateAvatar(design: unknown): string {
  const input = readRecordField(design, "avatar design")
  if (!input || Object.keys(input).some((key) => key !== "background" && key !== "shapes")) throw new HttpError(400, "Provide an avatar background and shapes.")
  const background = color(input.background)
  if (!Array.isArray(input.shapes) || input.shapes.length < 1 || input.shapes.length > 64) throw new HttpError(400, "Use between 1 and 64 avatar shapes.")
  const shapes = input.shapes.map((value) => {
    const shape = readRecordField(value, "shape")
    const type = shape?.type
    if (!shape || typeof type !== "string" || !Object.hasOwn(geometry, type)) throw new HttpError(400, "Unsupported avatar shape.")
    const allowed = ["type", ...geometry[type], "fill", "stroke", "strokeWidth", "opacity"]
    if (Object.keys(shape).some((key) => !allowed.includes(key))) throw new HttpError(400, "Unexpected avatar shape attribute.")
    const required = geometry[type].filter((key) => !(type === "rect" && key === "rx"))
    if (required.some((key) => shape[key] === undefined)) throw new HttpError(400, `Provide ${required.join(", ")} for ${type}.`)
    const attributes = Object.entries(shape).flatMap(([key, entry]) => {
      if (key === "type") return []
      if (key === "fill" || key === "stroke") return [`${key}="${color(entry)}"`]
      if (key === "d" || key === "points") {
        const pattern = key === "d" ? /^[MmZzLlHhVvCcSsQqTtAa\deE+.,\s-]+$/u : /^[\deE+.,\s-]+$/u
        if (typeof entry !== "string" || !entry.trim() || entry.length > 4000 || !pattern.test(entry)) throw new HttpError(400, "Invalid avatar path.")
        return [`${key}="${entry}"`]
      }
      const nonnegative = ["opacity", "strokeWidth", "r", "rx", "ry", "width", "height"].includes(key)
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < (nonnegative ? 0 : -512) || entry > (key === "opacity" ? 1 : key === "strokeWidth" ? 100 : 1024)) throw new HttpError(400, "Invalid avatar coordinate.")
      return [`${key === "strokeWidth" ? "stroke-width" : key}="${entry}"`]
    })
    return `<${type} ${attributes.join(" ")}/>`
  }).join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-pockcode-avatar="v1" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="${background}"/>${shapes}</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

function color(value: unknown): string {
  if (typeof value !== "string" || !colorPattern.test(value)) throw new HttpError(400, "Use a hex color or none for avatar colors.")
  return value
}
