import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { LogLevel } from "../../shared/protocol"

const envFiles = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env"),
  fileURLToPath(new URL("../../.env", import.meta.url)),
]

const envFile = envFiles.find((file) => existsSync(file))
if (envFile) {
  try {
    // .env is a fallback, not an override: anything already set in the real
    // environment must win. Node's loadEnvFile assigns unconditionally, so snapshot
    // and restore whatever the process was actually launched with.
    const inherited = { ...process.env }
    process.loadEnvFile(envFile)

    for (const [key, value] of Object.entries(inherited)) {
      if (value !== undefined) process.env[key] = value
    }
  } catch {
    console.warn(`[goto] failed to load ${envFile}`)
  }
}

const env = process.env

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(text(value, ""))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const normalized = text(value, "").toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return fallback
}

function level(value: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = text(value, "").toLowerCase()
  return (["debug", "info", "warn", "error"] as const).includes(normalized as LogLevel)
    ? (normalized as LogLevel)
    : fallback
}

export const config = {
  port: num(env.PORT, 8787),
  // Loopback by default. Binding anything else used to mean "the whole API - including a
  // permission-gated bash tool and the folder/file browser - is reachable from anywhere on
  // the LAN with no credentials at all". That is still the default posture, but the moment a
  // non-loopback address is bound the two-seat token layer in access.ts switches on, because
  // passing no hostname to node's listen() binds every interface.
  host: text(env.HOST, "127.0.0.1"),
  // Tri-state. Unset derives the answer from the bind address (which is the normal case);
  // "on" forces the token layer even on loopback, which is what the tests use. There is no
  // "off": binding a public interface without credentials is a full unauthenticated remote
  // shell, and that combination must not be reachable by setting an environment variable.
  shareAuth: text(env.SHARE_AUTH, ""),
  permissionTools: text(env.PERMISSION_TOOLS, "bash")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  maxSteps: num(env.MAX_STEPS, 40),
  bashTimeoutMs: num(env.BASH_TIMEOUT_MS, 120_000),
  contextWindow: num(env.CONTEXT_WINDOW, 128_000),
  contextInputLimit: num(env.CONTEXT_INPUT_LIMIT, 0),
  maxOutputTokens: num(env.MAX_OUTPUT_TOKENS, 4096),
  compactionAuto: bool(env.COMPACTION_AUTO, true),
  compactionReserved: num(env.COMPACTION_RESERVED, 0),
  compactionPrune: bool(env.COMPACTION_PRUNE, true),
  preserveRecentTokens: num(env.PRESERVE_RECENT_TOKENS, 0),
  tailTurns: num(env.TAIL_TURNS, 0),
  // These were ported from opencode verbatim, where they suit a 200k window. Here the
  // default window is 128k (108k usable), so 40k of protected tool output plus a 20k
  // minimum free meant tool output had to reach ~60k tokens - 55% of the budget - before
  // anything was reclaimed. Measured on a real session: 147k chars (~37k tokens) of tool
  // output never crossed the threshold, so prune never fired once. Keep the newest ~12k
  // tokens (roughly four large reads) live and reclaim past that.
  pruneMinimum: num(env.PRUNE_MINIMUM, 6_000),
  pruneProtect: num(env.PRUNE_PROTECT, 12_000),
  pruneProtectedTools: text(env.PRUNE_PROTECTED_TOOLS, "skill")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  memoryMaxTokens: num(env.MEMORY_MAX_TOKENS, 2000),
  hypothesisTtlTurns: num(env.HYPOTHESIS_TTL_TURNS, 20),

  // MCP tool definitions are injected into every request, so the total is capped: a server
  // that exposes 50 tools would otherwise cost thousands of tokens before the user types
  // anything.
  mcpMaxTools: num(env.MCP_MAX_TOOLS, 32),
  // per JSON-RPC request, so a wedged server cannot hang a turn forever
  mcpTimeoutMs: num(env.MCP_TIMEOUT_MS, 30_000),

  // a conversation must live in a folder; this caps how many fit in one
  maxSessionsPerFolder: num(env.MAX_SESSIONS_PER_FOLDER, 50),

  // the note file is unbounded, but only this much is injected per prompt
  noteInjectTokens: num(env.NOTE_INJECT_TOKENS, 5000),

  // multimodal. VISION=false keeps attachments but replaces them with a text
  // placeholder in the request, for models that reject image content parts.
  vision: bool(env.VISION, true),
  maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
  maxAttachments: num(env.MAX_ATTACHMENTS, 6),
  summarizeModel: text(env.SUMMARIZE_MODEL, ""),

  logLevel: level(env.LOG_LEVEL, "info"),
  logMaxBytes: num(env.LOG_MAX_BYTES, 5 * 1024 * 1024),
  logKeepFiles: num(env.LOG_KEEP_FILES, 3),
  logBufferSize: num(env.LOG_BUFFER_SIZE, 2000),
  logHttp: bool(env.LOG_HTTP, true),
  logLlmPayload: bool(env.LOG_LLM_PAYLOAD, false),
  logToolOutput: bool(env.LOG_TOOL_OUTPUT, false),

  openBrowser: bool(env.OPEN_BROWSER, false),
  // networking is off by default: the README's first promise is that this app does not talk
  // to anything except the model endpoint you configured
  webFetch: bool(env.WEB_FETCH, false),
  envDefaults: {
    apiKey: text(env.OPENAI_API_KEY, ""),
    baseURL: text(env.OPENAI_BASE_URL, "https://api.openai.com/v1"),
    model: text(env.MODEL, "gpt-4o-mini"),
    workspace: text(env.WORKSPACE_DIR, ""),
  },
}

export const dataFile = fileURLToPath(new URL("../../.data/settings.json", import.meta.url))
