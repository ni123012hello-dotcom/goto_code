// Ported from opencode — packages/opencode/src/session/compaction.ts
// Copyright (c) 2025 opencode — MIT License. See THIRD-PARTY-NOTICES.md
//
// Upstream runs on the Effect runtime against @opencode-ai/core schemas and
// stores the summary as its own assistant message (`summary: true`) with a
// separate user-side `compaction` marker part carrying `tail_start_id`.
// Here the same algorithm drives this project's session model, where the folded
// range is recorded as `foldedMessageIDs` on a single compaction part.

import path from "node:path"
import type OpenAI from "openai"
import type {
  CompactionPart,
  MemoryDelta,
  MemorySource,
  Message,
  TextPart,
  TokenUsage,
  ToolPart,
} from "../../../shared/protocol"
import { config } from "../config"
import { IMAGE_TOKEN_ESTIMATE } from "../files"
import { logger } from "../log"
import { applyMemoryDelta, loadMemory } from "../memory"
import { emit, newCompactionPart, newMessage, sessionScope, type Session } from "../sessions"
import { toChatMessages } from "./llm"
import {
  limitsForModel,
  overflowAt,
  preserveRecentBudget,
  usable,
  usageCount,
  MIN_PRESERVE_RECENT_TOKENS,
  type Limits,
} from "./overflow"
import { estimate } from "./tokens"

const TOOL_OUTPUT_MAX_CHARS = 2_000

