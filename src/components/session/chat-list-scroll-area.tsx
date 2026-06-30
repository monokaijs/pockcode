import type { ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"

export function ChatListScrollArea({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerStartY: number; scrollStartTop: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [scrollbar, setScrollbar] = useState({ height: 0, isScrollable: false, offset: 0 })

  const updateScrollbar = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const scrollableDistance = viewport.scrollHeight - viewport.clientHeight
    if (scrollableDistance <= 1) {
      setScrollbar((current) =>
        current.height === 0 && !current.isScrollable && current.offset === 0
          ? current
          : { height: 0, isScrollable: false, offset: 0 },
      )
      return
    }

    const height = Math.max(28, Math.round((viewport.clientHeight / viewport.scrollHeight) * viewport.clientHeight))
    const maxOffset = Math.max(0, viewport.clientHeight - height)
    const offset = Math.round((viewport.scrollTop / scrollableDistance) * maxOffset)
    setScrollbar((current) =>
      current.height === height && current.isScrollable && current.offset === offset
        ? current
        : { height, isScrollable: true, offset },
    )
  }, [])

  useEffect(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) {
      return
    }

    updateScrollbar()
    const resizeObserver = new ResizeObserver(updateScrollbar)
    resizeObserver.observe(content)
    resizeObserver.observe(viewport)
    return () => resizeObserver.disconnect()
  }, [updateScrollbar])

  useEffect(() => {
    updateScrollbar()
  }, [children, updateScrollbar])

  useEffect(() => {
    if (!isDragging) {
      return
    }

    function handlePointerMove(event: PointerEvent) {
      const drag = dragRef.current
      const viewport = viewportRef.current
      if (!drag || !viewport) {
        return
      }

      event.preventDefault()
      const scrollableDistance = viewport.scrollHeight - viewport.clientHeight
      const thumbTravel = viewport.clientHeight - scrollbar.height
      if (scrollableDistance <= 0 || thumbTravel <= 0) {
        return
      }

      viewport.scrollTop = drag.scrollStartTop + ((event.clientY - drag.pointerStartY) / thumbTravel) * scrollableDistance
      updateScrollbar()
    }

    function handlePointerEnd() {
      dragRef.current = null
      setIsDragging(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerEnd)
    window.addEventListener("pointercancel", handlePointerEnd)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerEnd)
      window.removeEventListener("pointercancel", handlePointerEnd)
    }
  }, [isDragging, scrollbar.height, updateScrollbar])

  return (
    <div className="relative mt-2 min-h-0 flex-1">
      <div className="chat-list-scroll-viewport h-full min-h-0 overflow-auto" ref={viewportRef} onScroll={updateScrollbar}>
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  )
}
