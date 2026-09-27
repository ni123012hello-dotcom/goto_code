import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type {
    AccessMode,
    CompactionPart,
    Message,
    Part,
    ReasoningPart,
    SessionInfo,
    ServerEvent,
    SessionMode,
    TextPart,
    ToolPart,
  } from "../../shared/protocol"
import { dataFile } from "./config"
import { logger } from "./log"
import { deleteMemoryFile } from "./memory"
import { getSettings } from "./settings"

export type Subscriber = (event: ServerEvent) => void

export type Session = {
  id: string
  title: string
  workspace: string
  createdAt: number
  messages: Message[]
  subscribers: Set<Subscriber>
  running: boolean
  abort: AbortController | null
  allowedTools: Set<string>
  /** UI grouping only. Every conversation belongs to exactly one folder, but the
   *  folder never scopes tools or path resolution - the workspace does that. */
    folderID: string
    accessMode: AccessMode
    /** plan is read-only: the mutating tools are withheld from the model entirely. Set by the
     *  user, never by the agent (same rule as accessMode). */
    mode: SessionMode
    /** empty means "follow the global setting" - only set when deliberately switched */
    model?: string
    /** set on sub-agents: the conversation that spawned it */
    parentID?: string
    /** set on sub-agents: the assignment it was given, shown in the UI */
    task?: string
    /** visible to the review seat. Off by default: sharing is an explicit act by the
     *  control seat, never something a conversation gains on its own. */
    shared: boolean
  }

/** One conversation can fan out to this many helpers at a time. */
export const MAX_SUBAGENTS = 5

const sessions = new Map<string, Session>()

const sessionDir = path.join(path.dirname(dataFile), "sessions")
const SAVE_DEBOUNCE_MS = 400
const saveTimers = new Map<string, NodeJS.Timeout>()

export function sessionScope(session: Session): { sessionID: string; workspace: string } {
  return { sessionID: session.id, workspace: session.workspace }
}

function sessionFile(id: string): string {
  return path.join(sessionDir, `${id}.json`)
}

export function persistSession(session: Session): void {
  const pending = saveTimers.get(session.id)
  if (pending) {
    clearTimeout(pending)
    saveTimers.delete(session.id)
  }

  try {
    fs.mkdirSync(sessionDir, { recursive: true })
    const payload = {
      id: session.id,
      title: session.title,
      workspace: session.workspace,
      createdAt: session.createdAt,
      allowedTools: [...session.allowedTools],
      folderID: session.folderID,
      accessMode: session.accessMode,
      mode: session.mode,
      // undefined is dropped by JSON.stringify, so old files stay clean
      model: session.model,
      parentID: session.parentID,
      task: session.task,
      shared: session.shared,
      messages: session.messages,
    }
    fs.writeFileSync(sessionFile(session.id), JSON.stringify(payload), "utf8")
  } catch (error) {
    logger.warn("session", "persist failed", { sessionID: session.id, error })
  }
}

// streaming rewrites the same text part dozens of times per second, so coalesce
export function scheduleSave(session: Session): void {
  const pending = saveTimers.get(session.id)
  if (pending) clearTimeout(pending)

  const timer = setTimeout(() => {
    saveTimers.delete(session.id)
    persistSession(session)
  }, SAVE_DEBOUNCE_MS)

  timer.unref()
  saveTimers.set(session.id, timer)
}

export function loadPersistedSessions(): number {
  try {
    if (!fs.existsSync(sessionDir)) return 0

    let loaded = 0
    for (const file of fs.readdirSync(sessionDir)) {
      if (!file.endsWith(".json")) continue
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, file), "utf8")) as Record<string, unknown>
        if (typeof raw.id !== "string" || !Array.isArray(raw.messages)) continue
        if (sessions.has(raw.id)) continue

        sessions.set(raw.id, {
          id: raw.id,
          title: typeof raw.title === "string" ? raw.title : "New session",
          workspace: typeof raw.workspace === "string" ? raw.workspace : getSettings().workspace,
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
          messages: raw.messages as Message[],
          subscribers: new Set(),
          running: false,
          abort: null,
          allowedTools: new Set(Array.isArray(raw.allowedTools) ? (raw.allowedTools as string[]) : []),
          // older files predate folders; "" marks them for reassignment on boot
          folderID: typeof raw.folderID === "string" ? raw.folderID : "",
          accessMode: raw.accessMode === "full" ? "full" : "workspace",
          // absent on files written before modes existed: agent, i.e. unchanged behaviour
          mode: raw.mode === "plan" ? "plan" : "agent",
          // optional: absent on files written before per-session models existed
          model: typeof raw.model === "string" && raw.model.trim() ? raw.model : undefined,
          // optional: absent on files written before sub-agents existed
          parentID: typeof raw.parentID === "string" && raw.parentID.trim() ? raw.parentID : undefined,
          task: typeof raw.task === "string" && raw.task.trim() ? raw.task : undefined,
          // absent on files written before sharing existed: not shared, i.e. unchanged behaviour
          shared: raw.shared === true,
        })
        loaded += 1
      } catch {
        logger.warn("session", "skipping unreadable session file", { file })
      }
    }
    return loaded
  } catch (error) {
    logger.warn("session", "failed to load persisted sessions", { error })
    return 0
  }
}

