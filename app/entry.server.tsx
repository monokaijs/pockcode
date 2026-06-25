import { PassThrough, Readable } from "node:stream"
import { renderToPipeableStream } from "react-dom/server"
import type { AppLoadContext, EntryContext } from "react-router"
import { ServerRouter } from "react-router"

export const streamTimeout = 5_000

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      headers: responseHeaders,
      status: responseStatusCode,
    })
  }

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort(), streamTimeout + 1000)

    const { pipe, abort } = renderToPipeableStream(<ServerRouter context={routerContext} url={request.url} />, {
      onAllReady() {
        shellRendered = true
        const body = new PassThrough({
          final(callback) {
            clearTimeout(timeoutId)
            timeoutId = undefined
            callback()
          },
        })
        const stream = Readable.toWeb(body) as ReadableStream<Uint8Array>

        responseHeaders.set("Content-Type", "text/html")
        pipe(body)

        resolve(new Response(stream, {
          headers: responseHeaders,
          status: responseStatusCode,
        }))
      },
      onError(error: unknown) {
        responseStatusCode = 500
        if (shellRendered) {
          console.error(error)
        }
      },
      onShellError(error: unknown) {
        clearTimeout(timeoutId)
        timeoutId = undefined
        reject(error)
      },
    })
  })
}
