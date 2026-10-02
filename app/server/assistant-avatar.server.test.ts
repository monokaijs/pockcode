import { describe, expect, it } from "vitest"
import { generateAvatar, readSavedAvatar, readUploadedAvatar } from "./assistant-avatar.server"

export const uploadedAvatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

describe("agent avatars", () => {
  it("accepts saved raster images and rejects mismatched or oversized uploads", () => {
    expect(readUploadedAvatar(uploadedAvatar)).toBe(uploadedAvatar)
    expect(readSavedAvatar(uploadedAvatar)).toBe(uploadedAvatar)
    expect(() => readUploadedAvatar(uploadedAvatar.replace("image/png", "image/jpeg"))).toThrow("invalid")
    expect(() => readUploadedAvatar("data:image/png;base64," + "A".repeat(1_000_000))).toThrow("smaller")
    expect(readSavedAvatar("https://example.com/avatar.png")).toBeUndefined()
  })

  it("creates a self-contained image from the agent's design and restores it", () => {
    const avatar = generateAvatar({ background: "#142a36", shapes: [
      { type: "circle", cx: 256, cy: 256, r: 160, fill: "#70c9b0" },
      { type: "path", d: "M 180 280 Q 256 340 332 280", fill: "none", stroke: "#142a36", strokeWidth: 12 },
    ] })
    const svg = Buffer.from(avatar.split(",")[1], "base64").toString("utf8")
    expect(svg).toContain('viewBox="0 0 512 512"')
    expect(svg).toContain('<circle cx="256" cy="256" r="160" fill="#70c9b0"/>')
    expect(readSavedAvatar(avatar)).toBe(avatar)
    expect(() => readUploadedAvatar(avatar)).toThrow("PNG, JPEG, or WebP")
  })

  it("rejects external resources, injected markup, invalid geometry, and too many shapes", () => {
    const circle = { type: "circle", cx: 256, cy: 256, r: 160, fill: "#abc" }
    for (const shape of [
      { ...circle, onclick: "alert(1)" }, { ...circle, fill: "url(https://example.com)" },
      { ...circle, r: -1 }, { ...circle, cx: Infinity }, { type: "image", href: "https://example.com" },
      { type: "path", d: '\"/><script>alert(1)</script>', fill: "#abc" },
    ]) expect(() => generateAvatar({ background: "#123", shapes: [shape] })).toThrow()
    expect(() => generateAvatar({ background: "#123", shapes: Array(65).fill(circle) })).toThrow("1 and 64")
    const malicious = '<svg xmlns="http://www.w3.org/2000/svg" data-pockcode-avatar="v1"><image href="https://example.com"/></svg>'
    expect(readSavedAvatar(`data:image/svg+xml;base64,${Buffer.from(malicious).toString("base64")}`)).toBeUndefined()
  })
})
