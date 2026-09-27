import { randomUUID } from "node:crypto"
import type { QuestionRequest } from "../../shared/protocol"
import { logger } from "./log"
import { emit, getSession, type Session } from "./sessions"

type Resolver = (answer: string) => void

type Pending = {
  /** replayed from the SSE snapshot, so reconnecting does not lose the dialog */
  request: QuestionRequest
  /** a sub-agent's question is shown on its parent's stream, so the parent is who reconnects */
  audienceID: string
  finish: Resolver
}

const TIMEOUT_MS = 10 * 60_000

const pending = new Map<string, Pending>()

export const SKIPPED = "（用户跳过了这个问题，请自行判断或停下来问得更具体）"
export const CANCELLED = "（对话已中止，问题没有得到回答）"
export const TIMED_OUT = "（用户没有在时限内回答）"

export function askUser(input: {
  session: Session
  question: string
  options: string[]
  allowFreeText: boolean
  signal: AbortSignal
}): Promise<string> {
  const { session, question, options, allowFreeText, signal } = input

  if (signal.aborted) return Promise.resolve(CANCELLED)

  const request: QuestionRequest = {
    id: randomUUID(),
    sessionID: session.id,
    // say who is asking when it is a sub-agent, otherwise the user sees a question out of nowhere
    question: session.task ? `子智能体「${session.task.slice(0, 40)}」问：${question}` : question,
    options,
    allowFreeText,
    createdAt: Date.now(),
  }

  // The UI only subscribes to the active session, so a sub-agent emitting on its own stream
  // would show no dialog at all and just hang until the timeout.
  const audience = session.parentID ? getSession(session.parentID) ?? session : session

  logger.info("question", "asked", { sessionID: session.id, id: request.id, options: options.length })

  return new Promise<string>((resolve) => {
    let settled = false

    const finish = (answer: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      pending.delete(request.id)
      logger.info("question", "answered", { sessionID: session.id, id: request.id, chars: answer.length })
      emit(audience, { type: "question.resolved", questionID: request.id, answer })
      resolve(answer)
    }

    const onAbort = () => finish(CANCELLED)
    const timer = setTimeout(() => finish(TIMED_OUT), TIMEOUT_MS)

    signal.addEventListener("abort", onAbort, { once: true })
    pending.set(request.id, { request, audienceID: audience.id, finish })

    emit(audience, { type: "question.request", request })
  })
}

export function resolveQuestion(id: string, answer: string): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  entry.finish(answer)
  return true
}

/** The question this conversation is still waiting on, if any - see pendingPermissionFor. */
export function pendingQuestionFor(sessionID: string): QuestionRequest | undefined {
  for (const entry of pending.values()) {
    if (entry.audienceID === sessionID) return entry.request
  }
  return undefined
}

export function pendingQuestionCount(): number {
  return pending.size
}
