import { useCallback, useEffect, useState } from "react"
import type { MemorySource, MemoryStatus } from "@shared/protocol"
import { api, type MemoryConflict, type MemoryEntry, type MemoryEntryInput, type MemoryView } from "../api"
import { Btn, Chip, Label, Modal, Notice, Rule, cx } from "../ui"

type Props = {
  sessionID: string
  onClose: () => void
  onDirty: () => void
}

type Row = {
  uid: string
  id?: string
  key: string
  value: string
  source: MemorySource
  status: MemoryStatus
  stale: boolean
}

type Tier = "pending" | "verified" | "inferred" | "stale"

const SOURCE_ORDER: MemorySource[] = ["user", "probe", "tool", "inferred"]

const SOURCE_TONE: Record<MemorySource, string> = {
  user: "text-s-ember",
  probe: "text-s-moss",
  tool: "text-s-soft",
  inferred: "text-s-faint",
}

/** The wire value stays English; what the user reads does not. */
const SOURCE_LABEL: Record<MemorySource, string> = {
  user: "用户声明",
  probe: "实测",
  tool: "工具",
  inferred: "推断",
}

let sequence = 0
const nextUid = () => `row-${(sequence += 1)}`
const number = (value: number) => `#${String(value).padStart(2, "0")}`

function tierOf(row: Row): Tier {
  if (row.status === "pending") return "pending"
  if (row.stale) return "stale"
  return row.source === "inferred" ? "inferred" : "verified"
}

function toRows(entries: MemoryEntry[]): Row[] {
  return entries.map((entry) => ({
    uid: nextUid(),
    id: entry.id,
    key: entry.key,
    value: entry.value,
    source: entry.source,
    status: entry.status,
    stale: entry.stale,
  }))
}

function MemoryRow({
  row,
  index,
  selected,
  editing,
  onSelect,
  onEdit,
  onDone,
  onChange,
  onDelete,
  onApprove,
  onReject,
}: {
  row: Row
  index: number
  selected: boolean
  editing: boolean
  onSelect: () => void
  onEdit: () => void
  onDone: () => void
  onChange: (patch: Partial<Row>) => void
  onDelete: () => void
  onApprove: () => void
  onReject: () => void
}) {
  if (editing) {
    return (
      <div className="flex items-center gap-2 border border-s-ember bg-s-well px-2 py-1.5">
        <Label className="text-s-ember">{number(index + 1)}</Label>

        <input
          value={row.key}
          onChange={(event) => onChange({ key: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") onDone()
          }}
          placeholder="标签（可选）"
          className="s-input w-36 shrink-0 px-1.5 py-0.5 text-s-soft"
        />

        <input
          value={row.value}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onChange({ value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Enter") onDone()
          }}
          placeholder="内容（留空则该条在保存时被丢弃）"
          className="s-input min-w-0 flex-1 px-1.5 py-0.5"
        />

        <Btn
          sm
          className={cx("s-tag", SOURCE_TONE[row.source])}
          onClick={() =>
            onChange({
              source: SOURCE_ORDER[(SOURCE_ORDER.indexOf(row.source) + 1) % SOURCE_ORDER.length],
              stale: false,
            })
          }
          title="切换来源：用户声明 / 实测 / 工具 / 推断"
        >
          {SOURCE_LABEL[row.source]}
        </Btn>

        <Btn
          sm
          className={cx("s-tag", row.status === "pending" ? "text-s-warn" : "text-s-faint")}
          onClick={() => onChange({ status: row.status === "pending" ? "active" : "pending" })}
          title="切换状态：active（进 prompt）/ pending（待确认）"
        >
          {row.status === "pending" ? "待确认" : "生效"}
        </Btn>

        <Btn sm icon="check" onClick={onDone} title="改完了">
          完成
        </Btn>

        <Btn sm icon="trash" className="text-s-rust" onClick={onDelete} title="删掉这一条">
          删除
        </Btn>
      </div>
    )
  }

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => (selected ? onEdit() : onSelect())}
        className={cx(
          "flex min-w-0 flex-1 items-baseline gap-2 border-l-2 px-2 py-0.5 text-left transition-colors",
          selected ? "border-s-ember bg-s-card" : "border-transparent hover:bg-s-card",
        )}
      >
        <Label className={selected ? "text-s-ember" : "text-s-faint"}>{number(index + 1)}</Label>
        <Label className={cx("w-16", SOURCE_TONE[row.source])}>{SOURCE_LABEL[row.source]}</Label>
        {row.key ? <span className="shrink-0 text-s-soft">{row.key}</span> : null}
        {row.key ? <span className="shrink-0 text-s-faint">::</span> : null}
        <span className={cx("min-w-0 flex-1 truncate", row.stale ? "text-s-faint line-through" : "text-s-body")}>
          {row.value || <span className="text-s-faint">(空)</span>}
        </span>
        <Label className="text-s-faint">{selected ? "再点一次编辑" : ""}</Label>
      </button>

      {row.status === "pending" ? (
        <div className="flex shrink-0 items-center gap-1 px-1">
          <Btn
            sm
            variant="ok"
            className="s-tag"
            onClick={onApprove}
            title="批准：标记为 user 来源并注入 prompt"
          >
            批准
          </Btn>
          <Btn sm className="s-tag text-s-rust" onClick={onReject} title="移除这条提议">
            移除
          </Btn>
        </div>
      ) : null}
    </div>
  )
}

