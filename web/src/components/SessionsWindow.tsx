import { useCallback, useEffect, useState } from "react"
import type { FolderNode, SessionInfo } from "@shared/protocol"
import { api } from "../api"
import { publish, readActiveSession, subscribe, writeActiveSession } from "../bus"
import { Btn, Empty, Icon, Label, Led, Notice, cx } from "../ui"

export default function SessionsWindow() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => readActiveSession())
  const [workspace, setWorkspace] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const [list, folderList, settings] = await Promise.all([api.sessions(), api.folders(), api.settings()])
      setSessions(list)
      setFolders(folderList)
      setWorkspace(settings.workspace)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => subscribe((message) => void (message.type === "sessions.changed" && refresh())), [refresh])

  const select = (id: string) => {
    setActiveId(id)
    writeActiveSession(id)
    publish({ type: "session.select", id })
  }

  const folderName = (folderID: string) =>
    folders.find((folder) => folder.id === folderID)?.name ?? "（已删除）"

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await api.deleteSession(id)
      if (activeId === id) {
        const next = sessions.find((session) => session.id !== id)?.id ?? null
        setActiveId(next)
        writeActiveSession(next)
        if (next) publish({ type: "session.select", id: next })
      }
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-s-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-s-line bg-s-rail px-3 py-2 shadow-[var(--el-1)]">
        <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
        <Label className="text-s-bright">goto · 全部会话</Label>
        <div className="s-hair min-w-0 flex-1" />
        <span className="shrink-0 text-s-faint">{sessions.length} 个</span>
        <Btn
          sm
          icon="refresh"
          onClick={() => void refresh()}
          disabled={busy}
          title="重新读取"
          className={cx(busy && "s-pulse")}
        />
      </div>

      {error ? (
        <Notice tone="bad" label="err">
          {error}
        </Notice>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((session, index) => {
          const active = session.id === activeId
          return (
            <div key={session.id} className="flex items-stretch">
              <button
                type="button"
                onClick={() => select(session.id)}
                title={`${session.title}\n${folderName(session.folderID)}\n${session.id}`}
                className={cx(
                  "flex min-w-0 flex-1 items-center gap-2 border-l-2 px-2.5 py-1.5 text-left transition-colors",
                  active
                    ? "border-s-ember bg-s-card text-s-bright"
                    : "border-transparent text-s-soft hover:bg-s-card hover:text-s-bright",
                )}
              >
                <Label className={active ? "text-s-ember" : "text-s-faint"}>
                  {String(index + 1).padStart(2, "0")}
                </Label>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{session.title}</span>
                  <span className="flex items-center gap-1 text-s-faint">
                    <Icon name="folder" size={10} />
                    <Label caps={false} className="truncate">
                      {folderName(session.folderID)}
                    </Label>
                  </span>
                </span>
                {session.running ? <Led tone="warn" pulse title="正在运行" /> : null}
              </button>

              <button
                type="button"
                onClick={() => void remove(session.id)}
                disabled={session.running}
                title="删除这个对话（连同它的记忆）"
                className="flex w-7 shrink-0 items-center justify-center border-l border-s-line text-s-faint transition-colors hover:bg-s-rust hover:text-s-on-rust disabled:opacity-30"
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          )
        })}

        {sessions.length === 0 && !busy ? (
          <Empty>还没有会话，在主窗口的导航栏点「新对话」开一个</Empty>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-s-line px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Icon name="tree" size={11} className="text-s-faint" />
          <Label className="text-s-faint">work 目录</Label>
        </div>
        <div className="mt-0.5 break-all text-s-soft">{workspace || "—"}</div>
      </div>
    </div>
  )
}
