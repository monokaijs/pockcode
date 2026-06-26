import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type Theme = "dark" | "light" | "system"
export type ResolvedTheme = "dark" | "light"

type ThemeProviderProps = {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  theme: Theme
}

const defaultTheme = "dark" satisfies Theme
export const themeStorageKey = "pockcode-theme"

const initialState: ThemeProviderState = {
  resolvedTheme: defaultTheme,
  setTheme: () => undefined,
  theme: defaultTheme,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

function isTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light" || value === "system"
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") {
    return defaultTheme
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme
}

function storedTheme(storageKey: string, fallback: Theme): Theme {
  if (typeof window === "undefined") {
    return fallback
  }
  const storedValue = window.localStorage.getItem(storageKey)
  return isTheme(storedValue) ? storedValue : fallback
}

function applyTheme(resolvedTheme: ResolvedTheme) {
  const root = window.document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(resolvedTheme)
  root.style.colorScheme = resolvedTheme
}

export function ThemeProvider({
  children,
  defaultTheme: defaultThemeProp = defaultTheme,
  storageKey = themeStorageKey,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => storedTheme(storageKey, defaultThemeProp))
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme))

  useEffect(() => {
    const nextResolvedTheme = resolveTheme(theme)
    applyTheme(nextResolvedTheme)
    setResolvedTheme(nextResolvedTheme)

    if (theme !== "system") {
      return undefined
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const onSystemThemeChange = () => {
      const nextSystemTheme = systemTheme()
      applyTheme(nextSystemTheme)
      setResolvedTheme(nextSystemTheme)
    }

    mediaQuery.addEventListener("change", onSystemThemeChange)
    return () => mediaQuery.removeEventListener("change", onSystemThemeChange)
  }, [theme])

  const value = useMemo<ThemeProviderState>(
    () => ({
      resolvedTheme,
      theme,
      setTheme: (nextTheme) => {
        window.localStorage.setItem(storageKey, nextTheme)
        setThemeState(nextTheme)
      },
    }),
    [resolvedTheme, storageKey, theme],
  )

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>
}

export function useTheme() {
  return useContext(ThemeProviderContext)
}
