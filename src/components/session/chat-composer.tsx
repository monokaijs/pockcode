import { Brain, Check, ChevronDown, Cpu, FileText, Folder, GripVertical, Pencil, Plus, Route, Shield, SlidersHorizontal, Square, Trash2, X, Zap } from "lucide-react"
import type { DragEvent as ReactDragEvent, ReactNode } from "react"
import type { ChatMessageResponse } from "@/lib/api-client"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import {
  composerReasoningEffortLabel,
  composerReasoningEffortOptions,
  composerServiceTierLabel,
  composerServiceTierOptions,
  type ChatSlashCommand,
} from "@/lib/session"
import { cn } from "@/lib/utils"
import type { ChatComposerAccessMode, ChatComposerAttachment, UserInputQuestion } from "@/types/session"
import { useChatPane } from "@/components/session/chat-pane-context"

export function ChatComposer() {
  const pane = useChatPane()

  return (
    <footer className="px-3 pb-3">
      <ChatQueuedMessageList />
      <div className="mx-auto rounded-lg border border-border bg-secondary p-3 shadow-inner">
        <ChatErrorNotice />
        <PendingUserInputPrompt />
        <ChatAttachmentList attachments={pane.attachments} onRemove={pane.removeAttachment} />
        <textarea
          className="min-h-8 w-full resize-none bg-transparent text-[13px] font-medium leading-5 text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Describe the outcome you want"
          ref={pane.textareaRef}
          value={pane.draft}
          onChange={(event) => pane.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void pane.submit()
            }
          }}
        />
        <SlashCommandPalette />
        <ComposerControls />
      </div>
    </footer>
  )
}

function ChatQueuedMessageList() {
  const pane = useChatPane()

  if (!pane.queuedMessages.length) {
    return null
  }
  return (
    <div className="mx-auto mb-2 grid max-h-44 gap-1 overflow-auto pr-0.5 ide-scrollbar" aria-label="Queued messages">
      <div className="flex min-h-5 items-center justify-between gap-2 px-1 text-[11px] font-medium text-muted-foreground">
        <span>Queued</span>
        <span>{pane.queuedMessages.length}</span>
      </div>
      {pane.queuedMessages.map((message) => (
        <ChatQueuedMessageItem key={message.id} message={message} />
      ))}
    </div>
  )
}

function ChatQueuedMessageItem({ message }: { message: ChatMessageResponse }) {
  const pane = useChatPane()
  const runId = message.runId
  const draggable = Boolean(runId)
  const draggingOver = Boolean(runId && pane.dragOverQueuedRunId === runId)

  return (
    <article
      className={cn(
        "group flex min-w-0 items-start gap-2 rounded-md border border-border bg-secondary/95 px-2 py-1.5 text-[12px] shadow-sm",
        draggingOver && "outline outline-1 outline-primary/70",
      )}
      draggable={draggable}
      onDragEnd={() => pane.setDragOverQueuedRunId(null)}
      onDragEnter={() => {
        if (runId) {
          pane.setDragOverQueuedRunId(runId)
        }
      }}
      onDragOver={(event) => {
        if (runId) {
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
        }
      }}
      onDragStart={(event: ReactDragEvent<HTMLElement>) => {
        if (!runId) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", runId)
      }}
      onDrop={(event) => {
        if (!runId) {
          return
        }
        event.preventDefault()
        const sourceRunId = event.dataTransfer.getData("text/plain")
        if (sourceRunId) {
          const bounds = event.currentTarget.getBoundingClientRect()
          const placement = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before"
          pane.reorderQueuedMessage(sourceRunId, runId, placement)
        }
      }}
    >
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded text-muted-foreground",
          draggable ? "cursor-grab hover:bg-accent hover:text-foreground" : "opacity-45",
        )}
        title={draggable ? "Drag to reorder" : "Queued"}
      >
        <GripVertical className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5 text-foreground">
        <div className="max-h-10 overflow-hidden">{message.content}</div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          aria-label="Steer queued message"
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!runId}
          title="Steer"
          type="button"
          onClick={() => {
            if (runId) {
              void pane.onSteerQueuedMessage(message.chatId, runId)
            }
          }}
        >
          <Route className="size-3.5" />
        </button>
        <button
          aria-label="Edit queued message"
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!runId}
          title="Edit"
          type="button"
          onClick={() => {
            if (runId) {
              void pane.onEditQueuedMessage(message.chatId, runId, message.content)
            }
          }}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          aria-label="Delete queued message"
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-destructive disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!runId}
          title="Delete"
          type="button"
          onClick={() => {
            if (runId) {
              void pane.onDeleteQueuedMessage(message.chatId, runId)
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </article>
  )
}

function ChatErrorNotice() {
  const pane = useChatPane()
  const message = pane.actionError ?? pane.error
  if (!message) {
    return null
  }
  return (
    <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] font-medium leading-5 text-destructive">
      {message}
    </div>
  )
}

