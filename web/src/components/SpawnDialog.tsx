import { useState } from "react"
import type { SpawnRequest } from "@shared/protocol"
import { api } from "../api"
import { Btn, Icon, Label, Notice, cx } from "../ui"

type Props = {
  request: SpawnRequest
  /** how many helpers one conversation may fan out to */
  max: number
  onClose: () => void
}

export default function SpawnDialog({ request, max, onClose }: Props) {
  const [parallel, setParallel] = useState(request.parallel)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const answer = async (allowed: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await api.resolveSpawn(request.id, allowed, parallel)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed bottom-4 left-4 z-60 w-[26rem] max-w-[calc(100vw-2rem)]">
      <div className="s-dialog shadow-float">
        <div className="s-dialog__head">
          <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
          <Label className="text-s-bright">子智能体</Label>
          <span className="flex min-w-0 items-center gap-1.5 truncate text-s-soft">
            <Icon name="plug" size={12} className="shrink-0 text-s-faint" />
            agent 想把这件事拆给 {request.tasks.length} 个子智能体
          </span>
          <div className="s-hair min-w-0 flex-1" />
          <Label className="text-s-faint">上限 {max}</Label>
        </div>

        <div className="border-b border-s-line px-3 py-1.5 text-s-faint">
          每个子智能体有独立的对话和上下文预算，跑完只把摘要交回来。创建前问你是刻意的 ——
          它们会并行消耗额度，也可能同时改同一个文件。
        </div>

        <div className="max-h-80 overflow-y-auto px-3 py-2">
          {request.tasks.map((task, index) => (
            <div key={task} className="flex gap-2 border-b border-s-line py-1.5 last:border-0">
              <Label className="pt-[3px] text-s-ember">{String(index + 1).padStart(2, "0")}</Label>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-s-body">{task}</span>
            </div>
          ))}
        </div>

        <div className="border-t border-s-line px-3 py-2">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={parallel}
              onChange={(event) => setParallel(event.target.checked)}
              className="mt-1 shrink-0 accent-s-ember"
            />
            <span className="min-w-0">
              <span className="text-s-soft">并发执行（默认串行）</span>
              <span className={cx("block", parallel ? "text-s-warn" : "text-s-faint")}>
                {parallel
                  ? "已开启："
                  : "已关闭：串行跑，一个接一个。"}
                并发更快，但它们共享同一个工作区：两个智能体改同一个文件会互相覆盖， 而且同时发{" "}
                {request.tasks.length} 路请求容易撞 provider 的速率限制。
              </span>
            </span>
          </label>
        </div>

        {error ? (
          <Notice tone="bad" label="err">
            {error}
          </Notice>
        ) : null}

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-s-line bg-s-rail px-3 py-2.5">
          <Btn onClick={() => void answer(false)} disabled={busy}>
            不要，自己来做
          </Btn>
          <Btn variant="key" icon="check" onClick={() => void answer(true)} disabled={busy}>
            允许，开始 {request.tasks.length} 个
          </Btn>
        </div>
      </div>
    </div>
  )
}
