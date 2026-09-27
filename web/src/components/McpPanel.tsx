import { useCallback, useEffect, useState } from "react"
import { api, type DiscoveredMcpServer, type McpServerStatus, type McpView, type PublicMcpServer } from "../api"
import { Btn, DialogFoot, Empty, Label, Led, Notice, Scrim, TONE_TEXT, Well, type Tone } from "../ui"

type Props = {
  /** bumped by the dialog's refresh button; a change triggers a refetch */
  reloadToken: number
}

/** The one-time approval is a distinct, deliberate action, so it gets its own confirm step
 *  rather than sharing the enable/disable toggle. Deleting also forgets the fingerprint. */
type Pending = { kind: "ack"; server: PublicMcpServer } | { kind: "delete"; server: PublicMcpServer }

function liveStatus(view: McpView | null, id: string): McpServerStatus | undefined {
  return view?.status.find((entry) => entry.id === id)
}

/** Maps the server's trust + lifecycle state onto a lamp and a human label.
 *  Anything that is "off" gets a hollow lamp: in LINEN a dark filled dot and a
 *  dark ring are trivially distinguishable, two dark hues are not. */
function describe(
  server: PublicMcpServer,
  live: McpServerStatus | undefined,
): { tone: Tone; text: string; pulse?: boolean; hollow?: boolean } {
  if (server.needsTrust) return { tone: "warn", text: "待确认" }
  if (!server.trusted) return { tone: "neutral", text: "已停用（未批准）", hollow: true }
  if (!server.enabled) return { tone: "neutral", text: "已停用（已批准）", hollow: true }

  const state = live?.status ?? "disabled"
  if (state === "ready") return { tone: "ok", text: `就绪 · ${live?.tools ?? 0} 个工具` }
  if (state === "starting") return { tone: "warn", text: "启动中", pulse: true }
  if (state === "failed") return { tone: "bad", text: "启动失败" }
  return { tone: "neutral", text: "未运行", hollow: true }
}

function commandLine(server: PublicMcpServer): string {
  return [server.command, ...server.args].join(" ")
}