export default function MemoryDialog({ sessionID, onClose, onDirty }: Props) {
  const [rows, setRows] = useState<Row[]>([])
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([])
  const [path, setPath] = useState("")
  const [tokens, setTokens] = useState(0)
  const [ttlTurns, setTtlTurns] = useState(20)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [editingUid, setEditingUid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const apply = (view: MemoryView) => {
    setRows(toRows(view.entries))
    setConflicts(view.conflicts)
    setPath(view.path)
    setTokens(view.tokens)
    setTtlTurns(view.ttlTurns)
    setSelectedUid(null)
    setEditingUid(null)
  }

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      apply(await api.memory(sessionID))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [sessionID])

  useEffect(() => {
    void load()
  }, [load])

  const tierRows: Record<Tier, Row[]> = {
    pending: rows.filter((row) => tierOf(row) === "pending"),
    verified: rows.filter((row) => tierOf(row) === "verified"),
    inferred: rows.filter((row) => tierOf(row) === "inferred"),
    stale: rows.filter((row) => tierOf(row) === "stale"),
  }

  const ordered = [...tierRows.pending, ...tierRows.verified, ...tierRows.inferred, ...tierRows.stale]

  const tiers: { key: Tier; label: string; note: string; add?: MemorySource }[] = [
    ...(tierRows.pending.length > 0
      ? [
          {
            key: "pending" as Tier,
            label: "待确认",
            note: `agent 提取，未进入 prompt — 批准后生效；${ttlTurns} 轮不理会自动清除`,
          },
        ]
      : []),
    {
      key: "verified",
      label: "已确认",
      note: "实测（probe）/ 工具输出 / 你声明的 — 会被当作事实采信",
      add: "user",
    },
    {
      key: "inferred",
      label: "AI 推断",
      note: "未经核实 — 注入时会标注，让 agent 自己再验证",
      add: "inferred",
    },
    {
      key: "stale",
      label: "已证伪",
      note: "与工作区实际情况冲突 — 不会被执行，只用于避免重新推断",
    },
  ]

  const update = (uid: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((row) => (row.uid === uid ? { ...row, ...patch } : row)))

  const remove = (uid: string) => {
    setRows((prev) => prev.filter((row) => row.uid !== uid))
    setSelectedUid(null)
    setEditingUid(null)
  }

  const add = (source: MemorySource) => {
    const row: Row = { uid: nextUid(), key: "", value: "", source, status: "active", stale: false }
    setRows((prev) => [...prev, row])
    setSelectedUid(row.uid)
    setEditingUid(row.uid)
  }

  const decide = async (row: Row, decision: "approve" | "reject") => {
    if (!row.id) {
      remove(row.uid)
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      apply(await api.decideMemory(sessionID, row.id, decision))
      setNotice(decision === "approve" ? "已批准，会进入 prompt" : "已移除")
      onDirty()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const payload: MemoryEntryInput[] = ordered.map(({ id, key, value, source, status }) => ({
        id,
        key,
        value,
        source,
        status,
      }))
      const next = await api.saveMemory(sessionID, payload)
      apply(next)
      setNotice(`已保存：${next.entries.length} 条，约 ${next.tokens} tokens`)
      onDirty()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="记忆"
      note="跨轮次保留的事实"
      onClose={onClose}
      className="max-w-3xl"
      footerNote={
        <>
          {rows.length} 条（待确认 {tierRows.pending.length} / 确认 {tierRows.verified.length} / 推断{" "}
          {tierRows.inferred.length} / 证伪 {tierRows.stale.length}）· {tokens} tokens
        </>
      }
      footer={
        <>
          <Btn onClick={() => void load()} disabled={busy}>
            重新载入
          </Btn>
          <Btn variant="key" onClick={() => void save()} disabled={busy}>
            保存
          </Btn>
        </>
      }
    >
      <div className="mb-2 text-s-faint">
        点一次选中整条，再点一次进入编辑。来源决定可信度，状态决定是否进入 prompt。
      </div>

      {conflicts.length > 0 ? (
        <div className="mb-3 border border-s-rust/50">
          <div className="flex items-center gap-2 bg-s-rust/10 px-2.5 py-1.5">
            <Chip tone="bad" filled>冲突 {conflicts.length}</Chip>
            <span className="min-w-0 flex-1 text-s-faint">
              与工作区实测不符。已告知 agent，下一轮仍未修正则自动改写为实测值。
            </span>
          </div>
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="flex items-baseline gap-2 border-t border-s-rust/30 px-2.5 py-1">
              <Label className="text-s-rust">!</Label>
              <span className="min-w-0 flex-1 truncate text-s-body">
                {conflict.key ? `${conflict.key} :: ` : ""}
                {conflict.value}
              </span>
              <Label className="text-s-faint">实测</Label>
              <span className="shrink-0 text-s-moss">{conflict.expected ?? "—"}</span>
              {!conflict.correctable ? <Label className="text-s-faint">人工声明，不覆盖</Label> : null}
            </div>
          ))}
        </div>
      ) : null}

      {tiers.map((tier) => {
        const list = tierRows[tier.key]
        const tick =
          tier.key === "pending"
            ? "var(--color-s-warn)"
            : tier.key === "verified"
              ? "var(--color-s-moss)"
              : tier.key === "inferred"
                ? "var(--color-s-edge)"
                : "var(--color-s-rust)"

        return (
          <div key={tier.key}>
            <div className="mt-3 flex items-center gap-2 border-b border-s-line pb-1">
              <span className="s-led" style={{ backgroundColor: tick }} />
              <Label className="text-s-bright">{tier.label}</Label>
              <span className="min-w-0 flex-1 truncate text-s-faint">{tier.note}</span>
              <Label className="text-s-faint">{list.length}</Label>
              {tier.add ? (
                <Btn sm icon="plus" onClick={() => add(tier.add as MemorySource)}>
                  新建
                </Btn>
              ) : null}
            </div>

            {list.length === 0 ? (
              /* three stacked "(空)" blocks make an empty dialog look broken; one muted
                 line per tier is enough, and the + new button above stays reachable */
              <div className="px-2 py-1 text-s-faint">空{tier.add ? " · 点「新建」添加一条" : ""}</div>
            ) : (
              list.map((row) => (
                <MemoryRow
                  key={row.uid}
                  row={row}
                  index={ordered.indexOf(row)}
                  selected={selectedUid === row.uid}
                  editing={editingUid === row.uid}
                  onSelect={() => setSelectedUid(row.uid)}
                  onEdit={() => setEditingUid(row.uid)}
                  onDone={() => {
                    setEditingUid(null)
                    setSelectedUid(row.uid)
                  }}
                  onChange={(patch) => update(row.uid, patch)}
                  onDelete={() => remove(row.uid)}
                  onApprove={() => void decide(row, "approve")}
                  onReject={() => void decide(row, "reject")}
                />
              ))
            )}
          </div>
        )
      })}

      <Rule className="my-3" />

      {notice ? <Notice tone="ok" label="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad" label="err" className="mt-2">{error}</Notice> : null}

      {/* a file path is data, not a field name — see Label's `caps` */}
      <Label caps={false} className="mt-2 block truncate text-s-faint">
        {path || sessionID}
      </Label>
    </Modal>
  )
}
