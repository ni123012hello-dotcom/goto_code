import { useCallback, useEffect, useState } from "react"
import { api, type ContextInfo, type ModelLimits } from "../api"
import { Btn, Empty, Label, Modal, Notice } from "../ui"

type Row = { model: string; context: string; input: string; output: string }

/** What the built-in registry alone suggests for a model, independent of what this user has
 *  typed into the fields. */
type Suggestion = NonNullable<ContextInfo["registry"]>

function toRow(model: string, limits: ModelLimits = {}): Row {
  return {
    model,
    context: limits.context ? String(limits.context) : "",
    input: limits.input ? String(limits.input) : "",
    output: limits.output ? String(limits.output) : "",
  }
}

function toLimits(row: Row): ModelLimits {
  const parse = (value: string) => {
    const n = Number(value.trim())
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
  }
  const limits: ModelLimits = {}
  const context = parse(row.context)
  const input = parse(row.input)
  const output = parse(row.output)
  if (context) limits.context = context
  if (input) limits.input = input
  if (output) limits.output = output
  return limits
}

export default function ModelLimitsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [known, setKnown] = useState<string[]>([])
  const [draft, setDraft] = useState("")
  const [path, setPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [suggest, setSuggest] = useState<Record<string, Suggestion>>({})

  /** The built-in registry's numbers show up as greyed placeholders, so a real value is
   *  visible without leaving the field empty and guessing. One request per row, and the list
   *  is only the handful of models this user actually runs. */
  const suggestFor = useCallback(async (names: string[]) => {
    const found: Record<string, Suggestion> = {}
    await Promise.all(
      names.map(async (name) => {
        try {
          const info = await api.context(name)
          if (info.registry) found[name] = info.registry
        } catch {
          // a suggestion is a nicety; it must never break the dialog
        }
      }),
    )
    if (Object.keys(found).length > 0) setSuggest((prev) => ({ ...prev, ...found }))
  }, [])

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const [limits, models] = await Promise.all([api.modelLimits(), api.models()])
      setPath(limits.path)
      const loaded = Object.entries(limits.limits)
        .map(([model, value]) => toRow(model, value))
        .sort((a, b) => a.model.localeCompare(b.model))
      setRows(loaded)
      void suggestFor(loaded.map((row) => row.model))
      setKnown(models.models)
      if (models.error) setError(`模型列表拉取失败（仍可手填模型名）：${models.error}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = (index: number, field: keyof Omit<Row, "model">, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
    setNotice(null)
  }

  const add = (model: string) => {
    const name = model.trim()
    if (!name) return
    if (rows.some((row) => row.model === name)) {
      setError(`「${name}」已经在列表里了`)
      return
    }
    setRows((prev) => [...prev, toRow(name)].sort((a, b) => a.model.localeCompare(b.model)))
    void suggestFor([name])
    setDraft("")
    setError(null)
    setNotice(null)
  }

  const drop = (model: string) => {
    setRows((prev) => prev.filter((row) => row.model !== model))
    setNotice(null)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const original = await api.modelLimits()
      const wanted = new Map(rows.map((row) => [row.model, toLimits(row)]))

      // clear entries the user removed by emptying every field
      for (const model of Object.keys(original.limits)) {
        if (!wanted.has(model)) await api.saveModelLimits(model, {})
      }
      let saved = 0
      for (const [model, limits] of wanted) {
        const before = original.limits[model] ?? {}
        if (JSON.stringify(before) === JSON.stringify(limits)) continue
        await api.saveModelLimits(model, limits)
        saved += 1
      }

      setNotice(saved === 0 ? "没有改动" : `已保存 ${saved} 个模型`)
      onSaved()
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const suggestions = Object.values(suggest)
  const suggestDate = suggestions.find((item) => item.fetchedAt)?.fetchedAt ?? null

  return (
    <Modal
      title="模型上限"
      note="每个模型的真实上下文 / 输入 / 输出上限"
      onClose={onClose}
      className="max-w-3xl"
      footerNote={path}
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
        留空就用全局默认。<b className="text-s-soft">只有填了 output，请求里才会真的带上输出上限</b>
        （不填就不发，免得用错参数名或超出模型天花板被整条拒绝）。
      </div>

      {rows.length === 0 ? (
        <Empty>还没有配置任何模型。下面添加一个。</Empty>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="s-tag text-s-faint">
              <th className="pb-1 text-left">模型</th>
              <th className="w-28 pb-1 text-left">上下文</th>
              <th className="w-28 pb-1 text-left">输入</th>
              <th className="w-28 pb-1 text-left">输出</th>
              <th className="w-10 pb-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const suggestion = suggest[row.model]
              return (
              <tr key={row.model} className="border-t border-s-line">
                <td className="py-1 pr-2">
                  <span className="font-mono text-s-body">{row.model}</span>
                  {/* Providers disagree on this id (glm-5.2 spans a 200k to a 1M window), and
                      the placeholder is the median. Saying so beats presenting it as fact. */}
                  {suggestion?.disagreed ? (
                    <span
                      className="ml-1 cursor-help text-s-faint"
                      title={`内置目录里 ${suggestion.providers} 家 provider 给出不同数值，灰色值取的是中位数`}
                    >
                      ≈
                    </span>
                  ) : null}
                </td>
                {(["context", "input", "output"] as const).map((field) => (
                  <td key={field} className="py-1 pr-2">
                    <input
                      value={row[field]}
                      onChange={(event) => patch(index, field, event.target.value.replace(/[^\d]/g, ""))}
                      inputMode="numeric"
                      placeholder={suggestion?.limits[field] ? String(suggestion.limits[field]) : "—"}
                      title={suggestion?.limits[field] ? "内置目录的建议值，留空就按它算" : undefined}
                      className="s-input w-full px-2 py-1 text-s-body"
                    />
                  </td>
                ))}
                <td className="py-1 text-right">
                  <button
                    type="button"
                    onClick={() => drop(row.model)}
                    title="移除这一行"
                    className="s-tag text-s-faint transition-colors hover:text-s-rust"
                  >
                    x
                  </button>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-s-line pt-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              add(draft)
            }
          }}
          list="goto-model-names"
          placeholder="模型名，例如 deepseek-flash"
          className="s-input min-w-0 flex-1 px-2 py-1 text-s-body"
        />
        <datalist id="goto-model-names">
          {known.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Btn onClick={() => add(draft)} disabled={!draft.trim()}>
          + 添加
        </Btn>
      </div>

      <div className="mt-1 text-s-faint">
        不填 <span className="font-mono">input</span> 时，预算按 <span className="font-mono">context − 缓冲区</span> 算
        （缓冲区取 20000 与窗口一半的较小值）；填了它就按 <span className="font-mono">input − output</span> 算。
      </div>

      {suggestions.length > 0 ? (
        <div className="mt-1 text-s-faint">
          灰色数字是内置目录的建议（models.dev，{suggestDate ?? "日期未知"}）—— 留空就按它算，填了以你为准。
          带 <span className="font-mono">≈</span> 的模型在目录里有多个 provider 给出不同数值，灰值取的是中位数。
          <Label className="ml-1 text-s-faint">测出来的值不一定等于你这个端点的真实上限。</Label>
        </div>
      ) : null}

      {notice ? <Notice tone="ok" label="ok" className="mt-3">{notice}</Notice> : null}
      {error ? <Notice tone="bad" label="err" className="mt-3">{error}</Notice> : null}

    </Modal>
  )
}
