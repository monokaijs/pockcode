import type { Server as HttpServer } from "node:http"
import { WebSocketServer } from "ws"
import { createLanguageServerWebSocketSession } from "./lsp.service"

const installedServers = new WeakSet<HttpServer>()

export function installLspSocketServer(server: HttpServer): void {
  if (installedServers.has(server)) {
    return
  }
  installedServers.add(server)

  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (url.pathname !== "/lsp") {
      return
    }

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      void createLanguageServerWebSocketSession({
        serverId: url.searchParams.get("serverId"),
        socket: webSocket,
        workspacePath: url.searchParams.get("workspacePath"),
      }).catch((error) => {
        webSocket.close(1008, readError(error))
      })
    })
  })
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : "Language server unavailable."
}
