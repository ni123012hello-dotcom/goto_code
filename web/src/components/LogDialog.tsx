import { useEffect, useMemo, useRef, useState } from "react"
import type { LogEntry, LogEvent, LogLevel } from "@shared/protocol"
import { api, type LogView } from "../api"
import { withToken } from "../auth"
import { Btn, Empty, Label, Led, Modal, Notice, cx } from "../ui"

type Props = {
  onClose: () => void
}

const MAX_ROWS = 3000

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const FILTERS: (LogLevel | "all")[] = ["all", "debug", "info", "warn", "error"]
/** The wire format stays English; only what the user reads is translated. */
const FILTER_LABEL: Record<LogLevel | "all", string> = {
  all: "全部",
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误",
}

function stamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function summarize(data?: Record<string, unknown>): string {
  if (!data) return ""
  const parts: string[] = []

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") continue
    let rendered: string
    if (typeof value === "string") rendered = value
    else if (typeof value === "object") rendered = JSON.stringify(value)
    else rendered = String(value)
    if (!rendered) continue
    parts.push(`${key}=${rendered}`)
  }

  return parts.join("  ")
}

/** A fixed-width level column, so the message column never jitters as rows stream in. */
function LevelTag({ level }: { level: LogLevel }) {
  const cls =
    level === "error"
      ? "bg-s-rust text-s-on-rust"
      : level === "warn"
        ? "bg-s-warn text-s-on-ember"
        : level === "info"
          ? "text-s-soft"
          : "text-s-faint"
  return <span className={cx("s-tag w-10 shrink-0 text-center", cls)}>{level}</span>
}

export default function LogDialog({ onClose }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [meta, setMeta] = useState<LogView | null>(null)
  const [filter, setFilter] = useState<LogLevel | "all">("all")
  const [search, setSearch] = useState("")
  const [follow, setFollow] = useState(true)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    stickRef.current = follow
  }, [follow])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const view = await api.logs(500)
        if (cancelled) return
        setMeta(view)
        setEntries(view.entries)
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()

    const source = new EventSource(withToken("/api/logs/stream"))
    source.onopen = () => setLive(true)
    source.onerror = () => setLive(false)
    source.addEventListener("message", (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as LogEvent
        if (event.type === "log.snapshot") {
          setEntries(event.entries)
          setLive(true)
          return
        }
        setEntries((prev) => {
          const next = [...prev, event.entry]
          return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
        })
      } catch {
        return
      }
    })

    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [entries])

  const visible = useMemo(() => {
    const min = filter === "all" ? 0 : RANK[filter]
    const needle = search.trim().toLowerCase()

    return entries.filter((entry) => {
      if (RANK[entry.level] < min) return false
      if (!needle) return true
      const haystack = `${entry.scope} ${entry.message} ${summarize(entry.data)}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [entries, filter, search])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (!atBottom && follow) setFollow(false)
  }

  const counts = useMemo(() => {
    const tally: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 }
    for (const entry of entries) tally[entry.level] += 1
    return tally
  }, [entries])

  return (
    <Modal
      title="运行日志"
      note="应用启动与请求过程，实时接收"
      onClose={onClose}
      className="max-w-5xl"
      bodyClassName="flex min-h-0 flex-col p-0"
      footerNote={
        <>
          {visible.length} / {entries.length} 条
          {meta ? ` · level ${meta.level} · ${(meta.maxBytes / 1024 / 1024).toFixed(1)}MB × ${meta.keepFiles} 轮转` : ""}
        </>
      }
      footer={
        <span className="min-w-0 truncate font-mono text-[10px] text-s-faint" title={meta?.file ?? ""}>
          {meta?.file ?? ""}
        </span>
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-s-line px-3 py-1.5">
        <Led tone={live ? "ok" : "bad"} pulse={live} />
        <Label className={live ? "text-s-moss" : "text-s-rust"}>{live ? "实时接收中" : "连接已断开"}</Label>
        <div className="s-hair min-w-0 flex-1" />
        <Label className="text-s-faint">只显示最近 {MAX_ROWS} 条</Label>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-s-line px-3 py-1.5">
        {FILTERS.map((item) => (
          <Btn key={item} sm on={filter === item} onClick={() => setFilter(item)}>
            {FILTER_LABEL[item]}
            {item !== "all" ? ` ${counts[item]}` : ` ${entries.length}`}
          </Btn>
        ))}

        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="过滤 scope / message / 字段"
          className="s-input min-w-[12rem] flex-1 px-2 py-0.5 text-s-body"
        />

        <Btn sm icon="refresh" on={follow} onClick={() => setFollow((value) => !value)} variant={follow ? "ok" : "plain"}>
          {follow ? "跟随中" : "已暂停"}
        </Btn>

        <Btn sm className="hover:text-s-rust" onClick={() => setEntries([])}>
          清空
        </Btn>
      </div>

      <div ref={containerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto bg-s-well">
        {visible.length === 0 ? (
          <Empty>{entries.length === 0 ? "暂无日志" : `已过滤掉全部 ${entries.length} 条`}</Empty>
        ) : (
          <div className="divide-y divide-s-line/40">
            {visible.map((entry) => (
              <div
                key={entry.seq}
                className="flex items-baseline gap-2 px-3 py-[3px] font-mono hover:bg-s-panel"
              >
                <span className="shrink-0 text-s-faint">{stamp(entry.ts)}</span>
                <LevelTag level={entry.level} />
                <Label className="w-16 shrink-0 truncate text-s-ember">{entry.scope}</Label>
                <span className="shrink-0 text-s-body">{entry.message}</span>
                <span className="min-w-0 flex-1 truncate text-s-faint">{summarize(entry.data)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error ? <Notice tone="bad" label="err">{error}</Notice> : null}
    </Modal>
  )
}
