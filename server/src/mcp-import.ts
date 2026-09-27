// Import MCP servers that are already configured for another agent.
//
// Nobody wants to retype what they already wrote elsewhere, and the formats are close enough to
// read: opencode keeps them under `mcp`, while Claude Desktop, Claude Code, Cursor and Windsurf
// all agree on `mcpServers`, and VS Code uses `servers`.
//
// Two rules keep this from turning into a security hole:
//
//  1. An import NEVER grants trust. What lands in .data/mcp.json is enabled as the source had it
//     and unconfirmed, so it cannot run until a human acknowledges the exact command line here.
//     "Another tool has it configured" is not approval for this tool to execute it. (The one
//     exception the other way: re-importing an entry whose definition is unchanged leaves an
//     existing confirmation intact, so a re-import cannot silently revoke one either.)
//  2. Remote (HTTP) servers are reported, never silently dropped: goto only speaks stdio, and an
//     entry the user cannot see is worse than an explicit "not supported".

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { logger } from "./log"
import { definitionWarnings, listMcpServers, serverIDFromName, upsertMcpServer, type McpServerInput } from "./mcp"

export type McpSourceKind = "opencode" | "mcpServers" | "vscode"

export type DiscoveredServer = {
  name: string
  /** the file it came from */
  from: string
  kind: McpSourceKind
  command: string
  args: string[]
  /** raw values - the route masks them before they leave the process */
  env: Record<string, string>
  cwd: string
  enabled: boolean
  /** the original one-line command, when the source wrote a string instead of an array */
  splitFrom: string | null
  /** worth showing the user, but not fatal */
  warnings: string[]
  /** set when the entry cannot be imported at all */
  problem: string | null
  /** already present in goto's config */
  imported: boolean
}

export type DiscoverOptions = { home?: string; workspace?: string }

type Candidate = Omit<DiscoveredServer, "from" | "kind" | "imported">

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

/** opencode allows `{env:VAR}` and `{file:path}` placeholders in string values. */
function expandValue(value: string): string {
  const envRef = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim())
  if (envRef) return process.env[envRef[1]] ?? ""

  const fileRef = /^\{file:(.+)\}$/.exec(value.trim())
  if (fileRef) {
    try {
      return fs.readFileSync(fileRef[1].trim(), "utf8").trim()
    } catch {
      return ""
    }
  }
  return value
}

function expandMap(value: Record<string, unknown> | null): Record<string, string> {
  if (!value) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = expandValue(entry)
  }
  return out
}

/** A whitespace split that respects quotes. Hand-written configs mix both, and a path with a
 *  space in it is only unambiguous when it was quoted. */
export function splitCommandString(input: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | null = null

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (current) out.push(current)
  return out
}

/** Repairs the case the split cannot see: an unquoted path containing a space. Two signals, both
 *  narrow on purpose, because a wrong merge silently changes what will be executed:
 *
 *   - the joined text names something that exists (the strong one)
 *   - the next token opens a parenthesis, which is the "Folder (2)" convention and never a CLI
 *     argument on its own
 */
export function joinSplitPaths(tokens: string[]): string[] {
  const out: string[] = []
  for (const token of tokens) {
    const last = out[out.length - 1]
    if (last !== undefined && !fs.existsSync(last) && fs.existsSync(`${last} ${token}`)) {
      out[out.length - 1] = `${last} ${token}`
      continue
    }
    if (last !== undefined && token.startsWith("(")) {
      out[out.length - 1] = `${last} ${token}`
      continue
    }
    out.push(token)
  }
  return out
}

/** Two shapes exist and they are NOT interchangeable:
 *
 *   - opencode puts the whole command line in `command`, as an array or as one string to split
 *   - Claude / Cursor / VS Code put the executable in `command` and the arguments in `args`
 *
 *  `explicitArgs` is how the caller says which one it is. An array `command` is always
 *  self-contained and wins. */
