import fs from "node:fs"
import path from "node:path"
import OpenAI from "openai"
import { modelLimits } from "./agent/models"
import { limitsForModel, preserveRecentBudget, usable } from "./agent/overflow"
import { lookupModel, registryMeta } from "./agent/registry"
import { config, dataFile } from "./config"

export type SettingsPatch = {
  apiKey?: string
  baseURL?: string
  model?: string
  workspace?: string
  /** the Settings switch for the fetch tool; a boolean, not a string like the rest */
  webFetch?: boolean
}

export type EffectiveSettings = {
  apiKey: string
  baseURL: string
  model: string
  workspace: string
}

const FIELDS = ["apiKey", "baseURL", "model", "workspace"] as const

/** Networking is OFF unless the user turns it on. The stored value wins; WEB_FETCH is only
 *  the fallback, so the Settings switch and the env var cannot silently disagree. */
export function webFetchEnabled(): boolean {
  return typeof stored.webFetch === "boolean" ? stored.webFetch : config.webFetch
}

function read(): SettingsPatch {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8")) as SettingsPatch
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

let stored: SettingsPatch = read()

function persist(): void {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true })
  fs.writeFileSync(dataFile, `${JSON.stringify(stored, null, 2)}\n`, "utf8")
}

export function getSettings(): EffectiveSettings {
  return {
    apiKey: stored.apiKey || config.envDefaults.apiKey,
    baseURL: stored.baseURL || config.envDefaults.baseURL,
    model: stored.model || config.envDefaults.model,
    workspace: stored.workspace || config.envDefaults.workspace || process.cwd(),
  }
}

export function maskKey(key: string): string {
  if (!key) return ""
  if (key.length <= 12) return `${key.slice(0, 3)}...`
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export function contextInfo(modelID: string) {
  const limits = limitsForModel(modelID)

  // Where these numbers came from. Without this the panel presents a guess as a fact, and
  // the user has no way to know a 1M window is the vendored registry's opinion rather than
  // anything their endpoint ever said.
  const known = lookupModel(modelID)
  const limitsFrom =
    Object.keys(modelLimits(modelID)).length > 0 ? "user" : known ? "registry" : "default"

  return {
    model: modelID || null,
    window: limits.context,
    inputLimit: limits.inputLimit,
    maxOutputTokens: limits.maxOutputTokens,
    budget: usable(limits),
    limitsFrom,
    /** What the vendored registry alone says, independent of the user's entry: the dialog
     *  offers these as placeholders, and it needs them even for a model the user has only
     *  partly filled - where `limitsFrom` is already "user" and the effective numbers are
     *  no longer the registry's. null when the registry has never heard of this model. */
    registry: known
      ? {
          limits: known.limits,
          matched: known.matched,
          providers: known.providers.length,
          disagreed: known.disagreed,
          fetchedAt: registryMeta()?.fetchedAt ?? null,
        }
      : null,
    auto: config.compactionAuto,
    prune: config.compactionPrune,
    pruneProtect: config.pruneProtect,
    preserveRecent: preserveRecentBudget(limits),
  }
}

export function publicSettings() {
  const settings = getSettings()

  return {
    baseURL: settings.baseURL,
    model: settings.model,
    workspace: settings.workspace,
    hasApiKey: Boolean(settings.apiKey),
    apiKeyHint: maskKey(settings.apiKey),
    apiKeySource: stored.apiKey ? "saved" : config.envDefaults.apiKey ? "env" : "none",
    permissionTools: config.permissionTools,
    maxSteps: config.maxSteps,
    settingsPath: dataFile,
    // the fetch tool is the one thing that can reach outside this machine, so its state is
    // part of the settings payload the UI renders
    webFetch: webFetchEnabled(),
    memory: {
      hypothesisTtlTurns: config.hypothesisTtlTurns,
      maxTokens: config.memoryMaxTokens,
    },
    context: contextInfo(settings.model),
  }
}

export function updateSettings(patch: SettingsPatch): void {
  for (const field of FIELDS) {
    const value = patch[field]
    if (value === undefined) continue
    const trimmed = String(value).trim()
    if (trimmed) stored[field] = trimmed
    else delete stored[field]
  }
  // booleans keep their own shape: the string loop above would turn `false` into a deletion
  if (typeof patch.webFetch === "boolean") stored.webFetch = patch.webFetch
  persist()
  // the cached model list belongs to the previous endpoint/key
  modelCache = null
}

export type ModelList = { models: string[]; fetchedAt: number; error?: string }

let modelCache: { key: string; at: number; models: string[] } | null = null
const MODEL_CACHE_MS = 5 * 60_000

/** Models the provider advertises. Cached briefly: the settings dialog and the
 *  header switcher both ask for it, and the endpoint can be slow. */
export async function listModels(force = false): Promise<ModelList> {
  const settings = getSettings()
  if (!settings.apiKey) return { models: [], fetchedAt: Date.now(), error: "还没有配置 API key" }

  const key = `${settings.baseURL}|${settings.apiKey.slice(-8)}`
  if (!force && modelCache && modelCache.key === key && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return { models: modelCache.models, fetchedAt: modelCache.at }
  }

  try {
    const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseURL, timeout: 20_000 })
    const list = await client.models.list()
    const models = list.data
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id))
      .sort()
    modelCache = { key, at: Date.now(), models }
    return { models, fetchedAt: modelCache.at }
  } catch (error) {
    // fall back to whatever we saw last: a stale list beats an empty dropdown
    return {
      models: modelCache?.models ?? [],
      fetchedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function testConnection(patch: SettingsPatch = {}): Promise<{
  ok: boolean
  models: number
  modelFound: boolean
}> {
  const settings = getSettings()

  const apiKey = patch.apiKey?.trim() || settings.apiKey
  const baseURL = patch.baseURL?.trim() || settings.baseURL
  const model = patch.model?.trim() || settings.model

  if (!apiKey) throw new Error("API key is empty")

  const client = new OpenAI({ apiKey, baseURL, timeout: 20_000 })
  const list = await client.models.list()
  const ids = list.data.map((entry) => entry.id)

  return {
    ok: true,
    models: ids.length,
    modelFound: ids.length === 0 ? true : ids.includes(model),
  }
}
