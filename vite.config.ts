import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import type { Server as HttpServer } from "node:http"
import path from "node:path"
import { defineConfig } from "vite"
import { installApiServer } from "./app/server/api.server"
import { startChatStatusMonitor } from "./app/server/chat-status-monitor.server"
import { installLspSocketServer } from "./app/server/lsp-socket.server"
import { startMessageScheduleMonitor } from "./app/server/message-schedule-monitor.server"
import { installProviderSocketServer } from "./app/server/socket.server"

const hmrHost = process.env.VITE_HMR_HOST
const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT ?? 443)

export default defineConfig({
  plugins: [
    {
      name: "pockcode-provider-socket",
      configureServer(server) {
        installApiServer(server.middlewares)
        if (server.httpServer) {
          installProviderSocketServer(server.httpServer as unknown as HttpServer)
          installLspSocketServer(server.httpServer as unknown as HttpServer)
          startChatStatusMonitor()
          startMessageScheduleMonitor()
        }
      },
    },
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    allowedHosts: true,
    hmr: hmrHost
      ? {
          clientPort: hmrClientPort,
          host: hmrHost,
          protocol: process.env.VITE_HMR_PROTOCOL ?? "wss",
        }
      : true,
  },
})
