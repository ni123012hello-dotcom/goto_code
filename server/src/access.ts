import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Context } from "hono"
import type { Seat } from "../../shared/protocol"
import { config, dataFile } from "./config"
import { logger } from "./log"

export type { Seat }

/** What a route needs before it will run. */
export type Requirement = "open" | "review" | "control"

const accessFile = path.join(path.dirname(dataFile), "access.json")

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""])

type AccessFile = {
  version: 1
  control: string
  review: string
  createdAt: number
}

/** Whether the token layer is active.
 *
 *  The decision is the *bind address*, never the source address. A reverse proxy running on
 *  the host would make every remote request arrive from 127.0.0.1, so "loopback means trusted"
 *  would quietly hand full control to whoever the proxy serves. Binding loopback (the default)
 *  keeps goto a single-user tool with no credentials at all; binding anything else turns the
 *  tokens on for everybody, including the host's own browser. */
export function authRequired(): boolean {
  if (config.shareAuth === "on") return true
  return !LOOPBACK_HOSTS.has(config.host.trim().toLowerCase())
}

function randomToken(): string {
  return randomBytes(24).toString("base64url")
}

function usable(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16
}

/** Falls back to null on anything unexpected - a truncated or hand-edited file is treated as
 *  absent rather than trusted, so a partial write can never leave a predictable token live. */
function readAccessFile(): AccessFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(accessFile, "utf8")) as Partial<AccessFile>
    if (!usable(raw.control) || !usable(raw.review)) return null
    return {
      version: 1,
      control: raw.control,
      review: raw.review,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    }
  } catch {
    return null
  }
}

