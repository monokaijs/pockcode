import type * as Monaco from "monaco-editor"
import { CompletionItemKind as LspCompletionItemKind, DiagnosticSeverity } from "vscode-languageserver-types"
import type {
  CompletionItem as LspCompletionItem,
  CompletionList as LspCompletionList,
  Diagnostic as LspDiagnostic,
  DocumentSymbol as LspDocumentSymbol,
  Hover as LspHover,
  Location as LspLocation,
  LocationLink as LspLocationLink,
  MarkupContent,
  Position as LspPosition,
  SymbolInformation as LspSymbolInformation,
} from "vscode-languageserver-types"
import { URI } from "vscode-uri"
import type { LanguageServerInfo } from "@/lib/api-client"

export type MonacoApi = typeof Monaco

export type LspStatus = {
  detail?: string
  state: "idle" | "starting" | "ready" | "unavailable" | "error"
}

type JsonRpcId = number | string

type JsonRpcMessage = {
  error?: { code: number; message: string }
  id?: JsonRpcId
  jsonrpc: "2.0"
  method?: string
  params?: unknown
  result?: unknown
}

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
}

type MonacoLspOptions = {
  content: string
  editor: Monaco.editor.IStandaloneCodeEditor
  filePath: string
  languageId: string
  monaco: MonacoApi
  onDiagnostics?: (diagnostics: LspDiagnostic[]) => void
  onOpenLocation?: (filePath: string, lineNumber: number, column: number) => boolean | Promise<boolean>
  onStatus?: (status: LspStatus) => void
  server: LanguageServerInfo
  workspaceName: string
  workspacePath: string
}

type TextDocumentPositionParams = {
  position: LspPosition
  textDocument: { uri: string }
}

type PublishDiagnosticsParams = {
  diagnostics: LspDiagnostic[]
  uri: string
}

const lspMarkerOwner = "pockcode-lsp"

export function fileUriFromPath(filePath: string): string {
  return URI.file(filePath).toString()
}

export function lspLanguageIdForPath(filePath: string, fallback: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".tsx")) return "typescriptreact"
  if (lower.endsWith(".jsx")) return "javascriptreact"
  if (lower.endsWith(".ts")) return "typescript"
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript"
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json"
  if (lower.endsWith(".scss")) return "scss"
  if (lower.endsWith(".sass")) return "sass"
  if (lower.endsWith(".less")) return "less"
  if (lower.endsWith(".css")) return "css"
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html"
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python"
  if (lower.endsWith(".rs")) return "rust"
  if (lower.endsWith(".go")) return "go"
  if (/\.(c|h)$/u.test(lower)) return "c"
  if (/\.(cc|cpp|cxx|hh|hpp|hxx)$/u.test(lower)) return "cpp"
  return fallback
}

export function selectLanguageServer(
  servers: LanguageServerInfo[],
  filePath: string,
  languageId: string,
): LanguageServerInfo | null {
  const extension = extensionFor(filePath)
  return servers.find((server) =>
    server.available &&
    (server.languages.includes(languageId) || server.extensions.includes(extension))
  ) ?? null
}

