import fs from "node:fs"
import path from "node:path"
import type { LogEntry, LogLevel } from "../../shared/protocol"
import { config, dataFile } from "./config"

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/\b(gh[pousr]_[A-Za-z0-9]{10,})/g, "***"],
  [/((?:api[_-]?key|token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, "$1***"],
]

const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization|credential)/i

const MAX_STRING = 400
const MAX_ITEMS = 50
const MAX_DEPTH = 4

const logDir = path.join(path.dirname(dataFile), "logs")
const logFile = path.join(logDir, "goto.jsonl")

const buffer: LogEntry[] = []
const subscribers = new Set<(entry: LogEntry) => void>()

let sequence = 0
let bytesWritten = 0

try {
  bytesWritten = fs.statSync(logFile).size
} catch {
  bytesWritten = 0
}

function clip(value: string): string {
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}... [+${value.length - MAX_STRING}]`
}

function redactString(value: string): string {
  let out = value
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return clip(out)
}

function redactValue(value: unknown, keyHint: string | undefined, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[deep]"
  if (value === null || value === undefined) return value

  if (typeof value === "string") {
    if (keyHint && SECRET_KEY.test(keyHint)) return "***"
    return redactString(value)
  }

  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return "[fn]"

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack?.split("\n").slice(0, 6).join("\n"),
    }
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => redactValue(item, undefined, depth + 1))
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (count >= MAX_ITEMS) break
      count += 1
      out[key] = redactValue(inner, key, depth + 1)
    }
    return out
  }

  return String(value)
}

function rotate(): void {
  try {
    for (let index = config.logKeepFiles - 1; index >= 1; index -= 1) {
      const from = index === 1 ? logFile : `${logFile}.${index - 1}`
      const to = `${logFile}.${index}`
      if (fs.existsSync(from)) fs.renameSync(from, to)
    }
  } catch {
    return
  }
  bytesWritten = 0
}

function persist(entry: LogEntry): void {
  try {
    fs.mkdirSync(logDir, { recursive: true })
    if (bytesWritten >= config.logMaxBytes) rotate()
    const line = `${JSON.stringify(entry)}\n`
    fs.appendFileSync(logFile, line, "utf8")
    bytesWritten += Buffer.byteLength(line)
  } catch {
    return
  }
}

export function log(
  level: LogLevel,
  scope: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (RANK[level] < RANK[config.logLevel]) return

  sequence += 1
  const entry: LogEntry = {
    seq: sequence,
    ts: Date.now(),
    level,
    scope,
    message: clip(message),
  }
  if (data) entry.data = redactValue(data, undefined, 0) as Record<string, unknown>

  buffer.push(entry)
  if (buffer.length > config.logBufferSize) buffer.shift()

  persist(entry)

  for (const fn of subscribers) {
    try {
      fn(entry)
    } catch {
      subscribers.delete(fn)
    }
  }
}

export const logger = {
  debug: (scope: string, message: string, data?: Record<string, unknown>) => log("debug", scope, message, data),
  info: (scope: string, message: string, data?: Record<string, unknown>) => log("info", scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) => log("warn", scope, message, data),
  error: (scope: string, message: string, data?: Record<string, unknown>) => log("error", scope, message, data),
}

export function subscribeLogs(fn: (entry: LogEntry) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function recentLogs(limit: number): LogEntry[] {
  return limit >= buffer.length ? [...buffer] : buffer.slice(-limit)
}

export function logFiles(): { file: string; maxBytes: number; keepFiles: number } {
  return { file: logFile, maxBytes: config.logMaxBytes, keepFiles: config.logKeepFiles }
}

export function bytes(value: string | undefined): number {
  return value ? Buffer.byteLength(value, "utf8") : 0
}
