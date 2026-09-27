import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import type { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { LogEvent, MeView, NoteView, PermissionResponse, ServerEvent, ShareView } from "../../shared/protocol"
import {
  accessTokens,
  assertRoutesClassified,
  authRequired,
  lanAddress,
  rotateAccess,
  seatMiddleware,
  seatOf,
  shareURL,
} from "./access"
import { previewFile } from "./preview"
import { runTurn } from "./agent/loop"
import { limitsFilePath, listModelLimits, setModelLimits, type ModelLimits } from "./agent/models"
import { probeWorkspace } from "./agent/probe"
import { estimate } from "./agent/tokens"
import {
  activateProvider,
  deleteProvider,
  publicProviders,
  upsertProvider,
  type ProviderInput,
} from "./providers"
import { commandCatalog, recordCommand, runCommand } from "./commands"
import { config } from "./config"
import { fileExists, isImageMime, maxUploadBytes, readFileBytes, sanitizeName, sniffMime, storeFile } from "./files"
import { descendantFolderIDs, createFolder, deleteFolder, ensureDefaultFolder, getFolder, listFolders, updateFolder } from "./folders"
import { logFiles, logger, recentLogs, subscribeLogs } from "./log"
import { deleteMcpServer, listMcpServers, publicMcpServers, upsertMcpServer, type McpServerInput } from "./mcp"
import { discoverMcpServers, importMcpServers } from "./mcp-import"
import { mcpStatus, reloadMcpServers, startMcpServers, stopMcpServers } from "./mcp-client"
import { pendingPermissionFor, resolvePermission } from "./permissions"
import { pendingQuestionFor, resolveQuestion, SKIPPED } from "./questions"
import {
  approveEntry,
  conflictsWith,
  deleteMemoryFile,
  loadMemory,
  memoryFile,
  memoryTokens,
  readMemoryText,
  rejectEntry,
  saveMemoryEntries,
  writeMemoryText,
  type Conflict,
  type MemoryEntryInput,
} from "./memory"
import {
  assignOrphansToFolder,
  countSessionsInFolder,
  createSession,
    deleteSession,
    emit,
    getSession,
  listSessions,
  loadPersistedSessions,
  newMessage,
  newTextPart,
  sessionsInFolders,
  sessionScope,
    setAccessMode,
    setSessionFolder,
    setSessionModel,
    setSessionMode,
    setSessionShared,
    setTitle,
    rewindTo,
    subscribe,
    toInfo,
    type Session,
  } from "./sessions"
  import { loadNote, notesFile, noteTokens, orderSections, readNoteText, renderNoteForPrompt, writeNoteText } from "./notes"
import { contextInfo, getSettings, listModels, maskKey, publicSettings, testConnection, updateSettings, type SettingsPatch } from "./settings"
import { resolveInside, safeRelativePath, toRelative } from "./safety"
import {
  PROMPT_BUDGET_CHARS,
  listSkills,
  readSkill,
  skillLayout,
  skillPromptPlan,
  skillRoots,
} from "./skills"
import { cancelSpawnsFor, pendingSpawnFor, resolveSpawn, spawnCatalog } from "./subagents"
import { listDirectory } from "./tree"

const app = new Hono()
// distinct from the per-request `startedAt` inside the logging middleware below
const bootedAt = Date.now()

app.onError((error, c) => {
  logger.error("http", `${c.req.method} ${c.req.path} failed`, { error })
  return c.json({ error: error.message }, 500)
})

app.use("*", async (c, next) => {
  const path = c.req.path
  if (!config.logHttp || path === "/api/logs/stream" || path.endsWith("/events")) return next()

  const startedAt = Date.now()
  await next()
  logger.info("http", `${c.req.method} ${path}`, { status: c.res.status, ms: Date.now() - startedAt })
})

// The single seat gate, before every route. It decides from the request alone, and every route
// is classified in access.ts - so there is exactly one place to look when asking "who may call
// this?". A route nobody classified fails the boot check below rather than defaulting open.
app.use("*", seatMiddleware())

app.get("/api/me", (c) => c.json({ seat: seatOf(c), authRequired: authRequired() } satisfies MeView))

/** The links the control seat hands to the other one. `enabled` is false on a loopback bind,
 *  where there is no token layer at all and therefore nothing to share. */
function shareView(): ShareView {
  const enabled = authRequired()
  return {
    enabled,
    host: lanAddress(),
    controlURL: enabled ? shareURL("control") : "",
    reviewURL: enabled ? shareURL("review") : "",
  }
}

app.get("/api/share", (c) => c.json(shareView()))

app.post("/api/share/rotate", async (c) => {
  if (!authRequired()) {
    return c.json({ error: "局域网共享没有开启：把 HOST 设为 0.0.0.0 并重启 gt 之后才有链接可换" }, 400)
  }

  const body = (await c.req.json().catch(() => ({}))) as { seat?: string }
  // default to the review token: that is the link that gets handed around, so it is the one
  // that leaks. Rotating it must not lock the host out of their own control link.
  const scope = body.seat === "control" || body.seat === "both" ? body.seat : "review"
  rotateAccess(scope)
  return c.json(shareView())
})

app.get("/api/logs", (c) => {
  const requested = Number(c.req.query("limit") ?? 500)
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 500, config.logBufferSize)
  return c.json({ entries: recentLogs(limit), level: config.logLevel, ...logFiles() })
})

