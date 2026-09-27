import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { api, ApiError } from "../api"
import { useSession } from "../useSession"
import { Btn, Icon, IconBtn, Label, Led, Notice, Well } from "../ui"
import MessageList from "./MessageList"

type Props = {
  sessionID: string
  task: string
  onClose: () => void
}

const WINDOW_WIDTH = 720
const WINDOW_HEIGHT = 520

/** A sub-agent's own conversation, in a movable window so the main one stays visible.
 *  Same drag mechanics as the note window. */
export default function SubagentWindow({ sessionID, task, onClose }: Props) {
  const state = useSession(sessionID)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [pos, setPos] = useState(() => ({
    x: Math.max(16, Math.round((window.innerWidth - WINDOW_WIDTH) / 2)),
    y: Math.max(16, Math.round((window.innerHeight - WINDOW_HEIGHT) / 3)),
  }))
  const windowRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = windowRef.current
    if (!el) return
    // Same reason as NoteDialog: capturing the pointer from a pointerdown on the close button
    // retargets the pointerup, so the button's click never fires and the window cannot close.
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const el = windowRef.current
    if (!drag || !el) return
    const maxX = Math.max(0, window.innerWidth - el.offsetWidth)
    const maxY = Math.max(0, window.innerHeight - el.offsetHeight)
    setPos({
      x: Math.min(Math.max(0, event.clientX - drag.dx), maxX),
      y: Math.min(Math.max(0, event.clientY - drag.dy), maxY),
    })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.prompt(sessionID, text, undefined, [])
      setDraft("")
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "NO_API_KEY") setError("还没配置 API key")
      else setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const stop = () => void api.abort(sessionID).catch(() => undefined)

  // the stream is per-session, so refresh the transcript when this one changes hands
  useEffect(() => {
    setDraft("")
  }, [sessionID])

  return (
    <div
      ref={windowRef}
      style={{ left: pos.x, top: pos.y, width: WINDOW_WIDTH, height: `min(${WINDOW_HEIGHT}px, calc(100vh - 40px))` }}
      className="s-dialog fixed z-40 flex flex-col shadow-float"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-s-line bg-s-card px-3 py-2 select-none active:cursor-grabbing"
        title="拖动可移动这个窗口"
      >
        <Icon name="plug" size={13} className="text-s-faint" />
        <Label className="text-s-bright">子智能体</Label>
        <span className="min-w-0 flex-1 truncate text-s-soft" title={task}>
          {task}
        </span>
        <span className="flex shrink-0 items-center gap-1.5" title={state.running ? "正在运行" : "空闲"}>
          <Led tone={state.running ? "warn" : "neutral"} pulse={state.running} />
          <Label className={state.running ? "text-s-warn" : "text-s-faint"}>
            {state.running ? "运行中" : "空闲"}
          </Label>
        </span>
        <IconBtn name="close" title="关闭窗口" onClick={onClose} className="hover:text-s-bright" />
      </div>

      <MessageList messages={state.messages} running={state.running} />

      {error ? (
        <Notice tone="bad" label="err">
          {error}
        </Notice>
      ) : null}

      <div className="flex shrink-0 items-stretch gap-2 border-t border-s-line px-3 py-2">
        <Well className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 focus-within:border-s-ember">
          <Icon name="chevronRight" size={13} className="mt-[5px] text-s-ember" />
          <textarea
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="给这个子智能体补一句指令…（Enter 发送）"
            className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent leading-[1.6] text-s-bright outline-none placeholder:text-s-faint"
          />
        </Well>
        {state.running ? (
          <Btn variant="bad" icon="stop" className="shrink-0 px-4" onClick={stop}>
            停止
          </Btn>
        ) : (
          <Btn
            variant="key"
            icon="send"
            className="shrink-0 px-4"
            onClick={() => void send()}
            disabled={busy || !draft.trim()}
          >
            发送
          </Btn>
        )}
      </div>
    </div>
  )
}
