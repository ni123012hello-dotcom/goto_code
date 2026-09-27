import { existsSync } from "node:fs"
import fs from "node:fs"
import path from "node:path"
import type { MemorySource, MemoryStatus } from "../../shared/protocol"
import type { ProjectFacts } from "./agent/probe"
import { estimate } from "./agent/tokens"
import { config, dataFile } from "./config"
import { logger } from "./log"

export type { MemorySource, MemoryStatus }

// memory is conversation state, not project state: each session owns exactly one
// memory file, so continuing a conversation continues its memory and switching
// conversations switches it. probe facts stay workspace-scoped because they
// describe the codebase, not the conversation.
export type MemoryScope = {
  sessionID: string
  workspace: string
}

export type MemoryEntry = {
  id: string
  key: string
  value: string
  source: MemorySource
  status: MemoryStatus
  stale: boolean
  rev: number
}

export type MemoryDelta = {
  key: string
  value: string
  source?: MemorySource
}

export type MemoryEntryInput = {
  id?: string
  key?: string
  value?: string
  source?: MemorySource
  status?: MemoryStatus
}

const SOURCES: MemorySource[] = ["user", "probe", "tool", "inferred"]
const STATUSES: MemoryStatus[] = ["active", "pending"]

const TRIM_RANK: Record<MemorySource, number> = { user: 4, probe: 3, tool: 2, inferred: 1 }

const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"]

const memoryDir = path.join(path.dirname(dataFile), "memory")

const HEADER = `# goto memory

<!-- 由 goto 维护，也可以直接手改。删掉一行 = 让 agent 忘记这条。 -->
<!-- 格式: - [id|source@rev] **标签** :: 内容                                  -->
<!--   source: user(人说的) | probe(工作区实测) | tool(工具输出) | inferred(AI推断) -->
<!--   尾部 |pending = 待批准，不进入 prompt；|stale = 与工作区冲突，不被采信      -->
<!-- rev 是写入时的轮次，inferred 条目超过 HYPOTHESIS_TTL_TURNS 轮会被清掉        -->

`

const LINE = /^-\s*\[([A-Za-z0-9]+)\|([a-z]+)(?:@(\d+))?((?:\|[a-z]+)*)\]\s*(.*)$/
const LEGACY_LINE = /^-\s*\[([A-Za-z0-9]+)\]\s*(.*)$/
const KEY_VALUE = /^\*\*(.+?)\*\*\s*::\s*(.+)$/
const SECTION = /^##\s*(user|agent)\b/i
const REVISION = /<!--\s*rev:\s*(\d+)\s*-->/

function newId(): string {
  return `m${Math.random().toString(36).slice(2, 8)}`
}

function stableId(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `h${(hash >>> 0).toString(36)}`
}

function normalizeSource(value: string | undefined, fallback: MemorySource): MemorySource {
  return SOURCES.includes(value as MemorySource) ? (value as MemorySource) : fallback
}

function normalizeStatus(value: string | undefined, fallback: MemoryStatus): MemoryStatus {
  return STATUSES.includes(value as MemoryStatus) ? (value as MemoryStatus) : fallback
}

export function memoryFile(scope: MemoryScope): string {
  return path.join(memoryDir, `${scope.sessionID}.md`)
}

function parseBody(
  id: string,
  rest: string,
  source: MemorySource,
  status: MemoryStatus,
  stale: boolean,
  rev: number,
): MemoryEntry {
  const pair = KEY_VALUE.exec(rest)
  return {
    id,
    key: pair ? pair[1].trim() : "",
    value: pair ? pair[2].trim() : rest.trim(),
    source,
    status,
    stale,
    rev,
  }
}

