// MCP (Model Context Protocol) server configuration and trust model.
//
// Transport lives in mcp-client.ts; this module owns where servers are defined, how their
// tools are named, and - the load-bearing part - what it takes to be allowed to run.
//
// THE TRUST MODEL
//
// Approval is the user's, and it is asked once per *definition*, not once per call. That only
// stays honest if approval cannot be stretched to cover a different command, so a server
// stores a fingerprint of command + args + cwd and must be re-confirmed whenever it changes:
//
//   enabled       run it at all
//   trusted       the user confirmed this exact definition once
//   fingerprint   sha256(command, args, cwd) at confirmation time
//   runnable      enabled && trusted && fingerprint === current fingerprint
//
// Editing the command later flips `trusted` back to false, so "confirm once" can never be
// used to smuggle in a command nobody looked at. env is deliberately NOT part of the
// fingerprint: tokens rotate, and re-asking on every rotation would train the user to click
// through the dialog.
//
// A new server is fail-closed: enabled=false, trusted=false. Nothing runs until someone
// explicitly acknowledges it.
//
// NAMING
//
// Every MCP tool is mcp__<serverID>__<tool>. The id is restricted to [a-z0-9-] so it can never
// contain "__" and leave the boundary between id and tool name ambiguous. mcpToolName() is the
// only place that builds one, and it enforces the 64 character limit OpenAI puts on function
// names.
//
// SECRETS
//
// env values are tokens: they live on disk and in the process we spawn, and publicMcpServers()
// only ever hands the browser a mask.

import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { dataFile } from "./config"
import { logger } from "./log"
import { maskKey } from "./settings"

export const MCP_TOOL_PREFIX = "mcp__"

/** OpenAI-compatible function names are capped at 64 characters, so the whole
 *  mcp__<server>__<tool> string has to fit. */
export const MAX_TOOL_NAME = 64

/** No "_" on purpose - see the naming note above. */
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

export type McpServer = {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  /** working directory for the process; empty means the goto root */
  cwd: string
  /** expose only these tools; empty means all of them */
  tools: string[]
  enabled: boolean
  trusted: boolean
  fingerprint: string
}

export type PublicMcpServer = {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  tools: string[]
  enabled: boolean
  trusted: boolean
  /** enabled, but its definition changed since it was confirmed: it will NOT run */
  needsTrust: boolean
  /** which definition the confirmation currently covers */
  fingerprint: string
}

export type McpServerInput = {
  id?: string
  name?: string
  command?: string
  args?: unknown
  env?: unknown
  cwd?: unknown
  tools?: unknown
  enabled?: boolean
  /** the one-time confirmation. The only way to grant trust; a plain `enabled: true` is not
   *  enough, so a script cannot switch a server on without meaning to approve its command. */
  acknowledge?: boolean
  /** confirm even though the definition provably cannot work (missing paths) */
  force?: boolean
}

const storeFile = path.join(path.dirname(dataFile), "mcp.json")

export function mcpFilePath(): string {
  return storeFile
}

/** Binds an approval to one exact command line. Same inputs must always give the same value,
 *  or a restart would silently invalidate every confirmation. */
export function definitionFingerprint(command: string, args: string[], cwd = ""): string {
  const payload = [command, ...args, `cwd=${cwd}`].join("\u0000")
  return createHash("sha256").update(payload).digest("hex").slice(0, 16)
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "")
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim()
    if (name && typeof entry === "string") out[name] = entry
  }
  return out
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
}

function maskEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, maskKey(value)]))
}

