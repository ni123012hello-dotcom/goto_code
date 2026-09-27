import OpenAI from "openai"
import type { ReasoningPart, TextPart } from "../../../shared/protocol"
import { config } from "../config"
import { bytes, logger } from "../log"
import { bumpRevision, expireHypotheses, loadMemory, promoteVerified, reconcileMemory } from "../memory"
import { renderNoteForPrompt } from "../notes"
import { requestPermission, requiresApproval } from "../permissions"
import { isMcpTool } from "../mcp"
import { askUser } from "../questions"
import { emit, newMessage, newReasoningPart, newTextPart, newToolPart, persistSession, scheduleSave, sessionScope, type Session } from "../sessions"
import { getSettings } from "../settings"
import { compactIfNeeded } from "./compact"
import { declaredOutput } from "./models"
import { streamCompletion, toChatMessages, type StreamResult } from "./llm"
import { usageCount } from "./overflow"
import { probeWorkspace, type ProjectFacts } from "./probe"
import { buildSystemPrompt } from "./prompt"
import { getTool, toolAllowedInMode, toolSchemas } from "./tools"

const CONTEXT_ERROR = /context (?:length|window|limit)|too many tokens|maximum context|exceeds the maximum|prompt is too long/i

function abortError(): Error {
  const error = new Error("Aborted by user")
  error.name = "AbortError"
  return error
}

