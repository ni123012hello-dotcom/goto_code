// MCP stdio transport.
//
// JSON-RPC 2.0, one JSON object per line, over a spawned child process' stdin/stdout. The
// subset we need is small - initialize, notifications/initialized, tools/list, tools/call -
// so it is hand-written rather than pulled in as a dependency (AGENTS.md §6).
//
// The safety notes matter more than the protocol:
//
//  - No shell. The configured command is resolved to a real file first. The one exception is
//    Windows .cmd/.bat, which CreateProcess cannot execute directly; those go through
//    cmd.exe /d /s /c with each token quoted by quoteForCommandLine, which refuses the
//    characters that could break out of the quoting. Model-supplied tool arguments never
//    reach this path at all - they travel as JSON over stdin.
//  - A wedged server cannot hang a turn: every request has a timeout.
//  - A server that dies is reported. Reconnecting is rate-limited so a crashing server cannot
//    turn into a spawn loop.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { dataFile, config } from "./config"
import { logger } from "./log"
import { runnableMcpServers, mcpToolName, type McpServer } from "./mcp"

export type McpTool = {
  /** server id */
  server: string
  /** the name the server knows it by */
  name: string
  /** the name the model sees: mcp__<server>__<tool> */
  fullName: string
  description: string
  inputSchema: Record<string, unknown>
}

