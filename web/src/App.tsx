import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { FolderNode, MeView, Message, PermissionResponse, SessionInfo, TextPart } from "@shared/protocol"
import { ApiError, api, REQUIRED_ROUTES, type AccessMode, type CommandInfo, type ContextInfo, type ProviderView, type Seat, type SessionMode, type Settings, type UploadedFile } from "./api"
import { changedFilesOf, fileRevisionOf } from "./changes"
import { publish, readActiveSession, subscribe, writeActiveSession } from "./bus"
import { useMediaQuery } from "./useMediaQuery"
import { applyTheme, readTheme, writeTheme, type Theme } from "./theme"
import { useSession } from "./useSession"
import { Btn, Chip, Icon, Label, Led, Modal, Notice, Seg, SegItem, Well, cx } from "./ui"
import Composer, { type ComposerHandle } from "./components/Composer"
import ExtensionsDialog from "./components/ExtensionsDialog"
import FileTree from "./components/FileTree"
import FilePreview from "./components/FilePreview"
import ReviewApp from "./components/ReviewApp"
import SidePanel from "./components/SidePanel"
import LogDialog from "./components/LogDialog"
import MemoryDialog from "./components/MemoryDialog"
import NavRail, { type NavGroup } from "./components/NavRail"
import ShortcutsDialog from "./components/ShortcutsDialog"
import SpawnDialog from "./components/SpawnDialog"
import SubagentStrip from "./components/SubagentStrip"
import SubagentWindow from "./components/SubagentWindow"
import MessageList from "./components/MessageList"
import ModelLimitsDialog from "./components/ModelLimitsDialog"
import NoteDialog from "./components/NoteDialog"
import PermissionDialog from "./components/PermissionDialog"
import type { StatusState } from "./components/StatusMark"
import QuestionDialog from "./components/QuestionDialog"
import SessionTree from "./components/SessionTree"
import SettingsDialog from "./components/SettingsDialog"
import ShareDialog from "./components/ShareDialog"
import TokenWatch from "./components/TokenWatch"

const MAX_PER_FOLDER = 50

/** Below this the side panel is dropped; below TIGHT the rail goes icon-only. */
const NARROW = "(max-width: 1180px)"
const TIGHT = "(max-width: 900px)"

/** A vertical hairline between two clusters in a bar. */
function VBar() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-s-line" />
}

/** A full-width alarm strip. It sits directly under the app bar so it is never
 *  mistaken for part of the transcript. */
function Banner({ tone, children }: { tone: "error" | "warn"; children: ReactNode }) {
  const alarm = tone === "error"
  return (
    <div className="flex shrink-0 items-stretch border-b border-s-line bg-s-panel shadow-[var(--el-1)]">
      <div className={cx("w-1 shrink-0", alarm ? "s-mark" : "s-mark--warn")} />
      <div
        className={cx(
          "flex flex-1 items-baseline gap-3 px-4 py-1.5",
          alarm ? "bg-s-rust/5 text-s-rust" : "bg-s-warn/5 text-s-warn",
        )}
      >
        <Label className="shrink-0">{alarm ? "alarm" : "warn"}</Label>
        <span className="min-w-0 flex-1">{children}</span>
      </div>
    </div>
  )
}