app.get("/api/logs/stream", (c) =>
  streamSSE(c, async (stream) => {
    const send = (event: LogEvent) => {
      void stream.writeSSE({ event: "message", data: JSON.stringify(event) })
    }

    const unsubscribe = subscribeLogs((entry) => send({ type: "log.entry", entry }))
    send({ type: "log.snapshot", entries: recentLogs(500) })

    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: String(Date.now()) })
    }, 15_000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve())
    })

    clearInterval(heartbeat)
    unsubscribe()
  }),
)

app.get("/api/settings", (c) => c.json({ ...publicSettings(), ...spawnCatalog() }))

// The web bundle is rebuilt without restarting the server, so a UI can easily be newer
// than the process serving it. That mismatch used to surface as a bare "404 Not Found"
// from whichever endpoint the new UI tried first. This handshake lets the UI say so.
app.get("/api/version", (c) =>
  c.json({
    startedAt: bootedAt,
    pid: process.pid,
    routes: [...new Set(app.routes.map((route) => route.path))].sort(),
  }),
)

app.put("/api/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SettingsPatch
  updateSettings(body)
  return c.json(publicSettings())
})

app.post("/api/settings/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SettingsPatch
  try {
    return c.json(await testConnection(body))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ ok: false, error: message }, 400)
  }
})

// memory is scoped to one conversation, so every memory route is keyed by session
async function memoryView(session: Session) {
  const scope = sessionScope(session)
  const entries = loadMemory(scope)

  let conflicts: Conflict[] = []
  try {
    conflicts = conflictsWith(scope, await probeWorkspace(session.workspace))
  } catch {
    conflicts = []
  }

  return {
    sessionID: session.id,
    path: memoryFile(scope),
    text: readMemoryText(scope),
    tokens: memoryTokens(entries),
    pending: entries.filter((entry) => entry.status === "pending").length,
    ttlTurns: config.hypothesisTtlTurns,
    maxTokens: config.memoryMaxTokens,
    entries,
    conflicts,
  }
}

/** A conversation the caller may actually see.
 *
 *  The review seat only reaches conversations the control seat has shared, plus the sub-agents
 *  of those. Anything else returns undefined, which every caller already turns into the same
 *  404 as a missing id - so a probe cannot even confirm that a private conversation exists. */
function visibleSession(c: Context, id: string | undefined): Session | undefined {
  const session = id ? getSession(id) : undefined
  if (!session) return undefined
  if (seatOf(c) !== "review") return session
  if (session.shared) return session

  // a helper is visible whenever the conversation that spawned it is; it carries no share flag
  // of its own
  return session.parentID && getSession(session.parentID)?.shared ? session : undefined
}

function sessionFor(c: Context, id: string | undefined): Session | undefined {
  return visibleSession(c, id)
}

app.get("/api/memory", async (c) => {
  const session = sessionFor(c, c.req.query("session"))
  if (!session) return c.json({ error: "Session not found" }, 404)
  return c.json(await memoryView(session))
})

app.put("/api/memory", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    session?: string
    text?: string
    entries?: MemoryEntryInput[]
  }

  const session = sessionFor(c, body.session)
  if (!session) return c.json({ error: "Session not found" }, 404)

  const scope = sessionScope(session)
  if (Array.isArray(body.entries)) saveMemoryEntries(scope, body.entries)
  else writeMemoryText(scope, String(body.text ?? ""))

  return c.json(await memoryView(session))
})

app.post("/api/memory/decide", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    session?: string
    id?: string
    decision?: "approve" | "reject"
  }

  const session = sessionFor(c, body.session)
  if (!session) return c.json({ error: "Session not found" }, 404)

  const id = String(body.id ?? "")
  if (!id) return c.json({ error: "Missing id" }, 400)

  const scope = sessionScope(session)
  const ok = body.decision === "reject" ? rejectEntry(scope, id) : Boolean(approveEntry(scope, id))
  if (!ok) return c.json({ error: "Memory entry not found" }, 404)

  return c.json(await memoryView(session))
})

