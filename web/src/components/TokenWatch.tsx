import { useMemo, useState } from "react"
import type { CompactionPart, Message, TokenUsage } from "@shared/protocol"
import type { ContextInfo } from "../api"
import { Icon, Label, Led, cx } from "../ui"

const CHARS_PER_TOKEN = 4
const stroke = { vectorEffect: "non-scaling-stroke" } as const

/* The chart paints itself, so it cannot use Tailwind classes — but it can read
   the same tokens. SVG `fill` / `stroke` accept var(), so both palettes work
   with no colour in this file at all. */
const COLOR = {
  user: "var(--color-s-ember)",
  agent: "var(--color-s-soft)",
  tools: "var(--color-s-faint)",
  summary: "var(--color-s-warn)",
  free: "var(--color-s-line)",
  ok: "var(--color-s-moss)",
  warn: "var(--color-s-warn)",
  bad: "var(--color-s-rust)",
  line: "var(--color-s-edge)",
  grid: "var(--color-s-line)",
  well: "var(--color-s-well)",
}

const estimate = (text: string) => Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))

function fmt(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—"
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function usageCount(tokens: TokenUsage): number {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

type Segment = { key: string; label: string; tokens: number; color: string }

/** The panel's one graphic: the cache-hit rate as a filled track, so the length is the
 *  percentage and 100% fills it.
 *
 *  A cached prompt is still a prompt - those tokens are re-sent on every request and still
 *  occupy the window - so this is not "context that got dropped", it is the share of the
 *  input the provider recognised and billed at the cheaper rate. */
function HitBar({ ratio, hasData }: { ratio: number; hasData: boolean }) {
  const percent = Math.round(ratio * 100)
  const color = !hasData ? COLOR.line : ratio >= 0.8 ? COLOR.ok : ratio >= 0.4 ? COLOR.warn : COLOR.bad

  return (
    <span className="s-well block h-3 w-full overflow-hidden rounded-none">
      <span
        className="block h-full transition-[width] duration-300"
        style={{ width: hasData ? `${percent}%` : "0%", backgroundColor: color }}
      />
    </span>
  )
}

function Sparkline({
  points,
  budget,
  color,
}: {
  points: { value: number; compacted: boolean }[]
  budget: number
  color: string
}) {
  const W = 1000
  const H = 46
  const pad = 3

  if (points.length === 0) {
    return <div className="s-well flex h-[46px] items-center justify-center text-s-faint">尚无用量数据</div>
  }

  const max = Math.max(budget, ...points.map((point) => point.value), 1)
  const x = (index: number) => (points.length <= 1 ? W / 2 : (index / (points.length - 1)) * W)
  const y = (value: number) => H - pad - (value / max) * (H - pad * 2)

  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`)
    .join(" ")
  const area = `${line} L${W},${H} L0,${H} Z`
  const budgetY = y(budget)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="s-well h-[46px] w-full" role="img">
      <defs>
        <linearGradient id="tw-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>

      <rect x={0} y={0} width={W} height={H} fill={COLOR.well} />
      {[0.25, 0.5, 0.75].map((fraction) => (
        <line
          key={fraction}
          x1={0}
          y1={H * fraction}
          x2={W}
          y2={H * fraction}
          stroke={COLOR.grid}
          strokeWidth={1}
          {...stroke}
        />
      ))}

      <path d={area} fill="url(#tw-area)" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} {...stroke} />

      <line
        x1={0}
        y1={budgetY}
        x2={W}
        y2={budgetY}
        stroke={COLOR.warn}
        strokeWidth={1}
        strokeDasharray="4 4"
        {...stroke}
      />

      {points.map((point, index) =>
        point.compacted ? (
          <rect key={index} x={x(index) - 1.5} y={0} width={3} height={H} fill={COLOR.summary} opacity={0.8} />
        ) : null,
      )}

      {points.map((point, index) => (
        <circle key={index} cx={x(index)} cy={y(point.value)} r={2} fill={color} {...stroke} />
      ))}

      <rect x={0} y={0} width={W} height={H} fill="none" stroke={COLOR.line} strokeWidth={1} {...stroke} />
    </svg>
  )
}

/** Composition as percentages rather than a bar - the bar is the cache-hit meter now. The
 *  denominator is the composed sum (not the budget) so the four shares add up to 100%. */
function Legend({ segments, free, total }: { segments: Segment[]; free: number; total: number }) {
  const denom = total > 0 ? total : 1

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {segments.map((segment) => (
        <span key={segment.key} className="flex shrink-0 items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ backgroundColor: segment.color }} />
          <Label className="text-s-faint">{segment.label}</Label>
          <span className="text-s-body">{Math.round((segment.tokens / denom) * 100)}%</span>
          <Label className="text-s-faint">~{fmt(segment.tokens)}</Label>
        </span>
      ))}
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ backgroundColor: COLOR.free }} />
        <Label className="text-s-faint">剩余</Label>
        <span className="text-s-soft">~{fmt(free)}</span>
      </span>
    </div>
  )
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <Label className="text-s-faint">{label}</Label>
      <span className={cx("text-s-body", className)}>{value}</span>
    </span>
  )
}

export default function TokenWatch({
  messages,
  context,
  running,
  lastTurnMs,
}: {
  messages: Message[]
  context: ContextInfo | null
  running: boolean
  lastTurnMs: number | null
}) {
  // Two bars plus a legend is ~110px of chrome. At 3% usage that is a lot of empty black
  // rectangle, so the panel stays folded until there is something to look at; the header
  // still carries the percentage either way, and an explicit toggle wins from then on.
  const [override, setOverride] = useState<boolean | null>(null)

  const stats = useMemo(() => {
    const folded = new Set<string>()
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "compaction") continue
        for (const id of part.foldedMessageIDs) folded.add(id)
      }
    }

    let usage: TokenUsage | undefined
    let compaction: CompactionPart | undefined

    const composition = { user: 0, agent: 0, tools: 0, summary: 0 }
    let pruned = 0

    for (const message of messages) {
      const own = message.parts.find(
        (candidate): candidate is CompactionPart => candidate.type === "compaction",
      )
      if (own) compaction = own

      const isFolded = folded.has(message.id)
      // a summary that was itself folded into a later one must not be counted twice
      if (own && !isFolded) composition.summary += estimate(own.summary)
      if (isFolded) continue

      for (const part of message.parts) {
        if (part.type === "text") {
          const tokens = estimate(part.text)
          if (message.role === "user") composition.user += tokens
          else composition.agent += tokens
          continue
        }

        if (part.type === "tool") {
          if (part.compactedAt) pruned += 1
          else composition.tools += estimate(part.output ?? "")
        }
      }
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].tokens) {
        usage = messages[index].tokens
        break
      }
    }

    const series = messages.flatMap((message) => {
      if (!message.tokens) return []
      return [
        {
          value: usageCount(message.tokens),
          compacted: message.parts.some((part) => part.type === "compaction"),
        },
      ]
    })

    const segments: Segment[] = [
      { key: "user", label: "你", tokens: composition.user, color: COLOR.user },
      { key: "agent", label: "智能体", tokens: composition.agent, color: COLOR.agent },
      { key: "tools", label: "工具输出", tokens: composition.tools, color: COLOR.tools },
      { key: "summary", label: "压缩摘要", tokens: composition.summary, color: COLOR.summary },
    ]

    return { usage, compaction, pruned, segments, series, messageCount: messages.length }
  }, [messages])

  const budget = context?.budget ?? 0
  const composed = stats.segments.reduce((sum, segment) => sum + segment.tokens, 0)
  const count = stats.usage ? usageCount(stats.usage) : composed
  const free = Math.max(0, budget - composed)
  const ratio = budget > 0 ? Math.min(1, count / budget) : 0
  const percent = Math.round(ratio * 100)
  const peak = stats.series.reduce((max, point) => Math.max(max, point.value), 0)

  const tone = percent >= 90 ? "text-s-rust" : percent >= 70 ? "text-s-warn" : "text-s-moss"
  const chartColor = percent >= 90 ? COLOR.bad : percent >= 70 ? COLOR.warn : COLOR.ok
  // cache.read is a subset of input (prompt_tokens_details.cached_tokens), so the hit rate is
  // over `input`. Dividing by the running total used to fold the output tokens into the
  // denominator, which read low.
  const hitRate =
    stats.usage && stats.usage.input > 0
      ? Math.min(1, Math.max(0, stats.usage.cache.read / stats.usage.input))
      : 0
  const hitPercent = Math.round(hitRate * 100)

  const worthOpening = percent >= 25 || stats.compaction != null || stats.pruned > 0 || stats.series.length >= 3
  const open = override ?? worthOpening

  return (
    <div className="shrink-0 border-t border-s-line bg-s-panel">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        title="上下文占用：正在发送的内容有多大，以及它是怎么构成的"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-s-card"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className="shrink-0 text-s-faint" />
        <Led tone={percent >= 90 ? "bad" : percent >= 70 ? "warn" : "ok"} pulse={running} />
        <Label className="text-s-bright">上下文占用</Label>
        <Label className={running ? "s-pulse text-s-warn" : "text-s-faint"}>
          {running ? "实时" : "空闲"}
        </Label>
        <div className="s-hair min-w-0 flex-1" />
        <Label className={tone}>{percent}%</Label>
        {/* folded, the header still needs to answer "how full" at a glance */}
        {!open ? (
          <span className="s-well h-2 w-24 shrink-0 overflow-hidden rounded-none">
            <span
              className="block h-full"
              style={{ width: `${Math.min(100, Math.max(2, percent))}%`, backgroundColor: chartColor }}
            />
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="space-y-1.5 border-t border-s-line px-3 py-2">
          <div className="flex items-baseline gap-2">
            <Label className="text-s-faint">构成</Label>
            <div className="min-w-0 flex-1" />
            <span className={cx("shrink-0", tone)}>
              {fmt(count)} / {fmt(budget)}
            </span>
          </div>

          <Legend segments={stats.segments} free={free} total={composed} />

          <div className="flex items-baseline gap-2 pt-1">
            <Label className="text-s-faint">缓存命中</Label>
            <Label className="text-s-faint">已缓存 / 输入</Label>
            <div className="min-w-0 flex-1" />
            <span className="shrink-0 text-s-soft">
              {stats.usage ? `${fmt(stats.usage.cache.read)} / ${fmt(stats.usage.input)}` : "—"}
            </span>
            <span className={cx("w-10 shrink-0 text-right", hitPercent > 0 ? "text-s-moss" : "text-s-faint")}>
              {stats.usage ? `${hitPercent}%` : "—"}
            </span>
          </div>

          <HitBar ratio={hitRate} hasData={stats.usage != null} />

          <div className="flex items-baseline gap-2 pt-1">
            <Label className="text-s-faint">趋势</Label>
            <Label className="text-s-faint">每轮</Label>
            <div className="min-w-0 flex-1" />
            <span className="shrink-0 text-s-soft">
              {stats.series.length} samples · peak {fmt(peak)}
            </span>
          </div>

          <Sparkline points={stats.series} budget={budget} color={chartColor} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
            <Stat label="in" value={stats.usage ? fmt(stats.usage.input) : "—"} />
            <Stat label="out" value={stats.usage ? fmt(stats.usage.output) : "—"} />
            {stats.usage && stats.usage.reasoning > 0 ? (
              <Stat label="think" value={fmt(stats.usage.reasoning)} />
            ) : null}
            {stats.compaction ? (
              <Stat
                label="compacted"
                value={`${stats.compaction.foldedCount} msgs · ${fmt(stats.compaction.tokensBefore)} → ${fmt(stats.compaction.tokensAfter)}`}
              />
            ) : null}
            {stats.pruned > 0 ? <Stat label="pruned" value={String(stats.pruned)} /> : null}
            <Stat label="last" value={fmtMs(lastTurnMs)} />
            {/* Where the window came from. "全局默认" is worth flagging rather than hiding:
                it means nobody knows this model's real window, which is the state that makes
                the budget wrong in the first place. */}
            {context ? (
              <Stat
                label="上限"
                value={
                  context.limitsFrom === "user"
                    ? "你填的"
                    : context.limitsFrom === "registry"
                      ? `目录${context.registry?.fetchedAt ? ` ${context.registry.fetchedAt}` : ""}`
                      : "全局默认（未识别）"
                }
                className={context.limitsFrom === "default" ? "text-s-warn" : undefined}
              />
            ) : null}
            {context && !context.auto ? <Label className="text-s-warn">自动压缩已关</Label> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
