// The vendored model registry (models.dev, MIT).
//
// goto deliberately ships no dataset of its own, because a bundled table goes stale and no
// bundled table is authoritative for the endpoint you actually talk to. What was missing was
// a *sensible starting point*: without one, every model fell back to a single global guess
// (128k window / 4096 output), which is wrong for nearly everything - a 32k local model got a
// budget three times its real window, and a 1M-window model compacted for no reason.
//
// So this is the lowest-confidence source in the ladder and it never overrides anything:
//
//     user-declared  >  what the endpoint reports  >  this registry  >  global defaults
//
// The file is committed under vendor/ rather than fetched, because the app's first promise is
// that it talks to nothing except the endpoint you configured. Refresh it with
// `pnpm -C server models:sync`.
//
// Two shapes of noise come with the data, and both are handled rather than hidden:
//   - the same model id is offered by many providers with different limits (11 of them for
//     claude-sonnet-4-5, and glm-5.2 ranges from a 200k to a 1M window), so we take the
//     MEDIAN and tell the caller it disagreed instead of silently picking one
//   - some entries cap output above their own context window, which as a reserve would zero
//     the budget, so callers clamp (see overflow.ts)

import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { logger } from "../log"

export type RegistryLimits = { context?: number; output?: number; input?: number }

export type RegistryEntry = {
  provider: string
  /** the provider's own id for it, shown when we have to explain a disagreement */
  id: string
  limits: RegistryLimits
}

export type RegistryMeta = {
  source: string
  license: string
  fetchedAt: string
  providers: number
  models: number
  bytes: number
}

export type RegistryMatch = {
  limits: RegistryLimits
  /** how it was found, so the UI can say why rather than just showing a number */
  matched: "provider" | "exact" | "segment"
  providers: string[]
  /** true when providers disagreed and the median was used */
  disagreed: boolean
}

const DATA_FILE = fileURLToPath(new URL("../../vendor/models.dev.json", import.meta.url))
const META_FILE = fileURLToPath(new URL("../../vendor/models.dev.meta.json", import.meta.url))

/** Enough of a hint to pick the right entry when an id is offered by many providers. A
 *  self-hosted gateway matches nothing here, which is fine: the ladder just falls through to
 *  the exact and segment passes. */
const HOST_PROVIDER: Record<string, string> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "google",
  "api.deepseek.com": "deepseek",
  "openrouter.ai": "openrouter",
  "api.x.ai": "xai",
  "api.mistral.ai": "mistral",
  "api.groq.com": "groq",
  "api.cerebras.ai": "cerebras",
  "api.together.xyz": "together",
  "api.moonshot.cn": "moonshotai",
  "api.moonshot.ai": "moonshotai",
  "open.bigmodel.cn": "zhipuai",
}

/** localhost is Ollama, whose ids the registry stores under the "ollama" provider */
function providerHint(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "ollama"
    return HOST_PROVIDER[host]
  } catch {
    return undefined
  }
}

const normalize = (id: string) => id.trim().toLowerCase().replace(/\\/g, "/")
const lastSegment = (id: string) => {
  const cut = id.lastIndexOf("/")
  return cut >= 0 ? id.slice(cut + 1) : id
}

type Index = {
  meta: RegistryMeta | null
  /** full model id -> entries. Also keyed by last segment when the id contains one, because
   *  2123 of the 3678 ids are vendor-prefixed (`meta-llama/Llama-3.3-70B-...`, `@cf/...`). */
  byId: Map<string, RegistryEntry[]>
  /** provider id -> (model id -> entries), for the hint pass */
  byProvider: Map<string, Map<string, RegistryEntry[]>>
}

let index: Index | null = null

function push(map: Map<string, RegistryEntry[]>, key: string, entry: RegistryEntry): void {
  const list = map.get(key)
  if (list) list.push(entry)
  else map.set(key, [entry])
}

/** Reads and indexes the vendor file once. Never throws: a missing or half-written file means
 *  "we have no suggestions", which degrades to the global defaults rather than taking the
 *  server down. */