export default function McpPanel({ reloadToken }: Props) {
  const [view, setView] = useState<McpView | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredMcpServer[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.mcp()
      setView(next)
      // discovery is a convenience, so a failure here must not hide the configured list
      try {
        setDiscovered((await api.mcpDiscover()).servers)
      } catch {
        setDiscovered([])
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  const run = async (work: () => Promise<McpView>, message: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setView(await work())
      setNotice(message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (server: PublicMcpServer, enabled: boolean) =>
    void run(
      () => api.saveMcpServer({ id: server.id, enabled }),
      enabled ? `已启用 ${server.id}` : `已停用 ${server.id}（批准保留，启用时不用重新确认）`,
    )

  const confirmAck = (server: PublicMcpServer) => {
    setPending(null)
    void run(
      () => api.saveMcpServer({ id: server.id, acknowledge: true, enabled: true }),
      `已确认并启动 ${server.id}`,
    )
  }

  const confirmDelete = (server: PublicMcpServer) => {
    setPending(null)
    void run(() => api.deleteMcpServer(server.id), `已移除 ${server.id}`)
  }

  const importServers = async (names?: string[]) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.mcpImport(names)
      setView(result)
      try {
        setDiscovered((await api.mcpDiscover()).servers)
      } catch {
        /* the configured list already refreshed, which is what matters */
      }
      const skipped = result.skipped.length
      setNotice(`已导入 ${result.imported.length} 个，均未确认${skipped > 0 ? `；跳过 ${skipped} 个` : ""}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const servers = view?.list ?? []
  const totalTools = (view?.status ?? []).reduce((sum, entry) => sum + entry.tools, 0)
  const pendingImport = discovered.filter((entry) => !entry.imported)

  return (
    <>
      <div className="shrink-0 border-b border-s-line px-3 py-1.5 text-s-faint">
        第三方工具进程，会拿到完整权限。批准发生在 server 级：确认一次，命令行一改就自动失效。
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === null ? (
          <Empty>正在读取…</Empty>
        ) : servers.length === 0 ? (
          <div className="px-3 py-4 text-s-faint">
            <div className="mb-1 text-s-soft">还没有配置 MCP server。</div>
            <div>
              用命令行导入或添加：<span className="font-mono text-s-body">gt mcp import</span> ·{" "}
              <span className="font-mono text-s-body">gt mcp confirm &lt;id&gt;</span>
            </div>
            <div className="mt-1">
              配置写在 <span className="font-mono">{view.path}</span>。新加的 server 默认不跑，确认一次才会启动。
            </div>
          </div>
        ) : (
          <div className="divide-y divide-s-line/40">
            {servers.map((server) => {
              const live = liveStatus(view, server.id)
              const state = describe(server, live)
              return (
                <div key={server.id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Led tone={state.tone} pulse={state.pulse} hollow={state.hollow} />
                    <span className="shrink-0 text-s-bright">{server.name}</span>
                    <Label className={TONE_TEXT[state.tone]}>{state.text}</Label>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[10px] text-s-faint"
                      title={commandLine(server)}
                    >
                      {commandLine(server)}
                    </span>

                    {!server.trusted ? (
                      <Btn sm variant="key" onClick={() => setPending({ kind: "ack", server })} disabled={busy}>
                        确认命令
                      </Btn>
                    ) : server.enabled ? (
                      <Btn sm onClick={() => toggle(server, false)} disabled={busy}>
                        停用
                      </Btn>
                    ) : (
                      <Btn sm onClick={() => toggle(server, true)} disabled={busy}>
                        启用
                      </Btn>
                    )}

                    <Btn
                      sm
                      className="hover:text-s-rust"
                      onClick={() => setPending({ kind: "delete", server })}
                      disabled={busy}
                    >
                      删除
                    </Btn>
                  </div>

                  {!server.trusted ? (
                    <div className="mt-1 pl-5 text-s-warn">
                      还没确认，或命令行改动过，所以不会运行。确认即同意以你的身份启动这个进程。
                    </div>
                  ) : null}

                  {live?.status === "failed" && live.error ? (
                    <div className="mt-1 break-words pl-5 text-s-rust">启动失败：{live.error}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

        {pendingImport.length > 0 ? (
          <div className="border-t border-s-line">
            <div className="flex items-center gap-2 bg-s-card px-3 py-1.5">
              <Label className="text-s-soft">从其它 agent 发现</Label>
              <span className="min-w-0 flex-1 truncate text-s-faint">导入后仍是「待确认」，不会自动运行</span>
              <Btn
                sm
                variant="warn"
                onClick={() => void importServers()}
                disabled={busy}
              >
                全部导入
              </Btn>
            </div>
            <div className="divide-y divide-s-line/40">
              {pendingImport.map((entry) => (
                <div key={`${entry.name}-${entry.from}`} className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-s-body">{entry.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-s-faint">
                      {entry.problem ?? [entry.command, ...entry.args].join(" ")}
                    </span>
                    {entry.problem ? (
                      <Label className="text-s-warn">跳过</Label>
                    ) : (
                      <Btn sm onClick={() => void importServers([entry.name])} disabled={busy}>
                        导入
                      </Btn>
                    )}
                  </div>
                  {entry.from || entry.warnings.length > 0 ? (
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-s-faint">
                      {entry.from ? <span className="min-w-0 truncate font-mono">{entry.from}</span> : null}
                      {entry.warnings.map((warning) => (
                        <span key={warning} className="text-s-warn">
                          ! {warning}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad" label="err">{error}</Notice> : null}

      <div className="flex shrink-0 items-center gap-2 border-t border-s-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-s-faint" title={view?.path ?? ""}>
          {view?.path ?? ""}
        </span>
        <span className="shrink-0 text-s-faint">
          {servers.length} 个 server · 已暴露 {totalTools} 个工具
        </span>
      </div>

      {pending ? (
        <Scrim className="z-60">
          <div className="s-dialog s-enter w-full max-w-md">
            <div className="s-mark h-2" />
            <div className="s-dialog__head">
              <Label className="bg-s-rust px-1.5 py-0.5 text-s-on-rust">
                {pending.kind === "ack" ? "提权" : "确认"}
              </Label>
              <Label className="text-s-bright">
                {pending.kind === "ack" ? "批准这个 MCP server" : "移除 MCP server"}
              </Label>
            </div>

            {pending.kind === "ack" ? (
              <>
                <div className="space-y-2 px-3 py-3 text-s-body">
                  <div>它将以你的身份在本机运行第三方进程，能读写任意文件、联网。</div>
                  <Well className="px-2.5 py-2 font-mono text-[11px] text-s-soft">
                    <div className="break-all">command  {pending.server.command}</div>
                    {pending.server.args.map((arg, index) => (
                      <div key={`${arg}-${index}`} className="break-all">
                        arg      {arg}
                      </div>
                    ))}
                    <div className="break-all">cwd      {pending.server.cwd || "（goto 根目录）"}</div>
                    <div className="break-all">指纹     {pending.server.fingerprint}</div>
                  </Well>
                  <div className="text-s-faint">
                    command、args 或 cwd 以后一改，这条批准立即失效，需要重新确认。env 可以改，不影响批准。
                  </div>
                </div>
                <DialogFoot>
                  <Btn onClick={() => setPending(null)}>取消</Btn>
                  <Btn variant="bad" onClick={() => confirmAck(pending.server)}>
                    我确认，启动
                  </Btn>
                </DialogFoot>
              </>
            ) : (
              <>
                <div className="space-y-2 px-3 py-3 text-s-body">
                  <div>
                    移除「<span className="text-s-bright">{pending.server.name}</span>」？
                  </div>
                  <Well className="break-all px-2.5 py-2 font-mono text-[11px] text-s-soft">
                    {commandLine(pending.server)}
                  </Well>
                  <div className="text-s-faint">它会一并忘掉批准与指纹，不可恢复。</div>
                </div>
                <DialogFoot>
                  <Btn onClick={() => setPending(null)}>取消</Btn>
                  <Btn variant="bad" onClick={() => confirmDelete(pending.server)}>
                    删除
                  </Btn>
                </DialogFoot>
              </>
            )}
          </div>
        </Scrim>
      ) : null}
    </>
  )
}
