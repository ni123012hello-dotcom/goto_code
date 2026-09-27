import { useEffect, useRef } from "react"
import type { CompactionPart, Message } from "@shared/protocol"
import { Btn, Card, Icon, Label, cx, type IconName } from "../ui"
import CompactionCard from "./CompactionCard"
import Markdown from "./Markdown"
import StatusMark from "./StatusMark"
import ToolCard from "./ToolCard"

const EXAMPLES = [
  "读一下 src/index.ts，告诉我这个项目是做什么的",
  "跑一遍 typecheck，把报错都修掉",
  "给 server/src/safety.ts 加上单元测试",
]

const CAPABILITIES: { icon: IconName; text: string }[] = [
  { icon: "tree", text: "read / write / edit" },
  { icon: "search", text: "list / grep" },
  { icon: "terminal", text: "bash · 需授权" },
  { icon: "memory", text: "上下文自动压缩" },
]

/** Consecutive tool calls that failed identically are one event, not five cards: keep the
 *  first of each run, fold the rest into a ×N badge. Runs are per-message, since a run that
 *  spans messages is two different turns and should stay readable as such. */
function foldRepeatedErrors(parts: Message["parts"]) {
  const repeat = new Map<string, number>()
  const hidden = new Set<string>()
  let signature: string | null = null
  let head: string | null = null

  for (const part of parts) {
    if (part.type !== "tool" || part.status !== "error") {
      signature = null
      head = null
      continue
    }

    const next = `${part.tool}|${part.error ?? ""}`
    if (signature === next && head) {
      repeat.set(head, (repeat.get(head) ?? 1) + 1)
      hidden.add(part.id)
      continue
    }

    signature = next
    head = part.id
  }

  return { repeat, hidden }
}

/** You are a framed caret, the agent is a level meter. Two marks, no legend. */
function Avatar({ isUser, running }: { isUser: boolean; running: boolean }) {
  if (isUser) {
    return (
      <span title="你" className="s-card mt-0.5 flex size-[22px] shrink-0 items-center justify-center">
        {/* the caret is the only interior the frame gets — the word appears
            once, in the row label */}
        <span className="h-[3px] w-[9px] bg-s-ember" />
      </span>
    )
  }
  return <StatusMark state={running ? "working" : "done"} size={22} />
}