function SlashCommandPalette() {
  const pane = useChatPane()
  if (!pane.slashMatches.length || !pane.draft.trim().startsWith("/")) {
    return null
  }
  return (
    <div className="mb-2 max-h-56 overflow-auto rounded-md border border-border bg-popover p-1 text-foreground shadow-lg">
      {pane.slashMatches.map((command) => (
        <SlashCommandButton command={command} key={command.id} />
      ))}
    </div>
  )
}

function SlashCommandButton({ command }: { command: ChatSlashCommand }) {
  const pane = useChatPane()
  const commandText = `/${command.id}`
  const needsArgument = command.usage.includes("<") || command.usage.includes("[")
  return (
    <button
      className="grid min-h-8 w-full grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] items-center gap-2 rounded-sm px-2 text-left text-[12px] hover:bg-accent"
      type="button"
      onClick={() => {
        pane.setDraft(needsArgument ? `${commandText} ` : commandText)
        pane.textareaRef.current?.focus()
      }}
    >
      <span className="font-semibold text-foreground">{command.usage}</span>
      <span className="min-w-0 truncate text-muted-foreground">{command.description}</span>
    </button>
  )
}

function PendingUserInputPrompt() {
  const pane = useChatPane()
  const question = pane.activeUserInputQuestion

  if (!pane.pendingUserInputPrompt || !question) {
    return null
  }
  const stageCount = pane.pendingUserInputQuestions.length
  return (
    <div className="mb-3 grid gap-2.5 rounded-md border border-border bg-card p-2.5 text-[12px] text-foreground">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold text-muted-foreground">
          {question.header || "User input"}
        </span>
        {stageCount > 1 ? (
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
            {pane.userInputStageIndex + 1}/{stageCount}
          </span>
        ) : null}
      </div>
      <PendingUserInputQuestion question={question} />
      <div className="flex items-center justify-between gap-2">
        <button
          className="h-7 rounded-md border border-border px-2.5 text-[11px] font-semibold text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
          disabled={pane.userInputStageIndex === 0 || pane.userInputSubmitting}
          type="button"
          onClick={pane.goToPreviousUserInputStage}
        >
          Back
        </button>
        <button
          className="h-7 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!pane.canContinueUserInput || pane.userInputSubmitting}
          type="button"
          onClick={pane.goToNextUserInputStage}
        >
          {pane.userInputSubmitting ? "Sending" : pane.userInputIsLastStage ? "Submit" : "Next"}
        </button>
      </div>
    </div>
  )
}

function PendingUserInputQuestion({ question }: { question: UserInputQuestion }) {
  const pane = useChatPane()
  const answer = pane.userInputAnswerValue(question)
  const freeform = pane.userInputUsesFreeform(question)

  return (
    <div className="grid gap-2">
      <div className="font-medium leading-5 text-foreground">{question.question}</div>
      {question.options.length ? (
        <div className="grid gap-1.5">
          {question.options.map((option) => {
            const selected = answer === option.label && !freeform
            return (
              <button
                className={cn(
                  "grid min-h-9 w-full gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-[11px] font-medium",
                  selected
                    ? "border-primary bg-primary/20 text-foreground"
                    : "border-border bg-secondary text-muted-foreground hover:bg-accent",
                )}
                key={option.label}
                title={option.description}
                type="button"
                onClick={() => pane.chooseUserInputOption(question, option.label)}
              >
                <span className="text-[12px] text-foreground">{option.label}</span>
                {option.description ? <span className="text-[11px] text-muted-foreground">{option.description}</span> : null}
              </button>
            )
          })}
          <button
            className={cn(
              "grid min-h-9 w-full gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-[11px] font-medium",
              freeform
                ? "border-primary bg-primary/20 text-foreground"
                : "border-border bg-secondary text-muted-foreground hover:bg-accent",
            )}
            type="button"
            onClick={() => pane.chooseUserInputFreeform(question)}
          >
            <span className="text-[12px] text-foreground">Other</span>
          </button>
        </div>
      ) : null}
      {freeform ? (
        <input
          className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:border-primary"
          autoFocus
          type={question.isSecret ? "password" : "text"}
          value={answer}
          onChange={(event) => pane.updateUserInputAnswer(question.id, event.target.value, { freeform: true })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && pane.canContinueUserInput && !pane.userInputSubmitting) {
              event.preventDefault()
              pane.goToNextUserInputStage()
            }
          }}
        />
      ) : null}
    </div>
  )
}