function load(): Index {
  if (index) return index

  const fresh: Index = { meta: null, byId: new Map(), byProvider: new Map() }
  index = fresh

  try {
    fresh.meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")) as RegistryMeta
  } catch {
    logger.warn("registry", "no meta beside the registry; the UI cannot show its age")
  }

  const startedAt = Date.now()
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Record<
      string,
      { models?: Record<string, { id?: unknown; limit?: Record<string, unknown> }> }
    >

    for (const provider of Object.keys(raw)) {
      for (const [fallbackId, model] of Object.entries(raw[provider]?.models ?? {})) {
        const limit = model?.limit
        if (!limit) continue

        const context = Number(limit.context) || undefined
        const output = Number(limit.output) || undefined
        const input = Number(limit.input) || undefined
        if (!context && !output) continue

        const id = normalize(typeof model.id === "string" && model.id ? model.id : fallbackId)
        const entry: RegistryEntry = {
          provider,
          id,
          limits: { ...(context ? { context } : {}), ...(output ? { output } : {}), ...(input ? { input } : {}) },
        }

        push(fresh.byId, id, entry)
        const segment = lastSegment(id)
        if (segment !== id) push(fresh.byId, segment, entry)

        const scoped = fresh.byProvider.get(provider) ?? new Map<string, RegistryEntry[]>()
        if (!fresh.byProvider.has(provider)) fresh.byProvider.set(provider, scoped)
        push(scoped, id, entry)
      }
    }

    logger.info("registry", "loaded", {
      providers: fresh.byProvider.size,
      ids: fresh.byId.size,
      ms: Date.now() - startedAt,
    })
  } catch (error) {
    logger.warn("registry", "could not read the vendored registry", { error })
  }

  return fresh
}

/** Median, not max: providers disagree wildly (glm-5.2 spans a 200k to a 1M window) and the
 *  max is usually the outlier that claims more than the model really allows. */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

function combine(entries: RegistryEntry[]): { limits: RegistryLimits; disagreed: boolean } {
  const pick = (field: keyof RegistryLimits) => {
    const values = entries.map((entry) => entry.limits[field]).filter((value): value is number => value !== undefined)
    return { value: median(values), spread: new Set(values).size > 1 }
  }

  const context = pick("context")
  const output = pick("output")
  const input = pick("input")

  return {
    limits: {
      ...(context.value ? { context: context.value } : {}),
      ...(output.value ? { output: output.value } : {}),
      ...(input.value ? { input: input.value } : {}),
    },
    disagreed: context.spread,
  }
}

export function lookupModel(modelID: string, baseURL?: string): RegistryMatch | undefined {
  const key = normalize(String(modelID ?? ""))
  if (!key) return undefined

  const { byId, byProvider } = load()

  const hinted = providerHint(baseURL)
  if (hinted) {
    const scoped = byProvider.get(hinted)?.get(key)
    if (scoped && scoped.length > 0) {
      const { limits, disagreed } = combine(scoped)
      return { limits, matched: "provider", providers: [hinted], disagreed }
    }
  }

  const exact = byId.get(key)
  if (exact && exact.length > 0) {
    const { limits, disagreed } = combine(exact)
    const providers = [...new Set(exact.map((entry) => entry.provider))]
    return { limits, matched: "exact", providers, disagreed }
  }

  const segment = lastSegment(key)
  if (segment !== key) {
    const viaSegment = byId.get(segment)
    if (viaSegment && viaSegment.length > 0) {
      const { limits, disagreed } = combine(viaSegment)
      const providers = [...new Set(viaSegment.map((entry) => entry.provider))]
      return { limits, matched: "segment", providers, disagreed }
    }
  }

  return undefined
}

/** For the UI: where the numbers came from and how old they are. */
export function registryMeta(): RegistryMeta | null {
  return load().meta
}

/** Every id the registry knows, for the sweep that proves no entry can zero a budget. */
export function registryIds(): string[] {
  return [...load().byId.keys()]
}

/** Test hook: drop the memoised index so a check can re-load from disk. */
export function resetRegistry(): void {
  index = null
}
