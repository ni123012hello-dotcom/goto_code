import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react"
import type { FolderNode, SessionInfo } from "@shared/protocol"
import { Btn, Icon, Label, Led, Notice, cx } from "../ui"

type Props = {
  folders: FolderNode[]
  sessions: SessionInfo[]
  activeId: string | null
  maxPerFolder: number
  onSelect: (id: string) => void
  onNewConversation: (folderID: string) => void
  onAddFolder: (parentID: string | null) => void
  onMoveSession: (sessionID: string, folderID: string) => void
  onMoveFolder: (folderID: string, parentID: string | null) => void
  onRenameFolder: (folderID: string, name: string) => void
  onDeleteFolder: (folderID: string) => void
  onClose: () => void
}

type Payload = { kind: "folder" | "session"; id: string }

const MIME = "application/x-goto-node"

function readPayload(event: DragEvent<HTMLElement>): Payload | null {
  try {
    return JSON.parse(event.dataTransfer.getData(MIME)) as Payload
  } catch {
    return null
  }
}

/** A section header: one lamp, one tag, one rule, and whatever the section needs. */
function Head({ label, tone = "key", children }: { label: string; tone?: "key" | "warn"; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-s-line px-2.5 py-1.5">
      <span
        className="s-led"
        style={{ backgroundColor: tone === "warn" ? "var(--color-s-warn)" : "var(--color-s-ember)" }}
      />
      <Label className="text-s-soft">{label}</Label>
      <div className="s-hair min-w-0 flex-1" />
      {children}
    </div>
  )
}

