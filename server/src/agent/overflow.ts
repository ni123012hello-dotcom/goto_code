// Ported from opencode — packages/opencode/src/session/overflow.ts
// Copyright (c) 2025 opencode — MIT License. See THIRD-PARTY-NOTICES.md

import type { TokenUsage } from "../../../shared/protocol"
import { config } from "../config"
import { modelLimits } from "./models"
import { lookupModel } from "./registry"

const COMPACTION_BUFFER = 20_000
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000

export type Limits = {
  context: number
  inputLimit: number
  maxOutputTokens: number
  reserved?: number
}

export function usable(input: Limits): number {
  const context = input.context
  if (context === 0) return 0

  const maxOutput = Math.max(1, input.maxOutputTokens)
  const reserved = input.reserved ?? Math.min(COMPACTION_BUFFER, maxOutput)

  return input.inputLimit
    ? Math.max(0, input.inputLimit - reserved)
    : Math.max(0, context - maxOutput)
}

// Upstream reads `limit.input` out of a model registry. This project has no such
// registry, and without it usable() falls back to `context - maxOutputTokens`,
// which leaves only a few thousand tokens of headroom — one large read is enough
// to push the next request past the model's real limit. So when the user has not
// declared a separate input cap, synthesise one that already carries the buffer.
export function limitsForModel(modelID: string, reserved?: number): Limits {
  const entry = modelLimits(modelID)

  // The vendored registry only fills fields the user left empty. It is a starting point, not
  // an override: a 128k guess is bad, but a guess that silently beats the user's own number
  // would be worse. No baseURL is passed, so a model offered by several providers resolves to
  // the median - passing one here would mean importing settings.ts, which already imports
  // this module. A caller that knows the endpoint (the model dialog) can be sharper.
  const guess = lookupModel(modelID)?.limits ?? {}

  const context = entry.context ?? guess.context ?? config.contextWindow

  // The buffer cannot exceed half the window. It exists to cover the tool output added inside
  // one step, and 20000 is right for the 128k models this was written against - but the
  // registry knows real models with a 4k window, and 4096 - 20000 clamps to a zero budget,
  // which overflowAt() reads as "always overflowing". That would compact on every step.
  const requested = (reserved ?? config.compactionReserved) || COMPACTION_BUFFER
  const buffer = Math.min(requested, Math.max(0, Math.floor(context / 2)))

  const userInput = entry.input ?? config.contextInputLimit
  const userOutput = entry.output
  const output = userOutput ?? guess.output ?? config.maxOutputTokens

  // A real input cap means the response headroom has to come out of it.
  const inputCap = userInput || guess.input || 0

  const reserve = userInput
    ? // unchanged path: the user's own numbers, exactly as before
      (userOutput ?? config.maxOutputTokens)
    : // registry path. Its output cap can exceed its own input cap (deepseek-reasoner is
      // 65536 output on a 64000 input), and using that as the reserve zeroes the budget, so
      // every step would compact. The reserve only has to cover the response we are about to
      // ask for, so bound it by the usual buffer and by half the cap.
      Math.min(output, buffer, Math.max(0, Math.floor(inputCap / 2)))

  return {
    context,
    inputLimit: inputCap || Math.max(0, context - buffer),
    maxOutputTokens: output,
    // the synthesised limit already accounts for the buffer; only subtract again when
    // something declared its own input cap
    reserved: inputCap ? Math.max(0, reserve) : 0,
  }
}

export function limitsFromConfig(reserved?: number): Limits {
  return limitsForModel("", reserved)
}

export function usageCount(tokens: TokenUsage): number {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function preserveRecentBudget(limits: Limits, override?: number): number {
  const configured = override ?? config.preserveRecentTokens
  if (configured && configured > 0) return configured

  return Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(limits) * 0.25)),
  )
}

export function overflowAt(count: number, limits: Limits, auto: boolean): boolean {
  if (!auto) return false
  if (limits.context === 0) return false
  return count >= usable(limits)
}

export function isOverflow(input: { tokens: TokenUsage; limits: Limits; auto: boolean }): boolean {
  return overflowAt(usageCount(input.tokens), input.limits, input.auto)
}

export { COMPACTION_BUFFER, MIN_PRESERVE_RECENT_TOKENS, MAX_PRESERVE_RECENT_TOKENS }
