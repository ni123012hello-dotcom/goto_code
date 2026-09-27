import { useCallback, useEffect, useRef, useState, type DragEvent } from "react"
import { api, type TreeNode } from "../api"
import type { ChangeKind, ChangedFile } from "../changes"
import { Btn, Empty, Icon, Label, Led, Notice, Well, cx } from "../ui"

type Props = {
  sessionID: string | null
  /** the primary action on a file, run on double-click. The control seat inserts the path into
   *  the composer; the review seat opens the code, since it has no composer to insert into. */
  onPick: (path: string) => void
  /** the tooltip and footer text describing what onPick does */
  pickHint?: string
  /** open the read-only viewer from the hover button. Kept off the plain click on purpose: a
   *  click already selects, and taking it over would swallow half of a double-click. */
  onView: (path: string) => void
  /** present only when the tree is one half of a collapsible panel; the review seat docks the
   *  tree permanently and passes nothing */
  onClose?: () => void
  /** dragging files in stages an import that ends in a write. Only the control seat may do
   *  that, so the review seat turns the whole gesture off rather than offering a 403. */
  canImport?: boolean
  /** files this conversation wrote or edited, keyed by the same relative path the tree uses */
  changed: Map<string, ChangedFile>
  /** grows on every write/edit so already-loaded directories can be refetched */
  revision: number
  /** the tree lists the workspace; hidden entries are remembered per workspace */
  workspace: string
}

/** mirrors the server's ceiling so a huge drop is refused before reading anything */
const MAX_DROP = 50

// Hiding is a view-only preference: nothing on disk is touched. It lives in localStorage
// (shared across tabs of this origin) keyed by workspace, so it needs no server state.
const HIDDEN_KEY = "goto.treeHidden"

function readHidden(workspace: string): Set<string> {
  if (!workspace) return new Set()
  try {
    const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}") as Record<string, string[]>
    const list = all[workspace]
    return new Set(Array.isArray(list) ? list : [])
  } catch {
    return new Set()
  }
}

function writeHidden(workspace: string, paths: Set<string>): void {
  if (!workspace) return
  try {
    const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}") as Record<string, string[]>
    if (paths.size === 0) delete all[workspace]
    else all[workspace] = [...paths].sort()
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(all))
  } catch {
    /* a full or disabled localStorage should not break the tree */
  }
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes}`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}k`
  return `${(bytes / 1024 / 1024).toFixed(1)}M`
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? "")
      const comma = result.indexOf(",")
      resolve(comma === -1 ? "" : result.slice(comma + 1))
    }
    reader.onerror = () => {
      // Chromium reports a bare `NotFoundError` here. In practice it means the file vanished
      // between the drop and the read: moved, deleted, or a cloud placeholder (OneDrive
      // "files on demand") that could not be hydrated in time.
      reject(new Error("读取不到内容（文件可能已被移动或删除，或是云盘的按需下载占位文件）"))
    }
    reader.readAsDataURL(file)
  })
}

type DropEntry = { file: File; path: string }

async function walk(entry: FileSystemEntry, prefix: string, out: DropEntry[]): Promise<void> {
  if (out.length >= MAX_DROP) return

  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    const file = await new Promise<File | null>((resolve) =>
      fileEntry.file((value) => resolve(value), () => resolve(null)),
    )
    if (file) out.push({ file, path: prefix ? `${prefix}/${entry.name}` : entry.name })
    return
  }

  if (!entry.isDirectory) return

  const folder = prefix ? `${prefix}/${entry.name}` : entry.name
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries returns one batch at a time and has to be called until it comes back empty
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries((entries) => resolve(entries), () => resolve([])),
    )
    if (batch.length === 0) break
    for (const child of batch) await walk(child, folder, out)
    if (out.length >= MAX_DROP) return
  }
}

/** Reads the drop synchronously: the entry handles are only valid during the event, so
 *  they are grabbed here and walked afterwards. */
function collectDrop(dataTransfer: DataTransfer | null): { entries: FileSystemEntry[]; plain: File[] } {
  const entries = Array.from(dataTransfer?.items ?? [])
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null)

  return { entries, plain: Array.from(dataTransfer?.files ?? []) }
}