export async function runTurn(session: Session, modelOverride?: string): Promise<void> {
  if (session.running) return

  const controller = new AbortController()
  session.abort = controller
  session.running = true
  emit(session, { type: "session.status", sessionID: session.id, running: true })

  const settings = getSettings()
  const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseURL })
  const model = modelOverride?.trim() || settings.model
  const scope = sessionScope(session)
  const turnStartedAt = Date.now()
  let hitStepLimit = true
  let steps = 0

  logger.info("turn", "start", { sessionID: session.id, model, messages: session.messages.length })

  try {
    if (!settings.apiKey) {
      throw new Error("No API key configured. Open Settings and add one.")
    }

    // advancing the revision here means anything written during this turn is
    // stamped with it, and unanswered hypotheses age by exactly one turn
    bumpRevision(scope)

    let facts: ProjectFacts | undefined
    try {
      facts = await probeWorkspace(session.workspace)
      logger.debug("probe", "workspace scanned", { sessionID: session.id, facts })

      if (facts) {
        const reconciled = reconcileMemory(scope, facts)
        const promoted = promoteVerified(scope, facts)
        if (reconciled.flagged + reconciled.corrected + reconciled.dropped + promoted > 0) {
          logger.warn("probe", "memory reconciled", { sessionID: session.id, ...reconciled, promoted })
        }
      }
    } catch (error) {
      logger.warn("probe", "workspace scan failed", { sessionID: session.id, error })
      facts = undefined
    }

    const expired = expireHypotheses(scope)
    if (expired > 0) logger.info("memory", "hypotheses expired", { sessionID: session.id, expired })

    for (let step = 0; step < config.maxSteps; step += 1) {
      if (controller.signal.aborted) throw abortError()

      steps = step + 1

      const assistant = newMessage(session, "assistant")
      emit(session, { type: "message.start", message: assistant })

      // Parts are created lazily, on the first chunk of that kind, so they land in the
      // array in the order the model actually produced them: thinking that arrives before
      // the answer sits above it, and thinking that resumes after the answer has started
      // becomes its own block below. Held on an object because TypeScript cannot see the
      // assignments made inside the stream callbacks and would narrow plain locals to null.
      const emitted = { text: null as TextPart | null, reasoning: null as ReasoningPart | null, contentSinceReasoning: false }

      const onDelta = (chunk: string) => {
        if (!emitted.text) {
          emitted.text = newTextPart(assistant)
          emit(session, { type: "part.start", messageID: assistant.id, part: emitted.text })
        }
        emitted.contentSinceReasoning = true
        emitted.text.text += chunk
        emit(session, { type: "text.delta", messageID: assistant.id, partID: emitted.text.id, delta: chunk })
      }

      const onReasoning = (chunk: string) => {
        if (!emitted.reasoning || emitted.contentSinceReasoning) {
          emitted.reasoning = newReasoningPart(assistant)
          emitted.contentSinceReasoning = false
          emit(session, { type: "part.start", messageID: assistant.id, part: emitted.reasoning })
        }
        emitted.reasoning.text += chunk
          emit(session, { type: "reasoning.delta", messageID: assistant.id, partID: emitted.reasoning.id, delta: chunk })
      }

      const outcome = await compactIfNeeded({
        session,
        client,
        model,
        signal: controller.signal,
      })

      if (outcome.error) emit(session, { type: "error", message: outcome.error })

      const buildHistory = () => [
        {
          role: "system" as const,
          content: buildSystemPrompt({
            facts,
            memory: loadMemory(scope),
            workspace: session.workspace,
            accessMode: session.accessMode,
            mode: session.mode,
            note: renderNoteForPrompt(session.id, config.noteInjectTokens, session.workspace).text,
          }),
        },
        ...toChatMessages(session),
      ]

      // `history` is reassigned on the retry below; the closure reads it at call time
      let history = buildHistory()
      const runStream = () =>
        streamCompletion(
          client,
          model,
          history,
          toolSchemas(session.mode),
          controller.signal,
          onDelta,
          onReasoning,
          // only sent when the user declared a cap for this model - guessing one risks
          // the wrong parameter name or a value above the model's ceiling
          declaredOutput(model),
        )

      const llmStartedAt = Date.now()
      logger.debug("llm", "request", {
        sessionID: session.id,
        step,
        model,
        messages: history.length,
        budget: outcome.budget,
        lastUsage: usageCount(outcome.tokens),
      })

      let streamed: StreamResult
      try {
        streamed = await runStream()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)

        // the provider rejected the request outright. a context-length error comes
        // back before any token streams, so nothing reached the client yet, but
        // reset the part anyway so a retry cannot append to a partial answer.
        if (!CONTEXT_ERROR.test(detail) || controller.signal.aborted) throw error

        logger.warn("llm", "provider rejected for context length, forcing compaction", {
          sessionID: session.id,
          step,
          error: detail,
        })
        emit(session, { type: "error", message: "上下文超出模型上限，正在强制压缩后重试…" })

        // a context error comes back before any chunk streams, so there is usually nothing
        // to clear here, but do it anyway in case a partial answer made it out
        if (emitted.text) emitted.text.text = ""
        await compactIfNeeded({ session, client, model, signal: controller.signal, force: true })

        history = buildHistory()
        logger.debug("llm", "retrying after forced compaction", {
          sessionID: session.id,
          step,
          messages: history.length,
        })

        streamed = await runStream()
      }

      const { text, calls, usage } = streamed

      if (usage) {
        assistant.tokens = usage
        emit(session, { type: "message.tokens", messageID: assistant.id, tokens: usage })
      }

      logger.info("llm", "response", {
        sessionID: session.id,
        step,
        model,
        ms: Date.now() - llmStartedAt,
        chars: text.length,
        toolCalls: calls.length,
        tokens: usage ? usageCount(usage) : undefined,
        budget: outcome.budget,
      })

      // text is accumulated inside onDelta, so nothing to assign here
      scheduleSave(session)

      if (calls.length === 0) {
        hitStepLimit = false
        break
      }

      for (const call of calls) {
        if (controller.signal.aborted) throw abortError()

        const part = newToolPart(assistant, call.name, call.id, call.input)
        emit(session, { type: "part.start", messageID: assistant.id, part })

        const toolStartedAt = Date.now()
        logger.info("tool", "start", { sessionID: session.id, step, tool: call.name, input: call.input })

        try {
          const tool = getTool(call.name)
          if (!tool) {
            // an MCP tool vanishes from the registry when its server stops, which can happen
            // between the request that advertised it and this call
            throw new Error(
              isMcpTool(call.name)
                ? `MCP tool ${call.name} is unavailable: its server is not running. Do not retry it.`
                : `Unknown tool: ${call.name}`,
            )
          }

          // the boundary for plan mode. The schema was already withheld, but a model can call a
          // tool it was not offered, so the check has to exist here too.
          if (!toolAllowedInMode(tool.name, session.mode)) {
            throw new Error(
              `The ${tool.name} tool is disabled in plan mode: this conversation is read-only. ` +
                `Do not try other ways to change anything - tell the user what you would change and ` +
                `ask them to switch to 执行 (agent) mode.`,
            )
          }

          if (requiresApproval(tool.name)) {
            const command = call.input.command
            const detail = typeof command === "string" ? command : JSON.stringify(call.input, null, 2)
            const answer = await requestPermission(session, tool.name, `Allow ${tool.name}`, detail)
            if (answer === "reject") throw new Error("User denied permission")
          }

          const result = await tool.run(call.input, {
            session,
            signal: controller.signal,
            part,
            stream: (chunk) =>
              emit(session, { type: "tool.output", messageID: assistant.id, partID: part.id, chunk }),
            ask: (question) =>
              askUser({ session, signal: controller.signal, ...question }),
          })

          part.status = "done"
          part.title = result.title
          part.output = result.output
          part.diff = result.diff

          logger.info("tool", "end", {
            sessionID: session.id,
            tool: call.name,
            ms: Date.now() - toolStartedAt,
            status: "done",
            title: result.title,
            outputBytes: bytes(result.output),
            diffChars: result.diff?.length ?? 0,
            ...(config.logToolOutput ? { output: result.output } : {}),
          })

          emit(session, {
            type: "tool.end",
            messageID: assistant.id,
            partID: part.id,
            status: "done",
            title: result.title,
            output: result.output,
            diff: result.diff,
          })

          // images can only travel on a user message, so a tool that returns one
          // hands it back as a follow-up turn rather than embedding it in the result
          if (result.images && result.images.length > 0) {
            const attachment = newMessage(session, "user")
            newTextPart(
              attachment,
              `[${call.name} attached ${result.images.length} image(s): ${result.images
                .map((image) => image.filename)
                .join(", ")}]`,
            )
            attachment.parts.push(...result.images)
            emit(session, { type: "message.start", message: attachment })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          part.status = "error"
          part.error = message

          logger.warn("tool", "end", {
            sessionID: session.id,
            tool: call.name,
            ms: Date.now() - toolStartedAt,
            status: "error",
            error: message,
          })

          emit(session, {
            type: "tool.end",
            messageID: assistant.id,
            partID: part.id,
            status: "error",
            error: message,
          })
        }
      }
    }

    if (hitStepLimit) {
      logger.warn("turn", "step limit reached", { sessionID: session.id, steps, maxSteps: config.maxSteps })
      emit(session, { type: "error", message: `Stopped after ${config.maxSteps} steps.` })
    }

    logger.info("turn", "end", {
      sessionID: session.id,
      steps,
      ms: Date.now() - turnStartedAt,
      status: "ok",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (message === "Aborted by user") {
      logger.warn("turn", "aborted", { sessionID: session.id, steps, ms: Date.now() - turnStartedAt })
    } else if (CONTEXT_ERROR.test(message)) {
      logger.error("turn", "context overflow survived forced compaction", { sessionID: session.id, steps, error })
      emit(session, {
        type: "error",
        message: `上下文超出模型上限，强制压缩后仍然失败。请换用更大窗口的模型，或缩小工作区。原始错误：${message}`,
      })
    } else {
      logger.error("turn", "failed", { sessionID: session.id, steps, ms: Date.now() - turnStartedAt, error })
      emit(session, { type: "error", message })
    }
  } finally {
    session.running = false
    session.abort = null
    emit(session, { type: "session.status", sessionID: session.id, running: false })
    // flush immediately rather than leaving the final state on the debounce timer
    persistSession(session)
  }
}