/** First run: introduce the thing rather than leaving a grey rectangle. */
function Welcome({ onExample }: { onExample?: (text: string) => void }) {
  return (
    <Card className="s-enter overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-s-line bg-s-rail px-3 py-2.5">
        <StatusMark state="idle" size={30} />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-[14px] font-semibold tracking-tight text-s-bright">goto</span>
          <Label className="text-s-faint">本地智能体 · 不上传任何数据</Label>
        </div>
      </div>

      <div className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
          <Label className="text-s-soft">可以做什么</Label>
          <div className="s-hair min-w-0 flex-1" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          {CAPABILITIES.map((item) => (
            <div key={item.text} className="flex items-center gap-1.5 text-s-soft">
              <Icon name={item.icon} size={13} className="text-s-faint" />
              {item.text}
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
          <Label className="text-s-soft">{onExample ? "点一下就填进输入框" : "试着问"}</Label>
          <div className="s-hair min-w-0 flex-1" />
        </div>
        <div className="mt-2 flex flex-col gap-1">
          {EXAMPLES.map((example) =>
            onExample ? (
              <button
                key={example}
                type="button"
                onClick={() => onExample(example)}
                title="填进输入框，改一改再发"
                className="s-btn s-btn--ghost min-h-0 justify-start px-2 py-1 text-left text-s-body hover:text-s-bright"
              >
                <Icon name="chevronRight" size={13} className="text-s-ember" />
                <span className="min-w-0 truncate">{example}</span>
              </button>
            ) : (
              <div key={example} className="text-s-body">
                <span className="text-s-ember">&gt; </span>
                {example}
              </div>
            ),
          )}
        </div>
      </div>
    </Card>
  )
}

export default function MessageList({
  messages,
  running,
  onEdit,
  onExample,
}: {
  messages: Message[]
  running: boolean
  onEdit?: (message: Message) => void
  /** one click on a starter example should be enough to get going */
  onExample?: (text: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const el = containerRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, running])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div
        className={cx(
          "mx-auto flex max-w-3xl flex-col gap-4",
          // an empty transcript is mostly floor; centring the one card in it reads as
          // "nothing yet" rather than "something failed to load"
          messages.length === 0 && "min-h-full justify-center",
        )}
      >
        {messages.length === 0 ? <Welcome onExample={onExample} /> : null}

        {messages.map((message, index) => {
          const compaction = message.parts.find(
            (part): part is CompactionPart => part.type === "compaction",
          )
          if (compaction) return <CompactionCard key={message.id} part={compaction} />

          const isUser = message.role === "user"
          const first = message.parts[0]
          const inline = isUser && first?.type === "text"
          const rest = inline ? message.parts.slice(1) : message.parts
          const folded = foldRepeatedErrors(rest)
          // the last agent message is the one still being written
          const live = !isUser && running && index === messages.length - 1

          return (
            <div key={message.id} className="flex gap-2.5">
              <Avatar isUser={isUser} running={live} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Label className={isUser ? "text-s-ember" : "text-s-soft"}>{isUser ? "你" : "agent"}</Label>
                  <Label className="text-s-faint">#{String(index + 1).padStart(3, "0")}</Label>
                  {isUser && onEdit && first?.type === "text" ? (
                    <Btn
                      sm
                      icon="pencil"
                      onClick={() => onEdit(message)}
                      title="重新编辑并发出（会先停掉正在跑的任务）"
                    >
                      重编辑
                    </Btn>
                  ) : null}
                  <div className="s-hair min-w-0 flex-1" />
                </div>

                {inline && first.type === "text" ? (
                  /* You get a filled block with an accent spine. The agent never gets a
                     bubble — its words are the page, which separates the two voices
                     without colour-coding every line of the transcript. */
                  <div className="s-card mt-1 flex overflow-hidden">
                    <span className="w-0.5 shrink-0 bg-s-ember" />
                    <div className="min-w-0 flex-1 px-2.5 py-1.5 whitespace-pre-wrap text-s-bright">
                      {first.text}
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 text-s-faint">{live ? <span className="s-pulse">▌</span> : null}</div>
                )}

                {rest.length > 0 ? (
                  <div className="mt-1.5 flex flex-col gap-2">
                    {rest.map((part) => {
                      if (part.type === "text") {
                        return part.text ? <Markdown key={part.id} text={part.text} /> : null
                      }
                      if (part.type === "reasoning") {
                        // collapsed by default: it is worth having, but it is not the answer
                        return (
                          <details key={part.id} className="s-card overflow-hidden">
                            <summary className="cursor-pointer px-2.5 py-1.5 text-s-soft transition-colors hover:text-s-bright">
                              <span className="s-tag">思考过程</span>
                              <span className="text-s-faint">{part.text ? `${part.text.length} 字` : "…"}</span>
                              {running ? <span className="s-pulse text-s-warn">生成中</span> : null}
                            </summary>
                            <div className="whitespace-pre-wrap border-t border-s-line px-2.5 py-1.5 leading-[1.7] text-s-faint">
                              {part.text || "（暂无内容）"}
                            </div>
                          </details>
                        )
                      }
                      if (part.type === "tool") {
                        if (folded.hidden.has(part.id)) return null
                        return <ToolCard key={part.id} part={part} repeat={folded.repeat.get(part.id) ?? 1} />
                      }
                      if (part.type === "file") {
                        return (
                          <a
                            key={part.id}
                            href={`/api/files/${part.fileID}`}
                            target="_blank"
                            rel="noreferrer"
                            title={`${part.filename} · ${Math.round(part.size / 1024)}KB · ${part.mime}`}
                            className="s-card inline-block w-fit overflow-hidden transition-colors hover:border-s-ember"
                          >
                            <img
                              src={`/api/files/${part.fileID}`}
                              alt={part.filename}
                              className="max-h-64 max-w-full object-contain"
                            />
                          </a>
                        )
                      }
                      return <CompactionCard key={part.id} part={part} />
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}

        {running ? (
          <div className="flex items-center gap-2">
            <StatusMark state="working" size={18} />
            <Label className="s-pulse text-s-warn">处理中</Label>
            <div className="s-hair min-w-0 flex-1" />
          </div>
        ) : null}
      </div>
    </div>
  )
}
