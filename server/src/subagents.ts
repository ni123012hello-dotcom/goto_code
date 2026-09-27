// Sub-agents: a conversation can fan its work out to up to MAX_SUBAGENTS helper
// conversations, each with its own task, own transcript and own context budget.
//
// Two deliberate constraints:
//   - nothing is created until the user allows it. The agent proposes (count + tasks +
//     parallel-or-not) and the prompt is the only place that decision is made, because
//     spawning agents costs real money and can hit provider rate limits.
//   - sequential by default. Parallel agents share one workspace, so two of them editing
//     the same file silently lose each other's writes, and 5 concurrent requests on a
//     small plan trips 429 fast. The user can opt in.

import { randomUUID } from "node:crypto"
import type { SpawnRequest, SpawnResponse, SubagentReport } from "../../shared/protocol"
import { logger } from "./log"
import { runTurn } from "./agent/loop"
import {
  createSession,
  emit,
  newMessage,
  newTextPart,
  toInfo,
  MAX_SUBAGENTS,
  subagentsOf,
  type Session,
} from "./sessions"

type Resolver = (response: SpawnResponse) => void

const TIMEOUT_MS = 5 * 60_000
/** a helper's report goes into the parent's context, so it is capped like any tool output */
const REPORT_MAX_CHARS = 2_000

const pending = new Map<string, { request: SpawnRequest; sessionID: string; resolve: Resolver }>()

/** Ask the user before creating anything. Resolves with what they chose. */
export async function requestSpawn(
  session: Session,
  tasks: string[],
  parallel: boolean,
): Promise<SpawnResponse | null> {
  if (tasks.length === 0 || tasks.length > MAX_SUBAGENTS) return null

  const request: SpawnRequest = {
    id: randomUUID(),
    sessionID: session.id,
    tasks,
    parallel,
    createdAt: Date.now(),
  }

  logger.info("spawn", "requested", { sessionID: session.id, count: tasks.length, parallel })

  const answer = await new Promise<SpawnResponse | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id)
      logger.warn("spawn", "timed out", { sessionID: session.id, id: request.id })
      resolve(null)
    }, TIMEOUT_MS)

    pending.set(request.id, {
      request,
      sessionID: session.id,
      resolve: (response) => {
        clearTimeout(timer)
        pending.delete(request.id)
        resolve(response)
      },
    })

    emit(session, { type: "spawn.request", request })
  })

  if (answer) emit(session, { type: "spawn.resolved", spawnID: request.id, response: answer })
  logger.info("spawn", "resolved", { sessionID: session.id, id: request.id, response: answer })
  return answer
}

export function resolveSpawn(id: string, response: SpawnResponse): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  entry.resolve(response)
  return true
}

/** The spawn prompt this conversation is still waiting on, if any - see pendingPermissionFor.
 *  A sub-agent cannot spawn, so the requesting conversation is always the one showing it. */
export function pendingSpawnFor(sessionID: string): SpawnRequest | undefined {
  for (const entry of pending.values()) {
    if (entry.sessionID === sessionID) return entry.request
  }
  return undefined
}

/** Releases anything still blocked on a prompt for this conversation, so deleting a
 *  conversation cannot leave a tool call hanging until the timeout. */
export function cancelSpawnsFor(sessionID: string): number {
  let cancelled = 0
  for (const [id, entry] of [...pending]) {
    if (entry.sessionID !== sessionID) continue
    pending.delete(id)
    entry.resolve({ allowed: false, parallel: false })
    cancelled += 1
  }
  if (cancelled > 0) logger.warn("spawn", "cancelled by session teardown", { sessionID, cancelled })
  return cancelled
}

function notify(parent: Session): void {
  emit(parent, { type: "subagents.changed", sessionID: parent.id, subagents: subagentsOf(parent.id).map(toInfo) })
}

function lastReport(sub: Session): string {
  for (let index = sub.messages.length - 1; index >= 0; index -= 1) {
    const message = sub.messages[index]
    if (message.role !== "assistant") continue
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()
    if (!text) continue
    return text.length > REPORT_MAX_CHARS ? `${text.slice(0, REPORT_MAX_CHARS)}\n…（已截断）` : text
  }
  return "（没有产出任何文字）"
}

async function runOne(parent: Session, task: string, signal: AbortSignal): Promise<SubagentReport> {
  const sub = createSession(parent.folderID, parent.workspace, {
    parentID: parent.id,
    task,
    title: task.length > 60 ? `${task.slice(0, 60)}…` : task,
  })
    // a helper works on the same files with the same model; only its transcript is its own.
    // The mode has to come with it: a sub-agent that defaulted to agent would be a way around
    // a read-only conversation.
    sub.accessMode = parent.accessMode
    sub.mode = parent.mode
  sub.model = parent.model
  notify(parent)

  let status: SubagentReport["status"] = "done"
  try {
    const user = newMessage(sub, "user")
    newTextPart(user, task)
    emit(sub, { type: "message.start", message: user })

    // aborting the parent must abort the helper that is currently running
    const onAbort = () => sub.abort?.abort()
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      await runTurn(sub)
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
    if (signal.aborted) status = "aborted"
  } catch (error) {
    status = "failed"
    logger.warn("spawn", "sub-agent failed", {
      sessionID: parent.id,
      subagentID: sub.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  notify(parent)
  return { id: sub.id, task, status, report: status === "done" ? lastReport(sub) : `（${status}）` }
}

/** Runs the helpers and returns their reports, in the order the tasks were given. */
export async function runSubagents(
  parent: Session,
  tasks: string[],
  parallel: boolean,
  signal: AbortSignal,
): Promise<SubagentReport[]> {
  const limited = tasks.slice(0, MAX_SUBAGENTS)

  if (!parallel) {
    const reports: SubagentReport[] = []
    for (const task of limited) {
      reports.push(await runOne(parent, task, signal))
      if (signal.aborted) break
    }
    return reports
  }

  logger.warn("spawn", "running sub-agents in parallel", {
    sessionID: parent.id,
    count: limited.length,
    note: "they share one workspace; concurrent edits to the same file lose data",
  })
  return Promise.all(limited.map((task) => runOne(parent, task, signal)))
}

export function spawnCatalog() {
  return { max: MAX_SUBAGENTS, reportMaxChars: REPORT_MAX_CHARS }
}
