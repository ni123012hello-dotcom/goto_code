import { randomUUID } from "node:crypto"
import type { PermissionRequest, PermissionResponse } from "../../shared/protocol"
import { config } from "./config"
import { logger } from "./log"
import { emit, getSession, type Session } from "./sessions"

type Resolver = (response: PermissionResponse) => void

type Pending = {
  /** kept so a client that connects (or reconnects) while the prompt is up can be shown it
   *  again out of the SSE snapshot */
  request: PermissionRequest
  /** the conversation whose stream the prompt went out on. A sub-agent's prompt is routed to
   *  its parent, so that - not request.sessionID - is who has to ask for it back. */
  audienceID: string
  resolve: Resolver
}

const TIMEOUT_MS = 5 * 60_000

const pending = new Map<string, Pending>()

/** Whether a call has to go through the approval dialog.
 *
 *  MCP tools are deliberately NOT gated here. Their approval happens once, at the server
 *  level, and is bound to an exact command line by a fingerprint (see mcp.ts). Two reasons:
 *  a per-call prompt for every MCP tool is noise the user unlearns by clicking "always", and
 *  a server whose definition changed since it was confirmed is not runnable at all - so
 *  there is no unapproved MCP tool that could reach this function in the first place.
 *
 *  Keeping it as one named decision point is the point: a future tool cannot quietly skip the
 *  dialog, because there is exactly one thing to change. */
export function requiresApproval(tool: string): boolean {
  return config.permissionTools.includes(tool)
}

export async function requestPermission(
  session: Session,
  tool: string,
  title: string,
  detail: string,
): Promise<PermissionResponse> {
  if (session.allowedTools.has(tool)) {
    logger.debug("permission", "auto allowed", { sessionID: session.id, tool })
    return "once"
  }

  const request: PermissionRequest = {
    id: randomUUID(),
    sessionID: session.id,
    tool,
    // a sub-agent's prompt has to say who is asking, or the user cannot judge it
    title: session.task ? `子智能体「${session.task.slice(0, 40)}」要执行 ${tool}` : title,
    detail,
    createdAt: Date.now(),
  }

  logger.warn("permission", "requested", {
    sessionID: session.id,
    tool,
    id: request.id,
    detail,
  })

  // who should see this prompt: for a sub-agent it is whoever is watching the parent
  const audience = session.parentID ? getSession(session.parentID) ?? session : session

  const answer = await new Promise<PermissionResponse>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id)
      logger.warn("permission", "timed out", { sessionID: session.id, tool, id: request.id })
      resolve("reject")
    }, TIMEOUT_MS)

    pending.set(request.id, {
      request,
      audienceID: audience.id,
      resolve: (response) => {
        clearTimeout(timer)
        pending.delete(request.id)
        resolve(response)
      },
    })

    // The UI only subscribes to the active session, so a sub-agent emitting on its own stream
    // would show no dialog at all and just hang until the timeout. Route it to the parent.
    emit(audience, { type: "permission.request", request })
  })

  if (answer === "always") session.allowedTools.add(tool)

  logger.info("permission", "resolved", { sessionID: session.id, tool, id: request.id, response: answer })
  emit(audience, { type: "permission.resolved", permissionID: request.id, response: answer })
  return answer
}

export function resolvePermission(id: string, response: PermissionResponse): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  entry.resolve(response)
  return true
}

/** The prompt this conversation is still waiting on, if any. The SSE snapshot replays it:
 *  nothing else re-emits a request, so a refresh used to lose the dialog entirely and leave
 *  the turn blocked until the timeout. At most one can be outstanding - the agent loop is
 *  serial, and a turn answers each call before making the next. */
export function pendingPermissionFor(sessionID: string): PermissionRequest | undefined {
  for (const entry of pending.values()) {
    if (entry.audienceID === sessionID) return entry.request
  }
  return undefined
}
