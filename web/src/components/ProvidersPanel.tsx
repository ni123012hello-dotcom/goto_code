import { useCallback, useEffect, useState } from "react"
import { api, type ProviderView, type Settings } from "../api"
import { Btn, Chip, Empty, Label, Led, Notice, Well } from "../ui"

type Props = {
  /** the live config just changed, so the parent should refresh settings + model list */
  onActivated: (settings: Settings) => void
}

type Draft = { id: string; name: string; baseURL: string; apiKey: string; model: string }
const EMPTY: Draft = { id: "", name: "", baseURL: "", apiKey: "", model: "" }

/** Saved endpoints. Switching one rewrites the live config, so it is a latched
 *  list with an explicit 启用 action rather than a dropdown that fires on change. */
export default function ProvidersPanel({ onActivated }: Props) {
  const [view, setView] = useState<ProviderView | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setView(await api.providers())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await work()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const activate = (id: string) =>
    run(async () => {
      const settings = await api.activateProvider(id)
      onActivated(settings)
      setView(await api.providers())
      setNotice("已切换。新请求马上生效，正在跑的回合不受影响。")
    })

  const save = () =>
    run(async () => {
      setView(
        await api.saveProvider({
          id: draft.id || undefined,
          name: draft.name,
          baseURL: draft.baseURL,
          // an empty key means "keep the saved one"; the UI never has the real value
          apiKey: draft.apiKey,
          model: draft.model,
        }),
      )
      setDraft(EMPTY)
      setNotice("已保存到提供商列表")
    })

  const remove = (id: string) =>
    run(async () => {
      setView(await api.deleteProvider(id))
      if (draft.id === id) setDraft(EMPTY)
      setNotice("已删除（当前生效的配置不受影响）")
    })

  const edit = (id: string) => {
    const provider = view?.list.find((entry) => entry.id === id)
    if (!provider) return
    setDraft({ id: provider.id, name: provider.name, baseURL: provider.baseURL, apiKey: "", model: provider.model })
    setNotice(null)
  }

  const list = view?.list ?? []

  return (
    <Well>
      <div className="flex items-center gap-2 border-b border-s-line px-2.5 py-1.5">
        <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
        <Label className="text-s-bright">API 端点</Label>
        <span className="min-w-0 flex-1 truncate text-s-faint">保存多个端点，点「启用」即切换（写入当前配置）</span>
        {view?.active === null && list.length > 0 ? (
          <Chip tone="warn">当前是自定义配置</Chip>
        ) : null}
      </div>

      <div className="px-2.5 py-1.5">
        {list.length === 0 ? (
          <Empty>还没有保存的提供商。在下面填一个。</Empty>
        ) : (
          list.map((provider) => {
            const active = provider.id === view?.active
            return (
              <div key={provider.id} className="flex items-center gap-2 py-[2px]">
                <Led
                  tone={active ? "ok" : "neutral"}
                  hollow={!active}
                  title={active ? "当前生效" : "未启用"}
                />
                <span className={active ? "shrink-0 text-s-bright" : "shrink-0 text-s-body"}>{provider.name}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[10px] text-s-faint"
                  title={provider.baseURL}
                >
                  {provider.baseURL}
                  {provider.model ? ` · ${provider.model}` : ""}
                  {provider.hasApiKey ? "" : " · 无 key"}
                </span>
                {active ? (
                  <Chip tone="ok">使用中</Chip>
                ) : (
                  <Btn sm onClick={() => void activate(provider.id)} disabled={busy}>
                    启用
                  </Btn>
                )}
                <Btn sm onClick={() => edit(provider.id)}>编辑</Btn>
                <Btn sm className="hover:text-s-rust" onClick={() => void remove(provider.id)} disabled={busy}>
                  删除
                </Btn>
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-s-line px-2.5 py-1.5">
        <Label className="mb-1 block text-s-soft">{draft.id ? "编辑提供商" : "新增提供商"}</Label>
        <div className="grid grid-cols-2 gap-1.5">
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="名字，例如 DeepSeek"
            className="s-input text-s-body"
          />
          <input
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            placeholder="默认模型，例如 deepseek-chat"
            className="s-input text-s-body"
          />
          <input
            value={draft.baseURL}
            onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })}
            placeholder="https://api.deepseek.com"
            className="s-input col-span-2 text-s-body"
          />
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            placeholder={draft.id ? "留空保持原来的 key" : "sk-..."}
            autoComplete="off"
            className="s-input col-span-2 text-s-body"
          />
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <Btn variant="key" onClick={() => void save()} disabled={busy || !draft.baseURL.trim()}>
            {draft.id ? "保存修改" : "加入列表"}
          </Btn>
          {draft.id ? (
            <Btn onClick={() => setDraft(EMPTY)}>取消编辑</Btn>
          ) : (
            <span className="text-s-faint">
              保存后还要点「启用」才会真的用它；也可以先复制上面的字段到下面的表单再测试连接。
            </span>
          )}
        </div>
      </div>

      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
    </Well>
  )
}