function parseMemory(text: string): { rev: number; entries: MemoryEntry[] } {
  const entries: MemoryEntry[] = []
  const revision = REVISION.exec(text)
  const rev = revision ? Number(revision[1]) : 0
  let section: MemorySource = "inferred"

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("<!--")) continue

    // must run before the `#` skip below, otherwise `## user` is swallowed as a
    // comment and every legacy entry migrates to the wrong source
    const heading = SECTION.exec(line)
    if (heading) {
      section = heading[1].toLowerCase() === "user" ? "user" : "inferred"
      continue
    }

    if (line.startsWith("#")) continue

    const modern = LINE.exec(line)
    if (modern) {
      const flags = modern[4].split("|").filter(Boolean)
      entries.push(
        parseBody(
          modern[1],
          modern[5],
          normalizeSource(modern[2], section),
          flags.includes("pending") ? "pending" : "active",
          flags.includes("stale"),
          modern[3] ? Number(modern[3]) : rev,
        ),
      )
      continue
    }

    const legacy = LEGACY_LINE.exec(line)
    if (legacy) {
      entries.push(parseBody(legacy[1], legacy[2], section, "active", false, rev))
      continue
    }

    if (line.startsWith("-")) {
      const value = line.replace(/^-\s*/, "").trim()
      if (value) {
        entries.push({ id: stableId(value), key: "", value, source: "user", status: "active", stale: false, rev })
      }
    }
  }

  return { rev, entries }
}

function renderMemory(entries: MemoryEntry[], rev: number): string {
  const lines = entries.map((entry) => {
    const flags = `${entry.status === "pending" ? "|pending" : ""}${entry.stale ? "|stale" : ""}`
    const tag = `${entry.id}|${entry.source}@${entry.rev}${flags}`
    return entry.key ? `- [${tag}] **${entry.key}** :: ${entry.value}` : `- [${tag}] ${entry.value}`
  })

  return `${HEADER.replace("-->", `-->\n<!-- rev: ${rev} -->`)}${lines.join("\n")}${lines.length ? "\n" : ""}`
}

type MemoryFile = { mtimeMs: number; rev: number; entries: MemoryEntry[] }

const cache = new Map<string, MemoryFile>()

function readFile(scope: MemoryScope): MemoryFile {
  const file = memoryFile(scope)

  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    mtimeMs = 0
  }

  const hit = cache.get(scope.sessionID)
  if (hit && hit.mtimeMs === mtimeMs) return hit

  const parsed = mtimeMs === 0 ? { rev: 0, entries: [] } : parseMemory(fs.readFileSync(file, "utf8"))
  const next: MemoryFile = { mtimeMs, rev: parsed.rev, entries: parsed.entries }
  cache.set(scope.sessionID, next)
  return next
}

export function loadMemory(scope: MemoryScope): MemoryEntry[] {
  return readFile(scope).entries
}

export function loadRevision(scope: MemoryScope): number {
  return readFile(scope).rev
}

export function saveMemory(scope: MemoryScope, entries: MemoryEntry[], rev?: number): void {
  const file = memoryFile(scope)
  const revision = rev ?? loadRevision(scope)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, renderMemory(entries, revision), "utf8")
  cache.delete(scope.sessionID)
}

export function readMemoryText(scope: MemoryScope): string {
  try {
    return fs.readFileSync(memoryFile(scope), "utf8")
  } catch {
    return renderMemory([], 0)
  }
}

export function writeMemoryText(scope: MemoryScope, text: string): MemoryEntry[] {
  const parsed = parseMemory(text)
  const entries = trimToBudget(parsed.entries)
  saveMemory(scope, entries, parsed.rev)
  return entries
}

export function saveMemoryEntries(scope: MemoryScope, input: MemoryEntryInput[]): MemoryEntry[] {
  const previous = new Map(loadMemory(scope).map((entry) => [entry.id, entry]))
  const rev = loadRevision(scope)

  const entries: MemoryEntry[] = []
  for (const raw of input) {
    const value = String(raw.value ?? "").trim()
    if (!value) continue
    const existing = raw.id ? previous.get(raw.id) : undefined

    entries.push({
      id: existing ? existing.id : newId(),
      key: String(raw.key ?? "").trim(),
      value,
      source: normalizeSource(raw.source, existing?.source ?? "user"),
      status: normalizeStatus(raw.status, existing?.status ?? "active"),
      stale: existing?.stale ?? false,
      rev: existing?.rev ?? rev,
    })
  }

  const trimmed = trimToBudget(entries)
  saveMemory(scope, trimmed)
  logger.info("memory", "saved from ui", {
    sessionID: scope.sessionID,
    total: trimmed.length,
    tokens: memoryTokens(trimmed),
  })
  return trimmed
}

