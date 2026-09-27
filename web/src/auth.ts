/** The seat token, which arrives in the URL fragment.
 *
 *  A fragment is never sent to the server, so a token that travels through a chat message or
 *  a bookmark does not end up in an access log or a Referer header. It is stripped out of the
 *  address bar as soon as it is read, so it is not left visible in a screenshot either.
 *
 *  localStorage rather than sessionStorage: the app opens a child window for the session list,
 *  and that window would otherwise come up with no seat at all. The cost is that two tabs of
 *  the same browser cannot hold two different seats - test the pair in two browsers, or on two
 *  machines. */
const STORAGE_KEY = "goto.token"

let token: string | null = null

function readHash(): string | null {
  const { hash } = window.location
  if (!hash.startsWith("#")) return null
  const found = new URLSearchParams(hash.slice(1)).get("t")
  return found?.trim() ? found.trim() : null
}

/** Runs before the first render, so nothing can fire a request without the token. */
export function initToken(): void {
  const fromURL = readHash()

  if (fromURL) {
    token = fromURL
    try {
      window.localStorage.setItem(STORAGE_KEY, fromURL)
    } catch {
      /* private mode: keep it in memory for this page only */
    }
    // drop it from the address bar without leaving a history entry behind
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    return
  }

  try {
    token = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    token = null
  }
}

export function authToken(): string | null {
  return token
}

/** For the two callers that cannot set a header: EventSource, and a plain download link. */
export function withToken(url: string): string {
  if (!token) return url
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`
}
