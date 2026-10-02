import { Tooltip } from "@base-ui/react/tooltip"
import { useEffect, useRef, useState, type RefObject } from "react"
import type { ChatNavigationItem } from "@/lib/chat-navigation"
import { cn } from "@/lib/utils"

export function ChatMessageNavigation({ contentRef, items, onNavigate, scrollRef }: {
  contentRef: RefObject<HTMLDivElement | null>
  items: ChatNavigationItem[]
  onNavigate: () => void
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const railRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const viewport = scrollRef.current
    const content = contentRef.current
    if (!viewport || !content || !items.length) return

    const anchors = new Map(Array.from(content.querySelectorAll<HTMLElement>("[data-chat-message-id]"))
      .map((element) => [element.dataset.chatMessageId, element]))
    let frame = 0
    const update = () => {
      frame = 0
      const readingLine = viewport.getBoundingClientRect().top + 24
      let current = items[0].id
      for (const item of items) {
        const anchor = anchors.get(item.id)
        if (anchor && anchor.getBoundingClientRect().top <= readingLine) current = item.id
      }
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2) {
        current = items.at(-1)!.id
      }
      setActiveId(current)
    }
    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    update()
    viewport.addEventListener("scroll", scheduleUpdate, { passive: true })
    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(viewport)
    observer.observe(content)
    return () => {
      viewport.removeEventListener("scroll", scheduleUpdate)
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [contentRef, items, scrollRef])

  useEffect(() => {
    const rail = railRef.current
    const marker = rail?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!rail || !marker) return
    const top = marker.offsetTop
    if (top < rail.scrollTop || top + marker.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = top - rail.clientHeight / 2
    }
  }, [activeId])

  const jumpToMessage = (id: string) => {
    const viewport = scrollRef.current
    const anchor = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-chat-message-id]") ?? [])
      .find((element) => element.dataset.chatMessageId === id)
    if (!viewport || !anchor) return
    onNavigate()
    viewport.scrollTo({
      top: viewport.scrollTop + anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    })
    setActiveId(id)
  }

  if (items.length < 2) return null

  return (
    <Tooltip.Provider delay={150}>
      <nav aria-label="Chat message navigation" className="chat-message-navigation absolute left-1 top-1/2 z-10 max-h-[calc(100%-2rem)] w-5 -translate-y-1/2 overflow-y-auto py-2" ref={railRef}>
        {items.map((item, index) => (
          <Tooltip.Root key={item.id}>
            <Tooltip.Trigger
              aria-current={activeId === item.id ? "location" : undefined}
              aria-label={`Jump to message ${index + 1}: ${item.prompt.slice(0, 100)}`}
              className="group flex h-2.5 w-full items-center justify-center rounded-sm px-1 outline-none focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
              type="button"
              onClick={() => jumpToMessage(item.id)}
            >
              <span className={cn(
                "h-0.5 rounded-full transition-[width,background-color] motion-reduce:transition-none group-hover:w-3 group-hover:bg-foreground group-focus-visible:w-3 group-focus-visible:bg-foreground",
                activeId === item.id ? "w-2 bg-foreground/80" : "w-1.5 bg-muted-foreground/35",
              )} />
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Positioner side="right" sideOffset={12} className="z-50">
                <Tooltip.Popup className="grid w-80 max-w-[calc(100vw-5rem)] gap-1.5 rounded-xl border border-border bg-popover p-3 text-[12px] leading-5 text-popover-foreground shadow-xl">
                  <p className="truncate font-medium">{item.prompt}</p>
                  {item.response ? <p className="line-clamp-3 text-muted-foreground">{item.response}</p> : null}
                  <p className="text-[10px] text-muted-foreground/70">Message {index + 1} of {items.length}</p>
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </nav>
    </Tooltip.Provider>
  )
}