export function memoryTokens(entries: MemoryEntry[]): number {
  return entries.reduce((total, entry) => total + estimate(`${entry.key}${entry.value}`) + 4, 0)
}

export function trimToBudget(entries: MemoryEntry[]): MemoryEntry[] {
  const kept = [...entries]
  const dropped: MemoryEntry[] = []

  while (memoryTokens(kept) > config.memoryMaxTokens) {
    // stale first, then inferred, then tool, then probe. pending before active at
    // equal source. user entries are never auto-trimmed - only a human removes those.
    const victim = kept
      .map((entry, index) => ({
        index,
        rank: entry.stale ? 0 : TRIM_RANK[entry.source],
        pending: entry.status === "pending" ? 0 : 1,
      }))
      .filter((candidate) => kept[candidate.index].source !== "user")
      .sort((a, b) => a.rank - b.rank || a.pending - b.pending || a.index - b.index)[0]

    if (!victim) break
    dropped.push(...kept.splice(victim.index, 1))
  }

  if (dropped.length > 0) {
    logger.warn("memory", "trimmed to budget", {
      maxTokens: config.memoryMaxTokens,
      dropped: dropped.length,
      droppedKeys: dropped.map((entry) => entry.key || entry.value.slice(0, 40)),
    })
  }

  return kept
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ")
}

export function applyMemoryDelta(
  scope: MemoryScope,
  added: MemoryDelta[],
  removed: string[],
  options: { status?: MemoryStatus } = {},
): { added: MemoryEntry[]; invalidated: MemoryEntry[]; entries: MemoryEntry[] } {
  const entries = loadMemory(scope)
  const rev = loadRevision(scope)
  const invalidated: MemoryEntry[] = []

  const remaining = entries.filter((entry) => {
    if (!removed.includes(entry.id)) return true
    invalidated.push(entry)
    return false
  })

  const addedEntries: MemoryEntry[] = []
  for (const delta of added) {
    const value = delta.value.trim()
    if (!value) continue
    const key = delta.key.trim()
    const source = normalizeSource(delta.source, "tool")
    const status = options.status ?? "pending"
    const identity = key ? normalize(key) : normalize(value)

    const existing = remaining.findIndex((entry) =>
      entry.key ? normalize(entry.key) === identity : normalize(entry.value) === identity,
    )

    if (existing !== -1) {
      const previous = remaining[existing]
      // never let a re-proposal silently demote something a human already approved
      const nextStatus = previous.status === "active" ? "active" : status
      if (previous.value === value && previous.source === source && previous.status === nextStatus) continue
      remaining.splice(existing, 1)
      const updated: MemoryEntry = {
        ...previous,
        value,
        source: previous.status === "active" ? previous.source : source,
        status: nextStatus,
        stale: false,
        rev,
      }
      remaining.push(updated)
      addedEntries.push(updated)
      continue
    }

    const entry: MemoryEntry = { id: newId(), key, value, source, status, stale: false, rev }
    remaining.push(entry)
    addedEntries.push(entry)
  }

  const trimmed = trimToBudget(remaining)
  saveMemory(scope, trimmed, rev)

  if (addedEntries.length > 0 || invalidated.length > 0) {
    logger.info("memory", "delta applied", {
      sessionID: scope.sessionID,
      added: addedEntries.map((entry) => entry.key || entry.value.slice(0, 40)),
      invalidated: invalidated.map((entry) => entry.key || entry.value.slice(0, 40)),
      total: trimmed.length,
      tokens: memoryTokens(trimmed),
    })
  }

  return { added: addedEntries, invalidated, entries: trimmed }
}

// --- verification -----------------------------------------------------------
// one tri-state verdict is shared by three jobs: `conflict` reports a mismatch to
// the model and eventually forces the entry to the measured value (T3/T7), a
// `match` auto-promotes a proposal out of the approval queue (T5), and `unknown`
// means the check cannot judge this entry so it must never count as evidence.

type Traditional =
  | { action: "rewrite"; from: string; to: string }
  | { action: "replace"; value: string }
  | { action: "drop" }

type Verdict = { kind: "match" | "conflict" | "unknown"; reason?: string; traditional?: Traditional }