type Turn = { start: number; end: number; id: string }
type Tail = { start: number; id: string }

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export function serializeMessage(message: Message): string {
  if (message.role === "user") {
    const text = message.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    return text ? `[User]: ${text}` : ""
  }

  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type !== "tool") return []

      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.input ?? {})})`
      if (part.status === "done") {
        const output = part.compactedAt ? "[Old tool result content cleared]" : truncate(part.output ?? "")
        return [call, `[Tool result]: ${output}`]
      }
      if (part.status === "error") return [call, `[Tool error]: ${part.error ?? ""}`]
      return [call]
    })
    .join("\n")
}

function estimateMessages(messages: Message[]): number {
  // thinking is stored so the UI can show it, but it is never sent back, so counting it
  // would make the overflow projection believe the next request is larger than it is
  const sent = messages.map((message) =>
    message.parts.some((part) => part.type === "reasoning")
      ? { ...message, parts: message.parts.filter((part) => part.type !== "reasoning") }
      : message,
  )

  let total = estimate(JSON.stringify(sent))

  // a FilePart carries no bytes in the json, so stringify() reports a screenshot
  // as nearly free. charge a flat stand-in instead; the provider's reported usage
  // is still the authoritative number, this only sizes the retained tail.
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file") total += IMAGE_TOKEN_ESTIMATE
    }
  }

  return total
}

// The provider's reported usage describes the request it already answered, so it is
// stale by exactly the tool output produced since — which is how one turn can blow
// past the limit while every check still reads "under budget". Re-estimating the live
// messages catches that growth. Pruning is the only thing that makes reality *smaller*
// than the last report, and we know how much it freed, so subtract that rather than
// deferring the decision to a number we will not see until after the next call.
export function projectedTokens(session: Session, reported: number, pruned: number): number {
  return Math.max(estimateMessages(session.messages), reported - pruned)
}

function turns(messages: Message[]): Turn[] {
  const result: Turn[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== "user") continue
    if (message.parts.some((part) => part.type === "compaction")) continue
    result.push({ start: index, end: messages.length, id: message.id })
  }

  for (let index = 0; index < result.length - 1; index += 1) {
    result[index].end = result[index + 1].start
  }

  return result
}

function splitTurn(input: { messages: Message[]; turn: Turn; budget: number }): Tail | undefined {
  if (input.budget <= 0) return undefined
  if (input.turn.end - input.turn.start <= 1) return undefined

  for (let start = input.turn.start + 1; start < input.turn.end; start += 1) {
    const size = estimateMessages(input.messages.slice(start, input.turn.end))
    if (size > input.budget) continue
    return { start, id: input.messages[start].id }
  }

  return undefined
}

export function select(input: {
  messages: Message[]
  limits: Limits
  preserveOverride?: number
}): { head: Message[]; tailStartId?: string } {
  const budget = preserveRecentBudget(input.limits, input.preserveOverride)
  const all = turns(input.messages)
  if (all.length === 0) return { head: input.messages, tailStartId: undefined }

  const recent = config.tailTurns > 0 ? all.slice(-config.tailTurns) : all

  let total = 0
  let keep: Tail | undefined

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index]
    // estimate lazily so cost stays proportional to the retained tail, not the whole session
    const size = estimateMessages(input.messages.slice(turn.start, turn.end))

    if (total + size <= budget) {
      total += size
      keep = { start: turn.start, id: turn.id }
      continue
    }

    const split = splitTurn({ messages: input.messages, turn, budget: budget - total })
    if (split) keep = split
    else if (!keep) logger.debug("compact", "tail fallback", { budget, size, total })
    break
  }

  if (!keep || keep.start === 0) return { head: input.messages, tailStartId: undefined }
  return { head: input.messages.slice(0, keep.start), tailStartId: keep.id }
}

/** Mark tool parts as compacted. Shared by prune() and the read tool's supersede rule so
 *  the wire format (llm.ts swaps the output for CLEARED) and the UI event stay identical. */
export function compactParts(session: Session, targets: ToolPart[]): void {
  if (targets.length === 0) return

  const at = Date.now()
  for (const part of targets) part.compactedAt = at

  emit(session, {
    type: "parts.compacted",
    sessionID: session.id,
    partIDs: targets.map((part) => part.id),
    at,
  })
}

/** A newer read of the same file makes every earlier copy dead weight: the model asked for
 *  the current bytes, so a stale copy is not merely wasted context, it can mislead. Measured
 *  on real sessions, one read index.html three times and kept all three - 28.8k characters
 *  of pure duplicate. */
export function supersedeReads(session: Session, target: string, keepPartID: string): void {
  const abs = path.resolve(session.workspace, target)
  const targets: ToolPart[] = []

  for (const message of session.messages ?? []) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "read") continue
      if (part.id === keepPartID || part.status !== "done" || part.compactedAt) continue

      const requested = (part.input as { path?: unknown } | undefined)?.path
      if (typeof requested !== "string" || !requested) continue
      if (path.resolve(session.workspace, requested) !== abs) continue

      targets.push(part)
    }
  }

  if (targets.length === 0) return
  logger.debug("compact", "superseded reads", { sessionID: session.id, path: abs, count: targets.length })
  compactParts(session, targets)
}

// Walks backwards through tool parts, keeps the newest PRUNE_PROTECT tokens of output, and
// erases everything older. The current turn is deliberately NOT exempt any more: a single
// 30-step turn is exactly where the growth happens (measured: 179KB in one turn), and the
// protected window is what keeps the freshest results alive. Already-compacted parts are
// skipped rather than treated as a stop boundary, because supersedeReads() compacts out of
// order - the "first compacted part" no longer means "everything older is already gone".
export function prune(session: Session): number {
  if (!config.compactionPrune) return 0

  const messages = session.messages
  let total = 0
  let pruned = 0
  const targets: ToolPart[] = []

  for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex -= 1) {
    const message = messages[msgIndex]
    if (message.role === "assistant" && message.summary) break

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]
      if (part.type !== "tool") continue
      if (part.status !== "done") continue
      if (config.pruneProtectedTools.includes(part.tool)) continue
      if (part.compactedAt) continue

      const size = estimate(part.output ?? "")
      total += size
      if (total <= config.pruneProtect) continue

      pruned += size
      targets.push(part)
    }
  }

  logger.debug("compact", "prune scan", { total, pruned, candidates: targets.length })

  if (pruned <= config.pruneMinimum) {
    // silence here previously looked identical to "nothing was prunable"
    if (pruned > 0) {
      logger.debug("compact", "prune skipped: below the minimum", { pruned, minimum: config.pruneMinimum })
    }
    return 0
  }

  logger.info("compact", "pruned", { count: targets.length, pruned, protectedTokens: total - pruned })
  compactParts(session, targets)

  return pruned
}

const SUMMARIZER_SYSTEM = `You are compacting an AI coding agent's conversation to free context space. You have three jobs.

## Job 1 — handoff summary
Write a dense summary so the agent can continue the work without the original messages.
Use exactly these sections, in this order, omitting any that are empty:

## Goal
## Done            concrete changes: files touched, decisions made and why
## Key facts       paths, commands, versions, constraints discovered
## Open problems   errors not yet fixed, open questions
## Next step

Rules: reproduce file paths, commands, symbol names and error messages VERBATIM. Drop
pleasantries, restatements and superseded reasoning. Never invent. Under 400 words.

## Job 2 — new memories
A fact qualifies ONLY if ALL of these hold:
1. It will still be true in 20 turns AND it affects future decisions.
2. A tool call DIRECTLY returned it, or the user stated it explicitly.

