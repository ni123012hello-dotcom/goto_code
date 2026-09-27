import { useEffect, useState } from "react"
import type { SessionInfo, ShareView } from "@shared/protocol"
import { api } from "../api"
import { Btn, Label, Modal, Notice, Well } from "../ui"

type Props = {
  sessionID: string | null
  sessionTitle: string
  shared: boolean
  onShared: (info: SessionInfo) => void
  onClose: () => void
}

/** The control seat's side of sharing: hand out the review link, and decide which
 *  conversations it may open. */
export default function ShareDialog({ sessionID, sessionTitle, shared, onShared, onClose }: Props) {
  const [view, setView] = useState<ShareView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .share()
      .then(setView)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const copy = () =>
    run(async () => {
      if (!view?.reviewURL) return
      await navigator.clipboard.writeText(view.reviewURL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })

  return (
    <Modal
      title="局域网共享"
      note="两个人用同一个对话：一个人控制 AI，另一个人只看"
      onClose={onClose}
      className="max-w-lg"
    >
      {error ? (
        <Notice tone="bad" label="err" className="mb-2">
          {error}
        </Notice>
      ) : null}

      {!view ? (
        <div className="text-s-faint">正在读取…</div>
      ) : !view.enabled ? (
        <Notice tone="warn" label="off">
          当前是只监听本机，没有也不需要访问链接。要让别人连进来，把 <b className="font-mono">HOST</b> 设成{" "}
          <b className="font-mono">0.0.0.0</b> 再重启 <b className="font-mono">gt</b>：
          <div className="mt-1 font-mono text-[11px] text-s-faint">
            set HOST=0.0.0.0 && gt
          </div>
          重启后终端会打印两条链接（控制席 / 检查席），把它们发给对方即可。
        </Notice>
      ) : (
        <>
          <div className="mb-2 text-s-body">
            检查席链接（任何人拿到它都只能看共享出来的对话）：
          </div>

          <Well className="mb-2 p-2">
            <div className="break-all font-mono text-[11px] text-s-bright">{view.reviewURL}</div>
          </Well>

          <div className="mb-3 flex items-center gap-2">
            <Btn sm variant="key" icon="plus" disabled={busy} onClick={() => void copy()}>
              {copied ? "已复制" : "复制链接"}
            </Btn>
            <Btn
              sm
              disabled={busy}
              title="作废已经发出去的检查席链接，换一条新的；控制席链接不受影响"
              onClick={() =>
                void run(async () => {
                  setView(await api.rotateShare("review"))
                })
              }
            >
              重新生成
            </Btn>
            <span className="ml-auto font-mono text-[11px] text-s-faint">{view.host}</span>
          </div>

          <div className="s-hair mb-2" />

          {sessionID ? (
            <>
              <div className="mb-1.5 flex items-center gap-2">
                <Label className="text-s-faint">当前对话</Label>
                <span className="min-w-0 flex-1 truncate text-s-body">{sessionTitle}</span>
              </div>
              <div className="flex items-center gap-2">
                <Btn
                  sm
                  variant={shared ? "ok" : "plain"}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      onShared(await api.sessionShare(sessionID, !shared))
                    })
                  }
                >
                  {shared ? "已共享给检查席 · 点击停止" : "共享给检查席"}
                </Btn>
                <span className="min-w-0 flex-1 text-s-faint">
                  {shared ? "检查席现在能看到这个对话" : "未共享的对话，检查席看不到"}
                </span>
              </div>
            </>
          ) : (
            <div className="text-s-faint">先打开一个对话，才能决定要不要共享它。</div>
          )}
        </>
      )}
    </Modal>
  )
}
