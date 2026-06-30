import { useMemo, useRef, type ReactNode } from "react"
import {
  hashString,
  markdownBlockSignature,
  parseMarkdownBlocks,
  safeMarkdownHref,
} from "@/lib/session"
import { cn } from "@/lib/utils"
import type { MarkdownBlock } from "@/types/session"

type MarkdownContentProps = {
  animateChanges?: boolean
  compact?: boolean
  content: string
  openFileLink?: (href: string) => boolean
  scopeKey?: string | null
}

export function MarkdownContent({
  animateChanges,
  compact,
  content,
  openFileLink,
  scopeKey,
}: MarkdownContentProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content])
  const blockSignatures = useMemo(() => blocks.map(markdownBlockSignature), [blocks])
  const animatedBlockIndexes = useChangedIndexes(blockSignatures, scopeKey ?? null, Boolean(animateChanges))

  return (
    <div className={cn("chat-markdown min-w-0 max-w-full", compact ? "space-y-2" : "space-y-3")}>
      {blocks.map((block, index) => (
        <div
          className={cn("min-w-0 max-w-full", animatedBlockIndexes.has(index) && "chat-append-enter")}
          key={`${index}:${hashString(blockSignatures[index] ?? "")}`}
        >
          {renderMarkdownBlock(block, index, Boolean(compact), openFileLink)}
        </div>
      ))}
    </div>
  )
}

function useChangedIndexes(signatures: string[], scopeKey: string | null, enabled: boolean): Set<number> {
  const stateRef = useRef<{ scopeKey: string | null; signatures: string[] }>({
    scopeKey: null,
    signatures: [],
  })
  const signaturesKey = signatures.map(hashString).join(":")

  return useMemo(() => {
    if (!enabled) {
      return new Set<number>()
    }

    const state = stateRef.current
    if (state.scopeKey !== scopeKey) {
      stateRef.current = { scopeKey, signatures }
      return new Set<number>()
    }

    const changedIndexes = new Set<number>()
    signatures.forEach((signature, index) => {
      if (state.signatures[index] !== signature) {
        changedIndexes.add(index)
      }
    })
    stateRef.current = { scopeKey, signatures }
    return changedIndexes
  }, [enabled, scopeKey, signatures, signaturesKey])
}

function renderMarkdownBlock(
  block: MarkdownBlock,
  index: number,
  compact: boolean,
  openFileLink?: (href: string) => boolean,
): ReactNode {
  if (block.type === "code") {
    return (
      <pre
        className="min-w-0 max-w-full overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-5 text-foreground ide-scrollbar"
        key={index}
      >
        <code>{block.value}</code>
      </pre>
    )
  }

  if (block.type === "heading") {
    const Tag = (`h${Math.min(block.level, 4)}`) as "h1" | "h2" | "h3" | "h4"
    return (
      <Tag className={cn("font-semibold text-foreground", block.level <= 2 ? "text-[15px]" : "text-[14px]")} key={index}>
        {renderInlineMarkdown(block.text, `heading-${index}`, openFileLink)}
      </Tag>
    )
  }

  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul"
    return (
      <Tag className={cn("grid gap-1 pl-5", block.ordered ? "list-decimal" : "list-disc")} key={index}>
        {block.items.map((item, itemIndex) => (
          <li className="min-w-0" key={itemIndex}>{renderInlineMarkdown(item, `list-${index}-${itemIndex}`, openFileLink)}</li>
        ))}
      </Tag>
    )
  }

  if (block.type === "blockquote") {
    return (
      <blockquote className="min-w-0 border-l-2 border-border pl-3 text-muted-foreground" key={index}>
        {renderInlineLines(block.lines, `quote-${index}`, openFileLink)}
      </blockquote>
    )
  }

  if (block.type === "table") {
    return (
      <div className="min-w-0 max-w-full overflow-auto ide-scrollbar" key={index}>
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th className="border border-border bg-accent px-2 py-1 font-semibold text-foreground" key={headerIndex}>
                  {renderInlineMarkdown(header, `table-${index}-header-${headerIndex}`, openFileLink)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td className="border border-border px-2 py-1 align-top" key={cellIndex}>
                    {renderInlineMarkdown(cell, `table-${index}-${rowIndex}-${cellIndex}`, openFileLink)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (block.type === "hr") {
    return <hr className="border-border" key={index} />
  }

  return (
    <p className={cn("min-w-0", compact ? "leading-5" : "leading-6")} key={index}>
      {renderInlineLines(block.lines, `paragraph-${index}`, openFileLink)}
    </p>
  )
}

function renderInlineLines(
  lines: string[],
  keyPrefix: string,
  openFileLink?: (href: string) => boolean,
): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index ? [<br key={`${keyPrefix}-br-${index}`} />] : []),
    ...renderInlineMarkdown(line, `${keyPrefix}-${index}`, openFileLink),
  ])
}

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  openFileLink?: (href: string) => boolean,
): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/gu
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    const key = `${keyPrefix}-${nodes.length}`
    if (token.startsWith("`")) {
      nodes.push(
        <code className="rounded bg-background px-1 py-0.5 font-mono text-[12px] text-foreground" key={key}>
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), `${key}-strong`, openFileLink)}</strong>)
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{renderInlineMarkdown(token.slice(1, -1), `${key}-em`, openFileLink)}</em>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u)
      const href = link?.[2]?.trim() ?? ""
      const safeHref = safeMarkdownHref(href)
      nodes.push(
        <a
          className="text-info underline decoration-info/40 underline-offset-2 hover:text-info"
          href={safeHref}
          key={key}
          rel={safeHref === "#" ? undefined : "noreferrer"}
          target={safeHref === "#" ? undefined : "_blank"}
          onClick={(event) => {
            if (openFileLink?.(href)) {
              event.preventDefault()
              return
            }
            if (safeHref === "#") {
              event.preventDefault()
            }
          }}
        >
          {renderInlineMarkdown(link?.[1] ?? token, `${key}-link`, openFileLink)}
        </a>,
      )
    }
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}
