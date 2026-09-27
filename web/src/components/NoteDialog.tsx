import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { api, type NoteView } from "../api"
import { Btn, Icon, IconBtn, Label, Notice } from "../ui"

type Props = {
  sessionID: string
  /** bumped by the server whenever the note changes, so the agent's writes show up live */
  revision: number
  running: boolean
  onClose: () => void
}

const WINDOW_WIDTH = 880
const WINDOW_HEIGHT = 560

function fmt(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

/** A floating window: the note is a live document the agent writes into, so it
 *  belongs beside the conversation, not on top of it. */
export default function NoteDialog({ sessionID, revision, running, onClose }: Props) {
  const [view, setView] = useState<NoteView | null>(null)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState(false)

  const [pos, setPos] = useState(() => ({
    x: Math.max(16, Math.round((window.innerWidth - WINDOW_WIDTH) / 2)),
    y: Math.max(16, Math.round((window.innerHeight - WINDOW_HEIGHT) / 3)),
  }))
  const windowRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  const apply = (next: NoteView) => {
    setView(next)
    setText(next.text)
  }

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setBusy(true)
      setError(null)
      try {
        apply(await api.note(sessionID))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (!quiet) setBusy(false)
      }
    },
    [sessionID],
  )

  useEffect(() => {
    void load()
  }, [load])

  // the agent writes sections while the turn runs, so follow along instead of making the
  // user hit reload. Unsaved edits win: never clobber what they typed.
  const dirtyRef = useRef(false)
  dirtyRef.current = view ? text !== view.text : false

  useEffect(() => {
    if (revision === 0) return
    if (dirtyRef.current) {
      setPendingUpdate(true)
      return
    }
    setPendingUpdate(false)
    void load(true).then(() => setNotice("已同步 agent 的修改"))
  }, [revision, load])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = windowRef.current
    if (!el) return
    // The handle contains the close button, so a pointerdown on that button must not start a
    // drag: capturing the pointer retargets the following pointerup to this element, which
    // makes the browser dispatch `click` on the common ancestor (here) instead of the button,
    // so its onClick never ran and the window could not be closed.
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

  const save = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await api.saveNote(sessionID, text)
      apply(next)
      setNotice(`已保存 ${next.sections.length} 节，${next.tokens} tok`)
      setPendingUpdate(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice("已复制到剪贴板")
    } catch {
      setError("复制失败，浏览器拒绝了剪贴板访问")
    }
  }

  const injected = new Set(view?.injected ?? [])
  const omitted = new Map((view?.omitted ?? []).map((item) => [item.name, item.tokens]))
  const injectedTokens = (view?.sections ?? [])
    .filter((section) => injected.has(section.name))
    .reduce((total, section) => total + section.tokens, 0)

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
        className="flex shrink-0 cursor-grab select-none items-center gap-2 border-b border-s-line bg-s-card px-3 py-2 active:cursor-grabbing"
        title="拖动可移动这个窗口"
      >
        <Icon name="note" size={13} className="text-s-faint" />
        <Label className="text-s-bright">笔记</Label>
        <span className="min-w-0 truncate text-s-soft">{view?.sessionTitle ?? "…"}</span>
        <div className="s-hair min-w-0 flex-1" />
        {running ? (
          <Label className="flex shrink-0 items-center gap-1.5 text-s-warn">
            <span className="s-pulse">●</span>agent 运行中
          </Label>
        ) : (
          <Label className="text-s-faint">本对话 · 内容会注入 prompt</Label>
        )}
        <IconBtn name="close" title="关闭窗口" onClick={onClose} className="hover:text-s-bright" />
      </div>

      <div className="flex min-h-0 flex-1">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          className="min-h-0 min-w-0 flex-1 resize-none border-r border-s-line bg-s-well p-3 leading-[1.7] text-s-body outline-none"
        />

        <div className="flex w-64 shrink-0 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-s-line px-2.5 py-1.5">
            <Label className="text-s-soft">注入预览</Label>
            <div className="s-hair min-w-0 flex-1" />
            <Label className="text-s-faint">
              {injectedTokens}/{view?.budget ?? 0}
            </Label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5">
            {view && view.sections.length > 0 ? (
              view.sections.map((section) => {
                const willInject = injected.has(section.name)
                const overBudget = omitted.get(section.name) ?? section.tokens
                return (
                  <div key={section.name} className="flex items-baseline gap-1.5 py-[2px]">
                    <span className={willInject ? "text-s-moss" : "text-s-faint"}>{willInject ? "✓" : "✗"}</span>
                    <span
                      className={`min-w-0 flex-1 truncate ${willInject ? "text-s-body" : "text-s-faint"}`}
                      title={section.name}
                    >
                      {section.name}
                    </span>
                    <Label className="text-s-faint">{willInject ? section.tokens : overBudget}</Label>
                  </div>
                )
              })
            ) : (
              <div className="text-s-faint">（还没有内容）</div>
            )}

            {view && view.omitted.length > 0 ? (
              <div className="mt-2 border-t border-s-line pt-1.5 text-s-warn">
                有 {view.omitted.length} 节超出预算，本次不会注入。agent 需要时会用
                <span className="font-mono"> note(action:"read") </span>
                单独读取。
              </div>
            ) : null}
          </div>

          <div className="shrink-0 border-t border-s-line px-2.5 py-1.5">
            <Label className="block text-s-faint">合计</Label>
            <div className="text-s-soft">
              {fmt(view?.tokens ?? 0)} tok · {view?.sections.length ?? 0} 节
            </div>
            {view?.workspace ? (
              <div className="mt-1 break-all font-mono text-[10px] text-s-faint" title={view.workspace}>
                工作区 {view.workspace}
              </div>
            ) : null}
            {view?.updatedAt ? (
              <div className="text-[10px] text-s-faint">最后更新 {view.updatedAt.slice(0, 16).replace("T", " ")}</div>
            ) : null}
          </div>
        </div>
      </div>

      {pendingUpdate ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-s-line bg-s-warn/5 px-2.5 py-1.5 text-s-warn">
          <Label className="shrink-0 text-s-warn">有冲突</Label>
          <span className="min-w-0 flex-1">笔记已被 agent 更新，但你有未保存的修改。</span>
          <Btn
            sm
            onClick={() => {
              setPendingUpdate(false)
              void load(true)
            }}
          >
            载入新版本
          </Btn>
        </div>
      ) : null}

      {notice ? <Notice tone="ok" label="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad" label="err">{error}</Notice> : null}

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-s-line px-3 py-2">
        <span className="min-w-0 truncate font-mono text-[10px] text-s-faint" title={view?.path ?? ""}>
          {view?.path ?? ""}
        </span>
        <div className="flex shrink-0 gap-2">
          <Btn onClick={() => void load()} disabled={busy}>
            重新载入
          </Btn>
          <Btn onClick={() => void copy()}>复制</Btn>
          <Btn onClick={() => window.open(api.noteExportURL(sessionID), "_blank")}>导出 .md</Btn>
          <Btn variant="key" onClick={() => void save()} disabled={busy}>
            保存
          </Btn>
        </div>
      </div>
    </div>
  )
}
