import * as React from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

type SelectContextValue = {
  contentRef: React.RefObject<HTMLDivElement | null>
  disabled?: boolean
  open: boolean
  selectedLabel: React.ReactNode
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSelectedLabel: React.Dispatch<React.SetStateAction<React.ReactNode>>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  value: string
  onValueChange?: (value: string) => void
}

const SelectContext = React.createContext<SelectContextValue | null>(null)

function useSelectContext() {
  const context = React.useContext(SelectContext)
  if (!context) {
    throw new Error("Select components must be used inside Select.")
  }
  return context
}

type SelectProps = {
  children: React.ReactNode
  className?: string
  defaultValue?: string
  disabled?: boolean
  value?: string
  onValueChange?: (value: string) => void
}

function Select({ children, className, defaultValue = "", disabled, value, onValueChange }: SelectProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue)
  const [open, setOpen] = React.useState(false)
  const [selectedLabel, setSelectedLabel] = React.useState<React.ReactNode>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const currentValue = value ?? internalValue

  React.useEffect(() => {
    if (!open) {
      return
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !contentRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }

    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  React.useEffect(() => {
    setSelectedLabel(null)
  }, [currentValue])

  const context = React.useMemo<SelectContextValue>(
    () => ({
      contentRef,
      disabled,
      open,
      selectedLabel,
      setOpen,
      setSelectedLabel,
      triggerRef,
      value: currentValue,
      onValueChange: (nextValue) => {
        setInternalValue(nextValue)
        onValueChange?.(nextValue)
      },
    }),
    [currentValue, disabled, open, onValueChange, selectedLabel],
  )

  return (
    <SelectContext.Provider value={context}>
      <div className={cn("relative inline-block", className)} ref={rootRef}>
        {children}
      </div>
    </SelectContext.Provider>
  )
}

type SelectTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement>

function SelectTrigger({ children, className, onClick, ...props }: SelectTriggerProps) {
  const { disabled, open, setOpen, triggerRef } = useSelectContext()
  const { disabled: triggerDisabled, ...restProps } = props

  return (
    <button
      aria-expanded={open}
      className={cn(
        "flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      disabled={disabled || triggerDisabled}
      ref={triggerRef}
      role="combobox"
      type="button"
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          setOpen((current) => !current)
        }
      }}
      {...restProps}
    >
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <ChevronDown className={cn("size-3.5 shrink-0 opacity-70 transition-transform", open && "rotate-180")} />
    </button>
  )
}

type SelectValueProps = {
  placeholder?: React.ReactNode
}

function SelectValue({ placeholder }: SelectValueProps) {
  const { selectedLabel } = useSelectContext()
  return <>{selectedLabel ?? placeholder ?? null}</>
}

type SelectContentProps = React.HTMLAttributes<HTMLDivElement> & {
  align?: "start" | "end"
}

function SelectContent({ align = "start", className, style, ...props }: SelectContentProps) {
  const { contentRef, open, triggerRef } = useSelectContext()
  const [triggerRect, setTriggerRect] = React.useState<DOMRect | null>(null)

  React.useLayoutEffect(() => {
    const updatePosition = () => {
      setTriggerRect(triggerRef.current?.getBoundingClientRect() ?? null)
    }
    if (open) {
      updatePosition()
      window.addEventListener("resize", updatePosition)
      window.addEventListener("scroll", updatePosition, true)
    }
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open, triggerRef])

  if (!open || typeof document === "undefined") {
    return null
  }

  const gutter = 4
  const viewportPadding = 8
  const spaceBelow = triggerRect ? window.innerHeight - triggerRect.bottom - viewportPadding : 0
  const spaceAbove = triggerRect ? triggerRect.top - viewportPadding : 0
  const openAbove = Boolean(triggerRect && spaceBelow < 160 && spaceAbove > spaceBelow)

  return createPortal(
    <div
      className={cn(
        "fixed z-50 max-h-72 min-w-36 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg ide-scrollbar",
        className,
      )}
      ref={contentRef}
      role="listbox"
      style={{
        maxHeight: triggerRect ? Math.max(96, openAbove ? spaceAbove - gutter : spaceBelow - gutter) : undefined,
        minWidth: triggerRect?.width,
        ...(openAbove && triggerRect
          ? { bottom: window.innerHeight - triggerRect.top + gutter }
          : { top: triggerRect ? triggerRect.bottom + gutter : undefined }),
        ...(align === "end" && triggerRect
          ? { right: window.innerWidth - triggerRect.right }
          : { left: triggerRect?.left }),
        ...style,
      }}
      {...props}
    />,
    document.body,
  )
}

type SelectItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label?: React.ReactNode
  value: string
}

function SelectItem({ children, className, label, value, onClick, ...props }: SelectItemProps) {
  const { setOpen, setSelectedLabel, value: currentValue, onValueChange } = useSelectContext()
  const selected = value === currentValue

  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      role="option"
      type="button"
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          setSelectedLabel(label ?? children)
          onValueChange?.(value)
          setOpen(false)
        }
      }}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Check className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
    </button>
  )
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