function sanitize(raw: unknown): McpServer[] {
  if (!raw || typeof raw !== "object") return []
  const list = (raw as { servers?: unknown }).servers
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const servers: McpServer[] = []

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>

    const command = typeof item.command === "string" ? item.command.trim() : ""
    // without something to spawn the entry cannot do anything
    if (!command) continue

    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : command

    // repair rather than drop: a hand-edited file should stay usable, and the id is the only
    // thing keeping the tool names unambiguous
    const rawID = typeof item.id === "string" ? item.id.trim() : ""
    let id = SERVER_ID.test(rawID) ? rawID : slug(rawID || name)
    if (!SERVER_ID.test(id)) {
      id = `srv-${randomUUID().slice(0, 8)}`
      logger.warn("mcp", "repaired an invalid server id", { name, was: rawID })
    }
    while (seen.has(id)) id = `${id.slice(0, 28)}-${randomUUID().slice(0, 4)}`
    seen.add(id)

    const args = stringList(item.args)
    const cwd = typeof item.cwd === "string" ? item.cwd.trim() : ""
    const fingerprint = definitionFingerprint(command, args, cwd)

    // a file that was hand-edited must not arrive pre-trusted: only an explicit stored
    // fingerprint matches, and it has to be the fingerprint of what is written next to it
    const reported = typeof item.fingerprint === "string" ? item.fingerprint : ""
    const trusted = item.trusted === true && reported === fingerprint

    servers.push({
      id,
      name,
      command,
      args,
      env: stringRecord(item.env),
      cwd,
      tools: stringList(item.tools),
      enabled: item.enabled === true,
      trusted,
      fingerprint,
    })
  }

  return servers
}

export function listMcpServers(): McpServer[] {
  try {
    return sanitize(JSON.parse(fs.readFileSync(storeFile, "utf8")))
  } catch {
    return [] // a missing or broken file is the normal first-run case
  }
}

/** The only set that may be spawned: switched on, confirmed, and still matching the
 *  definition that was confirmed. */
export function runnableMcpServers(): McpServer[] {
  return listMcpServers().filter((server) => server.enabled && server.trusted)
}

export function needsTrustMcpServers(): McpServer[] {
  return listMcpServers().filter((server) => server.enabled && !server.trusted)
}

function persist(servers: McpServer[]): void {
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true })
    fs.writeFileSync(storeFile, `${JSON.stringify({ servers }, null, 2)}\n`, "utf8")
  } catch (error) {
    logger.warn("mcp", "failed to write the server list", { error })
  }
}

function toPublic(server: McpServer): PublicMcpServer {
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    args: server.args,
    env: maskEnv(server.env),
    cwd: server.cwd,
    tools: server.tools,
    enabled: server.enabled,
    trusted: server.trusted,
    needsTrust: server.enabled && !server.trusted,
    fingerprint: server.fingerprint,
  }
}

export function publicMcpServers(): { list: PublicMcpServer[]; path: string } {
  return { path: storeFile, list: listMcpServers().map(toPublic) }
}