function ChatAttachmentList({ attachments, onRemove }: { attachments: ChatComposerAttachment[]; onRemove: (attachmentId: string) => void }) {
  if (!attachments.length) {
    return null
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      {attachments.map((attachment) => (
        <button
          className="flex max-w-[12rem] items-center gap-1 rounded-md border border-border bg-secondary px-1.5 py-1 hover:bg-accent"
          key={attachment.id}
          title={attachment.path ?? attachment.name}
          type="button"
          onClick={() => onRemove(attachment.id)}
        >
          {attachment.kind === "folder" ? <Folder className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate">{attachment.name}</span>
          <X className="size-3 shrink-0" />
        </button>
      ))}
    </div>
  )
}

function ComposerControls() {
  const pane = useChatPane()

  return (
    <div className="flex flex-wrap items-center gap-1 text-[12px] font-medium text-muted-foreground -mb-2 -mx-1 sm:gap-1.5 sm:-mx-2">
      <ComposerContextMenu />
      {pane.supportsAccessMode ? <ComposerAccessModeSelect /> : null}
      <ComposerGoalChip />
      <ComposerPlanChip />
      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-1.5">
        {pane.supportsModels || pane.supportsReasoningEffort || pane.supportsServiceTier ? <ComposerRuntimeSettingsMenu /> : null}
        <ComposerSendButton />
      </div>
    </div>
  )
}

function ComposerContextMenu() {
  const pane = useChatPane()

  return (
    <div className="relative">
      <button
        aria-expanded={pane.composerMenuOpen}
        aria-label="Add context"
        className="grid size-7 shrink-0 place-items-center rounded-md text-foreground hover:bg-accent"
        type="button"
        onClick={() => pane.setComposerMenuOpen((current) => !current)}
      >
        <Plus className="size-4" />
      </button>
      {pane.composerMenuOpen ? <ComposerContextMenuItems /> : null}
      <input className="hidden" multiple ref={pane.fileInputRef} type="file" onChange={(event) => void pane.attachFiles(event)} />
      <input
        className="hidden"
        multiple
        ref={pane.folderInputRef}
        type="file"
        onChange={pane.attachFolder}
        {...{ webkitdirectory: "", directory: "" }}
      />
    </div>
  )
}

function ComposerContextMenuItems() {
  const pane = useChatPane()

  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 w-56 rounded-md border border-border bg-popover p-1 text-foreground shadow-lg">
      <ComposerMenuButton disabled={!pane.supportsFiles} icon={<FileText className="size-3.5" />} label="Attach files" onClick={() => {
        pane.setComposerMenuOpen(false)
        pane.fileInputRef.current?.click()
      }} />
      <ComposerMenuButton disabled={!pane.supportsFolders} icon={<Folder className="size-3.5" />} label="Attach folder" onClick={() => {
        pane.setComposerMenuOpen(false)
        pane.folderInputRef.current?.click()
      }} />
      <ComposerMenuButton disabled={!pane.supportsGoal} icon={<Shield className="size-3.5" />} label="Goal" onClick={pane.promptForGoal} />
      <ComposerMenuButton disabled={!pane.supportsPlanMode} icon={<Route className="size-3.5" />} label="Plan mode" suffix={pane.planMode ? "On" : null} onClick={() => {
        pane.setPlanMode((current) => !current)
        pane.setComposerMenuOpen(false)
      }} />
    </div>
  )
}