function readCommand(
  value: unknown,
  explicitArgs?: unknown,
): { command: string; args: string[]; splitFrom: string | null } {
  if (Array.isArray(value)) {
    const tokens = stringList(value).map(expandValue)
    return { command: tokens[0] ?? "", args: tokens.slice(1), splitFrom: null }
  }

  if (typeof value === "string") {
    const original = value.trim()
    if (!original) return { command: "", args: [], splitFrom: null }

    if (Array.isArray(explicitArgs)) {
      return {
        command: expandValue(original),
        args: stringList(explicitArgs).map(expandValue),
        splitFrom: null,
      }
    }

    const tokens = joinSplitPaths(splitCommandString(original).map(expandValue))
    return { command: tokens[0] ?? "", args: tokens.slice(1), splitFrom: original }
  }

  return { command: "", args: [], splitFrom: null }
}

function unsupported(name: string, kind: string): Candidate {
  return {
    name,
    command: "",
    args: [],
    env: {},
    cwd: "",
    enabled: false,
    splitFrom: null,
    warnings: [],
    problem: `${kind} server: goto only speaks stdio, so it cannot be imported yet`,
  }
}

function empty(name: string, problem: string): Candidate {
  return {
    name,
    command: "",
    args: [],
    env: {},
    cwd: "",
    enabled: false,
    splitFrom: null,
    warnings: [],
    problem,
  }
}

function fromOpencode(raw: unknown): Candidate[] {
  const mcp = asRecord(asRecord(raw)?.mcp)
  if (!mcp) return []

  const out: Candidate[] = []
  for (const [name, value] of Object.entries(mcp)) {
    const entry = asRecord(value)
    if (!entry) continue

    if (entry.type !== "local") {
      out.push(unsupported(name, typeof entry.url === "string" ? "remote" : String(entry.type ?? "unknown")))
      continue
    }

    const { command, args, splitFrom } = readCommand(entry.command)
    if (!command) {
      out.push(empty(name, "no command in the config"))
      continue
    }

    out.push({
      name,
      command,
      args,
      env: expandMap(asRecord(entry.environment)),
      cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : "",
      enabled: entry.enabled !== false,
      splitFrom,
      warnings: [],
      problem: null,
    })
  }
  return out
}

/** The shape Claude Desktop, Claude Code, Cursor and Windsurf agree on. */
function fromMcpServers(raw: unknown): Candidate[] {
  const servers = asRecord(asRecord(raw)?.mcpServers)
  if (!servers) return []

  const out: Candidate[] = []
  for (const [name, value] of Object.entries(servers)) {
    const entry = asRecord(value)
    if (!entry) continue

    const type = typeof entry.type === "string" ? entry.type : ""
    if (entry.url !== undefined || type === "http" || type === "sse") {
      out.push(unsupported(name, entry.url !== undefined || type ? `${type || "url"} remote` : "remote"))
      continue
    }

    const { command, args, splitFrom } = readCommand(entry.command, entry.args)
    if (!command) {
      out.push(empty(name, "no command in the config"))
      continue
    }

    out.push({
      name,
      command,
      args,
      env: expandMap(asRecord(entry.env)),
      cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : "",
      // Claude Desktop has no switch; some forks use "disabled"
      enabled: entry.disabled !== true && entry.enabled !== false,
      splitFrom,
      warnings: [],
      problem: null,
    })
  }
  return out
}

/** VS Code's mcp.json. */
function fromVscode(raw: unknown): Candidate[] {
  const servers = asRecord(asRecord(raw)?.servers)
  if (!servers) return []

  const out: Candidate[] = []
  for (const [name, value] of Object.entries(servers)) {
    const entry = asRecord(value)
    if (!entry) continue

    const type = typeof entry.type === "string" ? entry.type : "stdio"
    if (type !== "stdio") {
      out.push(unsupported(name, `${type} remote`))
      continue
    }

    const { command, args, splitFrom } = readCommand(entry.command, entry.args)
    if (!command) {
      out.push(empty(name, "no command in the config"))
      continue
    }

    out.push({
      name,
      command,
      args,
      env: expandMap(asRecord(entry.env)),
      cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : "",
      enabled: entry.enabled !== false,
      splitFrom,
      warnings: [],
      problem: null,
    })
  }
  return out
}

type McpSource = { path: string; kind: McpSourceKind }

/** Where other agents keep their servers. Global locations first, then per-workspace ones, so a
 *  project-specific entry wins over a global one of the same name. */
