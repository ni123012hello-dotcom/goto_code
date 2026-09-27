import { useEffect, useState } from "react"

/* ============================================================================
 * One media query, as state.
 *
 * The shell is three fixed columns — rail, side panel, main — which is right for
 * a wide window and wrong for a narrow one. Rather than pretending the app is
 * fluid, it collapses a column when the width can no longer afford it.
 *
 * The listener is on the MediaQueryList, not on window resize: this fires only
 * when the threshold is actually crossed, so the parent can treat it as an
 * event and not fight the user's manual toggle on every render.
 * ==========================================================================*/

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)

    // the query can already have changed between the initial read and subscribe
    setMatches(list.matches)
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  }, [query])

  return matches
}