export type McpServerStatus = {
  id: string
  name: string
  status: "disabled" | "starting" | "ready" | "failed"
  tools: number
  error?: string
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Connection = {
  server: McpServer
  child: ChildProcessWithoutNullStreams
  pending: Map<number, Pending>
  nextId: number
  buffer: string
  tools: McpTool[]
  status: "starting" | "ready" | "failed"
  error?: string
  lastAttemptAt: number
}

const PROTOCOL_VERSION = "2024-11-05"
const CLIENT_INFO = { name: "goto", version: "0.0.1" }
const RESTART_COOLDOWN_MS = 10_000

const connections = new Map<string, Connection>()

/** <goto root> - .data/settings.json sits one level down from it. */
function gotoRoot(): string {
  return path.resolve(path.dirname(dataFile), "..")
}

function serverCwd(server: McpServer): string {
  if (!server.cwd) return gotoRoot()
  return path.isAbsolute(server.cwd) ? server.cwd : path.resolve(gotoRoot(), server.cwd)
}

/** Characters that would break out of the quoting we apply for cmd.exe. They are refused
 *  rather than escaped: a command line we cannot quote predictably should not run, and the
 *  fix (rename the argument) belongs to the user. */
const UNSAFE_IN_CMD = /["%\0\r\n]/

function quoteForCommandLine(value: string): string {
  if (UNSAFE_IN_CMD.test(value)) {
    throw new Error(`this argument cannot be passed safely through cmd.exe: ${JSON.stringify(value)}`)
  }
  return `"${value}"`
}

type ResolvedCommand = { file: string; needsCmd: boolean }

const resolved = new Map<string, ResolvedCommand>()

/** Turn a configured command into an absolute file we are willing to execute.
 *  Fixed arguments only, no shell: `where.exe`/`which` are real programs. */
export function resolveCommand(command: string): ResolvedCommand {
  const cached = resolved.get(command)
  if (cached) return cached

  const direct = path.isAbsolute(command) && path.extname(command) ? command : null
  let found = direct

  if (!found) {
    const probe =
      process.platform === "win32"
        ? spawnSync("where.exe", [command], { encoding: "utf8" })
        : spawnSync("which", [command], { encoding: "utf8" })

    const lines = String(probe.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    // `where` lists an extensionless stub first, which is not executable; prefer a real one
    const rank = (file: string) => (/\.exe$/i.test(file) ? 0 : /\.cmd$/i.test(file) ? 1 : /\.bat$/i.test(file) ? 2 : 3)
    found = lines.sort((a, b) => rank(a) - rank(b))[0] ?? null
  }

  if (!found) throw new Error(`command not found: ${command}`)

  const result = { file: found, needsCmd: /\.(cmd|bat)$/i.test(found) }
  resolved.set(command, result)
  return result
}

function feed(connection: Connection, chunk: string): void {
  connection.buffer += chunk

  // stdio framing is newline-delimited JSON: a message never contains a raw newline
  let index = connection.buffer.indexOf("\n")
  while (index !== -1) {
    const line = connection.buffer.slice(0, index).trim()
    connection.buffer = connection.buffer.slice(index + 1)
    if (line) handleLine(connection, line)
    index = connection.buffer.indexOf("\n")
  }
}

function send(connection: Connection, message: Record<string, unknown>): void {
  connection.child.stdin.write(`${JSON.stringify(message)}\n`)
}

function handleLine(connection: Connection, line: string): void {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line) as Record<string, unknown>
  } catch {
    logger.warn("mcp", "ignored a non-JSON line", { server: connection.server.id, chars: line.length })
    return
  }

  const id = typeof message.id === "number" ? message.id : null

  if (id !== null && ("result" in message || "error" in message)) {
    const pending = connection.pending.get(id)
    if (!pending) return
    connection.pending.delete(id)
    clearTimeout(pending.timer)

    if (message.error) {
      const error = message.error as { message?: string; code?: number }
      pending.reject(new Error(error.message ?? `MCP error ${error.code ?? "unknown"}`))
    } else {
      pending.resolve(message.result)
    }
    return
  }

  // server -> client. We advertise no capabilities, so the only correct answer to a request
  // is "unsupported"; notifications are ignored.
  if (typeof message.method === "string" && id !== null) {
    send(connection, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not supported" } })
  }
}

function request(connection: Connection, method: string, params: unknown, timeoutMs = config.mcpTimeoutMs): Promise<unknown> {
  const id = (connection.nextId += 1)
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id)
      reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`))
    }, timeoutMs)

    connection.pending.set(id, { resolve, reject, timer })
    try {
      send(connection, { jsonrpc: "2.0", id, method, params })
    } catch (error) {
      clearTimeout(timer)
      connection.pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function fail(connection: Connection, reason: string): void {
  connection.status = "failed"
  connection.error = reason
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error(`MCP server ${connection.server.id} stopped: ${reason}`))
  }
  connection.pending.clear()
  try {
    connection.child.kill()
  } catch {
    // already gone
  }
}

async function discoverTools(connection: Connection): Promise<McpTool[]> {
  const allow = new Set(connection.server.tools)
  const tools: McpTool[] = []
  let cursor: string | undefined

  // tools/list is paginated; a server with many tools decides the page size
  for (let page = 0; page < 50; page += 1) {
    const result = (await request(connection, "tools/list", cursor ? { cursor } : {})) as {
      tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[]
      nextCursor?: unknown
    }

    for (const entry of result?.tools ?? []) {
      const name = typeof entry.name === "string" ? entry.name : ""
      if (!name) continue
      if (allow.size > 0 && !allow.has(name)) continue
      tools.push({
        server: connection.server.id,
        name,
        fullName: mcpToolName(connection.server.id, name),
        description: typeof entry.description === "string" ? entry.description : "",
        inputSchema:
          entry.inputSchema && typeof entry.inputSchema === "object"
            ? (entry.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      })
    }

    cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined
    if (!cursor) break
  }

  return tools
}

async function connect(server: McpServer): Promise<Connection> {
  const { file, needsCmd } = resolveCommand(server.command)
  const cwd = serverCwd(server)
  const env = { ...process.env, ...server.env }

  let child: ChildProcessWithoutNullStreams
  if (needsCmd) {
    // cmd.exe is the only way to run a .cmd/.bat. windowsVerbatimArguments keeps Node from
    // re-quoting our payload; quoteForCommandLine has already refused anything unsafe. The
    // doubled outer quotes are the documented /s idiom.
    const payload = `"${[file, ...server.args].map(quoteForCommandLine).join(" ")}"`
    child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", payload], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: true,
    })
  } else {
    child = spawn(file, server.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  }

  const connection: Connection = {
    server,
    child,
    pending: new Map(),
    nextId: 0,
    buffer: "",
    tools: [],
    status: "starting",
    lastAttemptAt: Date.now(),
  }

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => feed(connection, chunk))
  // stderr is the server's own logging; keep it out of the conversation but leave a trace
  child.stderr.on("data", (chunk: string) => {
    const text = chunk.trim()
    if (text) logger.debug("mcp", "server stderr", { server: server.id, text: text.slice(0, 400) })
  })
  child.on("error", (error) => fail(connection, error.message))
  child.on("exit", (code, signal) => {
    if (connection.status !== "failed") fail(connection, `exited (code ${code ?? "null"}, signal ${signal ?? "none"})`)
  })

  connections.set(server.id, connection)

  try {
    await request(connection, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    send(connection, { jsonrpc: "2.0", method: "notifications/initialized" })
    connection.tools = await discoverTools(connection)
    connection.status = "ready"
    logger.info("mcp", "server ready", { server: server.id, tools: connection.tools.length })
  } catch (error) {
    fail(connection, error instanceof Error ? error.message : String(error))
  }

  return connection
}

/** Start every server the user has confirmed. Errors are per server and do not stop the rest. */
export async function startMcpServers(): Promise<McpServerStatus[]> {
  const servers = runnableMcpServers()
  if (servers.length === 0) return []

  await Promise.all(servers.map((server) => connect(server).catch(() => undefined)))
  return mcpStatus()
}

export function stopMcpServers(): void {
  for (const connection of connections.values()) {
    // closing stdin is how the spec says a server should be told to go away; it matters most
    // on Windows, where a .cmd wrapper's child would otherwise outlive the wrapper we kill
    try {
      connection.child.stdin.end()
    } catch {
      // already closed
    }
    try {
      connection.child.kill()
    } catch {
      // already gone
    }
  }
  connections.clear()
}

/** Config changed, so every running server is restarted against the new definitions. Restarting
 *  all of them rather than diffing is deliberate: it is one predictable rule, and a server that
 *  is never restarted against its own definition is exactly how a stale process lingers. */
export async function reloadMcpServers(): Promise<McpServerStatus[]> {
  stopMcpServers()
  return startMcpServers()
}

async function ensure(serverID: string): Promise<Connection> {
  const existing = connections.get(serverID)
  if (existing?.status === "ready") return existing

  // rate-limited restart: a server that crashes on startup must not be respawned per call
  if (existing && Date.now() - existing.lastAttemptAt < RESTART_COOLDOWN_MS) {
    throw new Error(`MCP server ${serverID} is not running: ${existing.error ?? "unknown error"}`)
  }

  const server = runnableMcpServers().find((entry) => entry.id === serverID)
  if (!server) throw new Error(`MCP server ${serverID} is not enabled and confirmed`)

  const connection = await connect(server)
  if (connection.status !== "ready") {
    throw new Error(`MCP server ${serverID} failed to start: ${connection.error ?? "unknown error"}`)
  }
  return connection
}

/** Every tool currently offered, capped so the definitions cannot eat the context window. */
export function mcpTools(): McpTool[] {
  const all: McpTool[] = []
  for (const connection of connections.values()) {
    if (connection.status === "ready") all.push(...connection.tools)
  }
  all.sort((a, b) => a.fullName.localeCompare(b.fullName))

  if (all.length <= config.mcpMaxTools) return all

  const kept = all.slice(0, config.mcpMaxTools)
  logger.warn("mcp", "tool limit reached: the rest are hidden from the model", {
    total: all.length,
    kept: kept.length,
    limit: config.mcpMaxTools,
  })
  return kept
}

/** Call a tool by its full (prefixed) name. Returns the text the model should see. */
export async function callMcpTool(fullName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = mcpTools().find((entry) => entry.fullName === fullName)
  if (!tool) throw new Error(`Unknown MCP tool: ${fullName}`)

  const connection = await ensure(tool.server)
  const result = (await request(connection, "tools/call", { name: tool.name, arguments: args })) as {
    content?: { type?: string; text?: string; mimeType?: string }[]
    structuredContent?: unknown
    isError?: unknown
  }

  const parts = (result?.content ?? [])
    .map((block) => {
      if (block?.type === "text" && typeof block.text === "string") return block.text
      // images and resources are not carried into the conversation yet: say so instead of
      // pretending the result was empty
      if (block?.type) return `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""} content is not shown]`
      return ""
    })
    .filter(Boolean)

  if (parts.length === 0 && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2))
  }

  const text = parts.join("\n\n") || "(empty result)"
  return { text, isError: result?.isError === true }
}

export function mcpStatus(): McpServerStatus[] {
  return runnableMcpServers().map((server) => {
    const connection = connections.get(server.id)
    return {
      id: server.id,
      name: server.name,
      status: connection ? connection.status : "disabled",
      tools: connection?.tools.length ?? 0,
      error: connection?.error,
    }
  })
}