export default function SessionTree({
  folders,
  sessions,
  activeId,
  maxPerFolder,
  onSelect,
  onNewConversation,
  onAddFolder,
  onMoveSession,
  onMoveFolder,
  onRenameFolder,
  onDeleteFolder,
  onClose,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(folders.map((folder) => folder.id)))
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Folders arrive after the first paint, so the initial state above can only ever be
  // empty. Open the top level the first time they show up — a panel that starts with
  // every folder collapsed looks like it has nothing in it.
  //
  // Once only, deliberately: this used to re-run on every change to `folders`, which
  // meant creating a folder (or moving one) silently re-opened whatever the user had
  // just collapsed. Collapsing a folder is a decision; nothing but the user may undo it.
  const openedOnce = useRef(false)
  useEffect(() => {
    if (openedOnce.current || folders.length === 0) return
    openedOnce.current = true
    setExpanded(new Set(folders.filter((folder) => !folder.parentID).map((folder) => folder.id)))
  }, [folders])

  const childFolders = (parentID: string | null) =>
    folders.filter((folder) => folder.parentID === parentID).sort((a, b) => a.order - b.order)

  const childSessions = (folderID: string) =>
    // sub-agents share their parent's folder but are not conversations the user made, so they
    // are rendered nested under their parent instead of as siblings
    sessions.filter((session) => session.folderID === folderID && !session.parentID).sort((a, b) => b.createdAt - a.createdAt)

  const subagentsOf = (parentID: string) =>
    sessions.filter((session) => session.parentID === parentID).sort((a, b) => a.createdAt - b.createdAt)

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = (action: () => void) => {
    try {
      setError(null)
      action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const dropOnFolder = (event: DragEvent<HTMLElement>, folderID: string) => {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)

    const payload = readPayload(event)
    if (!payload) return

    run(() => {
      // a conversation cannot exist outside a folder, so there is no "drop to root"
      if (payload.kind === "session") onMoveSession(payload.id, folderID)
      else onMoveFolder(payload.id, folderID)
    })
  }

  const dropOnRoot = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDropTarget(null)

    const payload = readPayload(event)
    // only folders may sit at the top level
    if (!payload || payload.kind !== "folder") return

    run(() => onMoveFolder(payload.id, null))
  }

  const renderSession = (session: SessionInfo, depth: number) => {
    const active = session.id === activeId
    return (
      <button
        key={session.id}
        type="button"
        draggable
        onDragStart={(event) => event.dataTransfer.setData(MIME, JSON.stringify({ kind: "session", id: session.id }))}
        onClick={() => onSelect(session.id)}
        title={`${session.title}\n${session.id}`}
        style={{ paddingLeft: `${depth * 12 + 20}px` }}
        className={cx(
          "flex w-full items-center gap-1.5 border-l-2 py-1 pr-2 text-left transition-colors",
          active
            ? "border-s-ember bg-s-card text-s-bright"
            : "border-transparent text-s-soft hover:bg-s-card hover:text-s-bright",
        )}
      >
        {session.running ? (
          <Led tone="warn" pulse />
        ) : (
          <Icon name="chat" size={12} className={active ? "text-s-ember" : "text-s-faint"} />
        )}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {session.running ? <Label className="text-s-warn">运行中</Label> : null}
      </button>
    )
  }

  const renderFolder = (folder: FolderNode, depth: number) => {
    const open = expanded.has(folder.id)
    const kids = childFolders(folder.id)
    const own = childSessions(folder.id)
    const full = own.length >= maxPerFolder
    const isDropTarget = dropTarget === folder.id

    return (
      <div key={folder.id}>
        <div
          onDragOver={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setDropTarget(folder.id)
          }}
          onDrop={(event) => dropOnFolder(event, folder.id)}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          className={cx(
            "group flex items-center gap-1 pr-1.5 transition-colors",
            isDropTarget ? "bg-s-ember/15 ring-1 ring-s-ember" : "hover:bg-s-card",
          )}
        >
          <button
            type="button"
            onClick={() => toggle(folder.id)}
            className="flex size-5 shrink-0 items-center justify-center text-s-faint hover:text-s-bright"
            title={open ? "收起" : "展开"}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          </button>

          <span
            draggable
            onDragStart={(event) =>
              event.dataTransfer.setData(MIME, JSON.stringify({ kind: "folder", id: folder.id }))
            }
            className="shrink-0 cursor-grab text-s-ember"
            title="拖动可以把它移进别的文件夹或移到顶层"
          >
            <Icon name="folder" size={13} />
          </span>

          {renaming === folder.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                if (draft.trim()) onRenameFolder(folder.id, draft.trim())
                setRenaming(null)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  if (draft.trim()) onRenameFolder(folder.id, draft.trim())
                  setRenaming(null)
                }
                if (event.key === "Escape") setRenaming(null)
              }}
              className="s-input s-input--focus min-w-0 flex-1 px-1 py-0"
            />
          ) : (
            <span
              onDoubleClick={() => {
                setDraft(folder.name)
                setRenaming(folder.id)
              }}
              className="min-w-0 flex-1 cursor-grab truncate py-1 text-s-soft"
              title={`${folder.name}（${own.length}/${maxPerFolder}）· 双击重命名`}
            >
              {folder.name}
            </span>
          )}

          <Label className={cx("shrink-0", full ? "text-s-rust" : "text-s-faint")}>
            {own.length}/{maxPerFolder}
          </Label>

          {/* actions stay hidden until you are on the row: six controls per folder
              would otherwise be the loudest thing in the panel */}
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={() => onNewConversation(folder.id)}
              disabled={full}
              title={full ? `已满（上限 ${maxPerFolder}）` : "在这里新建对话"}
              className="flex size-5 items-center justify-center text-s-faint hover:text-s-bright disabled:opacity-30"
            >
              <Icon name="plus" size={12} />
            </button>
            <button
              type="button"
              onClick={() => onAddFolder(folder.id)}
              title="新建子文件夹"
              className="flex size-5 items-center justify-center text-s-faint hover:text-s-bright"
            >
              <Icon name="tree" size={12} />
            </button>
            <button
              type="button"
              onClick={() => onDeleteFolder(folder.id)}
              title="删除文件夹（会连同里面的对话一起删，需确认）"
              className="flex size-5 items-center justify-center text-s-faint hover:text-s-rust"
            >
              <Icon name="trash" size={12} />
            </button>
          </span>
        </div>

        {open ? (
          <>
            {kids.map((child) => renderFolder(child, depth + 1))}
            {own.map((session) => (
              <div key={session.id}>
                {renderSession(session, depth + 1)}
                {subagentsOf(session.id).map((sub) => renderSession(sub, depth + 2))}
              </div>
            ))}
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Head label="文件夹">
        <Btn sm icon="plus" onClick={() => onAddFolder(null)} title="在最外层新建文件夹">
          新建
        </Btn>
        <button
          type="button"
          onClick={onClose}
          title="收起右侧面板"
          className="flex size-5 items-center justify-center text-s-faint hover:text-s-bright"
        >
          <Icon name="close" size={12} />
        </button>
      </Head>

      {error ? (
        <Notice tone="bad" label="err">
          {error}
        </Notice>
      ) : null}

      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropOnRoot}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {childFolders(null).map((folder) => renderFolder(folder, 0))}

        {folders.length === 0 ? <div className="px-2.5 py-2 text-s-faint">还没有文件夹，点「新建」。</div> : null}
      </div>

      <div className="shrink-0 border-t border-s-line px-2.5 py-1.5 text-s-faint">
        拖对话到文件夹 = 移进去 · 拖文件夹到空白 = 移到顶层 · 双击名字 = 重命名
      </div>
    </div>
  )
}
