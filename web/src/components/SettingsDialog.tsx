import { useState, type ReactNode } from "react"
import { api, type Settings, type SettingsPatch } from "../api"
import { Btn, Field, Label, Modal, Notice, Well } from "../ui"
import ProvidersPanel from "./ProvidersPanel"

type Props = {
  settings: Settings
  onClose: () => void
  onSaved: (settings: Settings) => void
}

export default function SettingsDialog({ settings, onClose, onSaved }: Props) {
  const [apiKey, setApiKey] = useState("")
  const [baseURL, setBaseURL] = useState(settings.baseURL)
  const [model, setModel] = useState(settings.model)
  const [workspace, setWorkspace] = useState(settings.workspace)
  const [webFetch, setWebFetch] = useState(settings.webFetch)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const patch = (): SettingsPatch => {
    const next: SettingsPatch = { baseURL, model, workspace, webFetch }
    if (apiKey.trim()) next.apiKey = apiKey.trim()
    return next
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      onSaved(await api.updateSettings(patch()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.testConnection(patch())
      setNotice(
        result.modelFound
          ? `连接成功，该端点返回 ${result.models} 个模型`
          : `连接成功，但模型 "${model}" 不在返回的 ${result.models} 个模型里，请核对名称`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="设置"
      note="API key、端点、工作区"
      onClose={onClose}
      className="max-w-xl"
      footerNote={<span title={settings.settingsPath}>{settings.settingsPath}</span>}
      footer={
        <>
          <Btn onClick={() => void test()} disabled={busy}>
            测试连接
          </Btn>
          <Btn variant="key" onClick={() => void save()} disabled={busy}>
            保存
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <ProvidersPanel
          onActivated={(next) => {
            // the live config changed underneath the form, so realign the fields
            setBaseURL(next.baseURL)
            setModel(next.model)
            setApiKey("")
            onSaved(next)
          }}
        />

        <Field
          label="api key"
          hint={
            settings.hasApiKey
              ? `${settings.apiKeyHint} 已配置${settings.apiKeySource === "env" ? "（来自 .env）" : ""}，留空保持不变`
              : "必填"
          }
        >
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings.hasApiKey ? "********" : "sk-..."}
            className="s-input w-full"
            autoComplete="off"
          />
        </Field>

        <Field label="base url" hint="任何兼容 OpenAI 协议的端点">
          <input
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="https://api.openai.com/v1"
            className="s-input w-full"
          />
        </Field>

        <Field label="model">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="gpt-4o-mini"
            className="s-input w-full"
          />
        </Field>

        <Field label="workspace" hint="agent 操作的项目目录，对新会话生效">
          <input
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="C:\path\to\your\code"
            className="s-input w-full"
          />
        </Field>

        <Field label="ai 联网访问" hint="默认关闭。打开后 agent 才能用 fetch 抓公开网页">
          <Well className="flex items-start gap-2 px-2.5 py-1.5">
            <input
              type="checkbox"
              checked={webFetch}
              onChange={(event) => setWebFetch(event.target.checked)}
              className="mt-1 shrink-0 accent-s-ember"
            />
            <span className="min-w-0">
              <span className={webFetch ? "text-s-warn" : "text-s-faint"}>
                {webFetch ? "已开启：agent 可以抓取公开网页" : "已关闭：agent 无法联网"}
              </span>
              <span className="block text-s-faint">
                只按 URL 抓正文，<b className="text-s-soft">不能</b>做关键词搜索。抓回来的是别人写的内容，属于
                <b className="text-s-soft">不可信输入</b>（页面里可能写“忽略之前的指令”）。
                只允许公网 http/https，本机/内网地址会被拒。保存后立即生效，不用重启。
              </span>
            </span>
          </Well>
        </Field>

        {notice ? <Notice tone="ok" label="ok">{notice}</Notice> : null}
        {error ? <Notice tone="bad" label="err">{error}</Notice> : null}

        <Label className="block text-s-faint">
          保存后写入 {settings.settingsPath}
        </Label>
      </div>
    </Modal>
  )
}
