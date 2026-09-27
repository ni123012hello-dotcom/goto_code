import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react"
import { api, type CommandInfo, type SessionMode, type UploadedFile } from "../api"
import { Btn, Icon, Label, Notice, Seg, SegItem, Well, cx } from "../ui"

export type ComposerHandle = {
  insert: (value: string) => void
  /** replace the whole draft - used when re-editing an already sent message */
  setText: (value: string) => void
  focus: () => void
}

type Props = {
  running: boolean
  disabled: boolean
  commands: CommandInfo[]
  /** read-only or full powers; the button switches it and Tab is the shortcut */
  mode: SessionMode
  onToggleMode: () => void
  /** non-null while an earlier message is being re-edited; count is how many messages a send would discard */
  editing: { count: number; onCancel: () => void } | null
  onSend: (text: string, files: UploadedFile[]) => void
  onStop: () => void
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? "")
      const comma = result.indexOf(",")
      resolve(comma === -1 ? "" : result.slice(comma + 1))
    }
    reader.onerror = () => {
      // Chromium reports a bare `NotFoundError` here, which says nothing useful:
      // it means the file was gone between the paste/drop and the read (moved,
      // deleted, or a cloud placeholder that could not be hydrated).
      reject(new Error("读取不到这张图片（文件可能已被移动或删除，或是云盘的按需下载占位文件）"))
    }
    reader.readAsDataURL(file)
  })
}

