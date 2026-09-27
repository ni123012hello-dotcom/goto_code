import { useState } from "react"
import type { ToolPart } from "@shared/protocol"
import { Band, Chip, Icon, Label, cx } from "../ui"
import Diff from "./Diff"

/** Status is a solid chip: a tool call that failed should be visible from the
 *  scrollbar, not discovered after opening the card. */
function StatusTag({ status }: { status: ToolPart["status"] }) {
  if (status === "running") {
    return (
      <Chip tone="warn" filled className="s-pulse">
        运行中
      </Chip>
    )
  }
  if (status === "error") {
    return (
      <Chip tone="bad" filled>
        失败
      </Chip>
    )
  }
  return (
    <Chip tone="ok" filled>
      完成
    </Chip>
  )
}

export default function ToolCard({ part, repeat = 1 }: { part: ToolPart; repeat?: number }) {
  const [open, setOpen] = useState(part.status === "running" || part.status === "error")
  const input = (part.input ?? {}) as Record<string, unknown>
  const command = typeof input.command === "string" ? input.command : null
  const rest = Object.entries(input).filter(([key]) => key !== "command")

  const diffStats = part.diff
    ? part.diff.split("\n").reduce(
        (acc, line) => {
          if (line.startsWith("+++") || line.startsWith("---")) return acc
          if (line.startsWith("+")) acc.added += 1
          else if (line.startsWith("-")) acc.removed += 1
          return acc
        },
        { added: 0, removed: 0 },
      )
    : null

  return (
    <div className="s-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-s-raise"
      >
        <Icon
          name={open ? "chevronDown" : "chevronRight"}
          size={12}
          className="shrink-0 text-s-faint"
        />
        <StatusTag status={part.status} />
        {part.compactedAt ? <Chip tone="neutral">已清除</Chip> : null}
        <Label caps={false} className="text-s-bright">
          {part.tool}
        </Label>
        <span className="min-w-0 flex-1 truncate text-s-soft">{command ?? part.title ?? ""}</span>
        {diffStats ? (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-s-moss">+{diffStats.added}</span>
            <span className="text-s-faint"> / </span>
            <span className="text-s-rust">-{diffStats.removed}</span>
          </span>
        ) : null}
        {repeat > 1 ? (
          <Chip tone="bad" filled title={`连续 ${repeat} 次相同的失败，已折叠`}>
            ×{repeat}
          </Chip>
        ) : null}
      </button>

      {open ? (
        <div className="space-y-2 border-t border-s-line px-2.5 py-2">
          {command ? (
            <div className="flex items-start gap-1.5 overflow-x-auto whitespace-pre font-mono">
              <span className="text-s-ember">&gt;</span>
              <span className="text-s-bright">{command}</span>
            </div>
          ) : null}

          {rest.length > 0 ? (
            /* A full JSON dump per card is the single biggest source of vertical
               noise in the transcript, and the useful argument is already inline. */
            <details>
              <summary className="cursor-pointer list-none text-s-faint transition-colors hover:text-s-soft">
                <span className="s-tag">参数 · {rest.length} 项</span>
              </summary>
              <pre className="s-well mt-1 overflow-x-auto p-2 text-s-soft">
                {JSON.stringify(Object.fromEntries(rest), null, 2)}
              </pre>
            </details>
          ) : null}

          {part.diff ? (
            <Band label="diff" note={diffStats ? `+${diffStats.added} / -${diffStats.removed}` : undefined}>
              <Diff patch={part.diff} />
            </Band>
          ) : null}

          {part.output ? (
            <Band label="stdout" note={part.compactedAt ? "已从上下文清除，仅本地可见" : undefined}>
              <pre
                className={cx(
                  "s-well max-h-72 overflow-auto whitespace-pre-wrap p-2 leading-[1.5]",
                  part.compactedAt ? "text-s-faint" : "text-s-soft",
                )}
              >
                {part.output}
              </pre>
            </Band>
          ) : null}

          {part.error ? (
            <Band label="error" tone="bad">
              <div className="flex">
                <div className="s-mark w-1 shrink-0" />
                <pre className="max-h-72 min-w-0 flex-1 overflow-auto border border-s-rust/40 border-l-0 bg-s-rust/5 p-2 whitespace-pre-wrap text-s-rust">
                  {part.error}
                </pre>
              </div>
            </Band>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
