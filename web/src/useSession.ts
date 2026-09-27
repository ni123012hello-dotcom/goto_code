import { useEffect, useReducer } from "react"
import type {
  Message,
  Part,
    PermissionRequest,
    QuestionRequest,
    ServerEvent,
    SessionInfo,
    SpawnRequest,
    ToolPart,
  } from "@shared/protocol"
import { withToken } from "./auth"

export type SessionState = {
  session: SessionInfo | null
  messages: Message[]
  running: boolean
  permission: PermissionRequest | null
  question: QuestionRequest | null
  spawn: SpawnRequest | null
  /** bumped when the set of sub-agents or their running state changes */
  subagentsRevision: number
  error: string | null
  /** bumped whenever the folder's shared note changes, so an open note window can refetch */
  noteRevision: number
}

const initialState: SessionState = {
  session: null,
  messages: [],
  running: false,
    permission: null,
    question: null,
    spawn: null,
    subagentsRevision: 0,
    error: null,
    noteRevision: 0,
  }

type Action = { kind: "reset" } | { kind: "event"; event: ServerEvent }

function updateMessage(messages: Message[], id: string, fn: (message: Message) => Message): Message[] {
  return messages.map((message) => (message.id === id ? fn(message) : message))
}

function updatePart(messages: Message[], messageID: string, partID: string, fn: (part: Part) => Part): Message[] {
  return updateMessage(messages, messageID, (message) => ({
    ...message,
    parts: message.parts.map((part) => (part.id === partID ? fn(part) : part)),
  }))
}

function reducer(state: SessionState, action: Action): SessionState {
  if (action.kind === "reset") return initialState

  const event = action.event

  switch (event.type) {
    case "snapshot":
      return {
        ...state,
        session: event.session,
        messages: event.messages,
        running: event.session.running,
        // taken from the event rather than left alone: the snapshot carries whatever is still
        // waiting for an answer, and a dialog that was answered while this client was away must
        // not linger. Nothing else replays a request, so this is the only chance to show one.
        permission: event.permission ?? null,
        question: event.question ?? null,
        spawn: event.spawn ?? null,
        error: null,
      }

    case "message.start":
      if (state.messages.some((message) => message.id === event.message.id)) return state
      return { ...state, messages: [...state.messages, event.message] }

    case "part.start":
      return {
        ...state,
        messages: updateMessage(state.messages, event.messageID, (message) =>
          message.parts.some((part) => part.id === event.part.id)
            ? message
            : { ...message, parts: [...message.parts, event.part] },
        ),
      }

    case "text.delta":
      return {
        ...state,
        messages: updatePart(state.messages, event.messageID, event.partID, (part) =>
          part.type === "text" ? { ...part, text: part.text + event.delta } : part,
        ),
      }

    case "reasoning.delta":
      return {
        ...state,
        messages: updatePart(state.messages, event.messageID, event.partID, (part) =>
          part.type === "reasoning" ? { ...part, text: part.text + event.delta } : part,
        ),
      }

    case "tool.input":
      return {
        ...state,
        messages: updatePart(state.messages, event.messageID, event.partID, (part) =>
          part.type === "tool" ? ({ ...part, input: event.input } as ToolPart) : part,
        ),
      }

    case "tool.output":
      return {
        ...state,
        messages: updatePart(state.messages, event.messageID, event.partID, (part) =>
          part.type === "tool" ? ({ ...part, output: (part.output ?? "") + event.chunk } as ToolPart) : part,
        ),
      }

    case "tool.end":
      return {
        ...state,
        messages: updatePart(state.messages, event.messageID, event.partID, (part) =>
          part.type === "tool"
            ? ({
                ...part,
                status: event.status,
                title: event.title ?? part.title,
                output: event.output ?? part.output,
                error: event.error,
                diff: event.diff,
              } as ToolPart)
            : part,
        ),
      }

    case "permission.request":
      return { ...state, permission: event.request }

    case "permission.resolved":
      return {
        ...state,
        permission: state.permission?.id === event.permissionID ? null : state.permission,
      }

    case "question.request":
      return { ...state, question: event.request }

    case "question.resolved":
      return { ...state, question: state.question?.id === event.questionID ? null : state.question }

    case "spawn.request":
      return { ...state, spawn: event.request }

    case "spawn.resolved":
      return { ...state, spawn: null }

    case "subagents.changed":
      return { ...state, subagentsRevision: state.subagentsRevision + 1 }

    case "session.status":
      return { ...state, running: event.running }

    case "session.info":
      return { ...state, session: event.session }

    case "message.tokens":
      return {
        ...state,
        messages: updateMessage(state.messages, event.messageID, (message) => ({
          ...message,
          tokens: event.tokens,
        })),
      }

    case "parts.compacted": {
      const cleared = new Set(event.partIDs)
      return {
        ...state,
        messages: state.messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) =>
            part.type === "tool" && cleared.has(part.id) ? { ...part, compactedAt: event.at } : part,
          ),
        })),
      }
    }

    case "note.changed":
      return { ...state, noteRevision: state.noteRevision + 1 }

    case "error":
      return { ...state, error: event.message }

    default:
      return state
  }
}

export function useSession(sessionId: string | null): SessionState {
  const [state, dispatch] = useReducer(reducer, initialState)

  useEffect(() => {
    dispatch({ kind: "reset" })
    if (!sessionId) return

    // EventSource cannot set a header, so the seat travels in the query string
    const source = new EventSource(withToken(`/api/sessions/${sessionId}/events`))
    source.addEventListener("message", (raw) => {
      try {
        dispatch({ kind: "event", event: JSON.parse((raw as MessageEvent<string>).data) as ServerEvent })
      } catch {
        return
      }
    })

    return () => source.close()
  }, [sessionId])

  return state
}