const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { running, disabled, commands, mode, onToggleMode, editing, onSend, onStop },
  handle,
) {
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<UploadedFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  useImperativeHandle(
    handle,
    () => ({
      insert: (value: string) => {
        setText((prev) => {
          const trimmed = prev.trimEnd()
          return trimmed ? `${trimmed} ${value}` : value
        })
        textareaRef.current?.focus()
      },
      setText: (value: string) => {
        setText(value)
        requestAnimationFrame(() => {
          resize()
          const el = textareaRef.current
          if (el) el.selectionStart = el.selectionEnd = el.value.length
          textareaRef.current?.focus()
        })
      },
      focus: () => textareaRef.current?.focus(),
    }),
    [],
  )

  const wantsCommand = text.startsWith("/") && !text.includes(" ")
  const query = wantsCommand ? text.slice(1).toLowerCase() : null
  const matches =
    query === null
      ? []
      : commands.filter(
          (command) =>
            command.name.startsWith(query) ||
            command.aliases.some((alias) => alias.toLowerCase().startsWith(query)),
        )

  const attach = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError(`只支持图片附件（收到 ${file.type || "未知类型"}）`)
      return
    }

    setBusy(true)
    setError(null)
    try {
      const dataBase64 = await toBase64(file)
      const uploaded = await api.upload({ mime: file.type, filename: file.name || "pasted.png", dataBase64 })
      setAttachments((prev) => [...prev, uploaded])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData?.items ?? []).filter(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    )
    if (images.length === 0) return

    event.preventDefault()
    for (const item of images) {
      const file = item.getAsFile()
      if (file) void attach(file)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    for (const file of Array.from(event.dataTransfer?.files ?? [])) void attach(file)
  }

  const submit = () => {
    const value = text.trim()
    if (running || disabled || busy) return
    if (!value && attachments.length === 0) return

    onSend(value, attachments)
    setText("")
    setAttachments([])
    setError(null)
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
      return
    }

    // Tab has two jobs, in this order: complete the highlighted slash command while that
    // menu is open, otherwise switch between plan and agent. Shift+Tab is deliberately left
    // alone so there is still a keyboard way out of the textarea.
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (matches.length > 0) {
        event.preventDefault()
        setText(`/${matches[0].name} `)
        return
      }
      if (!disabled) {
        event.preventDefault()
        onToggleMode()
      }
    }
  }

  const handleInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value)
    const el = event.target
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const canSend = !disabled && !busy && (text.trim().length > 0 || attachments.length > 0)

  return (
    <div
      className="relative shrink-0 border-t border-s-line bg-s-panel px-4 py-2.5"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {/* while a turn runs, a bar of light travels along the top seam. cheaper than a
          spinner and impossible to miss in peripheral vision. */}
      {running ? <div className="s-scan absolute inset-x-0 top-0 h-0.5" /> : null}

      <div className="mx-auto max-w-3xl">
        {dragging ? (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center border-2 border-dashed border-s-ember bg-s-floor/90">
            <span className="s-btn s-btn--primary">
              <Icon name="plus" size={14} />
              松开即可附加图片
            </span>
          </div>
        ) : null}

        {editing ? (
          <Notice tone="warn" label="edit" className="mb-1 items-center">
            <span className="min-w-0 flex-1">
              正在重新编辑这条消息 · 发送后会丢弃其后的 {editing.count} 条
            </span>
            <Btn sm onClick={editing.onCancel} className="ml-2">
              取消
            </Btn>
          </Notice>
        ) : null}

        {matches.length > 0 ? (
          <Well className="mb-1 overflow-hidden">
            {matches.map((command, index) => (
              <button
                key={command.name}
                type="button"
                onClick={() => {
                  setText(`/${command.name} `)
                  textareaRef.current?.focus()
                }}
                className={cx(
                  "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors",
                  index === 0 ? "bg-s-card" : "hover:bg-s-card",
                )}
              >
                <Label caps={false} className="text-s-ember">
                  {command.usage}
                </Label>
                <span className="min-w-0 flex-1 truncate text-s-faint">{command.description}</span>
                {index === 0 ? <Label className="text-s-bright">Tab</Label> : null}
              </button>
            ))}
            <div className="flex items-center gap-2 border-t border-s-line px-2.5 py-1">
              <Label className="text-s-faint">tab 补全 · enter 执行</Label>
            </div>
          </Well>
        ) : null}

        {attachments.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap items-stretch gap-1.5">
            {attachments.map((file) => (
              <div key={file.id} className="s-card relative overflow-hidden">
                <img
                  src={`/api/files/${file.fileID}`}
                  alt={file.filename}
                  title={`${file.filename} · ${Math.round(file.size / 1024)}KB`}
                  className="h-16 w-16 object-cover"
                />
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== file.id))}
                  title="移除这张图"
                  className="absolute right-0 top-0 flex size-5 items-center justify-center bg-s-rust text-s-on-rust"
                >
                  <Icon name="close" size={11} strokeWidth={2} />
                </button>
              </div>
            ))}
            <div className="flex items-center">
              <Label className="text-s-faint">{attachments.length} 张 · 随消息发送</Label>
            </div>
          </div>
        ) : null}

        {error ? (
          <Notice tone="bad" label="err" className="mb-1">
            {error}
          </Notice>
        ) : null}

        <div className="flex items-stretch gap-2">
          {/* plan / agent: the only switch in the app that changes what the agent
              is allowed to do, so it is a physical latched control, not a checkbox.
              It says what it does in the tooltip, in the same words the status bar uses. */}
          <Seg className="shrink-0">
            <SegItem
              on={mode !== "plan"}
              onClick={() => {
                if (mode === "plan") onToggleMode()
              }}
              disabled={disabled}
              title="执行模式：全部工具可用"
            >
              <Icon name="chevronRight" size={12} />
              执行
            </SegItem>
            <SegItem
              on={mode === "plan"}
              tone="warn"
              onClick={() => {
                if (mode !== "plan") onToggleMode()
              }}
              disabled={disabled}
              title="计划模式：只读（write / edit / shell / MCP 全禁用）。Tab 也可以切换"
            >
              <Icon name="search" size={12} />
              计划
            </SegItem>
          </Seg>

          <Well className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2 transition-shadow focus-within:border-s-ember">
            <Icon name="chevronRight" size={13} className="mt-[5px] text-s-ember" />
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                disabled
                  ? "先创建一个会话"
                  : busy
                    ? "正在上传图片…"
                    : "Enter 发送 · Shift+Enter 换行 · Tab 切换模式 · 粘贴图片 · / 查看指令"
              }
              className="max-h-[200px] min-h-[20px] flex-1 resize-none bg-transparent leading-[1.6] text-s-bright outline-none placeholder:text-s-faint"
            />
          </Well>

          {running ? (
            <Btn variant="bad" icon="stop" className="shrink-0 px-4" onClick={onStop} title="中止这一轮">
              停止
            </Btn>
          ) : (
            <Btn
              variant="key"
              icon="send"
              className="shrink-0 px-4"
              onClick={submit}
              disabled={!canSend}
              title="发送（Enter）"
            >
              发送
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
})

export default Composer
