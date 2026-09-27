import { useCallback, useEffect, useState } from "react"
import { api, type SkillBody, type SkillsView } from "../api"
import { Btn, Empty, IconBtn, Label, Notice, Scrim } from "../ui"

type Props = {
  sessionID: string | null
  /** bumped by the dialog's refresh button; a change triggers a refetch */
  reloadToken: number
}

export default function SkillPanel({ sessionID, reloadToken }: Props) {
  const [view, setView] = useState<SkillsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<SkillBody | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setView(await api.skills(sessionID ?? undefined))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [sessionID])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  const openPreview = async (name: string) => {
    setPreviewBusy(true)
    setError(null)
    try {
      // the body is what the agent will actually read, so it has to be auditable here
      setPreview(await api.skill(name, sessionID ?? undefined))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPreviewBusy(false)
    }
  }

  const copyPath = async (dir: string) => {
    setError(null)
    try {
      await navigator.clipboard.writeText(dir)
      setNotice(`已复制路径：${dir}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const skills = view?.list ?? []
  const dropped = skills.filter((skill) => !skill.injected)

  return (
    <>
      <div className="shrink-0 border-b border-s-line px-3 py-1.5 text-s-faint">
        每轮只把名字和描述放进 prompt（按需加载正文）。项目级装在工作区里，随代码走；个人级本机通用。
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === null ? (
          <Empty>正在读取…</Empty>
        ) : skills.length === 0 ? (
          <div className="px-3 py-4 text-s-faint">
            <div className="mb-1 text-s-soft">还没有装任何 skill。</div>
            <div>
              安装：<span className="font-mono text-s-body">gt skills add &lt;repo&gt;</span>，或把含{" "}
              <span className="font-mono text-s-body">SKILL.md</span> 的目录放进下面任一根目录。
            </div>
            <div className="mt-2 space-y-0.5">
              {view.roots.map((root) => (
                <div key={root.source} className="flex items-center gap-2">
                  <Label className="text-s-faint">{root.source === "project" ? "项目" : "个人"}</Label>
                  <span className="min-w-0 truncate font-mono">{root.dir}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-s-line/40">
            {skills.map((skill) => (
              <div key={skill.name} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <Label className={skill.source === "project" ? "text-s-moss" : "text-s-faint"}>
                    {skill.source === "project" ? "项目" : "个人"}
                  </Label>
                  <span className="shrink-0 text-s-bright">{skill.name}</span>
                  <Label className="text-s-faint">{skill.tokens} tok</Label>
                  {skill.install ? <Label className="text-s-warn">需要安装依赖</Label> : null}
                  {!skill.injected ? <Label className="text-s-warn">未注入</Label> : null}
                  <span className="min-w-0 flex-1" />
                  <Btn
                    sm
                    className="s-tag"
                    onClick={() => void openPreview(skill.name)}
                    disabled={previewBusy || busy}
                  >
                    看正文
                  </Btn>
                  <Btn sm className="s-tag" onClick={() => void copyPath(skill.dir)}>
                    复制路径
                  </Btn>
                </div>
                <div className="mt-0.5 text-s-faint">{skill.description}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad" label="err">{error}</Notice> : null}

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-s-line px-3 py-1.5 text-s-faint">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{skills.length} 个 skill</span>
          {view ? (
            <span className="shrink-0">prompt 占用 {view.promptChars} / {view.budget} 字符</span>
          ) : null}
        </div>
        {dropped.length > 0 ? (
          <div className="truncate text-s-warn" title={dropped.map((skill) => skill.name).join("、")}>
            描述超预算、未注入 prompt：{dropped.map((skill) => skill.name).join("、")}
          </div>
        ) : null}
      </div>

      {preview ? (
        <Scrim className="z-60">
          <div className="s-dialog s-enter flex max-h-[80vh] w-full max-w-3xl flex-col">
            <div className="s-dialog__head">
              <Label caps={false} className="text-s-bright">
                {preview.name}
              </Label>
              <Label className="text-s-faint">{preview.source === "project" ? "项目" : "个人"}</Label>
              <div className="s-hair min-w-0 flex-1" />
              <IconBtn
                name="close"
                title="关闭"
                onClick={() => setPreview(null)}
                className="hover:text-s-bright"
              />
            </div>

            <div className="flex shrink-0 items-center gap-2 border-b border-s-line px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-s-faint" title={preview.dir}>
                {preview.dir}
              </span>
              <Btn sm className="s-tag" onClick={() => void copyPath(preview.dir)}>
                复制路径
              </Btn>
            </div>

            <div className="shrink-0 border-b border-s-line bg-s-warn/5 px-3 py-1.5 text-s-warn">
              内容来自第三方仓库，载入后会被当作指令交给 agent —— 只装可信来源。
            </div>

            <div className="min-h-0 flex-1 overflow-auto bg-s-well">
              <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.6] text-s-body">
                {preview.body || "（正文为空）"}
              </pre>
            </div>
          </div>
        </Scrim>
      ) : null}
    </>
  )
}