app.post("/api/files", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    mime?: string
    filename?: string
    dataBase64?: string
  }

  const mime = String(body.mime ?? "")
  const encoded = String(body.dataBase64 ?? "")
  if (!encoded) return c.json({ error: "Missing dataBase64" }, 400)
  if (!isImageMime(mime)) return c.json({ error: `Unsupported mime type: ${mime || "(empty)"}` }, 415)

  const data = Buffer.from(encoded, "base64")
  if (data.length === 0) return c.json({ error: "Empty file" }, 400)

  const limit = maxUploadBytes()
  if (data.length > limit) {
    return c.json({ error: `File is ${data.length} bytes, limit is ${limit}` }, 413)
  }

  return c.json(storeFile({ data, mime, filename: String(body.filename ?? "upload") }), 201)
})

app.get("/api/files/:fileID", (c) => {
  const bytes = readFileBytes(c.req.param("fileID"))
  if (!bytes) return c.json({ error: "File not found" }, 404)

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": sniffMime(bytes),
      "cache-control": "private, max-age=31536000, immutable",
    },
  })
})

app.get("/api/tree", (c) => {
  const session = sessionFor(c, c.req.query("session"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  const relative = c.req.query("path") ?? ""
  try {
    const listing = listDirectory(session.workspace, relative, 400)
    return c.json({ path: relative, root: session.workspace, nodes: listing.nodes, truncated: listing.truncated })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

// The read-only viewer, and the review seat's only route to file contents. Confined to the
// session workspace unconditionally - see preview.ts.
app.get("/api/workspace/file", async (c) => {
  const session = sessionFor(c, c.req.query("session"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  const relative = c.req.query("path") ?? ""
  if (!relative) return c.json({ error: "path is required" }, 400)

  const requested = Number(c.req.query("offset") ?? 1)
  try {
    return c.json(await previewFile(session.workspace, relative, Number.isFinite(requested) && requested > 0 ? requested : 1))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

// Skills are read from the session's workspace plus the personal root, so this is
// session-scoped exactly like /api/tree: a conversation can point at another repo.
function skillsWorkspace(c: Context): string {
  return sessionFor(c, c.req.query("session"))?.workspace ?? getSettings().workspace
}

app.get("/api/skills", (c) => {
  const workspace = skillsWorkspace(c)
  const plan = skillPromptPlan(workspace)
  const injected = new Set(plan.injected)

  const list = listSkills(workspace).map((skill) => {
    const found = readSkill(workspace, skill.name)
    const layout = skillLayout(skill.dir)
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      dir: skill.dir,
      // the body is what the agent pays for once it loads the skill, so it is shown, not hidden
      tokens: found ? estimate(found.body) : 0,
      install: layout.install,
      entries: layout.entries,
      injected: injected.has(skill.name),
    }
  })

  return c.json({
    workspace,
    roots: skillRoots(workspace),
    budget: PROMPT_BUDGET_CHARS,
    promptChars: plan.chars,
    list,
  })
})

app.get("/api/skills/:name", (c) => {
  const workspace = skillsWorkspace(c)
  const found = readSkill(workspace, c.req.param("name"))
  if (!found) return c.json({ error: "Skill not found" }, 404)

  return c.json({
    name: found.skill.name,
    description: found.skill.description,
    source: found.skill.source,
    dir: found.skill.dir,
    body: found.body,
  })
})

app.get("/api/folders", (c) => c.json(listFolders()))

app.post("/api/folders", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; parentID?: string | null }

  try {
    return c.json(createFolder({ name: String(body.name ?? ""), parentID: body.parentID ?? null }), 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.patch("/api/folders/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; parentID?: string | null }

  try {
    const updated = updateFolder(c.req.param("id"), body)
    if (!updated) return c.json({ error: "Folder not found" }, 404)
    return c.json(updated)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.delete("/api/folders/:id", (c) => {
  const id = c.req.param("id")
  if (!getFolder(id)) return c.json({ error: "Folder not found" }, 404)

  // deleting a folder takes its whole subtree and every conversation inside with
  // it, so a run in progress must block it - the turn would lose its session mid-flight
  const subtree = descendantFolderIDs(id)
  const affected = sessionsInFolders(new Set(subtree))
  const running = affected.filter((session) => session.running)

  if (running.length > 0) {
    return c.json(
      { error: `有 ${running.length} 个对话正在运行，先停止它们再删` },
      409,
    )
  }

  let deletedSessions = 0
  for (const session of affected) {
    deleteMemoryFile(sessionScope(session))
    if (deleteSession(session.id)) deletedSessions += 1
  }
  for (const folderID of subtree) deleteFolder(folderID)

  logger.info("folder", "deleted with contents", {
    id,
    folders: subtree.length,
    sessions: deletedSessions,
  })

  return c.json({ ok: true, folders: subtree.length, sessions: deletedSessions })
})

app.post("/api/sessions/:id/folder", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { folderID?: string }
  const folderID = String(body.folderID ?? "")

  if (!folderID) return c.json({ error: "folderID is required" }, 400)
  if (!getFolder(folderID)) return c.json({ error: "Folder not found" }, 400)

  const session = getSession(c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  // the cap has to apply on move too, otherwise dragging bypasses it
  if (session.folderID !== folderID && countSessionsInFolder(folderID) >= config.maxSessionsPerFolder) {
    return c.json({ error: `目标文件夹已满（上限 ${config.maxSessionsPerFolder}）` }, 409)
  }

  return c.json(setSessionFolder(c.req.param("id"), folderID))
})

function noteView(session: Session): NoteView {
  const sessionID = session.id
  const { sections, workspace } = loadNote(sessionID)
  const injection = renderNoteForPrompt(sessionID, config.noteInjectTokens, getSettings().workspace)

  return {
    sessionID,
    sessionTitle: session.title,
    path: notesFile(sessionID),
    text: readNoteText(sessionID),
    sections: orderSections(sections),
    workspace,
    tokens: noteTokens(sections),
    budget: config.noteInjectTokens,
    injected: injection.injected,
    omitted: injection.omitted,
    updatedAt: sections.reduce<string | null>(
      (latest, section) =>
        section.updatedAt && (!latest || section.updatedAt > latest) ? section.updatedAt : latest,
      null,
    ),
  }
}

app.get("/api/notes", (c) => {
  const session = sessionFor(c, c.req.query("session"))
  if (!session) return c.json({ error: "Session not found" }, 404)
  return c.json(noteView(session))
})

app.put("/api/notes", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { session?: string; text?: string }
  const session = sessionFor(c, String(body.session ?? ""))
  if (!session) return c.json({ error: "Session not found" }, 404)

  writeNoteText(session.id, String(body.text ?? ""))
  // the note window may be open in another tab, and the note is per conversation
  emit(session, { type: "note.changed", sessionID: session.id })
  return c.json(noteView(session))
})

app.get("/api/notes/export", (c) => {
  const session = sessionFor(c, c.req.query("session"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  // the export carries enough context to be readable once it is detached from the app
  const header = [
    `<!-- 导出时间: ${new Date().toISOString()} -->`,
    `<!-- 对话: ${session.title} (${session.id}) -->`,
    `<!-- 工作区: ${getSettings().workspace} -->`,
    "",
    "",
  ].join("\n")

  return new Response(`${header}${readNoteText(session.id)}`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="note-${session.id.slice(0, 8)}.md"`,
    },
  })
})

// dropping files in from the OS writes straight to disk, so it gets a ceiling that a
// mis-aimed drop of a whole folder cannot blow past
const MAX_DROP_FILES = 50

app.post("/api/workspace/upload", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    session?: string
    dir?: string
    files?: { path?: string; name?: string; dataBase64?: string }[]
  }

  const session = getSession(String(body.session ?? ""))
  if (!session) return c.json({ error: "Session not found" }, 404)

  const offered = Array.isArray(body.files) ? body.files : []
  if (offered.length === 0) return c.json({ error: "files is required" }, 400)
  if (offered.length > MAX_DROP_FILES) {
    return c.json({ error: `一次最多拖入 ${MAX_DROP_FILES} 个文件（收到 ${offered.length}）` }, 400)
  }

  // The target directory comes from our own tree, so anything with ".." or an absolute form
  // means the request did not come from the UI and is rejected outright. Per-file paths are
  // different: they come from the OS drag payload (a dropped folder's structure), so those
  // get sanitised rather than rejected.
  const rawDir = String(body.dir ?? "").trim()
  if (rawDir && (/(^|[\\/])\.\.([\\/]|$)/.test(rawDir) || /^[\\/]/.test(rawDir) || /^[a-zA-Z]:/.test(rawDir))) {
    return c.json({ error: `目标目录不合法：${rawDir}` }, 400)
  }

  const base = safeRelativePath(rawDir)
  let targetDir: string
  try {
    targetDir = resolveInside(session.workspace, base)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }

  try {
    if (!statSync(targetDir).isDirectory()) return c.json({ error: "目标不是目录" }, 400)
  } catch {
    return c.json({ error: "目标目录不存在" }, 400)
  }

  const written: { path: string; bytes: number; renamedFrom?: string }[] = []
  const skipped: { name: string; reason: string }[] = []

  for (const raw of offered) {
    // a dropped folder carries a relative path per file ("proj/src/a.ts"); a plain file
    // just carries its name. Either way every segment is sanitised.
    const label = String(raw?.path ?? raw?.name ?? "")
    const relative = safeRelativePath(label)
    if (!relative) {
      skipped.push({ name: label || "?", reason: "路径无效" })
      continue
    }

    const data = String(raw?.dataBase64 ?? "")
    if (!data) {
      skipped.push({ name: relative, reason: "内容为空" })
      continue
    }

    const bytes = Buffer.from(data, "base64")
    if (bytes.length > maxUploadBytes()) {
      skipped.push({ name: relative, reason: `超过单文件上限 ${Math.round(maxUploadBytes() / 1024 / 1024)}MB` })
      continue
    }

    try {
      // belt and braces on top of safeRelativePath: the resolved path must still be inside
      const absolute = resolveInside(session.workspace, base ? `${base}/${relative}` : relative)
      mkdirSync(path.dirname(absolute), { recursive: true })

      // never clobber an existing file: an accidental drop should not destroy work
      const dir = path.dirname(absolute)
      const ext = path.extname(absolute)
      const stem = path.basename(absolute, ext)
      let finalName = path.basename(absolute)
      let counter = 1
      while (existsSync(path.join(dir, finalName))) {
        counter += 1
        finalName = `${stem} (${counter})${ext}`
      }

      writeFileSync(path.join(dir, finalName), bytes)
      written.push({
        path: toRelative(session.workspace, path.join(dir, finalName)),
        bytes: bytes.length,
        renamedFrom: finalName === path.basename(absolute) ? undefined : path.basename(absolute),
      })
    } catch (error) {
      // one unwritable file (a reserved name, a permission problem) must not fail the batch
      skipped.push({ name: relative, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  logger.info("workspace", "files dropped in", {
    sessionID: session.id,
    dir: String(body.dir ?? ""),
    written: written.length,
    skipped: skipped.length,
  })

  return c.json({ written, skipped })
})

app.get("/api/commands", (c) => c.json(commandCatalog()))

app.get("/api/sessions", (c) => {
  const all = listSessions()
  // The review seat only learns about conversations shared with it, so the list itself cannot
  // leak the control seat's other work. Sub-agents carry no flag: they follow their parent.
  if (seatOf(c) !== "review") return c.json(all)

  const shared = new Set(all.filter((info) => info.shared).map((info) => info.id))
  return c.json(all.filter((info) => shared.has(info.id) || (info.parentID !== undefined && shared.has(info.parentID))))
})

app.post("/api/sessions/:id/share", async (c) => {
  const session = getSession(c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { shared?: boolean }
  const updated = setSessionShared(session.id, body.shared === true)
  if (!updated) return c.json({ error: "Session not found" }, 404)

  // tell the open streams, so the review seat drops the conversation immediately instead of
  // holding a socket that the next reconnect would be refused
  emit(session, { type: "session.info", session: updated })
  return c.json(updated)
})

app.post("/api/sessions", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { workspace?: string; folderID?: string }
  const folderID = String(body.folderID ?? "")

  if (!folderID) {
    return c.json({ error: "folderID is required — a conversation must live in a folder" }, 400)
  }
  if (!getFolder(folderID)) return c.json({ error: "Folder not found" }, 400)

  const used = countSessionsInFolder(folderID)
  if (used >= config.maxSessionsPerFolder) {
    return c.json(
      { error: `文件夹已满（${used}/${config.maxSessionsPerFolder}），先新建一个文件夹再开对话` },
      409,
    )
  }

  const session = createSession(folderID, body.workspace)
  logger.info("session", "created", { sessionID: session.id, workspace: session.workspace, folderID })
  return c.json(toInfo(session), 201)
})

app.get("/api/sessions/:id", (c) => {
  const session = visibleSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)
  return c.json({ session: toInfo(session), messages: session.messages })
})

app.get("/api/sessions/:id/events", (c) => {
  const session = visibleSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  const seat = seatOf(c)
  // a sub-agent carries no share flag of its own; entitlement follows the conversation that
  // spawned it, exactly as it does for the listing and the visibility check
  const gate = session.parentID ? getSession(session.parentID) ?? session : session

  return streamSSE(c, async (stream) => {
    let revoked = false

    const send = (event: ServerEvent) => {
      if (revoked) return
      const written = stream.writeSSE({ event: "message", data: JSON.stringify(event) })

      // The review seat is only entitled to a conversation that is still shared, and nothing
      // else would ever tell it that sharing stopped. Flush the notice first so the client
      // learns why, instead of just seeing the socket die.
      if (seat === "review" && !gate.shared) {
        revoked = true
        void written.then(() => stream.close())
      }
    }

    const unsubscribe = subscribe(session, send)
    // The snapshot carries whatever is still waiting for an answer. Nothing replays those
    // events, so omitting them means a control seat that reloads loses the dialog and the turn
    // blocks until the timeout.
    send({
      type: "snapshot",
      session: toInfo(session),
      messages: session.messages,
      permission: pendingPermissionFor(session.id),
      question: pendingQuestionFor(session.id),
      spawn: pendingSpawnFor(session.id),
    })

    const heartbeat = setInterval(() => {
      if (revoked) return
      void stream.writeSSE({ event: "ping", data: String(Date.now()) })
    }, 15_000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve())
    })

    clearInterval(heartbeat)
    unsubscribe()
  })
})

app.post("/api/sessions/:id/prompt", async (c) => {
  const session = getSession(c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)
  if (session.running) return c.json({ error: "Session is already running" }, 409)

  const body = (await c.req.json().catch(() => ({}))) as {
    text?: string
    model?: string
    files?: { fileID?: string; mime?: string; filename?: string; size?: number }[]
  }
  const text = String(body.text ?? "").trim()

  const offered = Array.isArray(body.files) ? body.files : []
  const attachments = offered.slice(0, config.maxAttachments).flatMap((raw) => {
    const fileID = String(raw?.fileID ?? "")
    if (!fileID || !fileExists(fileID)) return []
    return [
      {
        id: randomUUID(),
        type: "file" as const,
        mime: String(raw.mime ?? "application/octet-stream"),
        filename: sanitizeName(String(raw.filename ?? "file")),
        size: Number(raw.size ?? 0),
        fileID,
      },
    ]
  })

  if (offered.length > attachments.length) {
    logger.warn("session", "dropped attachments", {
      sessionID: session.id,
      offered: offered.length,
      kept: attachments.length,
      limit: config.maxAttachments,
    })
  }

  if (!text && attachments.length === 0) return c.json({ error: "Empty prompt" }, 400)

  // slash commands run locally: no API key required, no model call, so a
  // user-issued /remember can never be transcribed wrong by an LLM
  if (text.startsWith("/") && attachments.length === 0) {
    recordCommand(session, text)
    const result = await runCommand(session, text)
    logger.info("command", "executed", { sessionID: session.id, chars: text.length, result: result.slice(0, 120) })
    return c.json({ ok: true, command: true }, 202)
  }

  if (!getSettings().apiKey) {
    return c.json({ error: "No API key configured", code: "NO_API_KEY" }, 412)
  }

  const user = newMessage(session, "user")
  if (text) newTextPart(user, text)
  user.parts.push(...attachments)
  setTitle(session, text || `（${attachments.length} 张图片）`)
  emit(session, { type: "message.start", message: user })

  // one-shot body.model wins, then the conversation's own choice, then the global default
  void runTurn(session, body.model?.trim() || session.model)
  logger.info("session", "prompt accepted", {
    sessionID: session.id,
    chars: text.length,
    attachments: attachments.length,
    model: body.model,
  })
  logger.debug("session", "prompt text", { sessionID: session.id, text })
  return c.json({ ok: true }, 202)
})

app.delete("/api/sessions/:id", (c) => {
  const session = getSession(c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  // the memory file belongs to the conversation, so it goes with it
  deleteMemoryFile(sessionScope(session))
  // release any spawn prompt still waiting on the user, so the tool call does not hang
  cancelSpawnsFor(session.id)
  deleteSession(session.id)
  return c.json({ ok: true })
})

app.post("/api/sessions/:id/access", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string }
  if (body.mode !== "workspace" && body.mode !== "full") {
    return c.json({ error: 'mode must be "workspace" or "full"' }, 400)
  }

  const updated = setAccessMode(c.req.param("id"), body.mode)
  if (!updated) return c.json({ error: "Session not found" }, 404)
  return c.json(updated)
})

// plan mode is folded into the system prompt on every turn ("mode.changed" is not needed):
// the next request already reflects it. Only the user can switch it - there is no tool for it.
app.post("/api/sessions/:id/mode", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string }
  if (body.mode !== "plan" && body.mode !== "agent") {
    return c.json({ error: 'mode must be "plan" or "agent"' }, 400)
  }

  const updated = setSessionMode(c.req.param("id"), body.mode)
  if (!updated) return c.json({ error: "Session not found" }, 404)
  return c.json(updated)
})

app.post("/api/sessions/:id/rewind", async (c) => {
  const session = getSession(c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { messageID?: string }
  const messageID = String(body.messageID ?? "")
  if (!messageID) return c.json({ error: "messageID is required" }, 400)

  // a turnaround that is still running would keep appending to the range we are about to
  // drop, so stop it and wait for it to release before touching the message list
  session.abort?.abort()
  for (let wait = 0; wait < 40 && session.running; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (session.running) return c.json({ error: "Session is still stopping" }, 409)

  const result = rewindTo(session, messageID)
  if (!result.ok) {
    return c.json(
      { error: result.reason === "not-user" ? "Can only rewind to a user message" : "Message not found" },
      result.reason === "not-user" ? 400 : 404,
    )
  }

  logger.info("session", "rewound", { sessionID: session.id, removed: result.removed })
  return c.json({ ok: true, removed: result.removed })
})

app.get("/api/models", async (c) => {
  const force = c.req.query("refresh") === "1"
  return c.json(await listModels(force))
})

app.post("/api/sessions/:id/model", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { model?: string }
  const updated = setSessionModel(c.req.param("id"), body.model)
  if (!updated) return c.json({ error: "Session not found" }, 404)
  logger.info("session", "model changed", { sessionID: updated.id, model: updated.model ?? "(default)" })
  return c.json(updated)
})

app.get("/api/providers", (c) => c.json(publicProviders()))

app.put("/api/providers", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ProviderInput
  try {
    upsertProvider(body)
    return c.json(publicProviders())
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.delete("/api/providers/:id", (c) => {
  deleteProvider(c.req.param("id"))
  return c.json(publicProviders())
})

app.post("/api/providers/:id/activate", (c) => {
  const provider = activateProvider(c.req.param("id"))
  if (!provider) return c.json({ error: "Provider not found" }, 404)
  // the live settings changed, so hand back the same payload the settings dialog uses
  return c.json(publicSettings())
})

app.get("/api/mcp", (c) => c.json({ ...publicMcpServers(), status: mcpStatus() }))

// Servers already configured for another agent (opencode, Claude, Cursor, VS Code). Read-only:
// the env values are that agent's secrets, so they are masked on the way out.
app.get("/api/mcp/discover", (c) => {
  const servers = discoverMcpServers({ workspace: getSettings().workspace }).map((server) => ({
    ...server,
    env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, maskKey(value)])),
  }))
  return c.json({ servers })
})

app.post("/api/mcp/import", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { names?: unknown }
  const names = Array.isArray(body.names) ? body.names.filter((name): name is string => typeof name === "string") : undefined

  // imported servers arrive unconfirmed, so this cannot start anything by itself; the reload is
  // here so the response reflects any entry whose definition actually changed on disk
  const result = importMcpServers({ workspace: getSettings().workspace, names })
  void reloadMcpServers()
  return c.json({ ...result, ...publicMcpServers(), status: mcpStatus() })
})

app.put("/api/mcp", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as McpServerInput
  const wanted = String(body.id ?? "").trim()
  // an id with no command and no existing entry is a request to update something that is not
  // there - saying "command is required" would send the caller looking in the wrong place
  if (wanted && !body.command && !listMcpServers().some((server) => server.id === wanted)) {
    return c.json({ error: `no such MCP server: ${wanted}` }, 404)
  }
  try {
    upsertMcpServer(body)
  } catch (error) {
    // includes "refusing to confirm a command that cannot work: ..." - the caller is expected to
    // read it and either fix the paths or send force
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
  // the definition (or its confirmation) changed, so running servers are restarted against it
  void reloadMcpServers()
  return c.json({ ...publicMcpServers(), status: mcpStatus() })
})

app.delete("/api/mcp/:id", (c) => {
  deleteMcpServer(c.req.param("id"))
  void reloadMcpServers()
  return c.json({ ...publicMcpServers(), status: mcpStatus() })
})

app.get("/api/context", (c) => c.json(contextInfo(c.req.query("model") ?? "")))

app.get("/api/model-limits", (c) => c.json({ path: limitsFilePath(), limits: listModelLimits() }))

app.put("/api/model-limits", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { model?: string; limits?: ModelLimits }
  const model = String(body.model ?? "").trim()
  if (!model) return c.json({ error: "model is required" }, 400)

  try {
    // clearing all three fields removes the entry, so there is no separate delete route
    // (model ids can contain "/", which a path parameter would not survive)
    const limits = setModelLimits(model, body.limits ?? {})
    logger.info("models", "limits updated", { model, limits: limits[model] ?? null })
    return c.json({ limits })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post("/api/sessions/:id/abort", (c) => {
  const session = getSession(c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)
  session.abort?.abort()
  return c.json({ ok: true })
})

app.post("/api/spawns/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { allowed?: boolean; parallel?: boolean }
  const ok = resolveSpawn(c.req.param("id"), { allowed: body.allowed === true, parallel: body.parallel === true })
  if (!ok) return c.json({ error: "Spawn request not found (already answered or timed out?)" }, 404)
  return c.json({ ok: true })
})

app.post("/api/questions/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { answer?: string; skip?: boolean }
  const answer = body.skip ? SKIPPED : String(body.answer ?? "").trim()
  if (!answer) return c.json({ error: "Empty answer" }, 400)

  if (!resolveQuestion(c.req.param("id"), answer)) {
    return c.json({ error: "Question not found" }, 404)
  }
  return c.json({ ok: true })
})

app.post("/api/permissions/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { response?: PermissionResponse }
  const response = body.response
  if (response !== "once" && response !== "always" && response !== "reject") {
    return c.json({ error: "Invalid response" }, 400)
  }
  return c.json({ ok: resolvePermission(c.req.param("id"), response) })
})

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

const distDir = fileURLToPath(new URL("../../web/dist", import.meta.url))
const indexFile = path.join(distDir, "index.html")
const hasDist = existsSync(indexFile)

if (hasDist) {
  app.use("/*", async (c, next) => {
    if (c.req.method !== "GET" || c.req.path.startsWith("/api/")) return next()

    const relative = decodeURIComponent(c.req.path).replace(/^\/+/, "")
    if (!relative) return next()

    const target = path.resolve(distDir, relative)
    if (!target.startsWith(distDir + path.sep)) return next()

    try {
      if (!statSync(target).isFile()) return next()
    } catch {
      return next()
    }

    const headers: Record<string, string> = {
      "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
    }
    headers["cache-control"] = relative.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache"

    return new Response(new Uint8Array(readFileSync(target)), { status: 200, headers })
  })

  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404)
    // read per request: a rebuild changes the hashed asset names, and a cached copy
    // would keep serving an index.html that points at files which no longer exist
    return c.html(readFileSync(indexFile, "utf8"))
  })
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] }

  try {
    spawn(opener.file, opener.args, { detached: true, stdio: "ignore" }).unref()
  } catch (error) {
    logger.warn("server", "could not open browser", { url, error })
  }
}

const restored = loadPersistedSessions()

// Only servers the user switched on AND confirmed are started (mcp.ts holds the fingerprint
// that binds that confirmation to an exact command line). Fire and forget: a slow or broken
// MCP server must not delay goto's boot.
void startMcpServers().catch((error) => logger.warn("mcp", "startup failed", { error }))

// children do not die with the parent on Windows, so make the kill explicit
process.on("exit", stopMcpServers)

// without an entry page there is nowhere to pick a folder, so the first run
// bootstraps one and adopts every conversation that has no live folder
const bootstrapFolder = ensureDefaultFolder(path.basename(getSettings().workspace) || "默认")
const adopted = assignOrphansToFolder(bootstrapFolder.id, new Set(listFolders().map((folder) => folder.id)))

// Everything is registered by now, so the seat table can be checked against reality. A route
// nobody classified would fall back to control-only, and a mistyped table entry would silently
// 403 the review seat - both are louder as a refusal to start than as a bug report later.
assertRoutesClassified(app.routes)

// Mint the tokens up front when the server is LAN-reachable, so the startup banner can print
// both links. On a loopback bind nothing is created: single-user installs stay credential-free.
const sharingOn = authRequired()
if (sharingOn) accessTokens()

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const settings = getSettings()
  const files = logFiles()
  // lanAddress() returns the configured host unless it is a wildcard, in which case "0.0.0.0"
  // would be a URL nobody can open - so a real interface address is used instead.
  const url = `http://${lanAddress()}:${info.port}`

  logger.info("server", "started", {
    url,
    workspace: settings.workspace,
    model: settings.model,
    hasApiKey: Boolean(settings.apiKey),
    staticUi: hasDist,
    restoredSessions: restored,
    folders: listFolders().length,
    adoptedSessions: adopted,
    logLevel: config.logLevel,
    logFile: files.file,
    sharedSeats: sharingOn,
  })

  console.log(`[goto] listening on ${url}`)
  console.log(`[goto] workspace: ${settings.workspace || process.cwd()}`)
  console.log(`[goto] model:     ${settings.model} @ ${settings.baseURL}`)
  console.log(`[goto] api key:   ${settings.apiKey ? "configured" : "NOT SET (fill it in the web UI)"}`)
  console.log(`[goto] sessions:  ${restored} restored from disk`)
  console.log(`[goto] log:       ${files.file} (level ${config.logLevel})`)
  console.log(`[goto] web ui:    ${hasDist ? "served from web/dist" : "not built - run `gt build`"}`)

  if (config.openBrowser) {
    if (hasDist) {
      // With the token layer on, plain http://<host>:8787 has no seat and would land on the
      // "ask the host for a link" screen - so open the host's own link instead.
      openBrowser(sharingOn ? shareURL("control") : url)
    } else {
      logger.warn("server", "OPEN_BROWSER set but web/dist is missing")
      console.log("[goto] OPEN_BROWSER is set but web/dist is missing, not opening a browser")
    }
  }
}) as Server

server.on("error", (error: Error) => {
  const code = (error as NodeJS.ErrnoException).code

  if (code === "EADDRINUSE") {
    logger.warn("server", "port already in use", { port: config.port })
    console.error(`[goto] port ${config.port} is already in use - goto is probably already running`)
    console.error(`[goto] open http://${config.host}:${config.port}, or use another port:`)
    console.error(`[goto]   set PORT=8788 && gt`)
  } else {
    logger.error("server", "listen failed", { error })
    console.error(`[goto] failed to start: ${error.message}`)
  }

  process.exit(1)
})
