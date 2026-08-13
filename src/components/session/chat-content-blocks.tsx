import type { MessageContentBlock, MessageToolCall } from "@/lib/api-client"
import { MarkdownContent } from "@/components/session/chat-markdown"

type ContentBlocksProps = {
  blocks: MessageContentBlock[]
  compact?: boolean
  openFileLink?: (href: string) => boolean
}

export function MessageContentBlocks({ blocks, compact, openFileLink }: ContentBlocksProps) {
  return (
    <div className={compact ? "grid gap-2" : "grid gap-3"}>
      {blocks.map((block, index) => (
        <MessageContentBlockView
          block={block}
          compact={compact}
          key={`${block.type}:${contentBlockKey(block)}:${index}`}
          openFileLink={openFileLink}
        />
      ))}
    </div>
  )
}

export function StructuredToolCallContent({ openFileLink, toolCall }: {
  openFileLink?: (href: string) => boolean
  toolCall: MessageToolCall
}) {
  const contentBlocks = toolCall.content.filter((entry) => entry.type === "content")
  const diffs = toolCall.content.filter((entry) => entry.type === "diff")
  const terminals = toolCall.content.filter((entry) => entry.type === "terminal")
  return (
    <div className="grid gap-3 text-[12px]">
      {toolCall.locations.length ? (
        <div className="flex flex-wrap gap-1.5">
          {toolCall.locations.map((location, index) => (
            <button
              className="rounded border border-border bg-background px-2 py-1 font-mono text-[11px] hover:bg-accent"
              key={`${location.path}:${location.line ?? ""}:${index}`}
              type="button"
              onClick={() => openFileLink?.(`${location.path}${location.line ? `:${location.line}` : ""}`)}
            >
              {location.path}{location.line ? `:${location.line}` : ""}
            </button>
          ))}
        </div>
      ) : null}
      {diffs.map((diff, index) => (
        <div className="min-w-0 overflow-hidden rounded-md border border-border" key={`${diff.path}:${index}`}>
          <button
            className="block w-full truncate border-b border-border bg-accent px-2 py-1 text-left font-mono text-[11px]"
            type="button"
            onClick={() => openFileLink?.(diff.path)}
          >
            {diff.path}
          </button>
          <div className="grid min-w-0 gap-px bg-border md:grid-cols-2">
            <DiffText label="Before" tone="delete" value={diff.oldText ?? ""} />
            <DiffText label="After" tone="add" value={diff.newText} />
          </div>
        </div>
      ))}
      {contentBlocks.map((entry, index) => (
        <MessageContentBlockView block={entry.content} compact key={`content:${index}`} openFileLink={openFileLink} />
      ))}
      {terminals.map((terminal) => (
        <div className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px]" key={terminal.terminalId}>
          Terminal {terminal.terminalId}
        </div>
      ))}
      {toolCall.rawInput !== null && toolCall.rawInput !== undefined ? (
        <JsonDetails label="Input" value={toolCall.rawInput} />
      ) : null}
      {toolCall.rawOutput !== null && toolCall.rawOutput !== undefined ? (
        <JsonDetails label="Output" value={toolCall.rawOutput} />
      ) : null}
    </div>
  )
}