function ComposerMenuButton({
  disabled,
  icon,
  label,
  suffix,
  onClick,
}: {
  disabled: boolean
  icon: ReactNode
  label: string
  suffix?: string | null
  onClick: () => void
}) {
  return (
    <button
      className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {suffix ? <span className="text-[11px] text-info">{suffix}</span> : null}
    </button>
  )
}

function ComposerAccessModeSelect() {
  const pane = useChatPane()
  const isFullAccess = pane.accessMode === "fullAccess"

  return (
    <Select className="!size-7 shrink-0 lg:!w-auto" disabled={pane.sending || pane.isSwitchingAccount} value={pane.accessMode} onValueChange={pane.changeAccessMode}>
      <SelectTrigger
        aria-label="Access mode"
        className={cn(
          "!size-7 shrink-0 justify-center gap-0 !rounded-md border p-0 text-[12px] font-semibold shadow-none [&>svg:last-child]:hidden lg:!h-7 lg:!w-auto lg:gap-1.5 lg:px-2 lg:[&>svg:last-child]:block",
          isFullAccess
            ? "border-warning/35 bg-warning/15 text-warning hover:bg-warning/20"
            : "border-success/35 bg-success/15 text-success hover:bg-success/20",
        )}
        size="sm"
        title={composerAccessModeLabel(pane.accessMode)}
      >
        <span className="flex min-w-0 items-center justify-center gap-0 lg:justify-start lg:gap-1.5">
          <Shield className="size-3.5 shrink-0" />
          <span className="hidden min-w-0 truncate lg:inline">{composerAccessModeLabel(pane.accessMode)}</span>
        </span>
      </SelectTrigger>
      <SelectContent align="start" className="border-border bg-popover text-foreground">
        <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="askForApproval">Normal access</SelectItem>
        <SelectItem className="text-[12px] hover:bg-accent focus-visible:bg-accent" value="fullAccess">Full access</SelectItem>
      </SelectContent>
    </Select>
  )
}

function composerAccessModeLabel(value: ChatComposerAccessMode): string {
  return value === "fullAccess" ? "Full access" : "Normal access"
}

