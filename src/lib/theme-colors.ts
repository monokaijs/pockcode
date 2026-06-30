import type { ResolvedTheme } from "@/components/theme-provider"
import type { MonacoApi } from "@/lib/monaco"

const HEX_COLOR_PATTERN = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i

function cssColor(value: string): string {
  if (typeof document === "undefined" || !document.body) {
    return normalizedColor(value) ?? value
  }

  const probe = document.createElement("span")
  probe.style.color = value
  probe.style.position = "absolute"
  probe.style.pointerEvents = "none"
  probe.style.visibility = "hidden"
  document.body.appendChild(probe)
  const resolved = window.getComputedStyle(probe).color
  probe.remove()
  return normalizedColor(resolved) ?? normalizedColor(value) ?? value
}

export function themeColor(variableName: string, fallback: string): string {
  if (typeof window === "undefined") {
    return normalizedColor(fallback) ?? fallback
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(variableName).trim()
  return cssColor(value || fallback)
}

function normalizedColor(value: string): string | null {
  const color = value.trim()
  if (!color) {
    return null
  }
  if (HEX_COLOR_PATTERN.test(color)) {
    return normalizeHexColor(color)
  }
  if (color.startsWith("oklch(")) {
    return oklchToHex(color)
  }
  if (color.startsWith("rgb(") || color.startsWith("rgba(")) {
    return rgbToHex(color)
  }
  if (color.startsWith("color(srgb ")) {
    return srgbColorToHex(color)
  }
  return null
}

function normalizeHexColor(value: string): string {
  const hex = value.slice(1)
  if (hex.length === 3 || hex.length === 4) {
    return `#${hex.slice(0, 3).split("").map((part) => `${part}${part}`).join("")}`
  }
  return `#${hex.slice(0, 6)}`
}

function rgbToHex(value: string): string | null {
  const channels = value
    .replace(/^rgba?\(/, "")
    .replace(/\)$/, "")
    .replace(/\s*\/\s*[\d.]+%?$/, "")
    .replaceAll(",", " ")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(parseRgbChannel)

  if (channels.length !== 3 || channels.some((channel) => channel === null)) {
    return null
  }

  return channelsToHex(channels as [number, number, number])
}

function srgbColorToHex(value: string): string | null {
  const channels = value
    .replace(/^color\(srgb\s+/, "")
    .replace(/\)$/, "")
    .replace(/\s*\/\s*[\d.]+%?$/, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map((channel) => clamp01(Number(channel)) * 255)

  if (channels.length !== 3 || channels.some((channel) => Number.isNaN(channel))) {
    return null
  }

  return channelsToHex(channels as [number, number, number])
}

function oklchToHex(value: string): string | null {
  const channels = value
    .replace(/^oklch\(/, "")
    .replace(/\)$/, "")
    .replace(/\s*\/\s*[\d.]+%?$/, "")
    .trim()
    .split(/\s+/)

  if (channels.length < 3) {
    return null
  }

  const lightness = parseOklchLightness(channels[0])
  const chroma = Number(channels[1])
  const hue = parseHue(channels[2])
  if ([lightness, chroma, hue].some((channel) => Number.isNaN(channel))) {
    return null
  }

  const hueRadians = hue * Math.PI / 180
  const a = chroma * Math.cos(hueRadians)
  const b = chroma * Math.sin(hueRadians)
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b
  const l = lPrime ** 3
  const m = mPrime ** 3
  const s = sPrime ** 3

  return channelsToHex([
    linearSrgbToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) * 255,
    linearSrgbToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) * 255,
    linearSrgbToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s) * 255,
  ])
}

function parseRgbChannel(value: string): number | null {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1))
    return Number.isNaN(percent) ? null : clamp01(percent / 100) * 255
  }
  const channel = Number(value)
  return Number.isNaN(channel) ? null : clamp(channel, 0, 255)
}

function parseOklchLightness(value: string): number {
  if (value.endsWith("%")) {
    return clamp01(Number(value.slice(0, -1)) / 100)
  }
  return clamp01(Number(value))
}

function parseHue(value: string): number {
  if (value === "none") {
    return 0
  }
  if (value.endsWith("turn")) {
    return Number(value.slice(0, -4)) * 360
  }
  if (value.endsWith("rad")) {
    return Number(value.slice(0, -3)) * 180 / Math.PI
  }
  if (value.endsWith("deg")) {
    return Number(value.slice(0, -3))
  }
  return Number(value)
}

function linearSrgbToSrgb(value: number): number {
  const channel = clamp01(value)
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
}

function channelsToHex(channels: [number, number, number]): string {
  return `#${channels.map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("")}`
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function terminalThemeColors() {
  const background = themeColor("--ide-terminal", "oklch(0.14 0.004 285)")
  const foreground = themeColor("--foreground", "oklch(0.88 0.006 285)")
  const muted = themeColor("--muted-foreground", "oklch(0.67 0.006 285)")
  const info = themeColor("--info", "oklch(0.75 0.13 250)")
  const success = themeColor("--success", "oklch(0.7 0.16 150)")
  const warning = themeColor("--warning", "oklch(0.78 0.14 82)")
  const destructive = themeColor("--destructive", "oklch(0.66 0.2 25)")
  const primary = themeColor("--primary", "oklch(0.58 0.16 276)")

  return {
    background,
    black: background,
    blue: info,
    brightBlack: muted,
    brightBlue: info,
    brightCyan: themeColor("--chart-2", "oklch(0.696 0.17 162.48)"),
    brightGreen: success,
    brightMagenta: themeColor("--chart-4", "oklch(0.627 0.265 303.9)"),
    brightRed: destructive,
    brightWhite: themeColor("--foreground", "oklch(0.985 0 0)"),
    brightYellow: warning,
    cursor: foreground,
    cyan: themeColor("--chart-2", "oklch(0.696 0.17 162.48)"),
    foreground,
    green: success,
    magenta: primary,
    red: destructive,
    selectionBackground: themeColor("--primary", "oklch(0.58 0.16 276)"),
    white: foreground,
    yellow: warning,
  }
}

export function definePockcodeMonacoTheme(monaco: MonacoApi, resolvedTheme: ResolvedTheme) {
  const themeName = pockcodeMonacoThemeName(resolvedTheme)
  monaco.editor.defineTheme(themeName, {
    base: resolvedTheme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": themeColor("--ide-editor", "oklch(0.19 0.004 285)"),
      "editor.lineHighlightBackground": themeColor("--accent", "oklch(0.27 0.006 285)"),
      "editor.selectionBackground": themeColor("--primary", "oklch(0.58 0.16 276)"),
      "editorCursor.foreground": themeColor("--foreground", "oklch(0.88 0.006 285)"),
      "editorLineNumber.activeForeground": themeColor("--foreground", "oklch(0.88 0.006 285)"),
      "editorLineNumber.foreground": themeColor("--muted-foreground", "oklch(0.67 0.006 285)"),
    },
  })
  return themeName
}

export function pockcodeMonacoThemeName(resolvedTheme: ResolvedTheme) {
  return `pockcode-${resolvedTheme}`
}