function MessageContentBlockView({ block, compact, openFileLink }: {
  block: MessageContentBlock
  compact?: boolean
  openFileLink?: (href: string) => boolean
}) {
  if (block.type === "text") {
    return <MarkdownContent compact={compact} content={block.text} openFileLink={openFileLink} />
  }
  if (block.type === "image") {
    const source = mediaSource(block.uri, block.data, block.mimeType, "image/")
    return source ? (
      <figure className="min-w-0">
        <img alt="ACP message attachment" className="max-h-[32rem] max-w-full rounded-md border border-border object-contain" src={source} />
      </figure>
    ) : <UnavailableMedia label={`Image (${block.mimeType})`} />
  }
  if (block.type === "audio") {
    const source = mediaSource(null, block.data, block.mimeType, "audio/")
    return source ? <audio className="max-w-full" controls preload="metadata" src={source} /> : <UnavailableMedia label={`Audio (${block.mimeType})`} />
  }
  if (block.type === "resource_link") {
    return <ResourceLink description={block.description} label={block.title || block.name} mimeType={block.mimeType} openFileLink={openFileLink} uri={block.uri} />
  }
  if (block.resource.type === "text") {
    return (
      <div className="min-w-0 rounded-md border border-border bg-background p-2">
        <ResourceLink label={block.resource.uri} mimeType={block.resource.mimeType} openFileLink={openFileLink} uri={block.resource.uri} />
        <div className="mt-2">
          {block.resource.mimeType?.includes("markdown")
            ? <MarkdownContent compact content={block.resource.text} openFileLink={openFileLink} />
            : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] ide-scrollbar">{block.resource.text}</pre>}
        </div>
      </div>
    )
  }
  const source = mediaSource(null, block.resource.blob, block.resource.mimeType || "application/octet-stream", "")
  return source ? (
    <a className="inline-flex max-w-full items-center rounded border border-border bg-background px-2 py-1 text-info hover:bg-accent" download={resourceName(block.resource.uri)} href={source}>
      Download {block.resource.uri}
    </a>
  ) : <UnavailableMedia label={`Binary resource: ${block.resource.uri}`} />
}

function ResourceLink({ description, label, mimeType, openFileLink, uri }: {
  description?: string | null
  label: string
  mimeType?: string | null
  openFileLink?: (href: string) => boolean
  uri: string
}) {
  const external = /^(https?:|mailto:)/iu.test(uri)
  return (
    <div className="min-w-0">
      <a
        className="block truncate text-info underline decoration-info/40 underline-offset-2"
        href={external ? uri : "#"}
        rel={external ? "noreferrer" : undefined}
        target={external ? "_blank" : undefined}
        onClick={(event) => {
          if (!external) {
            event.preventDefault()
            openFileLink?.(uri)
          }
        }}
      >
        {label}
      </a>
      {description || mimeType ? <div className="text-[11px] text-muted-foreground">{description || mimeType}</div> : null}
    </div>
  )
}

function DiffText({ label, tone, value }: { label: string; tone: "add" | "delete"; value: string }) {
  return (
    <div className="min-w-0 bg-background">
      <div className={tone === "add" ? "px-2 py-1 text-diff-addition-foreground" : "px-2 py-1 text-diff-deletion-foreground"}>{label}</div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-[11px] ide-scrollbar">{value || "∅"}</pre>
    </div>
  )
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary className="cursor-pointer text-muted-foreground">{label}</summary>
      <pre className="mt-1 max-h-80 overflow-auto rounded-md border border-border bg-background p-2 whitespace-pre-wrap break-words font-mono text-[11px] ide-scrollbar">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

function UnavailableMedia({ label }: { label: string }) {
  return <div className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">{label} unavailable</div>
}

function mediaSource(uri: string | null | undefined, data: string, mimeType: string, requiredPrefix: string): string | null {
  if (uri && /^(https?:|blob:|data:)/iu.test(uri)) {
    return uri
  }
  if ((!requiredPrefix || mimeType.startsWith(requiredPrefix)) && /^[\w.+-]+\/[\w.+-]+$/u.test(mimeType) && data) {
    return `data:${mimeType};base64,${data}`
  }
  return null
}

function resourceName(uri: string): string {
  return uri.split(/[\\/]/u).at(-1) || "resource"
}

function contentBlockKey(block: MessageContentBlock): string {
  if (block.type === "text") return block.text.slice(0, 32)
  if (block.type === "resource_link") return block.uri
  if (block.type === "resource") return block.resource.uri
  return `${block.mimeType}:${block.data.slice(0, 16)}`
}