type Check = (input: {
  entry: MemoryEntry
  text: string
  facts: ProjectFacts
  workspace: string
}) => Verdict

const URL_LIKE = /https?:\/\//

const KNOWN_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "rust",
  "golang",
  "go",
  "java",
  "kotlin",
  "ruby",
  "php",
  "csharp",
]

const checkPackageManager: Check = ({ text, facts }) => {
  if (!facts.packageManager) return { kind: "unknown" }
  if (!/package\s*manager|包管理/i.test(text)) return { kind: "unknown" }

  const mentioned = PACKAGE_MANAGERS.filter((manager) => new RegExp(`\\b${manager}\\b`).test(text))
  if (mentioned.length !== 1) return { kind: "unknown" }

  if (mentioned[0] === facts.packageManager) {
    return { kind: "match", reason: `工作区实测确认 ${facts.packageManager}` }
  }

  return {
    kind: "conflict",
    reason: `记忆里写的是 ${mentioned[0]}，工作区实测是 ${facts.packageManager}`,
    traditional: { action: "rewrite", from: mentioned[0], to: facts.packageManager },
  }
}

const checkLanguage: Check = ({ text, facts }) => {
  if (facts.languages.length === 0) return { kind: "unknown" }
  if (!/语言|language/i.test(text)) return { kind: "unknown" }

  const actual = facts.languages.map((language) => language.toLowerCase())
  const mentioned = KNOWN_LANGUAGES.find((language) => new RegExp(`\\b${language}\\b`).test(text))
  if (!mentioned) return { kind: "unknown" }

  if (actual.includes(mentioned)) return { kind: "match", reason: `工作区实测确认 ${mentioned}` }

  return {
    kind: "conflict",
    reason: `记忆里写的是 ${mentioned}，工作区实测是 ${facts.languages.join(", ")}`,
    traditional: { action: "rewrite", from: mentioned, to: facts.languages[0] },
  }
}

const checkPaths: Check = ({ entry, workspace }) => {
  if (URL_LIKE.test(entry.value)) return { kind: "unknown" }

  const paths = entry.value.match(/[\w@.-]+[/\\][\w./\\-]*\.[a-z]{1,6}\b/g) ?? []
  if (paths.length === 0) return { kind: "unknown" }

  const missing = paths.find((candidate) => !existsSync(path.resolve(workspace, candidate)))
  if (missing) {
    return {
      kind: "conflict",
      reason: `引用的路径 ${missing} 不存在`,
      // there is no correct value to substitute, the statement is simply void
      traditional: { action: "drop" },
    }
  }

  return { kind: "match", reason: `引用的路径都存在（${paths.join(", ")}）` }
}

const checkScripts: Check = ({ text, facts }) => {
  const names = Object.keys(facts.scripts)
  if (names.length === 0) return { kind: "unknown" }

  const hits = [...text.matchAll(/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/g)].map(
    (match) => match[1],
  )
  if (hits.length === 0) return { kind: "unknown" }

  const known = hits.filter((name) => names.includes(name))
  if (known.length === 0) return { kind: "unknown" }
  return { kind: "match", reason: `package.json 里有这些脚本：${known.join(", ")}` }
}

const CHECKS: Check[] = [checkPackageManager, checkLanguage, checkPaths, checkScripts]

export function evaluateEntry(entry: MemoryEntry, facts: ProjectFacts, workspace: string): Verdict {
  const text = `${entry.key} ${entry.value}`.toLowerCase()
  for (const check of CHECKS) {
    const verdict = check({ entry, text, facts, workspace })
    if (verdict.kind !== "unknown") return verdict
  }
  return { kind: "unknown" }
}

export function describeTraditional(traditional: Traditional | undefined): string | undefined {
  if (!traditional) return undefined
  if (traditional.action === "drop") return "（这条引用的目标不存在，应删除）"
  if (traditional.action === "rewrite") return traditional.to
  return traditional.value
}

export type Conflict = {
  id: string
  key: string
  value: string
  source: MemorySource
  status: MemoryStatus
  reason: string
  expected?: string
  correctable: boolean
}