export function createSession(
  folderID: string,
  workspace?: string,
  extras: { parentID?: string; task?: string; title?: string } = {},
): Session {
  const id = randomUUID()
  const session: Session = {
    id,
    title: extras.title ?? "New session",
    workspace: path.resolve(workspace || getSettings().workspace || process.cwd()),
    createdAt: Date.now(),
    messages: [],
    subscribers: new Set(),
    running: false,
    abort: null,
    allowedTools: new Set(),
    folderID,
    accessMode: "workspace",
    mode: "agent",
    parentID: extras.parentID,
    task: extras.task,
    shared: false,
  }
  sessions.set(id, session)
  persistSession(session)
  return session
}

/** Sub-agents of one conversation, oldest first so the UI keeps a stable order. */
export function subagentsOf(parentID: string): Session[] {
  return [...sessions.values()]
    .filter((session) => session.parentID === parentID)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function setAccessMode(id: string, mode: AccessMode): SessionInfo | undefined {
  const session = sessions.get(id)
  if (!session) return undefined

  session.accessMode = mode
  persistSession(session)
  logger.info("session", "access mode changed", { sessionID: id, mode })
  return toInfo(session)
}

export function setSessionMode(id: string, mode: SessionMode): SessionInfo | undefined {
  const session = sessions.get(id)
  if (!session) return undefined

  session.mode = mode
  persistSession(session)
  logger.info("session", "mode changed", { sessionID: id, mode })
  return toInfo(session)
}

/** Let the review seat see this conversation, or take that away. Persisted immediately: the
 *  grant is the whole basis of the other seat's access, so it must not be lost to a crash
 *  between the click and the next debounced save. */
export function setSessionShared(id: string, shared: boolean): SessionInfo | undefined {
  const session = sessions.get(id)
  if (!session) return undefined

  session.shared = shared
  persistSession(session)
  logger.info("session", "sharing changed", { sessionID: id, shared })
  return toInfo(session)
}

export function countSessionsInFolder(folderID: string): number {
  let total = 0
  for (const session of sessions.values()) {
    // sub-agents are ephemeral and not created by the user, so they must not eat into the
    // per-folder budget the user actually manages
    if (session.folderID === folderID && !session.parentID) total += 1
  }
  return total
}

export function sessionsInFolders(folderIDs: Set<string>): Session[] {
  return [...sessions.values()].filter((session) => folderIDs.has(session.folderID))
}

export function setSessionFolder(id: string, folderID: string): SessionInfo | undefined {
  const session = sessions.get(id)
  if (!session) return undefined

  session.folderID = folderID
  persistSession(session)
  return toInfo(session)
}

/** A conversation that points at a folder which no longer exists is invisible in
 *  the tree, so dangling references get repaired on boot just like missing ones. */
export function assignOrphansToFolder(folderID: string, knownFolderIDs: Set<string>): number {
  let moved = 0
  for (const session of sessions.values()) {
    if (session.folderID && knownFolderIDs.has(session.folderID)) continue
    session.folderID = folderID
    persistSession(session)
    moved += 1
  }
  return moved
}

export function deleteSessionsInFolder(folderID: string): number {
  let removed = 0
  for (const session of [...sessions.values()]) {
    if (session.folderID !== folderID) continue
    if (deleteSession(session.id)) removed += 1
  }
  return removed
}

export function deleteSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false

  // a sub-agent is meaningless without the conversation that spawned it, so it goes too
  for (const child of subagentsOf(id)) deleteSession(child.id)

  // a debounced save may still be queued; without cancelling it the timer fires
  // after the file is removed and resurrects a zombie session on disk
  const pending = saveTimers.get(id)
  if (pending) {
    clearTimeout(pending)
    saveTimers.delete(id)
  }

  session.abort?.abort()
  sessions.delete(id)
  // The memory file belongs to the conversation, so it has to go with it. This used to
  // live only in the HTTP DELETE route, which meant every other caller - a sub-agent's
  // teardown, a test's cleanup - left an orphan .data/memory/<id>.md behind forever
  // (context-check added one on every run, and the count only ever went up).
  deleteMemoryFile(sessionScope(session))
  try {
    fs.rmSync(sessionFile(id), { force: true })
  } catch {
    /* best effort */
  }
  logger.info("session", "deleted", { sessionID: id })
  return true
}

