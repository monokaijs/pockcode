import { useCallback, useState } from "react"
import { Popover } from "@base-ui/react/popover"
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, RotateCcw } from "lucide-react"
import type { ProviderModelOption } from "../../../app/types/providers"
import { composerReasoningEffortLabel, providerReasoningEffortOptions, readComposerReasoningEffort } from "@/lib/session"
import type { ChatComposerReasoningEffort } from "@/types/session"
import { cn } from "@/lib/utils"

type ModelSelectorProps = {
  disabled: boolean
  open: boolean
  view: "effort" | "models"
  onOpenChange: (open: boolean) => void
  onViewChange: (view: "effort" | "models") => void
  model: string
  modelOptions: ProviderModelOption[]
  selectedModel?: ProviderModelOption | null
  reasoningEffort: ChatComposerReasoningEffort
  supportsModels: boolean
  supportsReasoningEffort: boolean
  modelsLoading: boolean
  modelsError: string | null
  onModelChange: (value: string) => void
  onEffortChange: (value: string) => void
  onRefresh: () => void
}

export function ModelSelector(props: ModelSelectorProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const anchorRef = useCallback((node: HTMLDivElement | null) => {
    if (node) setPortalContainer(node.closest<HTMLElement>(".session-app"))
  }, [])
  const modelLabel = props.selectedModel?.displayName ?? (props.model || "Default")
  const label = [props.supportsModels ? modelLabel : null, props.supportsReasoningEffort ? composerReasoningEffortLabel(props.reasoningEffort) : null].filter(Boolean).join(" ")

  return (
    <div className="min-w-0" ref={anchorRef}>
      <Popover.Root open={props.open} onOpenChange={(open) => {
        props.onOpenChange(open)
        if (open) {
          props.onViewChange(props.supportsReasoningEffort ? "effort" : "models")
          props.onRefresh()
        }
      }}>
        <Popover.Trigger
          aria-label={`Select model and effort: ${label}`}
          disabled={props.disabled}
          className="flex h-7 max-w-[12rem] items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-muted-foreground disabled:cursor-not-allowed disabled:opacity-55 data-popup-open:bg-accent data-popup-open:text-foreground sm:max-w-[18rem]"
          title={label}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0" />
        </Popover.Trigger>
        <Popover.Portal container={portalContainer}>
          <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={12} className="z-50">
            <Popover.Popup className="w-64 max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-xl outline-none">
              <Popover.Title className="sr-only">Select model and effort</Popover.Title>
              {props.view === "effort" && props.supportsReasoningEffort ? (
                <EffortControl {...props} modelLabel={modelLabel} onShowModels={() => props.onViewChange("models")} />
              ) : (
                <ModelList {...props} onBack={props.supportsReasoningEffort ? () => props.onViewChange("effort") : undefined} onSelected={() => props.onViewChange(props.supportsReasoningEffort ? "effort" : "models")} />
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

function EffortControl(props: ModelSelectorProps & { modelLabel: string; onShowModels: () => void }) {
  const options = providerReasoningEffortOptions(props.selectedModel)
  const selectedIndex = options.findIndex((option) => option.value === props.reasoningEffort)
  const index = Math.max(0, selectedIndex)
  const defaultEffort = readComposerReasoningEffort(props.selectedModel?.defaultReasoningEffort ?? "medium")
  const resetEffort = options.some((option) => option.value === defaultEffort) ? defaultEffort : options[0]?.value
  const progress = options.length > 1 ? index / (options.length - 1) * 100 : 0

  return (
    <div className="p-3">
      <div className="relative flex min-h-10 items-start justify-center px-7">
        <div className="min-w-0 text-center">
          <div className="text-[14px] font-medium text-foreground">{composerReasoningEffortLabel(props.reasoningEffort)}</div>
          {props.supportsModels ? (
            <button type="button" onClick={props.onShowModels} className="mx-auto flex max-w-full items-center gap-0.5 rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-muted-foreground">
              <span className="truncate">{props.modelLabel}</span><ChevronRight className="size-3 shrink-0" />
            </button>
          ) : <span className="text-[11px] text-muted-foreground">Reasoning effort</span>}
        </div>
        <button aria-label="Reset effort to model default" title="Reset effort to model default" type="button" onClick={() => { if (resetEffort) props.onEffortChange(resetEffort) }} className="absolute right-0 top-0 grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-muted-foreground">
          <RotateCcw className="size-3.5" />
        </button>
      </div>
      <div className="relative mt-2 h-8">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-2.5 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none" style={{ width: `${progress}%` }} />
        </div>
        <input
          aria-label="Reasoning effort"
          aria-valuetext={composerReasoningEffortLabel(props.reasoningEffort)}
          className="model-effort-slider relative z-10 block w-full"
          type="range" min={0} max={Math.max(0, options.length - 1)} step={1} value={index}
          disabled={options.length < 2}
          onChange={(event) => { const option = options[Number(event.target.value)]; if (option) props.onEffortChange(option.value) }}
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-2.5 top-0 z-20 flex h-8 items-center justify-between">
          {options.map((option, optionIndex) => <span key={option.value} className={cn("size-1 rounded-full transition-colors duration-200 motion-reduce:transition-none", optionIndex <= index ? "bg-background/50" : "bg-muted-foreground/40", props.reasoningEffort === option.value && "opacity-0")} />)}
          <span className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-sm transition-[left] duration-200 ease-out motion-reduce:transition-none" style={{ left: `${progress}%` }} />
        </div>
      </div>
      {selectedIndex < 0 ? <p className="mt-2 text-[11px] text-muted-foreground">Choose a supported effort for this model.</p> : null}
    </div>
  )
}

function ModelList(props: ModelSelectorProps & { onBack?: () => void; onSelected: () => void }) {
  const select = (value: string) => { props.onModelChange(value); props.onSelected() }
  return (
    <div className="p-1.5">
      <div className="flex items-center gap-1 px-1.5 py-1 text-[11px] text-muted-foreground">
        {props.onBack ? <button aria-label="Back to effort" type="button" onClick={props.onBack} className="grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-muted-foreground"><ChevronLeft className="size-3.5" /></button> : null}
        <span className="flex-1">Select model</span>
        <button aria-label="Refresh models" type="button" disabled={props.modelsLoading} onClick={props.onRefresh} className="grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-muted-foreground disabled:opacity-50">
          {props.modelsLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        </button>
      </div>
      <div className="max-h-[min(22rem,50vh)] overflow-y-auto ide-scrollbar" role="group" aria-label="Models">
        <ModelOption title="Default" description="Use the account’s default model" selected={!props.model} onClick={() => select("")} />
        {props.modelOptions.map((option) => (
          <ModelOption key={option.id} title={option.displayName} selected={props.model === option.model || props.model === option.id} onClick={() => select(option.model)} />
        ))}
      </div>
      {props.modelsError ? (
        <div role="status" className="px-2 py-2 text-[11px] text-muted-foreground">Couldn’t refresh models. <button type="button" onClick={props.onRefresh} disabled={props.modelsLoading} className="text-foreground underline underline-offset-2 disabled:opacity-50">Retry</button></div>
      ) : props.modelsLoading && !props.modelOptions.length ? (
        <p role="status" className="px-2 py-2 text-[11px] text-muted-foreground">Loading models…</p>
      ) : !props.modelOptions.length ? (
        <p role="status" className="px-2 py-2 text-[11px] text-muted-foreground">No models available for this account.</p>
      ) : null}
    </div>
  )
}

function ModelOption({ title, description, selected, onClick }: { title: string; description?: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-muted-foreground">
      <span className="min-w-0 flex-1"><span className="block truncate">{title}</span>{description ? <span className="block text-[11px] text-muted-foreground">{description}</span> : null}</span>
      {selected ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </button>
  )
}