const MARK: Record<ChangeKind, { label: string; tone: "ok" | "warn" | "bad"; hint: string }> = {
  new: { label: "新", tone: "ok", hint: "本对话新建了这个文件" },
  modified: { label: "改", tone: "warn", hint: "本对话改动过这个文件" },
  failed: { label: "!", tone: "bad", hint: "本对话写这个文件时失败了" },
}

/** The project tree. It doubles as an import target: dropping files stages them
 *  and asks before anything is written to disk. */
export default function FileTree({ sessionID, onPick, pickHint = "双击把路径插进输入框", onView, onClose, canImport = true, changed, revision, workspace }: Props) {
  const [children, setChildren] = useState<Record<string, TreeNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]))
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [showHidden, setShowHidden] = useState(false)
  // a drop is staged here first: nothing touches the disk until the user confirms
  const [pending, setPending] = useState<{ dir: string; files: DropEntry[]; truncated: number } | null>(null)

  // each workspace keeps its own hidden list; switching conversations must reload it
  useEffect(() => {
    setHidden(readHidden(workspace))
    setShowHidden(false)
  }, [workspace])

  const hide = (path: string) => {
    setHidden((prev) => {
      const next = new Set(prev).add(path)
      writeHidden(workspace, next)
      return next
    })
    setNotice(null)
  }

  const restore = (path: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      next.delete(path)
      writeHidden(workspace, next)
      return next
    })
  }

  const restoreAll = () => {
    setHidden(() => {
      writeHidden(workspace, new Set())
      return new Set()
    })
    setShowHidden(false)
  }

  const load = useCallback(
    async (dir: string) => {
      if (!sessionID) return
      setBusy(true)
      setError(null)
      try {
        const view = await api.tree(sessionID, dir)
        setChildren((prev) => ({ ...prev, [dir]: view.nodes }))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [sessionID],
  )

  const refresh = useCallback(() => {
    setChildren({})
    setExpanded(new Set([""]))
    setSelected(null)
    setNotice(null)
    setPending(null)
    void load("")
  }, [load])

  useEffect(() => {
    setChildren({})
    setExpanded(new Set([""]))
    setSelected(null)
    setPending(null)
    if (sessionID) void load("")
  }, [sessionID, load])

  const loadedRef = useRef<string[]>([])
  loadedRef.current = Object.keys(children)

  useEffect(() => {
    if (revision === 0) return
    for (const dir of loadedRef.current) void load(dir)
  }, [revision, load])

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
    if (!children[dir]) void load(dir)
  }

  const reveal = async () => {
    const dirs = new Set<string>()
    for (const path of changed.keys()) {
      const parts = path.split("/")
      for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"))
    }
    const ordered = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length)
    setExpanded(new Set(["", ...ordered]))
    for (const dir of ordered) await load(dir)
  }

  const beginDrop = async (dir: string, entries: FileSystemEntry[], plain: File[]) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const collected: DropEntry[] = []
      if (entries.length > 0) {
        for (const entry of entries) await walk(entry, "", collected)
      } else {
        for (const file of plain) collected.push({ file, path: file.name })
      }

      if (collected.length === 0) {
        setError("没认出文件。空文件夹会被忽略；只拖文件夹图标也可以，但里面得有文件。")
        return
      }

      setPending({ dir, files: collected.slice(0, MAX_DROP), truncated: Math.max(0, collected.length - MAX_DROP) })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const confirmImport = async () => {
    if (!pending || !sessionID) return
    const { dir, files } = pending

    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      // allSettled, not all: one unreadable file must not throw away the whole drop
      const results = await Promise.allSettled(
        files.map(async (entry) => ({ path: entry.path, dataBase64: await readBase64(entry.file) })),
      )
      const payload: { path: string; dataBase64: string }[] = []
      const unreadable: string[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") payload.push(result.value)
        else unreadable.push(files[index].path)
      }

      if (payload.length === 0) {
        setError(
          `这 ${files.length} 个文件都读不出来：文件可能已被移动或删除，或是云盘的按需下载占位文件。` +
            `先把它们下载到本地再拖进来。`,
        )
        return
      }

      const result = await api.uploadToWorkspace(sessionID, dir, payload)
      setPending(null)

      const renamed = result.written.filter((item) => item.renamedFrom)
      setNotice(
        [
          `导入 ${result.written.length} 个文件到 ${dir || "工作区根目录"}`,
          renamed.length > 0 ? `（${renamed.length} 个重名，已改名避免覆盖）` : "",
          result.skipped.length > 0 ? `；跳过 ${result.skipped.length} 个：${result.skipped[0].reason}` : "",
          unreadable.length > 0 ? `；读不出来 ${unreadable.length} 个` : "",
        ].join(""),
      )
      if (unreadable.length > 0) {
        setError(`${unreadable.length} 个文件读取失败（可读的那些已经导入）：${unreadable.slice(0, 3).join("、")}`)
      }

      setExpanded((prev) => new Set([...prev, dir]))
      setChildren((prev) => {
        const next = { ...prev }
        delete next[dir]
        return next
      })
      await load(dir)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const render = (dir: string, depth: number) => {
    const nodes = (children[dir] ?? []).filter((node) => !hidden.has(node.path))

    return nodes.map((node) => {
      const isDir = node.type === "directory"
      const isOpen = expanded.has(node.path)
      const mark = !isDir ? changed.get(node.path) : undefined
      const isDropTarget = dropDir === node.path

      return (
        <div key={node.path}>
          <div
            className={cx(
              "group flex items-center transition-colors",
              isDropTarget
                ? "bg-s-ember/15 ring-1 ring-inset ring-s-ember"
                : selected === node.path
                  ? "bg-s-card"
                  : "hover:bg-s-card",
            )}
            onDragOver={(event) => {
              if (!canImport || !isDir) return
              event.preventDefault()
              setDropDir(node.path)
            }}
            onDragLeave={() => setDropDir((prev) => (prev === node.path ? null : prev))}
            onDrop={(event) => {
              if (!canImport || !isDir) return
              event.preventDefault()
              event.stopPropagation()
              setDropDir(null)
              const { entries, plain } = collectDrop(event.dataTransfer)
              void beginDrop(node.path, entries, plain)
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (isDir) toggle(node.path)
                else setSelected(node.path)
              }}
              onDoubleClick={() => {
                if (!isDir) onPick(node.path)
              }}
              title={isDir ? node.path : `${node.path}（${pickHint}）`}
              style={{ paddingLeft: `${depth * 10 + 8}px` }}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-[2px] text-left"
            >
              {isDir ? (
                <Icon
                  name={isOpen ? "chevronDown" : "chevronRight"}
                  size={11}
                  className="shrink-0 text-s-faint"
                />
              ) : (
                <Icon name="note" size={11} className="shrink-0 text-s-faint" />
              )}
              <span
                className={cx(
                  "min-w-0 flex-1 truncate",
                  mark ? (mark.kind === "failed" ? "text-s-rust" : mark.kind === "new" ? "text-s-moss" : "text-s-warn") : isDir ? "text-s-soft" : "text-s-body",
                )}
              >
                {node.name}
              </span>
              {mark ? (
                <Led
                  tone={MARK[mark.kind].tone}
                  title={`${MARK[mark.kind].hint}${mark.count > 1 ? `（${mark.count} 次）` : ""}`}
                />
              ) : null}
              {mark && mark.count > 1 ? <Label className="text-s-faint">×{mark.count}</Label> : null}
              {node.size !== undefined ? <Label className="text-s-faint">{formatSize(node.size)}</Label> : null}
            </button>
            {!isDir ? (
              <button
                type="button"
                onClick={() => onView(node.path)}
                title="只读查看文件内容"
                className="flex size-5 shrink-0 items-center justify-center text-s-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-s-ember"
              >
                <Icon name="search" size={11} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => hide(node.path)}
              title="从文件树里隐藏（删掉的只是这一行，磁盘上的文件不动）"
              className="flex size-5 shrink-0 items-center justify-center text-s-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-s-bright"
            >
              <Icon name="close" size={11} />
            </button>
          </div>

          {isDir && isOpen ? render(node.path, depth + 1) : null}
        </div>
      )
    })
  }

  const changedCount = changed.size

  return (
    <div
      className={cx("flex min-h-0 flex-1 flex-col", dropDir === "" ? "bg-s-ember/10" : "")}
      onDragOver={(event) => {
        if (!canImport || !sessionID) return
        event.preventDefault()
        setDropDir("")
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropDir((prev) => (prev === "" ? null : prev))
      }}
      onDrop={(event) => {
        if (!canImport) return
        event.preventDefault()
        setDropDir(null)
        const { entries, plain } = collectDrop(event.dataTransfer)
        void beginDrop("", entries, plain)
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-s-line px-2.5 py-1.5">
        <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
        <Label className="text-s-soft">项目文件</Label>
        {changedCount > 0 ? (
          <Btn
            sm
            variant="warn"
            icon="search"
            onClick={() => void reveal()}
            title="展开到本对话改动过的文件"
          >
            改动 {changedCount}
          </Btn>
        ) : null}
        {hidden.size > 0 ? (
          <Btn
            sm
            on={showHidden}
            onClick={() => setShowHidden((value) => !value)}
            title="这些只是从树上隐藏了，磁盘上的文件没动"
          >
            隐藏 {hidden.size}
          </Btn>
        ) : null}
        <div className="s-hair min-w-0 flex-1" />
        <Btn
          sm
          icon="refresh"
          onClick={refresh}
          disabled={busy || !sessionID}
          title="重新载入目录"
          className={cx(busy && "s-pulse")}
        />
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            title="收起右侧面板"
            className="flex size-5 items-center justify-center text-s-faint hover:text-s-bright"
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>

      {dropDir !== null && sessionID && !pending ? (
        <div className="shrink-0 border-b border-s-ember bg-s-ember/10 px-2.5 py-1 text-s-ember">
          松开即准备导入到 {dropDir || "工作区根目录"}（还没写盘）
        </div>
      ) : null}

      {error ? (
        <Notice tone="bad" label="err">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="ok" label="ok">
          {notice}
        </Notice>
      ) : null}

      {showHidden && hidden.size > 0 ? (
        <div className="max-h-40 min-h-0 shrink-0 overflow-y-auto border-b border-s-line bg-s-well px-2.5 py-1.5">
          <div className="flex items-center gap-2">
            <Label className="text-s-soft">已隐藏</Label>
            <span className="min-w-0 flex-1 truncate text-s-faint">只是不显示，磁盘上的文件没动</span>
            <Btn sm onClick={restoreAll}>
              全部恢复
            </Btn>
          </div>
          {[...hidden].sort().map((path) => (
            <div key={path} className="flex items-center gap-2 py-[1px]">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-s-body" title={path}>
                {path}
              </span>
              <button
                type="button"
                onClick={() => restore(path)}
                className="s-tag shrink-0 text-s-faint transition-colors hover:text-s-ember"
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {pending ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-s-line px-2.5 py-1.5">
            <div className="text-s-soft">
              准备导入 <b className="text-s-bright">{pending.files.length}</b> 个文件到{" "}
              <b className="text-s-bright">{pending.dir || "工作区根目录"}</b>
            </div>
            {pending.truncated > 0 ? (
              <div className="text-s-warn">超出上限，只取前 {MAX_DROP} 个，已忽略 {pending.truncated} 个</div>
            ) : null}
          </div>

          <Well className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5 font-mono text-[10px] text-s-body">
            {pending.files.slice(0, 40).map((entry) => (
              <div key={entry.path} className="truncate" title={entry.path}>
                {entry.path}
                <span className="ml-1 text-s-faint">{formatSize(entry.file.size)}</span>
              </div>
            ))}
            {pending.files.length > 40 ? (
              <div className="text-s-faint">…还有 {pending.files.length - 40} 个</div>
            ) : null}
          </Well>

          <div className="flex shrink-0 gap-2 border-t border-s-line px-2.5 py-1.5">
            <Btn variant="key" icon="check" onClick={() => void confirmImport()} disabled={busy}>
              确认导入
            </Btn>
            <Btn onClick={() => setPending(null)}>取消</Btn>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {!sessionID ? (
            <Empty>先创建会话</Empty>
          ) : Object.keys(children).length === 0 && !busy ? (
            <Empty>（空）</Empty>
          ) : (
            render("", 0)
          )}
        </div>
      )}

      <div className="shrink-0 border-t border-s-line px-2.5 py-1.5 text-s-faint">
        {busy
          ? "读取中…"
          : `悬停 🔍 = 只读查看 · ${pickHint}${canImport ? " · 拖入 = 导入" : ""} · 悬停 × = 从树上隐藏`}
      </div>
    </div>
  )
}