export type RewindResult = { ok: true; removed: number } | { ok: false; reason: "not-found" | "not-user" }

/** Drop this message and everything after it, so it can be re-sent edited.
 *  Only the owner of a user message is rewound: rewinding to an assistant or tool
 *  message would leave the transcript starting mid-turn. */
export function rewindTo(session: Session, messageID: string): RewindResult {
  const index = session.messages.findIndex((message) => message.id === messageID)
  if (index < 0) return { ok: false, reason: "not-found" }
  if (session.messages[index].role !== "user") return { ok: false, reason: "not-user" }

  const removed = session.messages.splice(index)
  persistSession(session)
  emit(session, { type: "snapshot", session: toInfo(session), messages: session.messages })
  return { ok: true, removed: removed.length }
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)
}

/** Set or clear this conversation's model override. Empty clears it, so the
 *  conversation goes back to following the global setting. */
export function setSessionModel(id: string, model: string | undefined): SessionInfo | undefined {
  const session = sessions.get(id)
  if (!session) return undefined

  const trimmed = String(model ?? "").trim()
  if (trimmed) session.model = trimmed
  else delete session.model

  scheduleSave(session)
  return toInfo(session)
}

export function listSessions(): SessionInfo[] {
  return [...sessions.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toInfo)
}

export function toInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    createdAt: session.createdAt,
    running: session.running,
    folderID: session.folderID,
      accessMode: session.accessMode,
      mode: session.mode,
      model: session.model,
      parentID: session.parentID,
      task: session.task,
      shared: session.shared,
    }
  }


export function subscribe(session: Session, fn: Subscriber): () => void {
  session.subscribers.add(fn)
  return () => session.subscribers.delete(fn)
}

export function emit(session: Session, event: ServerEvent): void {
  for (const fn of session.subscribers) {
    try {
      fn(event)
    } catch {
      session.subscribers.delete(fn)
    }
  }
}

export function newMessage(session: Session, role: Message["role"]): Message {
  const message: Message = {
    id: randomUUID(),
    sessionID: session.id,
    role,
    createdAt: Date.now(),
    parts: [],
  }
  session.messages.push(message)
  scheduleSave(session)
  return message
}

export function newTextPart(message: Message, text = ""): TextPart {
  const part: TextPart = { id: randomUUID(), type: "text", text }
  message.parts.push(part)
  return part
}

/** Parts are created in the order the stream produces them, so this simply appends.
 *  A step can end up with several of these when the model interleaves thinking and
 *  content: each resumption gets its own block, positioned where it happened. */
export function newReasoningPart(message: Message): ReasoningPart {
  const part: ReasoningPart = { id: randomUUID(), type: "reasoning", text: "" }
  message.parts.push(part)
  return part
}

export function newToolPart(message: Message, tool: string, callID: string, input: unknown): ToolPart {
  const part: ToolPart = {
    id: randomUUID(),
    type: "tool",
    callID,
    tool,
    input,
    status: "running",
  }
  message.parts.push(part)
  return part
}

export function newCompactionPart(
  message: Message,
  data: Omit<CompactionPart, "id" | "type">,
): CompactionPart {
  const part: CompactionPart = { id: randomUUID(), type: "compaction", ...data }
  message.parts.push(part)
  return part
}

export function findPart(message: Message, partID: string): Part | undefined {
  return message.parts.find((part) => part.id === partID)
}

export function setTitle(session: Session, text: string): void {
  if (session.title !== "New session") return
  const clean = text.replace(/\s+/g, " ").trim()
  session.title = clean.length > 60 ? `${clean.slice(0, 60)}...` : clean || "New session"
  scheduleSave(session)
}
