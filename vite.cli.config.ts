import { builtinModules } from "node:module"
import path from "node:path"
import { defineConfig } from "vite"

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: "dist",
    rollupOptions: {
      external: (id) => nodeBuiltins.has(id) || isRuntimeDependency(id),
      output: {
        entryFileNames: "pockcode.js",
      },
    },
    ssr: path.resolve(__dirname, "bin/pockcode.ts"),
    target: "node20",
  },
})

function isRuntimeDependency(id: string): boolean {
  return (
    !id.startsWith(".") &&
    !id.startsWith("/") &&
    !id.startsWith("\0") &&
    !id.startsWith("app/") &&
    !id.startsWith("bin/")
  )
}