export function attachMonacoLsp(options: MonacoLspOptions): () => void {
  const model = options.editor.getModel()
  if (!model) {
    options.onStatus?.({ state: "unavailable", detail: "Editor model unavailable." })
    return () => undefined
  }

  const client = new WorkspaceLspClient(options)
  const disposables: Monaco.IDisposable[] = [
    options.monaco.languages.registerCompletionItemProvider(options.languageId, {
      triggerCharacters: [".", "\"", "'", "/", "<", ":", "-"],
      provideCompletionItems: async (requestModel, position) => {
        if (!client.ownsModel(requestModel)) {
          return { suggestions: [] }
        }
        const result = await client.request("textDocument/completion", textDocumentPositionParams(requestModel, position))
        return {
          suggestions: completionItems(options.monaco, result, requestModel, position),
        }
      },
    }),
    options.monaco.languages.registerHoverProvider(options.languageId, {
      provideHover: async (requestModel, position) => {
        if (!client.ownsModel(requestModel)) {
          return null
        }
        const result = await client.request("textDocument/hover", textDocumentPositionParams(requestModel, position))
        return hover(options.monaco, result)
      },
    }),
    options.monaco.languages.registerDefinitionProvider(options.languageId, {
      provideDefinition: async (requestModel, position) => {
        if (!client.ownsModel(requestModel)) {
          return null
        }
        const result = await client.request("textDocument/definition", textDocumentPositionParams(requestModel, position))
        const locations = lspLocations(options.monaco, result)
        const externalLocation = locations.find((location) => location.uri.toString() !== requestModel.uri.toString())
        if (externalLocation && options.onOpenLocation) {
          const opened = await options.onOpenLocation(
            externalLocation.uri.fsPath,
            externalLocation.range.startLineNumber,
            externalLocation.range.startColumn,
          )
          if (opened) {
            return []
          }
        }
        return locations
      },
    }),
    options.monaco.languages.registerReferenceProvider(options.languageId, {
      provideReferences: async (requestModel, position) => {
        if (!client.ownsModel(requestModel)) {
          return []
        }
        const result = await client.request("textDocument/references", {
          ...textDocumentPositionParams(requestModel, position),
          context: { includeDeclaration: true },
        })
        return lspLocations(options.monaco, result)
      },
    }),
    options.monaco.languages.registerDocumentSymbolProvider(options.languageId, {
      provideDocumentSymbols: async (requestModel) => {
        if (!client.ownsModel(requestModel)) {
          return []
        }
        const result = await client.request("textDocument/documentSymbol", {
          textDocument: { uri: requestModel.uri.toString() },
        })
        return documentSymbols(options.monaco, result)
      },
    }),
  ]

  return () => {
    for (const disposable of disposables) {
      disposable.dispose()
    }
    options.monaco.editor.setModelMarkers(model, lspMarkerOwner, [])
    client.dispose()
  }
}

class WorkspaceLspClient {
  private disposed = false
  private nextId = 1
  private pending = new Map<JsonRpcId, PendingRequest>()
  private ready: Promise<void>
  private readyReject: (error: Error) => void = () => undefined
  private readyResolve: () => void = () => undefined
  private socket: WebSocket
  private readonly documentUri: string
  private readonly modelUri: string
  private readonly options: MonacoLspOptions

  constructor(options: MonacoLspOptions) {
    this.options = options
    this.documentUri = fileUriFromPath(options.filePath)
    this.modelUri = options.editor.getModel()?.uri.toString() ?? this.documentUri
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.socket = new WebSocket(lspSocketUrl(options.workspacePath, options.server.id))
    this.bindSocket()
  }

  dispose(): void {
    this.disposed = true
    this.options.onStatus?.({ state: "idle" })
    for (const request of this.pending.values()) {
      request.reject(new Error("Language server session closed."))
    }
    this.pending.clear()

    if (this.socket.readyState === WebSocket.OPEN) {
      this.notify("textDocument/didClose", { textDocument: { uri: this.documentUri } })
      void this.sendRequest("shutdown", {}).finally(() => {
        this.notify("exit", {})
        this.socket.close()
      })
      return
    }
    this.socket.close()
  }

  ownsModel(model: Monaco.editor.ITextModel): boolean {
    return model.uri.toString() === this.modelUri
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ready
    return this.sendRequest(method, params)
  }

