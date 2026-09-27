// Saved API providers.
//
// This is a list of presets, NOT the live config: settings.json stays the single source of
// truth for what is actually in use. "Switching" simply copies a preset into the live
// settings, which keeps getSettings() and everything downstream untouched — and means the
// current state is always inspectable in one place.
//
// The active provider is derived by comparing the live config against the list rather than
// stored, so editing the settings by hand can never leave a stale "active" marker behind.

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { dataFile } from "./config"
import { logger } from "./log"
import { getSettings, maskKey, updateSettings } from "./settings"

export type Provider = {
  id: string
  name: string
  baseURL: string
  apiKey: string
  model: string
}

/** What the UI is allowed to see: never the raw key. */
export type PublicProvider = {
  id: string
  name: string
  baseURL: string
  model: string
  hasApiKey: boolean
  apiKeyHint: string
}

export type ProviderInput = {
  id?: string
  name?: string
  baseURL?: string
  apiKey?: string
  model?: string
}

const storeFile = path.join(path.dirname(dataFile), "providers.json")

type Store = { list: Provider[] }

let cache: Store | null = null

function sanitize(raw: unknown): Store {
  if (!raw || typeof raw !== "object") return { list: [] }
  const list = (raw as { list?: unknown }).list
  if (!Array.isArray(list)) return { list: [] }

  const out: Provider[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID()
    const baseURL = typeof item.baseURL === "string" ? item.baseURL.trim() : ""
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : baseURL || "未命名"
    const apiKey = typeof item.apiKey === "string" ? item.apiKey : ""
    const model = typeof item.model === "string" ? item.model.trim() : ""
    if (!baseURL) continue
    out.push({ id, name, baseURL, apiKey, model })
  }
  return { list: out }
}

function read(): Store {
  if (cache) return cache

  try {
    cache = sanitize(JSON.parse(fs.readFileSync(storeFile, "utf8")))
  } catch {
    cache = { list: [] }
  }

  // first run: adopt whatever is already configured, so the user does not start empty
  if (cache.list.length === 0) {
    const settings = getSettings()
    if (settings.baseURL) {
      cache = {
        list: [
          {
            id: randomUUID(),
            name: "当前配置",
            baseURL: settings.baseURL,
            apiKey: settings.apiKey,
            model: settings.model,
          },
        ],
      }
      persist(cache)
    }
  }

  return cache
}

function persist(store: Store): void {
  cache = store
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true })
    fs.writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`, "utf8")
  } catch (error) {
    logger.warn("providers", "failed to write provider list", { error })
  }
}

export function providersFilePath(): string {
  return storeFile
}

/** Derived, never stored: whichever preset matches the live config.
 *
 *  A preset with no key of its own matches on baseURL alone — after activating it the live
 *  key is whatever was already saved, and the UI must still highlight it rather than
 *  claiming "custom". A preset that does carry a key has to match it exactly, so two
 *  entries for the same endpoint with different accounts stay distinguishable. */
export function activeProviderId(): string | null {
  const settings = getSettings()
  const hit = read().list.find(
    (provider) =>
      provider.baseURL === settings.baseURL && (provider.apiKey ? provider.apiKey === settings.apiKey : true),
  )
  return hit?.id ?? null
}

export function publicProviders(): { active: string | null; list: PublicProvider[]; path: string } {
  return {
    active: activeProviderId(),
    path: storeFile,
    list: read().list.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      model: provider.model,
      hasApiKey: Boolean(provider.apiKey),
      apiKeyHint: maskKey(provider.apiKey),
    })),
  }
}

export function upsertProvider(input: ProviderInput): PublicProvider {
  const store = read()
  const existing = input.id ? store.list.find((provider) => provider.id === input.id) : undefined

  const baseURL = String(input.baseURL ?? existing?.baseURL ?? "").trim()
  if (!baseURL) throw new Error("baseURL is required")

  const name = String(input.name ?? existing?.name ?? "").trim() || baseURL
  const model = String(input.model ?? existing?.model ?? "").trim()

  // an empty key means "leave it alone" — the UI never receives the real one, so it cannot
  // send it back. Creating a new provider with an empty key is allowed (env may supply it).
  const rawKey = String(input.apiKey ?? "").trim()
  const apiKey = rawKey || existing?.apiKey || ""

  const next: Provider = { id: existing?.id ?? randomUUID(), name, baseURL, apiKey, model }
  const list = existing
    ? store.list.map((provider) => (provider.id === next.id ? next : provider))
    : [...store.list, next]

  persist({ list })
  logger.info("providers", existing ? "updated" : "created", { id: next.id, name, baseURL })

  return {
    id: next.id,
    name: next.name,
    baseURL: next.baseURL,
    model: next.model,
    hasApiKey: Boolean(next.apiKey),
    apiKeyHint: maskKey(next.apiKey),
  }
}

export function deleteProvider(id: string): boolean {
  const store = read()
  const list = store.list.filter((provider) => provider.id !== id)
  if (list.length === store.list.length) return false

  persist({ list })
  logger.info("providers", "deleted", { id })
  return true
}

/** Copies the preset into the live settings. Only non-empty fields are written, because
 *  updateSettings() treats an empty string as "remove this field". */
export function activateProvider(id: string): Provider | undefined {
  const provider = read().list.find((entry) => entry.id === id)
  if (!provider) return undefined

  const patch: { baseURL: string; apiKey?: string; model?: string } = { baseURL: provider.baseURL }
  if (provider.apiKey) patch.apiKey = provider.apiKey
  if (provider.model) patch.model = provider.model

  updateSettings(patch)
  logger.info("providers", "activated", { id, name: provider.name, baseURL: provider.baseURL })
  return provider
}
