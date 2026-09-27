import { useEffect, useRef, useState, type ReactNode } from "react"

const MIN = 0.15
const MAX = 0.85

/** The side panel: folders on top, project tree below, with a draggable seam
 *  between them. The seam is a real groove with a grip on it, because it is a
 *  real control — and a control that does not look like one gets missed.
 *
 *  It docks on the right, so the hairline is on its left edge — the side that
 *  actually meets the transcript. */
export default function SidePanel({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  const [ratio, setRatio] = useState(0.55)
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const el = containerRef.current
      if (!draggingRef.current || !el) return
      const rect = el.getBoundingClientRect()
      if (rect.height === 0) return
      const next = (event.clientY - rect.top) / rect.height
      setRatio(Math.min(MAX, Math.max(MIN, next)))
    }

    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      setDragging(false)
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
    }

    // listening on window, not the handle: the pointer leaves the 6px strip immediately
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [])

  const startDrag = () => {
    draggingRef.current = true
    setDragging(true)
    // otherwise the drag selects text across the whole page
    document.body.style.userSelect = "none"
    document.body.style.cursor = "row-resize"
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-s-line bg-s-panel shadow-[var(--el-1)]">
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
        <div style={{ height: `${ratio * 100}%` }} className="flex min-h-0 flex-col">
          {top}
        </div>

        <div
          onMouseDown={startDrag}
          onDoubleClick={() => setRatio(0.55)}
          title="拖动调整高度 · 双击复位"
          className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-y border-s-line bg-s-well transition-colors hover:border-s-ember"
        >
          {/* the grip: three right angles that only light up on approach */}
          <span className="flex items-center gap-0.5">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className={
                  dragging
                    ? "h-0.5 w-4 bg-s-ember"
                    : "h-0.5 w-4 bg-s-edge transition-colors group-hover:bg-s-ember"
                }
              />
            ))}
          </span>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{bottom}</div>
      </div>
    </aside>
  )
}