function persistAccessFile(tokens: AccessFile): void {
  fs.mkdirSync(path.dirname(accessFile), { recursive: true })
  fs.writeFileSync(accessFile, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}

let cached: AccessFile | null = null

/** Loaded lazily and only when the token layer is on, so a single-user install never grows a
 *  credentials file it has no use for. */
export function accessTokens(): AccessFile {
  if (cached) return cached

  const existing = readAccessFile()
  if (existing) {
    cached = existing
    return cached
  }

  const fresh: AccessFile = { version: 1, control: randomToken(), review: randomToken(), createdAt: Date.now() }
  persistAccessFile(fresh)
  cached = fresh
  // the tokens themselves must never reach a log - only the fact that they were created
  logger.info("access", "generated seat tokens", { file: accessFile })
  return cached
}

/** Mint a new token for one seat or both. Rotating the review token is the usual thing: that
 *  is the link that gets handed around, so it is the one that leaks. */
export function rotateAccess(scope: Seat | "both"): AccessFile {
  const current = accessTokens()
  const next: AccessFile = {
    version: 1,
    control: scope === "review" ? current.control : randomToken(),
    review: scope === "control" ? current.review : randomToken(),
    createdAt: Date.now(),
  }
  persistAccessFile(next)
  cached = next
  logger.info("access", "rotated tokens", { scope })
  return next
}

/** Constant-time compare. The length guard is required: timingSafeEqual throws on a mismatch,
 *  and the length of a token is not the secret. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function seatForToken(provided: string | undefined): Seat | null {
  if (!provided) return null
  const { control, review } = accessTokens()
  if (tokenMatches(provided, control)) return "control"
  if (tokenMatches(provided, review)) return "review"
  return null
}

/** Hono's `c.req.path` is the pathname without the query string, and the HTTP logging
 *  middleware uses the same accessor - so a token passed as `?t=` is never written to the log. */
export function seatFrom(c: Context): Seat | null {
  if (!authRequired()) return "control"
  return seatForToken(c.req.header("x-goto-token") ?? c.req.query("t"))
}

export function seatOf(c: Context): Seat | null {
  const seat = c.get("seat") as Seat | null | undefined
  return seat ?? null
}

/** Every route the server registers, and the seat it requires.
 *
 *  Deliberately exhaustive instead of a list of "the privileged ones". A route missing from
 *  here is a route nobody made a decision about, and the boot check in assertRoutesClassified
 *  refuses to start until it is added - which is the same reason PLAN_MODE_TOOLS is a
 *  whitelist. Keys are "<METHOD> <hono pattern>", i.e. exactly what GET /api/version reports,
 *  so the table and the running app can be diffed against each other.
 *
 *  Review-accessible routes that name a conversation are *additionally* filtered by
 *  visibleSession() - being on this list only says the route is not control-only. */
const ROUTE_SEATS: Record<string, Requirement> = {
  // The SPA shell and these two are reachable without a token: the client cannot present one
  // until it has loaded, and "who am I" has to answer even when the answer is "nobody".
  "GET /api/version": "open",
  "GET /api/me": "open",

  // Read-only surface. A reviewer needs the transcript, what the agent touched, and the code.
  "GET /api/sessions": "review",
  "GET /api/sessions/:id": "review",
  "GET /api/sessions/:id/events": "review",
  "GET /api/tree": "review",
  "GET /api/workspace/file": "review",
  "GET /api/files/:fileID": "review",
  "GET /api/notes": "review",
  "GET /api/notes/export": "review",
  "GET /api/memory": "review",
  "GET /api/commands": "review",
  "GET /api/context": "review",

  // Everything that drives the agent, changes a setting, or writes to disk.
  "GET /api/logs": "control",
  "GET /api/logs/stream": "control",
  "GET /api/settings": "control",
  "PUT /api/settings": "control",
  "POST /api/settings/test": "control",
  "PUT /api/memory": "control",
  "POST /api/memory/decide": "control",
  "POST /api/files": "control",
  "GET /api/skills": "control",
  "GET /api/skills/:name": "control",
  "GET /api/folders": "control",
  "POST /api/folders": "control",
  "PATCH /api/folders/:id": "control",
  "DELETE /api/folders/:id": "control",
  "POST /api/sessions": "control",
  "POST /api/sessions/:id/folder": "control",
  "PUT /api/notes": "control",
  "POST /api/workspace/upload": "control",
  "POST /api/sessions/:id/prompt": "control",
  "DELETE /api/sessions/:id": "control",
  "POST /api/sessions/:id/access": "control",
  "POST /api/sessions/:id/mode": "control",
  "POST /api/sessions/:id/rewind": "control",
  "POST /api/sessions/:id/model": "control",
  "POST /api/sessions/:id/abort": "control",
  "POST /api/sessions/:id/share": "control",
  "GET /api/models": "control",
  "GET /api/providers": "control",
  "PUT /api/providers": "control",
  "DELETE /api/providers/:id": "control",
  "POST /api/providers/:id/activate": "control",
  "GET /api/mcp": "control",
  "GET /api/mcp/discover": "control",
  "POST /api/mcp/import": "control",
  "PUT /api/mcp": "control",
  "DELETE /api/mcp/:id": "control",
  "GET /api/model-limits": "control",
  "PUT /api/model-limits": "control",
  "POST /api/spawns/:id": "control",
  "POST /api/questions/:id": "control",
  "POST /api/permissions/:id": "control",
  "GET /api/share": "control",
  "POST /api/share/rotate": "control",
}

/** `:param` is the only placeholder this codebase uses. Anything else is escaped literally,
 *  so a pattern cannot accidentally match more than it was written to. */
function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => (/^:/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/")
  return new RegExp(`^${source}$`)
}

// Sorted by privilege so a broad "control" pattern can never shadow a narrow "open" one.
const PRECEDENCE: Requirement[] = ["open", "review", "control"]

const MATCHERS = PRECEDENCE.flatMap((requirement) =>
  Object.entries(ROUTE_SEATS)
    .filter(([, declared]) => declared === requirement)
    .map(([key]) => {
      const space = key.indexOf(" ")
      return { method: key.slice(0, space), pattern: patternToRegExp(key.slice(space + 1)), requirement }
    }),
)

export function requirementFor(method: string, pathname: string): Requirement {
  // The SPA bundle carries no secrets, and the client cannot present a token until it has
  // loaded. Everything under /api/ is decided by the table.
  if (!pathname.startsWith("/api/")) return "open"

  for (const entry of MATCHERS) {
    if (entry.method === method && entry.pattern.test(pathname)) return entry.requirement
  }

  // Fail closed. An unclassified endpoint gets the most privileged requirement, so forgetting
  // to add a route here can only ever lock the review seat out, never let it in.
  return "control"
}

/** Boot check. Both directions matter: a registered route that is missing from the table means
 *  somebody added an endpoint without deciding who may call it, and a table entry with no
 *  matching route means a typo - which would silently make the real route control-only and
 *  break the review seat with a 403 nobody can explain from the code. */
export function assertRoutesClassified(routes: { method: string; path: string }[]): void {
  const declared = new Set(Object.keys(ROUTE_SEATS))
  const registered = new Set(
    routes
      // "ALL" is app.use (middleware), and the "*" catch-all serves index.html - it is not an
      // API route at all, so it never reaches requirementFor's table lookup.
      .filter((route) => route.method !== "ALL" && !route.path.includes("*"))
      .map((route) => `${route.method} ${route.path}`),
  )

  const missing = [...registered].filter((key) => !declared.has(key))
  const stale = [...declared].filter((key) => !registered.has(key))
  if (missing.length === 0 && stale.length === 0) return

  const detail = [
    missing.length ? `未分类（新增路由必须加进 access.ts 的 ROUTE_SEATS）: ${missing.join(", ")}` : "",
    stale.length ? `表里有但服务端没注册（多半是打错了）: ${stale.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("；")

  throw new Error(`[access] 路由分类表与已注册路由不一致 - ${detail}`)
}

/** The address a guest should be told to use. When the bind is a wildcard, pick the first
 *  non-internal IPv4 so the printed link is actually reachable from the other machine. */
export function lanAddress(): string {
  const configured = config.host.trim()
  if (configured && !WILDCARD_HOSTS.has(configured)) return configured

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address
    }
  }
  return "127.0.0.1"
}

/** The link one seat opens. The token rides in the fragment, which the browser never sends to
 *  the server, so it cannot land in an access log or a referrer header. */
export function shareURL(seat: Seat): string {
  const { control, review } = accessTokens()
  const token = seat === "control" ? control : review
  return `http://${lanAddress()}:${config.port}/#t=${token}`
}

/** The single gate. Registered once, before every route, so there is exactly one place where
 *  a request's seat is decided. */
export function seatMiddleware() {
  return async (c: Context, next: () => Promise<void>) => {
    const requirement = requirementFor(c.req.method, c.req.path)
    const seat = seatFrom(c)

    if (!seat && requirement !== "open") {
      logger.warn("access", "missing seat token", { method: c.req.method, path: c.req.path })
      return c.json({ error: "这个地址需要访问链接，请向布置主机的同学索取带令牌的网址", code: "NO_SEAT" }, 401)
    }

    if (seat === "review" && requirement === "control") {
      logger.warn("access", "review seat denied", { method: c.req.method, path: c.req.path })
      return c.json({ error: "检查席只能查看，不能执行这个操作", code: "READ_ONLY_SEAT" }, 403)
    }

    c.set("seat", seat)
    await next()
  }
}