export function importSources(home: string, workspace: string): McpSource[] {
  const windows = process.platform === "win32"
  const mac = process.platform === "darwin"
  const out: McpSource[] = []
  const add = (file: string, kind: McpSourceKind) => out.push({ path: file, kind })

  // opencode uses XDG on every platform
  add(path.join(home, ".config", "opencode", "opencode.json"), "opencode")
  add(path.join(home, ".config", "opencode", "opencode.jsonc"), "opencode")
  if (workspace) {
    add(path.join(workspace, "opencode.json"), "opencode")
    add(path.join(workspace, "opencode.jsonc"), "opencode")
  }

  add(path.join(home, ".claude.json"), "mcpServers")
  add(path.join(home, ".cursor", "mcp.json"), "mcpServers")
  add(path.join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers")
  add(path.join(home, ".vscode", "mcp.json"), "vscode")

  const claudeDesktop = windows
    ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : mac
      ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : path.join(home, ".config", "Claude", "claude_desktop_config.json")
  add(claudeDesktop, "mcpServers")

  if (workspace) {
    add(path.join(workspace, ".cursor", "mcp.json"), "mcpServers")
    add(path.join(workspace, ".vscode", "mcp.json"), "vscode")
    add(path.join(workspace, ".mcp.json"), "mcpServers")
  }

  return out
}

/** Comments, because opencode ships .jsonc and people edit both. A scan rather than a regex, so
 *  a "//" inside a string is left alone. Trailing commas are not handled: a file that has them
 *  fails to parse and is reported, which beats guessing wrong. */
export function stripJsonComments(text: string): string {
  let out = ""
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (lineComment) {
      if (char === "\n") {
        lineComment = false
        out += char
      }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    out += char
  }

  return out
}

function readConfig(file: string): unknown {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return undefined // not having that file is the normal case
  }

  try {
    return JSON.parse(stripJsonComments(text))
  } catch (error) {
    // do not let a typo in someone else's config look like "nothing to import"
    logger.warn("mcp", "could not parse another agent's config", {
      file,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

export function discoverMcpServers(options: DiscoverOptions = {}): DiscoveredServer[] {
  const home = options.home ?? os.homedir()
  const workspace = options.workspace ?? ""
  const existing = new Set(listMcpServers().map((server) => server.id))
  const seen = new Set<string>()
  const out: DiscoveredServer[] = []

  for (const source of importSources(home, workspace)) {
    const raw = readConfig(source.path)
    if (raw === undefined) continue

    const candidates =
      source.kind === "opencode"
        ? fromOpencode(raw)
        : source.kind === "vscode"
          ? fromVscode(raw)
          : fromMcpServers(raw)

    for (const candidate of candidates) {
      if (seen.has(candidate.name)) continue // an earlier (more global) source wins
      seen.add(candidate.name)
      const id = serverIDFromName(candidate.name)
      out.push({
        ...candidate,
        warnings: [
          ...candidate.warnings,
          ...definitionWarnings({ command: candidate.command, args: candidate.args, env: candidate.env }),
        ],
        from: source.path,
        kind: source.kind,
        imported: id ? existing.has(id) : false,
      })
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Deterministic, so importing twice updates instead of duplicating. */
function importID(name: string): string {
  const slug = serverIDFromName(name)
  if (slug) return slug
  return `mcp-${createHash("sha1").update(name).digest("hex").slice(0, 8)}`
}

export function importMcpServers(
  options: DiscoverOptions & { names?: string[] } = {},
): { imported: string[]; skipped: { name: string; reason: string }[] } {
  const wanted = options.names && options.names.length > 0 ? new Set(options.names) : null
  const imported: string[] = []
  const skipped: { name: string; reason: string }[] = []

  for (const server of discoverMcpServers(options)) {
    if (!wanted || wanted.has(server.name)) {
      if (server.problem) {
        skipped.push({ name: server.name, reason: server.problem })
        continue
      }

      const input: McpServerInput = {
        id: importID(server.name),
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        enabled: server.enabled,
        // no acknowledge on purpose: importing is not approving
      }
      upsertMcpServer(input)
      imported.push(server.name)
    }
  }

  if (imported.length > 0) logger.info("mcp", "imported servers", { count: imported.length })
  return { imported, skipped }
}
