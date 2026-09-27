import { useEffect, useState } from "react"
import type { SessionInfo } from "@shared/protocol"
import { Btn, Card, Icon, Label, Led } from "../ui"

/** How long a sub-agent may sit untouched before we offer to clean it up. */
const IDLE_PROMPT_MS = 30 * 60_000

type Props = {
  subagents: SessionInfo[]
  onOpen: (id: string) => void
  onClose: (id: string) => void
}

/** Last activity we can actually observe: the newest message, or creation if it never spoke. */
function lastActive(sub: SessionInfo): number {
  return sub.createdAt
}

export default function SubagentStrip({ subagents, onOpen, onClose }: Props) {
  // "keep" is per-session and deliberately not persisted: reopening the app may ask again,
  // which is the right default for something that costs money to keep around
  const [kept, setKept] = useState<Set<string>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const stale = subagents.filter((sub) => now - lastActive(sub) > IDLE_PROMPT_MS && !kept.has(sub.id))

  return (
    <>
      {subagents.length > 0 ? (
        <div className="flex shrink-0 items-stretch gap-2 overflow-x-auto border-t border-s-line bg-s-panel px-4 py-1.5">
          <span className="flex shrink-0 items-center gap-1.5">
            <Icon name="plug" size={12} className="text-s-faint" />
            <Label className="text-s-faint">子智能体 {subagents.length}</Label>
          </span>
          {subagents.map((sub) => (
            <div
              key={sub.id}
              onDoubleClick={() => onOpen(sub.id)}
              title={`${sub.task ?? ""}\n\n双击打开它的对话`}
              className="group s-well flex w-56 shrink-0 cursor-pointer items-center gap-1.5 px-2 py-1 transition-colors hover:border-s-ember"
            >
              <Led tone={sub.running ? "warn" : "neutral"} pulse={sub.running} />
              <span className="min-w-0 flex-1 truncate text-s-body">{sub.task ?? sub.title}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(sub.id)
                }}
                title="关闭这个子智能体（会中止它并删除它的对话）"
                className="flex size-5 shrink-0 items-center justify-center text-s-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-s-rust"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {stale.length > 0 ? (
        <Card className="fixed bottom-4 left-4 z-30 w-80 shadow-[var(--el-3)]">
          <div className="flex items-center gap-2 border-b border-s-line bg-s-warn/10 px-2.5 py-1.5">
            <Icon name="clock" size={13} className="text-s-warn" />
            <Label className="text-s-warn">闲置</Label>
            <span className="min-w-0 flex-1 text-s-warn">这些子智能体 30 分钟没动静了</span>
          </div>
          <div className="max-h-40 overflow-y-auto px-2.5 py-1.5">
            {stale.map((sub) => (
              <div key={sub.id} className="flex items-center gap-2 py-[2px]">
                <span className="min-w-0 flex-1 truncate text-s-body" title={sub.task ?? ""}>
                  {sub.task ?? sub.title}
                </span>
                <Btn sm onClick={() => setKept((prev) => new Set(prev).add(sub.id))}>
                  保留
                </Btn>
                <Btn sm className="hover:text-s-rust" onClick={() => onClose(sub.id)}>
                  删除
                </Btn>
              </div>
            ))}
          </div>
          <div className="border-t border-s-line px-2.5 py-1 text-s-faint">
            删除会连它的对话一起删掉，不可恢复。
          </div>
        </Card>
      ) : null}
    </>
  )
}
