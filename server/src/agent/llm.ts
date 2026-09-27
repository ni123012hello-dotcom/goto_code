import { randomUUID } from "node:crypto"
import type OpenAI from "openai"
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions"
import type { CompactionPart, FilePart, TextPart, TokenUsage, ToolPart } from "../../../shared/protocol"
import { config } from "../config"
import { isImageMime, readFileBase64 } from "../files"
import { logger } from "../log"
import type { Session } from "../sessions"

export type StreamedCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type StreamResult = {
  text: string
  calls: StreamedCall[]
  usage?: TokenUsage
}

const CLEARED = "[Old tool result content cleared]"

export function foldedMessageIds(session: Session): Set<string> {
  const folded = new Set<string>()
  for (const message of session.messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue
      for (const id of part.foldedMessageIDs) folded.add(id)
    }
  }
  return folded
}

export function toChatMessages(session: Session): ChatCompletionMessageParam[] {
  const folded = foldedMessageIds(session)
  const out: ChatCompletionMessageParam[] = []

  for (const message of session.messages) {
    if (folded.has(message.id)) continue

    const compaction = message.parts.find((part): part is CompactionPart => part.type === "compaction")
    if (compaction) {
      out.push({ role: "system", content: compaction.summary })
      continue
    }

    const text = message.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("")

    if (message.role === "user") {
      const files = message.parts.filter((part): part is FilePart => part.type === "file")

      if (files.length === 0) {
        if (text) out.push({ role: "user", content: text })
        continue
      }

      // images may only ride on user messages: the chat API has no image content
      // part for assistant or tool messages
      const content: ChatCompletionContentPart[] = []
      if (text) content.push({ type: "text", text })

      for (const file of files) {
        if (!config.vision || !isImageMime(file.mime)) {
          content.push({ type: "text", text: `[Attached ${file.mime}: ${file.filename}]` })
          continue
        }

        const base64 = readFileBase64(file.fileID)
        if (!base64) {
          content.push({
            type: "text",
            text: `[Attached ${file.mime}: ${file.filename} — the file is missing on disk]`,
          })
          continue
        }

        content.push({ type: "image_url", image_url: { url: `data:${file.mime};base64,${base64}` } })
      }

      out.push({ role: "user", content })
      continue
    }

    const toolParts = message.parts.filter((part): part is ToolPart => part.type === "tool")
    if (toolParts.length === 0) {
      if (text) out.push({ role: "assistant", content: text })
      continue
    }

    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolParts.map((part) => ({
        id: part.callID,
        type: "function" as const,
        function: {
          name: part.tool,
          arguments: JSON.stringify(part.input ?? {}),
        },
      })),
    })

    for (const part of toolParts) {
      out.push({ role: "tool", tool_call_id: part.callID, content: toolResultContent(part) })
    }
  }

  return out
}

function toolResultContent(part: ToolPart): string {
  if (part.status === "error") return `Error: ${part.error ?? "unknown error"}`
  if (part.compactedAt) return CLEARED
  return part.output ?? ""
}

function normalizeUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined

  const promptDetails = usage.prompt_tokens_details as { cached_tokens?: number } | undefined
  const completionDetails = usage.completion_tokens_details as { reasoning_tokens?: number } | undefined

  return {
    total: usage.total_tokens,
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    reasoning: completionDetails?.reasoning_tokens ?? 0,
    cache: { read: promptDetails?.cached_tokens ?? 0, write: 0 },
  }
}

async function openStream(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: unknown,
  signal: AbortSignal,
  maxOutputTokens?: number,
) {
  // OpenAI's reasoning families renamed the cap and reject the old name outright, so the
  // key has to follow the model rather than the provider
  const capKey = /(^|\/)(o[1-9]|gpt-5)/i.test(model) ? "max_completion_tokens" : "max_tokens"

  const base = {
    model,
    messages,
    tools: tools as never,
    stream: true as const,
    ...(maxOutputTokens ? { [capKey]: maxOutputTokens } : {}),
  }

  try {
    return await client.chat.completions.create({ ...base, stream_options: { include_usage: true } }, { signal })
  } catch (error) {
    logger.debug("llm", "include_usage rejected, retrying without it", { error })
    return await client.chat.completions.create(base, { signal })
  }
}

export async function streamCompletion(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: unknown,
  signal: AbortSignal,
  onDelta: (chunk: string) => void,
  onReasoning?: (chunk: string) => void,
  maxOutputTokens?: number,
): Promise<StreamResult> {
  const stream = await openStream(client, model, messages, tools, signal, maxOutputTokens)

  let text = ""
  let usage: TokenUsage | undefined
  const acc: Record<number, { id: string; name: string; args: string }> = {}

  for await (const chunk of stream) {
    if (chunk.usage) usage = normalizeUsage(chunk.usage)

    // providers disagree on the field: DeepSeek and most openai-compatible endpoints use
    // reasoning_content, OpenRouter normalises it to reasoning
    const delta = chunk.choices?.[0]?.delta as
      | { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: any[] }
      | undefined
    if (!delta) continue

    const thinking = delta.reasoning_content ?? delta.reasoning
    if (typeof thinking === "string" && thinking && onReasoning) onReasoning(thinking)

    if (typeof delta.content === "string" && delta.content) {
      text += delta.content
      onDelta(delta.content)
    }

    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0
      const entry = (acc[index] ??= { id: "", name: "", args: "" })
      if (call.id) entry.id = call.id
      if (call.function?.name) entry.name += call.function.name
      if (call.function?.arguments) entry.args += call.function.arguments
    }
  }

  const calls: StreamedCall[] = Object.values(acc)
    .filter((entry) => entry.name)
    .map((entry) => {
      let input: Record<string, unknown> = {}
      if (entry.args.trim()) {
        try {
          input = JSON.parse(entry.args)
        } catch {
          input = { __unparsed: entry.args }
        }
      }
      return { id: entry.id || randomUUID(), name: entry.name, input }
    })

  return { text, calls, usage }
}