A memory may only record an OBSERVATION, never a conclusion. Some values are guesses, and a guess
written into memory becomes a permanent lie that future turns will trust. So:

  ALLOWED, because a tool returned it:
    "package manager is pnpm"       <- [Tool result] from reading package.json / a lockfile
    "tests run via pnpm test"       <- [Tool result] from reading package.json scripts
    "the entry point is src/index.ts"  <- [Tool result] from a glob or read
  ALLOWED, because the user said it:
    "never write code comments"     <- [User]
  FORBIDDEN, because you inferred it:
    "this module handles rendering" <- your own conclusion, no tool returned this string
    "the config should be moved"    <- your own opinion
    "the user probably wants X"     <- speculation
  FORBIDDEN, because it is transient:
    "currently fixing a type error" / "the build failed" / "was reading file X"

Only [Tool result] and [User] lines in the transcript are acceptable sources.
[Assistant] and [Assistant reasoning] lines are your own output and are NEVER a source.
If you cannot point to the exact tool result or user message that states the fact, do not record it.
When unsure whether you observed it or inferred it, treat it as inferred and DO NOT record it.

At most 6 entries. Few high-value entries beat many trivial ones. Empty is a fine answer.

## Job 3 — invalidate memories
An existing memory must be removed if the conversation proved it false or obsolete.

## Output format
Reply with EXACTLY this and nothing else:

<<<SUMMARY>>>
<the handoff summary>
<<<MEMORY>>>
+ <key> :: <value>
+? <key> :: <value>
- <existing memory id>
<<<END>>>

Prefix a line with "+" when a [Tool result] or [User] line states the fact.
Prefix it with "+?" when it is your own inference that still seems worth keeping;
it will be stored as unverified and the agent will be told to double-check it.
Writing a conclusion as "+" is dishonest - use "+?" or drop it.
Use a single line containing "none" for an empty section. Memory ids are the bracketed
values in the list of existing memories.`

export function parseCompactionOutput(text: string): {
  summary: string
  added: MemoryDelta[]
  removed: string[]
} {
  const summaryMatch = /<<<SUMMARY>>>([\s\S]*?)(?:<<<MEMORY>>>|<<<END>>>|$)/.exec(text)
  const memoryMatch = /<<<MEMORY>>>([\s\S]*?)(?:<<<END>>>|$)/.exec(text)

  const summary = (summaryMatch ? summaryMatch[1] : text).trim()
  const added: MemoryDelta[] = []
  const removed: string[] = []

  const parseDelta = (body: string, source: MemorySource): MemoryDelta => {
    const [key, ...rest] = body.split("::")
    if (rest.length > 0) return { key: key.trim(), value: rest.join("::").trim(), source }
    return { key: "", value: body, source }
  }

  if (memoryMatch) {
    for (const raw of memoryMatch[1].split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.toLowerCase() === "none") continue

      // "+?" must be tested first: it also starts with "+"
      if (line.startsWith("+?")) {
        const body = line.slice(2).trim()
        if (body) added.push(parseDelta(body, "inferred"))
        continue
      }

      if (line.startsWith("+")) {
        const body = line.slice(1).trim()
        if (body) added.push(parseDelta(body, "tool"))
        continue
      }

      if (line.startsWith("-")) {
        const id = line.slice(1).trim()
        if (id && id.toLowerCase() !== "none") removed.push(id)
      }
    }
  }

  return { summary, added, removed }
}

function previousSummary(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = messages[index].parts.find(
      (candidate): candidate is CompactionPart => candidate.type === "compaction",
    )
    if (part) return part.summary
  }
  return undefined
}

function renderMemoryList(entries: { id: string; key: string; value: string }[]): string {
  if (entries.length === 0) return "none"
  return entries
    .map((entry) => (entry.key ? `- [${entry.id}] **${entry.key}** :: ${entry.value}` : `- [${entry.id}] ${entry.value}`))
    .join("\n")
}

async function summarize(input: {
  session: Session
  client: OpenAI
  model: string
  signal: AbortSignal
  head: Message[]
  tailStartId?: string
  tokensBefore: number
}): Promise<{ tokens: number; error?: string } | null> {
  const { session, client, model, signal, head, tailStartId, tokensBefore } = input
  if (head.length === 0) return null

  const scope = sessionScope(session)
  const memory = loadMemory(scope)
  const prior = previousSummary(session.messages)
  const conversation = head.map(serializeMessage).filter(Boolean).join("\n\n")

  const userContent = [
    prior ? `## Previous summary\n${prior}` : undefined,
    `## Existing memories\n${renderMemoryList(memory)}`,
    `## Conversation to compact\n${conversation}`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const summarizeModel = config.summarizeModel || model
  const startedAt = Date.now()

  const completion = await client.chat.completions.create(
    {
      model: summarizeModel,
      messages: [
        { role: "system", content: SUMMARIZER_SYSTEM },
        { role: "user", content: userContent },
      ],
    },
    { signal },
  )

  const raw = completion.choices[0]?.message?.content ?? ""
  const parsed = parseCompactionOutput(raw)

  if (!parsed.summary) {
    logger.warn("compact", "summarizer returned no summary", {
      sessionID: session.id,
      model: summarizeModel,
      ms: Date.now() - startedAt,
      chars: raw.length,
    })
    return null
  }

  let added: MemoryDelta[] = []
  let invalidated: MemoryDelta[] = []
  let memoryError: string | undefined

  try {
    const applied = applyMemoryDelta(scope, parsed.added, parsed.removed)
    added = applied.added.map((entry) => ({ key: entry.key, value: entry.value }))
    invalidated = applied.invalidated.map((entry) => ({ key: entry.key, value: entry.value }))
  } catch (caught) {
    memoryError = `记忆写入失败：${caught instanceof Error ? caught.message : String(caught)}`
  }

  const foldedIDs = head.map((message) => message.id)
  const message = newMessage(session, "assistant")
  message.summary = true

  const part = newCompactionPart(message, {
    summary: parsed.summary,
    foldedMessageIDs: foldedIDs,
    foldedCount: foldedIDs.length,
    tokensBefore,
    tokensAfter: 0,
    tailStartId,
    addedMemories: added,
    invalidatedMemories: invalidated,
  })

  // newMessage() appended it; move it up to the fold boundary so the projection
  // reads [folded...] [summary] [tail...]
  const insertAt = tailStartId ? session.messages.findIndex((candidate) => candidate.id === tailStartId) : -1
  if (insertAt >= 0) {
    session.messages.pop()
    session.messages.splice(insertAt, 0, message)
  }

  part.tokensAfter = estimate(JSON.stringify(toChatMessages(session)))

  logger.info("compact", "summarized", {
    sessionID: session.id,
    model: summarizeModel,
    ms: Date.now() - startedAt,
    folded: foldedIDs.length,
    transcriptChars: conversation.length,
    summaryChars: parsed.summary.length,
    memoryAdded: added.length,
    memoryInvalidated: invalidated.length,
    tokensBefore,
    tokensAfter: part.tokensAfter,
  })

  emit(session, { type: "message.start", message })
  emit(session, { type: "part.start", messageID: message.id, part })

  return { tokens: part.tokensAfter, error: memoryError }
}

