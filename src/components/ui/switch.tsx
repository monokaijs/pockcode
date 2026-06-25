import * as React from "react"
import { cn } from "@/lib/utils"

type SwitchProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

function Switch({
  checked,
  className,
  defaultChecked = false,
  disabled,
  onCheckedChange,
  onClick,
  ...props
}: SwitchProps) {
  const [internalChecked, setInternalChecked] = React.useState(defaultChecked)
  const isChecked = checked ?? internalChecked

  return (
    <button
      aria-checked={isChecked}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary",
        className,
      )}
      data-state={isChecked ? "checked" : "unchecked"}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented && !disabled) {
          const nextChecked = !isChecked
          if (checked === undefined) {
            setInternalChecked(nextChecked)
          }
          onCheckedChange?.(nextChecked)
        }
      }}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
        )}
        data-state={isChecked ? "checked" : "unchecked"}
      />
    </button>
  )
}

export { Switch }
