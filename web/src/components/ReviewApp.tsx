import { useEffect, useMemo, useState } from "react"
import type { SessionInfo } from "@shared/protocol"
import { api } from "../api"
import { changedFilesOf, changesOf, fileRevisionOf, type ChangeEntry, type ChangeKind } from "../changes"
import { useSession } from "../useSession"
import { Btn, Empty, Icon, Label, Led, Notice, Well, cx } from "../ui"
import CodeView from "./CodeView"
import Diff from "./Diff"
import FileTree from "./FileTree"

/** How often the shared-session list is refetched. The control seat decides what is shared
 *  while this window is already open - and can take it away again - so the list cannot be
 *  loaded once and trusted; the server also hangs up the stream on unshare, and this is what
 *  turns that into "the conversation disappeared from my list". */
const REFRESH_MS = 8_000

const MARK: Record<ChangeKind, { label: string; tone: "ok" | "warn" | "bad" }> = {
  new: { label: "新", tone: "ok" },
  modified: { label: "改", tone: "warn" },
  failed: { label: "失败", tone: "bad" },
}

/** The review seat's whole interface.
 *
 *  Deliberately not the control shell with things greyed out: a reviewer has one job, and the
 *  layout says so. Left is the project tree, right is either what the agent just wrote (with
 *  patches) or the code of a file that was opened. There is nothing to type into and nothing
 *  to answer - the server refuses all of it anyway, this just does not pretend otherwise. */
export default function ReviewApp() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const state = useSession(activeId)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const list = await api.sessions()
        if (cancelled) return
        setError(null)
        // keep the previous array when nothing about the list changed, so a poll does not
        // re-render the tree and the change list every 8 seconds for no reason
        setSessions((prev) =>
          prev.length === list.length &&
          prev.every((session, index) => session.id === list[index].id && session.title === list[index].title)
            ? prev
            : list,
        )
        // a conversation that stopped being shared drops out of this list server-side, so the
        // active id has to be re-validated on every poll rather than only at boot
        setActiveId((prev) => (prev && list.some((session) => session.id === prev) ? prev : list[0]?.id ?? null))
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      }
    }

    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // the path is relative to one conversation's workspace, so it cannot survive a switch
  useEffect(() => {
    setOpenPath(null)
  }, [activeId])

  const workspace = state.session?.workspace ?? ""
  const changes = useMemo(() => changesOf(state.messages, workspace), [state.messages, workspace])
  const changed = useMemo(() => changedFilesOf(state.messages, workspace), [state.messages, workspace])
  const revision = useMemo(() => fileRevisionOf(state.messages), [state.messages])

  // newest first: what the agent just did is what a reviewer came to look at
  const ordered = useMemo(() => [...changes].reverse(), [changes])
  const touchedFiles = useMemo(() => new Set(changes.map((entry) => entry.path)).size, [changes])

  return (
    <div className="flex h-full flex-col">
      <header className="s-bar flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2">
        <span className="text-[14px] font-semibold tracking-tight text-s-bright">goto</span>
        <Label className="text-s-warn" title="只能查看被共享出来的对话，不能下指令、不能应答弹窗、不能改任何设置">
          检查席 · 只读
        </Label>
        <span aria-hidden className="h-4 w-px shrink-0 bg-s-line" />

        {sessions.length > 0 ? (
          <label className="flex min-w-0 items-center gap-1.5" title="控制席共享给你的对话">
            <Label className="text-s-faint">对话</Label>
            <select
              value={activeId ?? ""}
              onChange={(event) => setActiveId(event.target.value || null)}
              className="s-input min-w-0 max-w-[22rem] py-1 text-s-body"
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.parentID ? `└ ${session.title}` : session.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Label className="text-s-faint">还没有共享给你的对话</Label>
        )}

        <span className="min-w-0 flex-1" />

        <span className="flex shrink-0 items-center gap-1.5" title={state.running ? "AI 正在写" : "空闲"}>
          <Led tone={state.running ? "warn" : "neutral"} pulse={state.running} />
          <Label className={state.running ? "text-s-warn" : "text-s-faint"}>
            {state.running ? "AI 正在工作" : "空闲"}
          </Label>
        </span>
      </header>

      {error ? (
        <Notice tone="bad" label="err">
          {error}
        </Notice>
      ) : null}

      {sessions.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <Well className="max-w-md p-5">
            <div className="mb-2 text-[15px] font-semibold tracking-tight text-s-bright">还没有可看的对话</div>
            <div className="mb-3 text-s-body">
              控制席需要在左侧导航的「共享」里，把要一起看的那个对话共享给检查席。共享之后这里会自动出现，
              不用手动刷新。
            </div>
            <div className="text-s-faint">
              你拿到的这条链接只能看被共享出来的对话；控制席没共享的对话，你这边看不到，也打不开。
            </div>
          </Well>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-80 shrink-0 flex-col border-r border-s-line bg-s-panel">
            <FileTree
              sessionID={activeId}
              onPick={setOpenPath}
              pickHint="双击查看代码"
              onView={setOpenPath}
              canImport={false}
              changed={changed}
              revision={revision}
              workspace={workspace}
            />
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            {openPath && activeId ? (
              <CodeView
                sessionID={activeId}
                path={openPath}
                onClose={() => setOpenPath(null)}
                closeLabel="返回改动"
              />
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-s-line bg-s-panel px-3 py-1.5">
                  <Icon name="spark" size={12} className="text-s-ember" />
                  <Label className="text-s-soft">AI 刚写的代码</Label>
                  <Label className="text-s-faint">
                    {ordered.length} 处改动 · {touchedFiles} 个文件
                  </Label>
                  <span className="min-w-0 flex-1" />
                  <span className="text-s-faint">点文件名看完整代码</span>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {ordered.length === 0 ? (
                    <Empty>
                      {state.running ? "AI 正在工作，改动的文件会实时出现在这里" : "这个对话还没有写过任何文件"}
                    </Empty>
                  ) : (
                    <div className="divide-y divide-s-line/50">
                      {ordered.map((entry) => (
                        <ChangeCard key={entry.id} entry={entry} onOpen={setOpenPath} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  )
}

function ChangeCard({ entry, onOpen }: { entry: ChangeEntry; onOpen: (path: string) => void }) {
  const [shown, setShown] = useState(true)
  const mark = MARK[entry.kind]

  return (
    <div className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cx(
            "s-tag shrink-0",
            mark.tone === "ok" ? "text-s-moss" : mark.tone === "bad" ? "text-s-rust" : "text-s-warn",
          )}
          title={entry.kind === "new" ? "新建" : entry.kind === "failed" ? "写入失败" : "修改"}
        >
          {mark.label}
        </span>
        <button
          type="button"
          onClick={() => onOpen(entry.path)}
          title="打开这个文件的代码"
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-s-bright underline-offset-2 hover:underline"
        >
          {entry.path}
        </button>
        <Label className="shrink-0 text-s-faint">{entry.tool}</Label>
        {entry.diff ? (
          <Btn sm on={shown} onClick={() => setShown((value) => !value)} title="展开或收起这次的补丁">
            {shown ? "收起" : "看补丁"}
          </Btn>
        ) : null}
      </div>

      {entry.error ? <Notice tone="bad" label="err" className="mt-1">{entry.error}</Notice> : null}

      {entry.diff && shown ? (
        <div className="mt-1.5">
          <Diff patch={entry.diff} />
        </div>
      ) : null}
    </div>
  )
}