export type CompactionOutcome = {
  reason: "not-needed" | "summarized" | "failed"
  pruned: number
  tokens: TokenUsage
  budget: number
  error?: string
}

export function lastUsage(session: Session): TokenUsage | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const tokens = session.messages[index].tokens
    if (tokens) return tokens
  }
  return undefined
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

export async function compactIfNeeded(input: {
  session: Session
  client: OpenAI
  model: string
  signal: AbortSignal
  /** last resort: the provider already rejected the request, so compact regardless */
  force?: boolean
}): Promise<CompactionOutcome> {
  const { session, client, model, signal, force = false } = input
  const limits = limitsForModel(model)
  const budget = usable(limits)

  // prune runs every step: it is idempotent and only touches parts it already
  // marked, so repeated calls cost a single backwards scan and free nothing more
  const pruned = prune(session)

  const usage = lastUsage(session)
  const reported = usage ? usageCount(usage) : 0
  const projected = projectedTokens(session, reported, pruned)

  if (!force) {
    if (projected === 0) return { reason: "not-needed", pruned, tokens: emptyUsage(), budget }

    // decide on the size of the request we are about to send, not on what the provider
    // said about the previous one
    if (!config.compactionAuto || !overflowAt(projected, limits, true)) {
      return { reason: "not-needed", pruned, tokens: usage ?? emptyUsage(), budget }
    }
  }

  const tokensBefore = reported

  try {
    const selection = select({
      messages: session.messages,
      limits,
      // a forced run already had its request rejected, so keep only the minimum
      // tail alive rather than the usual ~25% of budget
      preserveOverride: force ? MIN_PRESERVE_RECENT_TOKENS : undefined,
    })

    const result = await summarize({
      session,
      client,
      model,
      signal,
      head: selection.head,
      tailStartId: selection.tailStartId,
      tokensBefore,
    })

    if (result) {
      return { reason: "summarized", pruned, tokens: usage ?? emptyUsage(), budget, error: result.error }
    }

    // summarize() returns nothing when it found no range worth folding. Staying silent
    // here is what let compaction fail for 73 turns without anything showing up in the logs.
    logger.warn("compact", "summarize produced no summary", {
      sessionID: session.id,
      messages: session.messages.length,
      projected,
      budget,
    })
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    logger.error("compact", "summarize failed", { sessionID: session.id, error: caught })
    return { reason: "failed", pruned, tokens: usage ?? emptyUsage(), budget, error: message }
  }

  return {
    reason: "failed",
    pruned,
    tokens: usage ?? emptyUsage(),
    budget,
    error: "Compaction produced no summary",
  }
}