  private bindSocket(): void {
    this.options.onStatus?.({ state: "starting", detail: this.options.server.displayName })
    this.socket.addEventListener("open", () => {
      void this.initialize()
    })
    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data)
    })
    this.socket.addEventListener("error", () => {
      this.fail(new Error(`${this.options.server.displayName} language server connection failed.`))
    })
    this.socket.addEventListener("close", () => {
      if (!this.disposed) {
        this.fail(new Error(`${this.options.server.displayName} language server stopped.`))
      }
    })
  }

  private fail(error: Error): void {
    this.options.onStatus?.({ state: "error", detail: error.message })
    this.readyReject(error)
    for (const request of this.pending.values()) {
      request.reject(error)
    }
    this.pending.clear()
  }

  private async initialize(): Promise<void> {
    try {
      await this.sendRequest("initialize", {
        capabilities: {
          textDocument: {
            completion: { completionItem: { documentationFormat: ["markdown", "plaintext"], snippetSupport: false } },
            definition: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            publishDiagnostics: { relatedInformation: true },
            references: {},
            synchronization: { didClose: true, didOpen: true, willSave: false, willSaveWaitUntil: false },
          },
          workspace: { workspaceFolders: true },
        },
        clientInfo: { name: "Pockcode" },
        processId: null,
        rootPath: this.options.workspacePath,
        rootUri: fileUriFromPath(this.options.workspacePath),
        workspaceFolders: [{
          name: this.options.workspaceName,
          uri: fileUriFromPath(this.options.workspacePath),
        }],
      })
      this.notify("initialized", {})
      this.notify("textDocument/didOpen", {
        textDocument: {
          languageId: this.options.languageId,
          text: this.options.content,
          uri: this.documentUri,
          version: 1,
        },
      })
      this.options.onStatus?.({ state: "ready", detail: this.options.server.displayName })
      this.readyResolve()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Language server initialization failed."))
    }
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : data instanceof Blob ? null : String(data)
    if (!text) {
      return
    }

    let message: JsonRpcMessage
    try {
      message = JSON.parse(text) as JsonRpcMessage
    } catch {
      return
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message)
      return
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message))
        return
      }
      pending.resolve(message.result)
      return
    }

    if (message.method === "textDocument/publishDiagnostics") {
      this.handleDiagnostics(message.params)
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    this.send({
      id: message.id,
      jsonrpc: "2.0",
      result: this.serverRequestResult(message.method ?? "", message.params),
    })
  }

  private serverRequestResult(method: string, params: unknown): unknown {
    if (method === "workspace/configuration") {
      const items = Array.isArray((params as { items?: unknown[] } | null)?.items)
        ? (params as { items: unknown[] }).items
        : []
      return items.map(() => ({}))
    }
    if (method === "workspace/workspaceFolders") {
      return [{
        name: this.options.workspaceName,
        uri: fileUriFromPath(this.options.workspacePath),
      }]
    }
    return null
  }

  private handleDiagnostics(params: unknown): void {
    const diagnosticsParams = params as Partial<PublishDiagnosticsParams>
    if (diagnosticsParams.uri !== this.documentUri) {
      return
    }

    const diagnostics: LspDiagnostic[] = Array.isArray(diagnosticsParams.diagnostics)
      ? diagnosticsParams.diagnostics
      : []
    const model = this.options.editor.getModel()
    if (model) {
      this.options.monaco.editor.setModelMarkers(
        model,
        lspMarkerOwner,
        diagnostics.map((diagnostic) => monacoMarker(this.options.monaco, diagnostic)),
      )
    }
    this.options.onDiagnostics?.(diagnostics)
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    this.send({ id, jsonrpc: "2.0", method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve })
    })
  }

  private send(message: JsonRpcMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Language server connection is not open.")
    }
    this.socket.send(JSON.stringify(message))
  }
}

function lspSocketUrl(workspacePath: string, serverId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  const params = new URLSearchParams({ serverId, workspacePath })
  return `${protocol}//${window.location.host}/lsp?${params.toString()}`
}

function textDocumentPositionParams(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): TextDocumentPositionParams {
  return {
    position: { character: position.column - 1, line: position.lineNumber - 1 },
    textDocument: { uri: model.uri.toString() },
  }
}

function completionItems(
  monaco: MonacoApi,
  result: unknown,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  const items = Array.isArray(result)
    ? result as LspCompletionItem[]
    : Array.isArray((result as Partial<LspCompletionList> | null)?.items)
      ? (result as LspCompletionList).items
      : []
  const word = model.getWordUntilPosition(position)
  const fallbackRange = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  )

  return items.map((item) => {
    const label = typeof item.label === "string" ? item.label : String(item.label)
    const textEdit = item.textEdit && "range" in item.textEdit ? item.textEdit : null
    return {
      detail: item.detail,
      documentation: markdownString(monaco, item.documentation),
      insertText: textEdit?.newText ?? item.insertText ?? label,
      kind: completionKind(monaco, item.kind),
      label,
      range: textEdit ? range(monaco, textEdit.range) : fallbackRange,
      sortText: item.sortText,
    }
  })
}