export function conflictsWith(scope: MemoryScope, facts: ProjectFacts): Conflict[] {
  const conflicts: Conflict[] = []

  for (const entry of loadMemory(scope)) {
    const verdict = evaluateEntry(entry, facts, scope.workspace)
    if (verdict.kind !== "conflict") continue

    conflicts.push({
      id: entry.id,
      key: entry.key,
      value: entry.value,
      source: entry.source,
      status: entry.status,
      reason: verdict.reason ?? "与工作区实测不符",
      expected: describeTraditional(verdict.traditional),
      // a human may legitimately know something the filesystem does not, so their
      // own statements are reported but never overwritten
      correctable: entry.source !== "user" && Boolean(verdict.traditional),
    })
  }

  return conflicts
}

// T3 + T7: probe re-reads ground truth from disk every turn. A mismatch is first
// reported to the model (and shown as refuted in its prompt) and given one turn to
// self-correct through the normal memory channel; if the model does nothing, the
// entry is rewritten to the measured value so memory heals without a human.
export function reconcileMemory(
  scope: MemoryScope,
  facts: ProjectFacts,
): { flagged: number; corrected: number; dropped: number } {
  const entries = loadMemory(scope)
  const rev = loadRevision(scope)
  const result = { flagged: 0, corrected: 0, dropped: 0 }
  if (entries.length === 0) return result

  const kept: MemoryEntry[] = []

  for (const entry of entries) {
    const verdict = evaluateEntry(entry, facts, scope.workspace)

    if (verdict.kind !== "conflict") {
      if (entry.stale) {
        entry.stale = false
        result.flagged += 1
      }
      kept.push(entry)
      continue
    }

    if (entry.source === "user" || !verdict.traditional) {
      entry.stale = true
      result.flagged += 1
      kept.push(entry)
      continue
    }

    // first sighting: flag it and let the model fix it in its own words this turn
    if (!entry.stale) {
      entry.stale = true
      result.flagged += 1
      logger.warn("memory", "conflict reported to model", {
        sessionID: scope.sessionID,
        id: entry.id,
        key: entry.key || entry.value.slice(0, 40),
        reason: verdict.reason,
      })
      kept.push(entry)
      continue
    }

    // the model already had its turn and did not react -> force the measured value
    const traditional = verdict.traditional

    if (traditional.action === "drop") {
      result.dropped += 1
      logger.warn("memory", "dropped conflicting memory", {
        sessionID: scope.sessionID,
        id: entry.id,
        key: entry.key || entry.value.slice(0, 40),
        reason: verdict.reason,
      })
      continue
    }

    if (traditional.action === "replace") {
      entry.value = traditional.value
    } else {
      const pattern = new RegExp(`\\b${traditional.from}\\b`, "i")
      if (!pattern.test(entry.value)) {
        kept.push(entry)
        continue
      }
      entry.value = entry.value.replace(new RegExp(`\\b${traditional.from}\\b`, "gi"), traditional.to)
    }

    entry.source = "probe"
    entry.status = "active"
    entry.stale = false
    entry.rev = rev
    result.corrected += 1
    logger.info("memory", "forced to measured value", {
      sessionID: scope.sessionID,
      id: entry.id,
      value: entry.value.slice(0, 60),
      reason: verdict.reason,
    })
    kept.push(entry)
  }

  if (result.flagged + result.corrected + result.dropped > 0) {
    saveMemory(scope, trimToBudget(kept), rev)
  }
  return result
}

// T5: a proposed entry that probe can positively confirm does not need a human,
// so it leaves the queue automatically. Everything else waits.
export function promoteVerified(scope: MemoryScope, facts: ProjectFacts): number {
  const entries = loadMemory(scope)
  const pending = entries.filter((entry) => entry.status === "pending" && !entry.stale)
  if (pending.length === 0) return 0

  let promoted = 0
  for (const entry of pending) {
    const verdict = evaluateEntry(entry, facts, scope.workspace)
    if (verdict.kind !== "match") continue

    entry.status = "active"
    entry.source = "probe"
    entry.stale = false
    promoted += 1
    logger.info("memory", "auto promoted", {
      sessionID: scope.sessionID,
      id: entry.id,
      key: entry.key || entry.value.slice(0, 40),
      reason: verdict.reason,
    })
  }

  if (promoted === 0) return 0
  saveMemory(scope, trimToBudget(entries))
  return promoted
}