function ComposerRuntimeSettingsMenu() {
  const pane = useChatPane()
  const runtimeLabel = [
    pane.supportsModels ? pane.selectedModelOption?.displayName ?? pane.model : null,
    pane.supportsReasoningEffort ? composerReasoningEffortLabel(pane.reasoningEffort) : null,
    pane.supportsServiceTier ? composerServiceTierLabel(pane.serviceTier) : null,
  ].filter(Boolean).join(" / ")
  const compactRuntimeLabel = [
    pane.supportsModels ? (pane.selectedModelOption?.displayName ?? pane.model).trim().replace(/^gpt[-\s]?/iu, "") : null,
    pane.supportsReasoningEffort ? ({
      extraHigh: "XHigh",
      high: "High",
      low: "Low",
      medium: "Med",
      minimal: "Min",
      none: "None",
    }[pane.reasoningEffort]) : null,
    pane.supportsServiceTier ? (pane.serviceTier === "fast" ? "F" : "S") : null,
  ].filter(Boolean).join(" / ")
  const disabled = pane.sending || pane.running || pane.isSwitchingAccount

  return (
    <div className="relative min-w-0" ref={pane.runtimeSettingsRef}>
      <button
        aria-expanded={pane.runtimeSettingsOpen}
        aria-label="Runtime settings"
        className="flex h-7 max-w-[11rem] items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55 lg:max-w-[16rem]"
        disabled={disabled}
        title={runtimeLabel}
        type="button"
        onClick={() => pane.setRuntimeSettingsOpen((open) => !open)}
      >
        <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate lg:hidden">{compactRuntimeLabel}</span>
        <span className="hidden min-w-0 truncate lg:inline">{runtimeLabel}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", pane.runtimeSettingsOpen && "rotate-180")} />
      </button>
      {pane.runtimeSettingsOpen ? (
        <div className="absolute bottom-9 right-0 z-40 w-64 overflow-hidden rounded-md border border-border bg-popover py-1 text-foreground shadow-xl">
          {pane.supportsReasoningEffort ? (
            <ComposerRuntimeMenuSection icon={<Brain className="size-3.5 text-muted-foreground" />} label="Reasoning">
              {composerReasoningEffortOptions.map((option) => (
                <ComposerRuntimeMenuItem
                  key={option.value}
                  selected={pane.reasoningEffort === option.value}
                  title={option.label}
                  onClick={() => pane.changeReasoningEffort(option.value)}
                />
              ))}
            </ComposerRuntimeMenuSection>
          ) : null}
          {pane.supportsModels ? (
            <ComposerRuntimeMenuSection icon={<Cpu className="size-3.5 text-muted-foreground" />} label="Model">
              {pane.visibleModelOptions.map((option) => (
                <ComposerRuntimeMenuItem
                  key={option.id}
                  selected={(pane.model || pane.selectedModelOption?.model) === option.model || pane.model === option.id}
                  title={option.displayName}
                  onClick={() => pane.changeModel(option.model)}
                />
              ))}
            </ComposerRuntimeMenuSection>
          ) : null}
          {pane.supportsServiceTier ? (
            <ComposerRuntimeMenuSection icon={<Zap className="size-3.5 text-muted-foreground" />} label="Speed">
              {composerServiceTierOptions.map((option) => (
                <ComposerRuntimeMenuItem
                  description={option.description}
                  key={option.value}
                  selected={pane.serviceTier === option.value}
                  title={option.label}
                  onClick={() => pane.changeServiceTier(option.value)}
                />
              ))}
            </ComposerRuntimeMenuSection>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ComposerRuntimeMenuSection({ children, icon, label }: { children: ReactNode; icon: ReactNode; label: string }) {
  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex h-7 items-center gap-2 px-2 text-[11px] font-medium text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="pb-1">{children}</div>
    </div>
  )
}

function ComposerRuntimeMenuItem({
  description,
  selected,
  title,
  onClick,
}: {
  description?: string
  selected: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      className="flex min-h-8 w-full min-w-0 items-center gap-2 px-2 text-left text-[12px] hover:bg-accent"
      type="button"
      onClick={onClick}
    >
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{title}</span>
        {description ? <span className="truncate text-[11px] font-normal text-muted-foreground">{description}</span> : null}
      </span>
      <Check className={cn("size-3.5 shrink-0 text-info", selected ? "opacity-100" : "opacity-0")} />
    </button>
  )
}

function ComposerGoalChip() {
  const pane = useChatPane()

  if (!pane.goalObjective) {
    return null
  }
  return (
    <button
      className="flex h-7 max-w-[14rem] items-center gap-1 rounded-md border border-border bg-secondary px-2 text-[11px] text-foreground hover:bg-accent"
      title={pane.goalObjective}
      type="button"
      onClick={() => pane.setGoalObjective(null)}
    >
      <Shield className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">Goal: {pane.goalObjective}</span>
      <X className="size-3 shrink-0" />
    </button>
  )
}

function ComposerPlanChip() {
  const pane = useChatPane()

  if (!pane.planMode) {
    return null
  }
  return (
    <button
      aria-label="Turn off Plan mode"
      className="flex size-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/15 px-0 text-[11px] text-primary hover:bg-primary/20 lg:w-auto lg:gap-1 lg:px-2"
      title="Plan mode"
      type="button"
      onClick={() => pane.setPlanMode(false)}
    >
      <Route className="size-3.5 shrink-0" />
      <span className="hidden lg:inline">Plan mode</span>
      <X className="hidden size-3 shrink-0 lg:block" />
    </button>
  )
}

function ComposerSendButton() {
  const pane = useChatPane()

  return (
    <button
      className={cn(
        "grid size-7 shrink-0 place-items-center text-lg disabled:cursor-not-allowed disabled:opacity-45",
        pane.showStopAction
          ? "rounded-full bg-foreground text-background hover:bg-foreground/90"
          : "rounded-md text-foreground hover:bg-accent",
      )}
      aria-label={pane.showStopAction ? "Stop chat" : "Send message"}
      disabled={pane.showStopAction ? false : !pane.canSend}
      type="button"
      onClick={() => pane.showStopAction ? void pane.onStopChat() : void pane.submit()}
    >
      {pane.showStopAction ? <Square className="size-3 fill-current" /> : "↵"}
    </button>
  )
}