function hover(monaco: MonacoApi, result: unknown): Monaco.languages.Hover | null {
  const lspHover = result as LspHover | null
  if (!lspHover?.contents) {
    return null
  }
  const contents = markdownContents(monaco, lspHover.contents)
  if (!contents.length) {
    return null
  }
  return {
    contents,
    range: lspHover.range ? range(monaco, lspHover.range) : undefined,
  }
}

function lspLocations(monaco: MonacoApi, result: unknown): Monaco.languages.Location[] {
  const values = Array.isArray(result) ? result : result ? [result] : []
  return values.flatMap((entry) => {
    if (isLocationLink(entry)) {
      return [{
        range: range(monaco, entry.targetSelectionRange ?? entry.targetRange),
        uri: monaco.Uri.parse(entry.targetUri),
      }]
    }
    if (isLocation(entry)) {
      return [{
        range: range(monaco, entry.range),
        uri: monaco.Uri.parse(entry.uri),
      }]
    }
    return []
  })
}

function documentSymbols(monaco: MonacoApi, result: unknown): Monaco.languages.DocumentSymbol[] {
  const values = Array.isArray(result) ? result : []
  return values.flatMap((entry) => {
    if (isDocumentSymbol(entry)) {
      return [documentSymbol(monaco, entry)]
    }
    if (isSymbolInformation(entry)) {
      return [{
        children: [],
        detail: entry.containerName ?? "",
        kind: symbolKind(monaco, entry.kind),
        name: entry.name,
        range: range(monaco, entry.location.range),
        selectionRange: range(monaco, entry.location.range),
        tags: [],
      }]
    }
    return []
  })
}

function documentSymbol(monaco: MonacoApi, symbol: LspDocumentSymbol): Monaco.languages.DocumentSymbol {
  return {
    children: (symbol.children ?? []).map((child) => documentSymbol(monaco, child)),
    detail: symbol.detail ?? "",
    kind: symbolKind(monaco, symbol.kind),
    name: symbol.name,
    range: range(monaco, symbol.range),
    selectionRange: range(monaco, symbol.selectionRange),
    tags: [],
  }
}

function monacoMarker(monaco: MonacoApi, diagnostic: LspDiagnostic): Monaco.editor.IMarkerData {
  const markerRange = range(monaco, diagnostic.range)
  return {
    endColumn: markerRange.endColumn,
    endLineNumber: markerRange.endLineNumber,
    message: diagnosticMessage(diagnostic.message),
    severity: markerSeverity(monaco, diagnostic.severity),
    source: diagnostic.source ?? "LSP",
    startColumn: markerRange.startColumn,
    startLineNumber: markerRange.startLineNumber,
  }
}

function diagnosticMessage(message: LspDiagnostic["message"]): string {
  return typeof message === "string" ? message : message.value
}

function range(monaco: MonacoApi, input: { end: LspPosition; start: LspPosition }): Monaco.Range {
  return new monaco.Range(
    input.start.line + 1,
    input.start.character + 1,
    input.end.line + 1,
    input.end.character + 1,
  )
}

function markdownContents(monaco: MonacoApi, contents: LspHover["contents"]): Monaco.IMarkdownString[] {
  if (Array.isArray(contents)) {
    return contents.flatMap((item) => markdownString(monaco, item) ?? [])
  }
  const content = markdownString(monaco, contents)
  return content ? [content] : []
}

function markdownString(monaco: MonacoApi, value: unknown): Monaco.IMarkdownString | undefined {
  if (!value) {
    return undefined
  }
  if (typeof value === "string") {
    return { value }
  }
  if (typeof value === "object" && "value" in value && typeof (value as MarkupContent).value === "string") {
    return { value: (value as MarkupContent).value }
  }
  if (typeof value === "object" && "language" in value && "value" in value) {
    const marked = value as { language?: string; value?: string }
    return { value: `\`\`\`${marked.language ?? ""}\n${marked.value ?? ""}\n\`\`\`` }
  }
  void monaco
  return undefined
}

