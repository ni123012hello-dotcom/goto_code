import { useState } from "react"
import type { CompactionPart } from "@shared/protocol"
import { Band, Btn, Chip, Icon, Label, Well } from "../ui"
import Markdown from "./Markdown"

const CELLS = 24

function fmt(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}

/** A compression event, drawn as a meter that visibly lost weight. */
export default function CompactionCard({ part }: { part: CompactionPart }) {
  const [open, setOpen] = useState(false)

  const saved = Math.max(0, part.tokensBefore - part.tokensAfter)
  const ratio = part.tokensBefore > 0 ? Math.min(1, part.tokensAfter / part.tokensBefore) : 1
  const filled = Math.max(0, Math.min(CELLS, Math.round(ratio * CELLS)))
  const percent = part.tokensBefore > 0 ? Math.round((1 - ratio) * 100) : 0
  const changed = part.addedMemories.length + part.invalidatedMemories.length

  return (
    <div className="s-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-s-raise"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className="shrink-0 text-s-faint" />
        <Chip tone="neutral">压缩</Chip>
        <span className="shrink-0 text-s-soft">{part.foldedCount} 条 → 摘要</span>
        <span className="min-w-0 flex-1 truncate text-s-faint">
          {fmt(part.tokensBefore)} → {fmt(part.tokensAfter)} tok
          {saved > 0 ? ` · 省 ${fmt(saved)}` : ""}
          {changed > 0 ? ` · 记忆 ${changed} 处变动` : ""}
        </span>
      </button>

      {/* the meter: filled cells are what survived, empty cells are what was cut */}
      <div className="flex items-center gap-2 border-t border-s-line px-2.5 py-1.5">
        <span className="flex shrink-0 gap-px">
          {Array.from({ length: CELLS }, (_, index) => (
            <span
              key={index}
              className="h-3 w-1.5"
              style={{
                backgroundColor: index < filled ? "var(--color-s-moss)" : "var(--color-s-line)",
              }}
            />
          ))}
        </span>
        <div className="s-hair min-w-0 flex-1" />
        <Label className="text-s-moss">-{percent}%</Label>
      </div>

      {open ? (
        <div className="space-y-2 border-t border-s-line px-2.5 py-2">
          {part.addedMemories.length > 0 ? (
            <div>
              <Band label="mem+" tone="ok" />
              <div className="mt-1">
                {part.addedMemories.map((entry, index) => (
                  <div key={index} className="flex items-baseline gap-1.5 text-s-moss">
                    <span className="s-led mt-1.5" style={{ backgroundColor: "var(--color-s-moss)" }} />
                    <span className="min-w-0 flex-1">
                      {entry.key ? <span className="text-s-faint">{entry.key} :: </span> : null}
                      {entry.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {part.invalidatedMemories.length > 0 ? (
            <div>
              <Band label="mem-" tone="bad" />
              <div className="mt-1">
                {part.invalidatedMemories.map((entry, index) => (
                  <div key={index} className="flex items-baseline gap-1.5 text-s-rust">
                    <span className="s-led mt-1.5" style={{ backgroundColor: "var(--color-s-rust)" }} />
                    <span className="min-w-0 flex-1">
                      {entry.key ? <span className="text-s-faint">{entry.key} :: </span> : null}
                      {entry.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <Band label="summary">
            <Well className="px-2.5 py-2">
              <Markdown text={part.summary} />
            </Well>
          </Band>

          <div className="flex justify-end">
            <Btn sm onClick={() => setOpen(false)}>
              收起
            </Btn>
          </div>
        </div>
      ) : null}
    </div>
  )
}
