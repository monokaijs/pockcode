type ResizePointerEvent = {
  clientX: number
  clientY: number
  currentTarget: { setPointerCapture: (pointerId: number) => void }
  pointerId: number
  preventDefault: () => void
}

type HorizontalResizeOptions = {
  initialWidth: number
  max: number
  min: number
  onResize: (width: number) => void
  origin: "left" | "right"
}

type VerticalResizeOptions = {
  initialHeight: number
  max: number
  min: number
  onResize: (height: number) => void
  origin: "bottom" | "top"
}

export function startHorizontalResize(event: ResizePointerEvent, options: HorizontalResizeOptions) {
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const cleanup = prepareDocumentForResize("col-resize")

  const handlePointerMove = (moveEvent: PointerEvent) => {
    const delta = options.origin === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX
    options.onResize(clamp(options.initialWidth + delta, options.min, options.max))
  }
  const stopResize = () => {
    cleanup()
    document.removeEventListener("pointermove", handlePointerMove)
    document.removeEventListener("pointerup", stopResize)
  }
  document.addEventListener("pointermove", handlePointerMove)
  document.addEventListener("pointerup", stopResize)
}

export function startVerticalResize(event: ResizePointerEvent, options: VerticalResizeOptions) {
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  const startY = event.clientY
  const cleanup = prepareDocumentForResize("row-resize")

  const handlePointerMove = (moveEvent: PointerEvent) => {
    const delta = options.origin === "top" ? startY - moveEvent.clientY : moveEvent.clientY - startY
    options.onResize(clamp(options.initialHeight + delta, options.min, options.max))
  }
  const stopResize = () => {
    cleanup()
    document.removeEventListener("pointermove", handlePointerMove)
    document.removeEventListener("pointerup", stopResize)
  }
  document.addEventListener("pointermove", handlePointerMove)
  document.addEventListener("pointerup", stopResize)
}

function prepareDocumentForResize(cursor: string) {
  const previousCursor = document.body.style.cursor
  const previousUserSelect = document.body.style.userSelect
  document.body.style.cursor = cursor
  document.body.style.userSelect = "none"
  return () => {
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}