function completionKind(monaco: MonacoApi, kind?: LspCompletionItemKind): Monaco.languages.CompletionItemKind {
  switch (kind) {
    case LspCompletionItemKind.Method:
      return monaco.languages.CompletionItemKind.Method
    case LspCompletionItemKind.Function:
      return monaco.languages.CompletionItemKind.Function
    case LspCompletionItemKind.Constructor:
      return monaco.languages.CompletionItemKind.Constructor
    case LspCompletionItemKind.Field:
      return monaco.languages.CompletionItemKind.Field
    case LspCompletionItemKind.Variable:
      return monaco.languages.CompletionItemKind.Variable
    case LspCompletionItemKind.Class:
      return monaco.languages.CompletionItemKind.Class
    case LspCompletionItemKind.Interface:
      return monaco.languages.CompletionItemKind.Interface
    case LspCompletionItemKind.Module:
      return monaco.languages.CompletionItemKind.Module
    case LspCompletionItemKind.Property:
      return monaco.languages.CompletionItemKind.Property
    case LspCompletionItemKind.Unit:
      return monaco.languages.CompletionItemKind.Unit
    case LspCompletionItemKind.Value:
      return monaco.languages.CompletionItemKind.Value
    case LspCompletionItemKind.Enum:
      return monaco.languages.CompletionItemKind.Enum
    case LspCompletionItemKind.Keyword:
      return monaco.languages.CompletionItemKind.Keyword
    case LspCompletionItemKind.Snippet:
      return monaco.languages.CompletionItemKind.Snippet
    case LspCompletionItemKind.Color:
      return monaco.languages.CompletionItemKind.Color
    case LspCompletionItemKind.File:
      return monaco.languages.CompletionItemKind.File
    case LspCompletionItemKind.Reference:
      return monaco.languages.CompletionItemKind.Reference
    case LspCompletionItemKind.Folder:
      return monaco.languages.CompletionItemKind.Folder
    case LspCompletionItemKind.EnumMember:
      return monaco.languages.CompletionItemKind.EnumMember
    case LspCompletionItemKind.Constant:
      return monaco.languages.CompletionItemKind.Constant
    case LspCompletionItemKind.Struct:
      return monaco.languages.CompletionItemKind.Struct
    case LspCompletionItemKind.Event:
      return monaco.languages.CompletionItemKind.Event
    case LspCompletionItemKind.Operator:
      return monaco.languages.CompletionItemKind.Operator
    case LspCompletionItemKind.TypeParameter:
      return monaco.languages.CompletionItemKind.TypeParameter
    default:
      return monaco.languages.CompletionItemKind.Text
  }
}

function markerSeverity(monaco: MonacoApi, severity?: DiagnosticSeverity): Monaco.MarkerSeverity {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return monaco.MarkerSeverity.Error
    case DiagnosticSeverity.Warning:
      return monaco.MarkerSeverity.Warning
    case DiagnosticSeverity.Information:
      return monaco.MarkerSeverity.Info
    case DiagnosticSeverity.Hint:
      return monaco.MarkerSeverity.Hint
    default:
      return monaco.MarkerSeverity.Warning
  }
}

function symbolKind(monaco: MonacoApi, kind: number): Monaco.languages.SymbolKind {
  return kind in monaco.languages.SymbolKind
    ? kind as Monaco.languages.SymbolKind
    : monaco.languages.SymbolKind.Variable
}

function isLocation(value: unknown): value is LspLocation {
  return Boolean(value && typeof value === "object" && "uri" in value && "range" in value)
}

function isLocationLink(value: unknown): value is LspLocationLink {
  return Boolean(value && typeof value === "object" && "targetUri" in value && "targetRange" in value)
}

function isDocumentSymbol(value: unknown): value is LspDocumentSymbol {
  return Boolean(value && typeof value === "object" && "selectionRange" in value && "range" in value)
}

function isSymbolInformation(value: unknown): value is LspSymbolInformation {
  return Boolean(value && typeof value === "object" && "location" in value && "kind" in value)
}

function extensionFor(filePath: string): string {
  const index = filePath.lastIndexOf(".")
  return index >= 0 ? filePath.slice(index).toLowerCase() : ""
}
