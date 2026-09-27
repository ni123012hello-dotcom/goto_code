// Per-model limits, supplied by the user.
//
// Upstream opencode reads these out of a models.dev registry. This project deliberately
// ships no dataset: the numbers go stale, no two providers agree on them, and for the
// handful of models a user actually runs, typing them once is more reliable than trusting
// a bundled table. Unset fields fall back to the global env config.

import fs from "node:fs"
import path from "node:path"
import { dataFile } from "../config"
import { logger } from "../log"

export type ModelLimits = {
  /** total context window */
  context?: number
  /** max tokens accepted on input, when it differs from the window */
  input?: number
  /** max tokens the model may generate */
  output?: number
}

const storeFile = path.join(path.dirname(dataFile), "models.json")

let cache: Record<string, ModelLimits> | null = null

function positive(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

/** Drops anything that is not a usable positive integer, so a half-edited file
 *  degrades to "that field is unset" instead of poisoning the budget math. */
function sanitize(raw: unknown): Record<string, ModelLimits> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}

  const out: Record<string, ModelLimits> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim()
    if (!id) continue

    const entry = (value ?? {}) as Record<string, unknown>
    const limits: ModelLimits = {}
    const context = positive(entry.context)
    const input = positive(entry.input)
    const output = positive(entry.output)
    if (context) limits.context = context
    if (input) limits.input = input
    if (output) limits.output = output

    if (Object.keys(limits).length > 0) out[id] = limits
  }
  return out
}

function read(): Record<string, ModelLimits> {
  if (cache) return cache

  try {
    cache = sanitize(JSON.parse(fs.readFileSync(storeFile, "utf8")))
  } catch {
    cache = {}
  }
  return cache
}

function persist(store: Record<string, ModelLimits>): void {
  cache = store
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true })
    const sorted = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)))
    fs.writeFileSync(storeFile, `${JSON.stringify(sorted, null, 2)}\n`, "utf8")
  } catch (error) {
    logger.warn("models", "failed to write model limits", { error })
  }
}

export function limitsFilePath(): string {
  return storeFile
}

export function listModelLimits(): Record<string, ModelLimits> {
  return { ...read() }
}

/** What the user declared for this model. Empty object when nothing is set. */
export function modelLimits(id: string): ModelLimits {
  const key = String(id ?? "").trim()
  if (!key) return {}
  return read()[key] ?? {}
}

/** The output cap to actually send, or undefined when the user has not declared one.
 *  Sending a cap we guessed is worse than sending none: the wrong parameter name or a
 *  value above the model's ceiling makes the provider reject the whole request. */
export function declaredOutput(id: string): number | undefined {
  return modelLimits(id).output
}

export function setModelLimits(id: string, limits: ModelLimits): Record<string, ModelLimits> {
  const key = String(id ?? "").trim()
  if (!key) throw new Error("Model id is empty")

  const store = read()
  const cleaned = sanitize({ [key]: limits })[key]
  // all three fields cleared means "forget this model" rather than "store an empty entry"
  if (cleaned) store[key] = cleaned
  else delete store[key]

  persist(store)
  return { ...store }
}