// T4: an inference nobody confirmed and nothing verified should fade instead of
// living forever. Rev advances once per turn, so this is measured in turns of use.
export function bumpRevision(scope: MemoryScope): number {
  const rev = loadRevision(scope) + 1
  saveMemory(scope, loadMemory(scope), rev)
  return rev
}

export function expireHypotheses(scope: MemoryScope): number {
  const entries = loadMemory(scope)
  const rev = loadRevision(scope)
  const ttl = config.hypothesisTtlTurns

  const kept = entries.filter(
    (entry) => !(entry.source === "inferred" && entry.status === "pending" && rev - entry.rev > ttl),
  )

  const dropped = entries.length - kept.length
  if (dropped === 0) return 0

  logger.info("memory", "expired hypotheses", { sessionID: scope.sessionID, dropped, rev, ttl })
  saveMemory(scope, trimToBudget(kept), rev)
  return dropped
}

export function approveEntry(scope: MemoryScope, id: string): MemoryEntry | undefined {
  const entries = loadMemory(scope)
  const entry = entries.find((candidate) => candidate.id === id)
  if (!entry) return undefined

  entry.status = "active"
  entry.source = "user"
  entry.stale = false
  saveMemory(scope, trimToBudget(entries))
  logger.info("memory", "approved by user", { sessionID: scope.sessionID, id })
  return entry
}

export function rejectEntry(scope: MemoryScope, id: string): boolean {
  const entries = loadMemory(scope)
  const kept = entries.filter((entry) => entry.id !== id)
  if (kept.length === entries.length) return false

  saveMemory(scope, kept)
  logger.info("memory", "rejected by user", { sessionID: scope.sessionID, id })
  return true
}

function renderEntry(entry: MemoryEntry): string {
  // the id is included so the agent can target it with the memory tool's remove action
  const body = entry.key ? `${entry.key} — ${entry.value}` : entry.value
  return `- [${entry.id}] ${body}`
}

export function formatMemoryForPrompt(
  entries: MemoryEntry[],
  facts?: ProjectFacts,
  workspace?: string,
): string {
  // T5 quarantine: pending entries are deliberately absent. An unverified claim
  // cannot reach the model as a fact until probe confirms it or a human approves it.
  const active = entries.filter((entry) => entry.status === "active")

  const verified = active.filter((entry) => !entry.stale && entry.source !== "inferred")
  const inferred = active.filter((entry) => !entry.stale && entry.source === "inferred")
  const stale = active.filter((entry) => entry.stale)

  const blocks: string[] = []

  if (verified.length > 0) {
    blocks.push(`已确认（可直接采信）\n${verified.map(renderEntry).join("\n")}`)
  }

  if (inferred.length > 0) {
    blocks.push(`AI 推断（未经核实，用到时请自行验证）\n${inferred.map(renderEntry).join("\n")}`)
  }

  if (stale.length > 0) {
    const lines = stale.map((entry) => {
      const verdict = facts && workspace ? evaluateEntry(entry, facts, workspace) : { kind: "unknown" as const }
      const expected = describeTraditional(verdict.traditional)
      const line = renderEntry(entry)
      return expected ? `${line}\n  ↳ 工作区实测：${expected}` : line
    })

    blocks.push(
      `已证伪（与工作区实测冲突，不要采信。系统会在下一轮自动改写，你不需要处理）\n${lines.join("\n")}`,
    )
  }

  const body = blocks.length === 0 ? "" : `## 长期记忆（跨会话保留）\n\n${blocks.join("\n\n")}`
  const hint =
    "用 memory 工具增删记忆。要改一条，用 remove 删旧 id 再 add 新的，不要问用户。"

  return body ? `${body}\n\n${hint}` : ""
}

export function pendingCount(scope: MemoryScope): number {
  return loadMemory(scope).filter((entry) => entry.status === "pending").length
}

export function deleteMemoryFile(scope: MemoryScope): void {
  try {
    fs.rmSync(memoryFile(scope), { force: true })
  } catch {
    /* best effort */
  }
  cache.delete(scope.sessionID)
}