/** One numeric readout in the status bar. The tag is what makes it scannable. */
function Readout({
  label,
  value,
  tone,
  className,
}: {
  label: string
  value: string
  tone?: string
  className?: string
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`${label} ${value}`}>
      <Label className="text-s-faint">{label}</Label>
      <span className={cx(tone ?? "text-s-soft", className ?? "")}>{value}</span>
    </span>
  )
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [model, setModel] = useState("")
  const [showSettings, setShowSettings] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const [showLimits, setShowLimits] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [openSubagent, setOpenSubagent] = useState<string | null>(null)
  const [modelContext, setModelContext] = useState<ContextInfo | null>(null)
  const [contextNonce, setContextNonce] = useState(0)
  const [editing, setEditing] = useState<{ messageID: string; text: string } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [providers, setProviders] = useState<ProviderView | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelsBusy, setModelsBusy] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showExtensions, setShowExtensions] = useState(false)
  const [mcpAlerts, setMcpAlerts] = useState(0)
  // three fixed columns are right for a wide window and wrong for a narrow one,
  // so the panel starts out of the way when there is no room for it
  const [showPanel, setShowPanel] = useState(() => !window.matchMedia(NARROW).matches)
  const [bootError, setBootError] = useState<string | null>(null)
  const [staleServer, setStaleServer] = useState<string | null>(null)
  // who this browser is: null while unknown, "control", "review", or null inside a loaded
  // MeView when the server wanted a token and none was presented
  const [me, setMe] = useState<MeView | null>(null)
  const [showShare, setShowShare] = useState(false)
  // the workspace-relative path open in the read-only viewer, or null
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [memoryPending, setMemoryPending] = useState(0)
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined)
  const [newFolderName, setNewFolderName] = useState("")
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingFull, setPendingFull] = useState(false)
  // index.html already painted this before the bundle ran; we only keep the
  // React copy so the switch can render the current palette in its own label
  const [theme, setTheme] = useState<Theme>(() => readTheme())

  // This shell is the control seat's. The review seat never renders it - the branch below
  // hands it to ReviewApp, which is an interface of its own rather than this one with things
  // switched off. The server refuses the review seat every control-only route either way.
  const seat: Seat | null = me?.seat ?? null

  const state = useSession(activeId)
  const turnStartRef = useRef<number | null>(null)
  const composerRef = useRef<ComposerHandle>(null)

  useEffect(() => {
    return subscribe((message) => {
      if (message.type === "session.select") setActiveId(message.id)
      if (message.type === "sessions.changed") {
        void api.sessions().then(setSessions).catch(() => undefined)
      }
    })
  }, [])

  useEffect(() => {
    writeActiveSession(activeId)
    // a pending re-edit belongs to the session it came from
    setEditing(null)
    // so does an open file: the path is relative to that conversation's workspace
    setPreviewPath(null)
  }, [activeId])

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const narrow = useMediaQuery(NARROW)
  const tight = useMediaQuery(TIGHT)

  // Fold the panel away only when the threshold is actually crossed, so a manual
  // toggle is not undone by an unrelated re-render — only by resizing.
  const narrowRef = useRef(narrow)
  useEffect(() => {
    if (narrowRef.current === narrow) return
    narrowRef.current = narrow
    setShowPanel(!narrow)
  }, [narrow])

  const openSessionsWindow = () => {
    window.open(`${window.location.origin}/?window=sessions`, "goto-sessions", "width=380,height=780")
  }

  /** Persisting and painting are the same action, so they live in one place. */
  const toggleTheme = () => {
    const next: Theme = theme === "linen" ? "dark" : "linen"
    writeTheme(next)
    setTheme(next)
  }

  useEffect(() => {
    if (state.running) {
      turnStartRef.current = Date.now()
      return
    }
    if (turnStartRef.current !== null) {
      setLastTurnMs(Date.now() - turnStartRef.current)
      turnStartRef.current = null
    }
  }, [state.running])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const identity = await api.me()
        if (cancelled) return
        setMe(identity)

        // No seat means the server wants a token and this browser has none: every other call
        // would 401, so stop here and let the render show "ask the host for a link".
        if (!identity.seat) return

        // The review seat gets its own shell, and that shell loads its own data: settings,
        // folders and the folder tree are all control-only and would just 403 here.
        if (identity.seat === "review") return

        const loaded = await api.settings()
        if (cancelled) return
        setSettings(loaded)
        setModel(loaded.model)
        if (!loaded.hasApiKey) setShowSettings(true)

        const folderList = await api.folders()
        if (cancelled) return
        setFolders(folderList)

        const list = await api.sessions()
        if (cancelled) return

        if (list.length > 0) {
          setSessions(list)
          const stored = readActiveSession()
          const valid = stored && list.some((session) => session.id === stored) ? stored : list[0].id
          setActiveId(valid)
        } else if (folderList.length > 0) {
          // the server guarantees at least one folder, so this is the normal first run
          const created = await api.createSession(folderList[0].id)
          if (cancelled) return
          setSessions([created])
          setActiveId(created.id)
        }
      } catch (error) {
        if (!cancelled) setBootError(error instanceof Error ? error.message : String(error))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    void api.commands().then(setCommands).catch(() => undefined)
  }, [])

  const prevRunningRef = useRef(false)

  const refreshMemory = useCallback((sessionID: string | null) => {
    if (!sessionID) {
      setMemoryPending(0)
      return
    }
    void api
      .memory(sessionID)
      .then((view) => setMemoryPending(view.pending))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshMemory(activeId)
  }, [activeId, refreshMemory])

  useEffect(() => {
    const was = prevRunningRef.current
    prevRunningRef.current = state.running
    // refresh only on the running -> idle edge, so this cannot feed itself
    if (!was || state.running) return
    void api.sessions().then(setSessions).catch(() => undefined)
    void api.settings().then(setSettings).catch(() => undefined)
    refreshMemory(activeId)
  }, [state.running, activeId, refreshMemory])

  const guard = async (action: () => Promise<void>) => {
    try {
      setActionError(null)
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const newConversation = (folderID: string) =>
    void guard(async () => {
      const created = await api.createSession(folderID)
      setSessions((prev) => [created, ...prev])
      setActiveId(created.id)
      publish({ type: "sessions.changed" })
    })

  /** The rail's primary action should land where you already are, not in folder #1. */
  const newConversationHere = () => {
    const folderID = sessions.find((session) => session.id === activeId)?.folderID ?? folders[0]?.id
    if (folderID) newConversation(folderID)
  }

  const moveSession = (sessionID: string, folderID: string) =>
    void guard(async () => {
      const updated = await api.moveSession(sessionID, folderID)
      setSessions((prev) => prev.map((session) => (session.id === sessionID ? updated : session)))
    })

  const moveFolder = (folderID: string, parentID: string | null) =>
    void guard(async () => {
      const updated = await api.updateFolder(folderID, { parentID })
      setFolders((prev) => prev.map((folder) => (folder.id === folderID ? updated : folder)))
    })

  const renameFolder = (folderID: string, name: string) =>
    void guard(async () => {
      const updated = await api.updateFolder(folderID, { name })
      setFolders((prev) => prev.map((folder) => (folder.id === folderID ? updated : folder)))
    })

  const deleteFolder = (folderID: string) => setPendingDelete(folderID)

  // mirrors descendantFolderIDs on the server; used only to preview the blast radius
  const deleteScope = (() => {
    if (!pendingDelete) return null

    const ids = new Set<string>([pendingDelete])
    let grew = true
    while (grew) {
      grew = false
      for (const folder of folders) {
        if (!folder.parentID || ids.has(folder.id) || !ids.has(folder.parentID)) continue
        ids.add(folder.id)
        grew = true
      }
    }

    const doomed = sessions.filter((session) => ids.has(session.folderID))
    return {
      name: folders.find((folder) => folder.id === pendingDelete)?.name ?? "这个文件夹",
      folders: ids.size - 1,
      sessions: doomed.length,
      running: doomed.filter((session) => session.running).length,
      sessionIDs: new Set(doomed.map((session) => session.id)),
    }
  })()

  const confirmDelete = () =>
    void guard(async () => {
      const id = pendingDelete
      if (!id) return

      const doomed = deleteScope?.sessionIDs ?? new Set<string>()
      await api.deleteFolder(id)

      const remaining = await api.sessions()
      const folderList = await api.folders()
      setFolders(folderList)

      if (activeId && doomed.has(activeId)) {
        // the open conversation just vanished; land on something that exists
        if (remaining.length > 0) {
          setActiveId(remaining[0].id)
        } else if (folderList.length > 0) {
          const created = await api.createSession(folderList[0].id)
          remaining.push(created)
          setActiveId(created.id)
        } else {
          setActiveId(null)
        }
      }

      setSessions(remaining)
      setPendingDelete(null)
      publish({ type: "sessions.changed" })
    })

  const submitNewFolder = () =>
    void guard(async () => {
      const name = newFolderName.trim()
      if (!name) return
      const folder = await api.createFolder({ name, parentID: newFolderParent ?? null })
      setFolders((prev) => [...prev, folder])
      setNewFolderParent(undefined)
      setNewFolderName("")
    })

  const accessMode: AccessMode = sessions.find((session) => session.id === activeId)?.accessMode ?? "workspace"
  // plan withholds every mutating tool; only the user can switch it
  const mode: SessionMode = sessions.find((session) => session.id === activeId)?.mode ?? "agent"
  // model is per conversation; empty means "follow the global setting"
  const sessionModel = sessions.find((session) => session.id === activeId)?.model ?? ""
  const effectiveModel = sessionModel || model
  // how many messages a send would discard while re-editing
  const editIndex = editing ? state.messages.findIndex((message) => message.id === editing.messageID) : -1
  const editDiscard = editIndex >= 0 ? state.messages.length - editIndex : 0

  const subagents = sessions.filter((session) => activeId !== null && session.parentID === activeId)
  const openSubagentInfo = subagents.find((session) => session.id === openSubagent) ?? null

  const closeSubagent = async (id: string) => {
    if (openSubagent === id) setOpenSubagent(null)
    await guard(async () => {
      await api.deleteSession(id)
      setSessions(await api.sessions())
    })
  }

  const applyAccessMode = (mode: AccessMode) =>
    void guard(async () => {
      if (!activeId) return
      const updated = await api.setAccessMode(activeId, mode)
      setSessions((prev) => prev.map((session) => (session.id === activeId ? updated : session)))
      setPendingFull(false)
    })

  const requestAccessMode = (mode: AccessMode) => {
    if (mode === "full" && accessMode !== "full") {
      setPendingFull(true)
      return
    }
    applyAccessMode(mode)
  }

  const applyMode = (next: SessionMode) =>
    void guard(async () => {
      if (!activeId) return
      const updated = await api.setMode(activeId, next)
      setSessions((prev) => prev.map((session) => (session.id === activeId ? updated : session)))
    })

  const loadModels = useCallback(async (refresh = false) => {
    setModelsBusy(true)
    try {
      const result = await api.models(refresh)
      setModels(result.models)
      setModelsError(result.error ?? null)
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelsBusy(false)
    }
  }, [])

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await api.providers())
    } catch {
      // the switcher is optional; a failure just hides it
      setProviders(null)
    }
  }, [])

  useEffect(() => {
    if (!settings?.hasApiKey) return
    void loadModels()
    void loadProviders()
  }, [settings?.hasApiKey, settings?.baseURL, loadModels, loadProviders])

  // a failed or unconfirmed MCP server is otherwise silent until someone opens the dialog,
  // so a lightweight poll drives the rail badge
  const refreshMcp = useCallback(async () => {
    try {
      const view = await api.mcp()
      const failed = view.status.filter((entry) => entry.status === "failed").length
      const pending = view.list.filter((entry) => entry.needsTrust).length
      setMcpAlerts(failed + pending)
    } catch {
      setMcpAlerts(0)
    }
  }, [])

  useEffect(() => {
    void refreshMcp()
    const timer = setInterval(() => void refreshMcp(), 30_000)
    return () => clearInterval(timer)
  }, [refreshMcp])

  // the server only sends a revision; the list itself is refetched from the sessions list,
  // which is also what makes sub-agents show up after a page reload
  useEffect(() => {
    if (state.subagentsRevision === 0) return
    void api.sessions().then(setSessions).catch(() => undefined)
  }, [state.subagentsRevision])

  const changeProvider = (id: string) => {
    if (!id) return
    void guard(async () => {
      const next = await api.activateProvider(id)
      setSettings(next)
      // the provider carries its own default model, so realign everything that depends on it
      setModel(next.model)
      setContextNonce((value) => value + 1)
      await Promise.all([loadModels(true), loadProviders()])
    })
  }

  useEffect(() => {
    // the bundle is rebuilt without restarting the server, so the two can drift apart
    void (async () => {
      try {
        const info = await api.version()
        const missing = REQUIRED_ROUTES.filter((route) => !info.routes.includes(route))
        setStaleServer(missing.length > 0 ? missing.join("、") : null)
      } catch {
        setStaleServer("没有 /api/version")
      }
    })()
  }, [])

  useEffect(() => {
    if (!settings?.hasApiKey || !effectiveModel) {
      setModelContext(null)
      return
    }
    let cancelled = false
    void api
      .context(effectiveModel)
      .then((info) => {
        // switching models can resolve out of order, so only accept the answer we asked for
        if (!cancelled && info.model === effectiveModel) setModelContext(info)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [effectiveModel, settings?.hasApiKey, contextNonce])

  // files this conversation wrote or edited, derived from the tool calls we already have
  // (no extra endpoint, and it can only show what the agent actually did). The review seat
  // derives the same thing from the same helper, so the two shells cannot disagree.
  const changedFiles = useMemo(
    () => changedFilesOf(state.messages, settings?.workspace ?? ""),
    [state.messages, settings?.workspace],
  )

  // grows on every write/edit, which is what makes the tree refetch while the agent works
  const fileRevision = useMemo(() => fileRevisionOf(state.messages), [state.messages])

  const startEdit = async (message: Message) => {
    if (!activeId) return
    const text = message.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (!text) return

    // stop the task first: a running turn keeps appending to the range a rewind would drop
    if (state.running) {
      await api.abort(activeId).catch(() => undefined)
    }
    setEditing({ messageID: message.id, text })
    composerRef.current?.setText(text)
  }

  const send = async (text: string, files: UploadedFile[] = []) => {
    if (!activeId) return
    if (!settings?.hasApiKey) {
      setShowSettings(true)
      return
    }

    setActionError(null)
    try {
      // re-editing an earlier message drops it and everything after it before re-sending
      if (editing) {
        await api.rewind(activeId, editing.messageID)
        setEditing(null)
      }
      // the model is resolved server-side: session override first, then the global setting
      await api.prompt(activeId, text, undefined, files)
    } catch (error) {
      if (error instanceof ApiError && error.code === "NO_API_KEY") {
        setShowSettings(true)
        return
      }
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const changeModel = (value: string) => {
    if (!activeId) return
    void guard(async () => {
      const updated = await api.setSessionModel(activeId, value)
      setSessions((prev) => prev.map((session) => (session.id === activeId ? updated : session)))
    })
  }

  const stop = () => {
    if (!activeId) return
    void api.abort(activeId).catch(() => undefined)
  }

  const respond = async (response: PermissionResponse) => {
    const request = state.permission
    if (!request) return
    try {
      await api.permission(request.id, response)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const answerQuestion = async (answer: string, skip: boolean) => {
    const request = state.question
    if (!request) return
    try {
      await api.answerQuestion(request.id, answer, skip)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleSaved = (next: Settings) => {
    setSettings(next)
    setModel(next.model)
    setShowSettings(false)
    setActionError(null)
  }

  const error = bootError ?? actionError ?? state.error

  // what the status meter reads: a fault beats work in progress beats finished
  const status: StatusState = error
    ? "error"
    : state.running
      ? "working"
      : state.messages.some((message) => message.role !== "user")
        ? "done"
        : "idle"

  const statusText = error
    ? "上一轮出错了"
    : state.running
      ? "正在处理你的请求"
      : status === "done"
        ? "已回复，等待下一步"
        : "待命中"

  /* Everything you can open, in one column, in the same order every time. The
     grouping is by what the thing belongs to, not by how often it is used. */
  const navGroups: NavGroup[] = [
    {
      group: "对话",
      entries: [
        {
          id: "panel",
          icon: "panel",
          label: showPanel ? "收起侧栏" : "展开侧栏",
          hint: "文件夹与项目树",
          on: showPanel,
          run: () => setShowPanel((value) => !value),
        },
        {
          id: "sessions",
          icon: "chat",
          label: "全部会话",
          hint: "在新窗口里列出所有对话，可切换与删除",
          run: openSessionsWindow,
        },
        {
          id: "note",
          icon: "note",
          label: "笔记",
          hint: "本对话的笔记，agent 写给自己看的",
          disabled: !activeId,
          run: () => setShowNote(true),
        },
        {
          id: "memory",
          icon: "memory",
          label: "记忆",
          hint: "跨轮次保留的事实；有待确认时会亮数字",
          badge: memoryPending,
          run: () => setShowMemory(true),
        },
        {
          id: "extensions",
          icon: "plug",
          label: "扩展",
          hint: "MCP 第三方工具与技能：状态、确认、启停",
          badge: mcpAlerts,
          run: () => setShowExtensions(true),
        },
      ],
    },
    {
      group: "系统",
      entries: [
        {
          id: "share",
          icon: "copy",
          label: "共享",
          hint: "把当前对话交给检查席查看，或换一条检查席链接",
          note: state.session?.shared ? "已共享" : undefined,
          run: () => setShowShare(true),
        },
        {
          id: "logs",
          icon: "terminal",
          label: "日志",
          hint: "应用运行日志，实时跟随",
          run: () => setShowLogs(true),
        },
        {
          id: "settings",
          icon: "tune",
          label: "设置",
          hint: "API key、端点、工作区、联网开关",
          run: () => setShowSettings(true),
        },
        {
          id: "theme",
          icon: theme === "linen" ? "moon" : "sun",
          label: "主题",
          hint: theme === "linen" ? "当前：米白色系 · 点击切到深色" : "当前：深色 · 点击切到米白",
          note: theme === "linen" ? "米白" : "深色",
          run: toggleTheme,
        },
        {
          id: "help",
          icon: "help",
          label: "快捷键",
          hint: "键盘与鼠标手势一览",
          run: () => setShowHelp(true),
        },
      ],
    },
  ]

  // The review seat gets its own interface, not this one with the controls taken away.
  if (me?.seat === "review") return <ReviewApp />

  // No seat and the server wants one: nothing else on this screen can work, so it is replaced
  // wholesale rather than shown with a wall of 401 banners over it.
  if (!me && !bootError) {
    return <div className="flex h-full items-center justify-center text-s-faint">正在连接…</div>
  }

  if (me && !me.seat) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Well className="max-w-md p-5">
          <div className="mb-2 text-[15px] font-semibold tracking-tight text-s-bright">需要访问链接</div>
          <div className="mb-3 text-s-body">
            这台 goto 开在局域网上，所有接口都需要令牌。请向布置主机的同学要一条链接（形如{" "}
            <span className="font-mono text-[11px]">http://…:8787/#t=…</span>），直接打开它就行。
          </div>
          <div className="text-s-faint">
            令牌只在打开链接时读一次，之后存在本机浏览器里，地址栏里的那一截会被自动抹掉。
          </div>
        </Well>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <NavRail
        status={status}
        statusText={statusText}
        compact={tight}
        onNewConversation={newConversationHere}
        canCreate={folders.length > 0}
        groups={navGroups}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {/* ------------------------------------------------------------------
         * App bar. Identity, not state: the status meter is the first thing in
         * the rail, so this row is free to answer "which conversation, on which
         * model".
         * ---------------------------------------------------------------- */}
        <header className="s-bar flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[14px] font-semibold tracking-tight text-s-bright">
              {state.session?.title ?? "还没有对话"}
            </span>
            <span className="flex items-center gap-1.5">
              <Label className={mode === "plan" ? "text-s-warn" : "text-s-faint"}>
                {mode === "plan" ? "计划 · 只读" : "执行"}
              </Label>
              <span className="text-s-line">│</span>
              <Label className={accessMode === "full" ? "text-s-rust" : "text-s-faint"}>
                {accessMode === "full" ? "完全访问" : "工作区"}
              </Label>
              <span className="text-s-line">│</span>
              <Label className="text-s-faint">{state.messages.length} 条消息</Label>
            </span>
          </div>

          {seat ? (
            <Label className="text-s-moss" title="控制席：驱动 AI、应答弹窗、修改设置">
              控制席
            </Label>
          ) : null}

          {providers && providers.list.length > 0 ? (
            <label
              className="flex shrink-0 items-center gap-1.5"
              title={
                providers.active
                  ? "切换 API 提供商（会一并换掉 baseURL / key / 默认模型）"
                  : "当前配置不匹配列表里的任何提供商，所以显示为自定义"
              }
            >
              <Label className="text-s-faint">端点</Label>
              <select
                value={providers.active ?? ""}
                onChange={(event) => changeProvider(event.target.value)}
                className={cx("s-input w-32 min-w-0 py-1 text-s-body", providers.active ? "" : "s-input--warn")}
              >
                {providers.active === null ? <option value="">（自定义）</option> : null}
                {providers.list.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label
            className="flex shrink-0 items-center gap-1.5"
            title={modelsError ? `模型列表拉取失败：${modelsError}` : "每个会话独立；选「跟随设置」即用全局默认"}
          >
            <Label className="text-s-faint">模型</Label>
            <select
              value={sessionModel}
              onChange={(event) => changeModel(event.target.value)}
              disabled={!activeId || modelsBusy}
              className={cx(
                "s-input w-44 min-w-0 py-1 text-s-body disabled:opacity-40",
                sessionModel ? "s-input--focus" : "",
              )}
            >
              <option value="">跟随设置（{model || "未设置"}）</option>
              {/* a hand-typed name that the provider does not advertise must stay selectable */}
              {[...new Set([...models, ...(sessionModel ? [sessionModel] : [])])].sort().map((name) => (
                <option key={name} value={name}>
                  {/* an unknown name is exactly what produces "404 model is not found" */}
                  {name}
                  {models.length > 0 && !models.includes(name) ? "（当前端点没有）" : ""}
                </option>
              ))}
            </select>
            <Btn
              sm
              icon="refresh"
              onClick={() => void loadModels(true)}
              disabled={modelsBusy}
              title={modelsError ? `拉取失败：${modelsError}` : `重新拉取模型列表（当前 ${models.length} 个）`}
              className={cx(modelsBusy && "s-pulse", modelsError && "text-s-rust")}
            />
            <Btn sm icon="tune" onClick={() => setShowLimits(true)} title="配置每个模型的 context / input / output 上限">
              限制
            </Btn>
          </label>

          <VBar />

          <span className="flex shrink-0 items-center gap-1.5" title={statusText}>
            <Led
              tone={status === "working" ? "warn" : status === "error" ? "bad" : status === "done" ? "ok" : "neutral"}
              pulse={status === "working"}
            />
            <Label
              className={cx(
                status === "working"
                  ? "text-s-warn"
                  : status === "error"
                    ? "text-s-rust"
                    : status === "done"
                      ? "text-s-moss"
                      : "text-s-faint",
              )}
            >
              {status === "working"
                ? "处理中"
                : status === "error"
                  ? "出错"
                  : status === "done"
                    ? "就绪"
                    : "空闲"}
            </Label>
          </span>
        </header>

        {settings && !settings.hasApiKey ? (
          <Banner tone="warn">
            尚未配置 API Key，agent 无法发起请求。
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="ml-2 underline underline-offset-2 hover:text-s-bright"
            >
              去配置
            </button>
          </Banner>
        ) : null}

        {staleServer ? (
          <Banner tone="error">
            服务端比前端旧（缺 {staleServer}）。界面已经更新，但正在跑的进程还是老的 ——
            在启动它的窗口按 Ctrl+C，然后重新运行 <b className="font-mono">gt</b>。
          </Banner>
        ) : null}

        {error ? <Banner tone="error">{error}</Banner> : null}

        <MessageList
          messages={state.messages}
          running={state.running}
          onEdit={startEdit}
          onExample={(text) => composerRef.current?.setText(text)}
        />

        <TokenWatch
          messages={state.messages}
          context={modelContext ?? settings?.context ?? null}
          running={state.running}
          lastTurnMs={lastTurnMs}
        />

        <SubagentStrip subagents={subagents} onOpen={setOpenSubagent} onClose={(id) => void closeSubagent(id)} />

        <Composer
          ref={composerRef}
          running={state.running}
          disabled={!activeId}
          commands={commands}
          mode={mode}
          onToggleMode={() => applyMode(mode === "plan" ? "agent" : "plan")}
          editing={editing ? { count: editDiscard, onCancel: () => setEditing(null) } : null}
          onSend={send}
          onStop={stop}
        />

        {/* One status bar, not two: every stacked row here is height taken away from the
            transcript, and the access-mode strip and the counters answer the same question
            ("what is this session allowed to do, and how big is it"). */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-s-line bg-s-panel px-3 py-1.5">
          <Seg>
            <SegItem
              on={accessMode === "workspace"}
              tone="ok"
              onClick={() => requestAccessMode("workspace")}
              disabled={!activeId}
              title="read / write / edit / list / grep 限制在工作区内"
            >
              <Icon name="tree" size={12} />
              工作区
            </SegItem>
            <SegItem
              on={accessMode === "full"}
              tone="danger"
              onClick={() => requestAccessMode("full")}
              disabled={!activeId}
              title="允许文件工具访问任意路径（会先弹窗确认）"
            >
              <Icon name="warn" size={12} />
              完全访问
            </SegItem>
          </Seg>

          <span className="min-w-0 flex-1 truncate text-s-faint">
            {mode === "plan"
              ? "计划模式：只读，write / edit / shell / MCP 全部禁用"
              : accessMode === "full"
                ? "文件工具可读写任意路径（shell 一向不受此限制）"
                : `文件工具限制在 ${settings?.workspace ?? "工作区"} 内`}
          </span>

          <Readout label="ws" value={settings?.workspace || "—"} className="max-w-[13rem] truncate" />
          <span aria-hidden className="shrink-0 text-s-line">│</span>
          <Readout label="folders" value={String(folders.length)} />
          <span aria-hidden className="shrink-0 text-s-line">│</span>
          <Readout label="sessions" value={String(sessions.length)} />
          <span aria-hidden className="shrink-0 text-s-line">│</span>
          <Readout label="msgs" value={String(state.messages.length)} />
          <span aria-hidden className="shrink-0 text-s-line">│</span>
          <Readout label="model" value={effectiveModel || "—"} tone={sessionModel ? "text-s-ember" : undefined} />
        </div>
      </main>

      {/* Folders and the project tree dock on the right, so the transcript keeps the
          wide half of the window and the panel never pushes the conversation around. */}
      {showPanel ? (
        <SidePanel
          top={
            <SessionTree
              folders={folders}
              sessions={sessions}
              activeId={activeId}
              maxPerFolder={MAX_PER_FOLDER}
              onSelect={setActiveId}
              onNewConversation={newConversation}
              onAddFolder={(parentID) => {
                setNewFolderName("")
                setNewFolderParent(parentID)
              }}
              onMoveSession={moveSession}
              onMoveFolder={moveFolder}
              onRenameFolder={renameFolder}
              onDeleteFolder={deleteFolder}
              onClose={() => setShowPanel(false)}
            />
          }
          bottom={
            <FileTree
              sessionID={activeId}
              onPick={(path) => composerRef.current?.insert(path)}
              onView={setPreviewPath}
              onClose={() => setShowPanel(false)}
              changed={changedFiles}
              revision={fileRevision}
              workspace={settings?.workspace ?? ""}
            />
          }
        />
      ) : null}

      {newFolderParent !== undefined ? (
        <Modal
          title="新建文件夹"
          onClose={() => setNewFolderParent(undefined)}
          footer={
            <>
              <Btn onClick={() => setNewFolderParent(undefined)}>取消</Btn>
              <Btn variant="key" onClick={submitNewFolder} disabled={!newFolderName.trim()}>
                创建
              </Btn>
            </>
          }
        >
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitNewFolder()
              if (event.key === "Escape") setNewFolderParent(undefined)
            }}
            placeholder="文件夹名"
            className="s-input w-full"
          />
          <div className="mt-2 text-s-faint">
            文件夹只用来分组，不会限制 agent 能访问的范围。每个文件夹最多 50 个对话。
          </div>
        </Modal>
      ) : null}

      {deleteScope ? (
        <Modal
          badge="confirm"
          badgeTone="bad"
          title="删除文件夹"
          tone="bad"
          onClose={() => setPendingDelete(null)}
          footer={
            <>
              <Btn onClick={() => setPendingDelete(null)}>取消</Btn>
              <Btn variant="bad" onClick={confirmDelete} disabled={deleteScope.running > 0}>
                确认删除
              </Btn>
            </>
          }
        >
          <div className="space-y-2 text-s-body">
            <div>
              确认删除「<span className="text-s-bright">{deleteScope.name}</span>」？
            </div>

            <Well className="px-2.5 py-2 text-s-soft">
              同时删除 <span className="text-s-rust">{deleteScope.sessions}</span> 个对话
              {deleteScope.folders > 0 ? (
                <>
                  、<span className="text-s-rust">{deleteScope.folders}</span> 个子文件夹
                </>
              ) : null}
            </Well>

            {deleteScope.running > 0 ? (
              <Notice tone="bad">有 {deleteScope.running} 个对话正在运行，先停止它们再删。</Notice>
            ) : (
              <div className="text-s-faint">对话和它们的记忆会一起消失，不可恢复。</div>
            )}
          </div>
        </Modal>
      ) : null}

      {pendingFull ? (
        <Modal
          badge="escalate"
          badgeTone="bad"
          title="开启完全访问"
          tone="bad"
          onClose={() => setPendingFull(false)}
          footer={
            <>
              <Btn onClick={() => setPendingFull(false)}>取消</Btn>
              <Btn variant="bad" onClick={() => applyAccessMode("full")}>
                开启完全访问
              </Btn>
            </>
          }
        >
          <div className="space-y-2 text-s-body">
            <div>read / write / edit / list / grep 将可以对你机器上的任意路径读写，不再限制在工作区内。</div>
            <Well className="px-2.5 py-2 text-s-soft">
              当前工作区：
              <span className="ml-1 break-all text-s-bright">{settings?.workspace ?? "—"}</span>
            </Well>
            <div className="text-s-faint">
              只作用于当前对话，随时可以切回。注意 shell 工具本来就不受工作区限制，它靠的是每次执行前的权限弹窗。
            </div>
          </div>
        </Modal>
      ) : null}

      {state.question ? <QuestionDialog request={state.question} onAnswer={answerQuestion} /> : null}

      {state.spawn && settings ? (
        <SpawnDialog request={state.spawn} max={settings.max} onClose={() => undefined} />
      ) : null}

      {state.permission ? <PermissionDialog request={state.permission} onRespond={respond} /> : null}

      {showShare ? (
        <ShareDialog
          sessionID={activeId}
          sessionTitle={state.session?.title ?? "未命名"}
          shared={state.session?.shared ?? false}
          onShared={(info) => setSessions((prev) => prev.map((session) => (session.id === info.id ? info : session)))}
          onClose={() => setShowShare(false)}
        />
      ) : null}

      {previewPath && activeId ? (
        <FilePreview sessionID={activeId} path={previewPath} onClose={() => setPreviewPath(null)} />
      ) : null}

      {showSettings && settings ? (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSaved={handleSaved} />
      ) : null}

      {showHelp ? <ShortcutsDialog onClose={() => setShowHelp(false)} /> : null}

      {openSubagentInfo ? (
        <SubagentWindow
          sessionID={openSubagentInfo.id}
          task={openSubagentInfo.task ?? openSubagentInfo.title}
          onClose={() => setOpenSubagent(null)}
        />
      ) : null}

      {showNote && activeId ? (
        <NoteDialog
          sessionID={activeId}
          revision={state.noteRevision}
          running={state.running}
          onClose={() => setShowNote(false)}
        />
      ) : null}

      {showLimits ? (
        <ModelLimitsDialog
          onClose={() => setShowLimits(false)}
          onSaved={() => setContextNonce((value) => value + 1)}
        />
      ) : null}

      {showMemory && activeId ? (
        <MemoryDialog
          sessionID={activeId}
          onClose={() => setShowMemory(false)}
          onDirty={() => refreshMemory(activeId)}
        />
      ) : null}

      {showLogs ? <LogDialog onClose={() => setShowLogs(false)} /> : null}

      {showExtensions ? (
        <ExtensionsDialog
          sessionID={activeId}
          onClose={() => {
            setShowExtensions(false)
            void refreshMcp()
          }}
        />
      ) : null}
    </div>
  )
}
