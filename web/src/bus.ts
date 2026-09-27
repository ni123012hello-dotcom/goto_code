export type BusMessage =
  | { type: "session.select"; id: string }
  | { type: "sessions.changed" }

const NAME = "goto"
const ACTIVE_KEY = "goto.activeSession"

let channel: BroadcastChannel | null = null

try {
  channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(NAME) : null
} catch {
  channel = null
}

export function publish(message: BusMessage): void {
  channel?.postMessage(message)
}

export function subscribe(handler: (message: BusMessage) => void): () => void {
  if (!channel) return () => undefined

  const listener = (event: MessageEvent) => {
    handler(event.data as BusMessage)
  }

  channel.addEventListener("message", listener)
  return () => channel?.removeEventListener("message", listener)
}

// the selected session has to survive a window opening after the fact, and
// BroadcastChannel has no request/response, so localStorage carries the value
export function readActiveSession(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function writeActiveSession(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* ignore */
  }
}
