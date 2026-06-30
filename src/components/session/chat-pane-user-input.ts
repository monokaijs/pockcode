import { useEffect, useMemo, useState } from "react"
import { apiClient, type ChatMessageResponse, type ChatResponse } from "@/lib/api-client"
import {
  findLast,
  isPendingUserInputPrompt,
  readError,
  readUserInputQuestions,
} from "@/lib/session"
import type { UserInputQuestion } from "@/types/session"

export function usePendingUserInputState({
  chat,
  messages,
  setActionError,
}: {
  chat: ChatResponse | null
  messages: ChatMessageResponse[]
  setActionError: (message: string | null) => void
}) {
  const [dismissedServerRequestIds, setDismissedServerRequestIds] = useState<Set<string>>(new Set())
  const [userInputAnswers, setUserInputAnswers] = useState<Record<string, Record<string, string>>>({})
  const [userInputFreeform, setUserInputFreeform] = useState<Record<string, Record<string, boolean>>>({})
  const [userInputStageIndex, setUserInputStageIndex] = useState(0)
  const [userInputSubmitting, setUserInputSubmitting] = useState(false)
  const pendingUserInputPrompt = useMemo(
    () => findLast(messages, (message) => isPendingUserInputPrompt(message) && !dismissedServerRequestIds.has(message.requestId ?? "")),
    [dismissedServerRequestIds, messages],
  )
  const pendingUserInputQuestions = useMemo(
    () => pendingUserInputPrompt ? readUserInputQuestions(pendingUserInputPrompt.rawPayload) : [],
    [pendingUserInputPrompt],
  )
  const pendingUserInputRequestId = pendingUserInputPrompt?.requestId ?? null
  const pendingUserInputStateKey = pendingUserInputPrompt?.id ?? null

  useEffect(() => {
    setUserInputStageIndex(0)
  }, [pendingUserInputPrompt?.id])

  useEffect(() => {
    setUserInputStageIndex((current) => Math.min(current, Math.max(0, pendingUserInputQuestions.length - 1)))
  }, [pendingUserInputQuestions.length])

  const userInputAnswerValue = (question: UserInputQuestion, overrides: Record<string, string> = {}): string => {
    const requestAnswers = pendingUserInputStateKey ? userInputAnswers[pendingUserInputStateKey] : undefined
    return overrides[question.id] ?? requestAnswers?.[question.id] ?? ""
  }

  const userInputUsesFreeform = (question: UserInputQuestion): boolean => {
    if (!question.options.length) {
      return true
    }
    const answer = userInputAnswerValue(question)
    const requestFreeform = pendingUserInputStateKey ? userInputFreeform[pendingUserInputStateKey] : undefined
    return Boolean(requestFreeform?.[question.id]) || Boolean(answer && !question.options.some((option) => option.label === answer))
  }

  const updateUserInputAnswer = (questionId: string, value: string, options: { freeform?: boolean } = {}) => {
    if (!pendingUserInputStateKey) {
      return
    }
    setUserInputAnswers((current) => ({
      ...current,
      [pendingUserInputStateKey]: {
        ...current[pendingUserInputStateKey],
        [questionId]: value,
      },
    }))
    setUserInputFreeform((current) => ({
      ...current,
      [pendingUserInputStateKey]: {
        ...current[pendingUserInputStateKey],
        [questionId]: options.freeform === true,
      },
    }))
  }

  const submitUserInput = async (overrides: Record<string, string> = {}) => {
    if (!chat || !pendingUserInputRequestId || !pendingUserInputQuestions.length) {
      return
    }
    const answers = Object.fromEntries(
      pendingUserInputQuestions.map((question) => [question.id, { answers: [userInputAnswerValue(question, overrides)] }]),
    )
    setUserInputSubmitting(true)
    setActionError(null)
    try {
      await apiClient.chats.respondToServerRequest(chat.id, pendingUserInputRequestId, {
        kind: "userInput",
        result: { answers },
      })
      setDismissedServerRequestIds((current) => new Set(current).add(pendingUserInputRequestId))
      setUserInputStageIndex(0)
    } catch (error) {
      setActionError(readError(error))
    } finally {
      setUserInputSubmitting(false)
    }
  }

  const activeUserInputQuestion = pendingUserInputQuestions[userInputStageIndex] ?? pendingUserInputQuestions[0] ?? null
  const userInputIsLastStage = pendingUserInputQuestions.length > 0 && userInputStageIndex >= pendingUserInputQuestions.length - 1
  const canContinueUserInput = activeUserInputQuestion ? Boolean(userInputAnswerValue(activeUserInputQuestion).trim()) : false

  const goToPreviousUserInputStage = () => {
    setUserInputStageIndex((current) => Math.max(0, current - 1))
  }

  const goToNextUserInputStage = () => {
    if (!canContinueUserInput) {
      return
    }
    if (userInputIsLastStage) {
      void submitUserInput()
      return
    }
    setUserInputStageIndex((current) => Math.min(pendingUserInputQuestions.length - 1, current + 1))
  }

  const chooseUserInputOption = (question: UserInputQuestion, value: string) => {
    if (userInputSubmitting) {
      return
    }
    updateUserInputAnswer(question.id, value, { freeform: false })
    if (userInputIsLastStage) {
      void submitUserInput({ [question.id]: value })
      return
    }
    setUserInputStageIndex((current) => Math.min(pendingUserInputQuestions.length - 1, current + 1))
  }

  const chooseUserInputFreeform = (question: UserInputQuestion) => {
    const currentAnswer = userInputAnswerValue(question)
    const nextAnswer = question.options.some((option) => option.label === currentAnswer) ? "" : currentAnswer
    updateUserInputAnswer(question.id, nextAnswer, { freeform: true })
  }

  return {
    activeUserInputQuestion,
    canContinueUserInput,
    chooseUserInputFreeform,
    chooseUserInputOption,
    goToNextUserInputStage,
    goToPreviousUserInputStage,
    pendingUserInputPrompt,
    pendingUserInputQuestions,
    submitUserInput,
    updateUserInputAnswer,
    userInputAnswerValue,
    userInputIsLastStage,
    userInputStageIndex,
    userInputSubmitting,
    userInputUsesFreeform,
  }
}