export function upsertMcpServer(input: McpServerInput): PublicMcpServer {
  const servers = listMcpServers()
  const wanted = String(input.id ?? "").trim()
  const existing = wanted ? servers.find((server) => server.id === wanted) : undefined

  const command = String(input.command ?? existing?.command ?? "").trim()
  if (!command) throw new Error("command is required")

  const name = String(input.name ?? existing?.name ?? "").trim() || command

  // an empty value means "keep the one on disk": the UI only ever receives a masked hint, so
  // it cannot send the real secret back
  const env: Record<string, string> = { ...(existing?.env ?? {}) }
  for (const [key, value] of Object.entries(stringRecord(input.env))) {
    if (value) env[key] = value
  }

  const args = Array.isArray(input.args) ? stringList(input.args) : (existing?.args ?? [])
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : (existing?.cwd ?? "")
  const tools = Array.isArray(input.tools) ? stringList(input.tools) : (existing?.tools ?? [])

  const id =
    existing?.id ?? (SERVER_ID.test(wanted) ? wanted : slug(name) || `srv-${randomUUID().slice(0, 8)}`)

  const fingerprint = definitionFingerprint(command, args, cwd)
  // a changed command line invalidates the old confirmation - this is the whole point of
  // storing the fingerprint
  const definitionChanged = existing ? existing.fingerprint !== fingerprint : false

  const acknowledged = input.acknowledge === true
  const wantsEnabled = typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? false)

  // Confirming is the one moment a human is looking at this command line, so it is the moment to
  // say "this cannot work". `force` exists so the check is a speed bump, not a wall.
  if (acknowledged && input.force !== true) {
    const problems = definitionWarnings({ command, args, env })
    if (problems.length > 0) {
      throw new Error(
        `refusing to confirm a command that cannot work:\n  ${problems.join("\n  ")}\n` +
          `fix the paths, or confirm anyway with force=true`,
      )
    }
  }

  // trust is only ever granted explicitly, and only ever covers the definition written now
  const trusted = acknowledged ? true : Boolean(existing?.trusted) && !definitionChanged

  // Enabling something that is not trusted is allowed but runs nothing: `runnable` requires
  // trust, and the response says `needsTrust` so the caller can see what still needs a human.
  // (Importing from another agent's config lands exactly here: switched on there, unconfirmed
  // here.)
  if (wantsEnabled && !trusted) {
    logger.info("mcp", "enabled but not confirmed: it will not run until acknowledged", { id })
  }

  const next: McpServer = {
    id,
    name,
    command,
    args,
    env,
    cwd,
    tools,
    enabled: wantsEnabled,
    trusted,
    fingerprint,
  }

  const list = existing ? servers.map((s) => (s.id === next.id ? next : s)) : [...servers, next]
  persist(list)

  logger.info("mcp", existing ? "server updated" : "server added", {
    id,
    enabled: next.enabled,
    trusted: next.trusted,
    definitionChanged,
  })
  if (definitionChanged && existing?.trusted) {
    logger.warn("mcp", "definition changed: the previous confirmation no longer applies", { id })
  }

  return toPublic(next)
}

export function deleteMcpServer(id: string): boolean {
  const servers = listMcpServers()
  const list = servers.filter((server) => server.id !== id)
  if (list.length === servers.length) return false

  persist(list)
  logger.info("mcp", "server deleted", { id })
  return true
}

/** The id a server with this name will get, or "" when the name cannot produce one.
 *  Import needs it to be stable, or re-importing would create duplicates instead of updating. */
export function serverIDFromName(name: string): string {
  const id = slug(name)
  return SERVER_ID.test(id) ? id : ""
}

/** A drive path, a UNC path, or an absolute POSIX path. */
function looksAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || (value.startsWith("/") && value.length > 1)
}

/** Things about a definition that provably will not work, such as a path that does not exist.
 *
 *  Used twice, on purpose: as a warning when configs are discovered, and as a hard gate when a
 *  confirmation is recorded. Approving a command whose paths are missing means approving
 *  something that cannot run, and an approval nobody can act on is exactly what should take a
 *  second look. */
export function definitionWarnings(server: {
  command: string
  args: string[]
  env: Record<string, string>
}): string[] {
  const warnings: string[] = []
  for (const token of [server.command, ...server.args]) {
    if (looksAbsolute(token) && !fs.existsSync(token)) warnings.push(`path does not exist: ${token}`)
  }
  for (const [key, value] of Object.entries(server.env)) {
    if (looksAbsolute(value) && !fs.existsSync(value)) {
      warnings.push(`env ${key} points at a missing path: ${value}`)
    }
  }
  return warnings
}

/** The single place that knows an MCP tool's shape. Discovery and calls must go through this
 *  rather than building the string by hand, or the naming invariant above stops holding. */
export function mcpToolName(serverID: string, tool: string): string {
  const name = `${MCP_TOOL_PREFIX}${serverID}__${tool}`
  if (name.length > MAX_TOOL_NAME) {
    throw new Error(`MCP tool name exceeds ${MAX_TOOL_NAME} characters: ${name}`)
  }
  return name
}

/** Prefix-based, so a tool offered by an MCP server is recognisable from its name alone -
 *  there is no registry to consult and therefore nothing to keep in sync. */
export function isMcpTool(name: string): boolean {
  return typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX) && name.length > MCP_TOOL_PREFIX.length
}
