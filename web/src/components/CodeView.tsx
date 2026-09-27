import { useCallback, useEffect, useState } from "react"
import { api, type FilePreview as Preview } from "../api"
import { Btn, Empty, Label, Notice, Well, cx } from "../ui"

type Props = {
  sessionID: string
  path: string
  /** shown as a back/close action when the viewer owns a pane of its own */
  onClose?: () => void
  closeLabel?: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The read-only file viewer, with no frame of its own so both shells can host it: the control
 *  seat opens it in a modal, the review seat docks it as its main pane.
 *
 *  Deliberately a viewer and nothing else - no editing, no saving, no "insert into the
 *  composer" - which is what makes it safe to hand to the review seat. */
export default function CodeView({ sessionID, path, onClose, closeLabel = "关闭" }: Props) {
  const [view, setView] = useState<Preview | null>(null)
  const [offset, setOffset] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)

  // a different file starts from the top again
  useEffect(() => {
    setOffset(1)
    setView(null)
    setError(null)
  }, [path, sessionID])

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setView(await api.workspaceFile(sessionID, path, offset))
    } catch (caught) {
      setView(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [sessionID, path, offset])

  useEffect(() => {
    void load()
  }, [load])

  const lines = view && !view.binary ? view.text.split("\n") : []
  const lastLine = view ? view.startLine + lines.length - 1 : 0
  const hasPrev = offset > 1
  // the server windows by a fixed line count, so this is a fresh request rather than a
  // client-side slice - the file may be larger than anything we hold in memory
  const hasNext = view ? view.truncated || lastLine < view.totalLines : false

  const copy = () =>
    void navigator.clipboard
      .writeText(view?.text ?? "")
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => setError("复制失败：浏览器拒绝了剪贴板访问"))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-s-line px-3 py-1.5">
        {onClose ? (
          <Btn sm icon="chevronRight" onClick={onClose} title="回到上一屏">
            {closeLabel}
          </Btn>
        ) : null}
        <Label className="text-s-faint">只读</Label>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-s-faint" title={path}>
          {path}
        </span>
        {view?.binary ? <Label className="text-s-warn">二进制</Label> : null}
        {view?.truncated && !view.binary ? <Label className="text-s-warn">已截断</Label> : null}
        {view && !view.binary ? (
          <Label className="text-s-faint">
            {formatSize(view.size)} · {view.startLine}–{lastLine} / {view.totalLines} 行
          </Label>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-s-line px-3 py-1">
        <Btn
          sm
          icon="chevronDown"
          disabled={busy || !hasPrev}
          onClick={() => setOffset(Math.max(1, offset - 400))}
        >
          上一段
        </Btn>
        <Btn
          sm
          icon="chevronRight"
          disabled={busy || !hasNext}
          onClick={() => setOffset(lastLine + 1)}
          title={hasNext ? "继续读后面的行" : "已经是结尾"}
        >
          下一段
        </Btn>
        <span className="min-w-0 flex-1" />
        <Btn sm on={wrap} onClick={() => setWrap((value) => !value)} title="长行是否自动换行">
          {wrap ? "换行" : "不换行"}
        </Btn>
        <Btn sm icon="copy" disabled={!view || view.binary} onClick={copy}>
          {copied ? "已复制" : "复制"}
        </Btn>
        <Btn sm icon="refresh" disabled={busy} onClick={() => void load()} className={cx(busy && "s-pulse")}>
          重新读取
        </Btn>
      </div>

      {error ? (
        <Notice tone="bad" label="err">
          {error}
        </Notice>
      ) : null}

      {view?.binary ? (
        <Empty>这是二进制文件（{formatSize(view.size)}），没法当文本看。图片请在对话里查看。</Empty>
      ) : (
        <Well className="min-h-0 flex-1 overflow-auto rounded-none border-0 p-0">
          {lines.length === 0 && !error ? (
            <Empty>{busy ? "读取中…" : "（空文件）"}</Empty>
          ) : (
            <div className="min-w-full font-mono text-[11px] leading-[1.65]">
              {lines.map((line, index) => (
                <div key={index} className="flex hover:bg-s-card">
                  <span className="sticky left-0 w-12 shrink-0 select-none bg-s-well pr-2 text-right text-s-faint">
                    {view ? view.startLine + index : index + 1}
                  </span>
                  <span
                    className={cx(
                      "min-w-0 flex-1 pl-3 pr-2 text-s-body",
                      wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                    )}
                  >
                    {line || " "}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Well>
      )}
    </div>
  )
}
