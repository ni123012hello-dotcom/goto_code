import { useEffect, useState } from "react"
import { Icon, Led, Label, cx, type IconName } from "../ui"
import StatusMark, { type StatusState } from "./StatusMark"

/* ============================================================================
 * The rail.
 *
 * The previous shell stacked eight unlabelled English buttons in one row and
 * asked the user to remember what `extensions` did. Everything you can open now
 * lives in one column, in the same place every time, spelled out in Chinese,
 * with a badge when something is waiting for you.
 *
 * Two things keep it honest: groups are separated by a rule rather than a
 * colour, and the lamp at the bottom is the only thing in it that moves.
 * ==========================================================================*/

const COLLAPSE_KEY = "goto.railCollapsed"

export type NavEntry = {
  id: string
  icon: IconName
  label: string
  hint: string
  on?: boolean
  badge?: number
  /** right-aligned state text, for entries that are a switch rather than a door */
  note?: string
  disabled?: boolean
  run: () => void
}

export type NavGroup = { group: string; entries: NavEntry[] }

export default function NavRail({
  status,
  statusText,
  compact,
  onNewConversation,
  canCreate,
  groups,
}: {
  status: StatusState
  statusText: string
  /** forced by a narrow window; the stored preference is additive, not overridden */
  compact?: boolean
  onNewConversation: () => void
  canCreate: boolean
  groups: NavGroup[]
}) {
  // Collapsing is a per-user preference about screen real estate, so it lives in
  // localStorage rather than on the server. It is read lazily so a locked-down
  // storage cannot break the first paint.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1"
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0")
    } catch {
      /* a disabled localStorage should not break the shell */
    }
  }, [collapsed])

  // A narrow window cannot afford 196px of rail. The stored preference is
  // additive — collapse on your own and it stays collapsed once you widen again,
  // but while the window is tight the rail is icon-only either way.
  const isCollapsed = collapsed || compact === true

  return (
    <aside
      className="s-rail flex shrink-0 flex-col transition-[width] duration-200 ease-[var(--ease-out)]"
      style={{ width: isCollapsed ? 54 : 196 }}
    >
      {/* brand — the status meter is here because "is it working?" is the most
          asked question in the app, and this is the corner you are already
          looking at */}
      <div className={cx("flex shrink-0 items-center gap-2.5 px-3 py-3", isCollapsed && "justify-center px-0")}>
        <StatusMark state={status} size={isCollapsed ? 26 : 30} hint={statusText} />
        {isCollapsed ? null : (
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[14px] font-semibold tracking-tight text-s-bright">goto</span>
            <Label className="text-s-faint">本地智能体</Label>
          </div>
        )}
      </div>

      <div className={cx("pb-2.5", isCollapsed ? "px-2" : "px-2.5")}>
        <button
          type="button"
          onClick={onNewConversation}
          disabled={!canCreate}
          title={canCreate ? "在当前文件夹里开一个新对话" : "还没有文件夹"}
          className={cx("s-btn s-btn--primary w-full", isCollapsed && "px-0")}
        >
          <Icon name="spark" size={14} />
          {isCollapsed ? null : <span className="truncate">新对话</span>}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {groups.map((group, index) => (
          <div key={group.group}>
            {isCollapsed ? (
              index > 0 ? <div className="s-hair my-2" /> : null
            ) : (
              <div className={cx("flex items-center gap-2 pb-1", index === 0 ? "pt-0.5" : "pt-3")}>
                <Label className="text-s-faint">{group.group}</Label>
                <div className="s-hair min-w-0 flex-1" />
              </div>
            )}

            <div className="flex flex-col gap-0.5">
              {group.entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-on={entry.on ? "true" : undefined}
                  disabled={entry.disabled}
                  onClick={entry.run}
                  title={isCollapsed ? `${entry.label} — ${entry.hint}` : entry.hint}
                  className={cx("s-nav", isCollapsed && "justify-center px-0")}
                >
                  <Icon name={entry.icon} size={15} className={entry.on ? "text-s-ember" : undefined} />
                  {isCollapsed ? null : <span className="min-w-0 flex-1 truncate">{entry.label}</span>}
                  {!isCollapsed && entry.note ? (
                    <Label className="text-s-faint">{entry.note}</Label>
                  ) : null}
                  {entry.badge && entry.badge > 0 ? (
                    isCollapsed ? (
                      <span className="absolute right-1.5 top-1.5 size-1.5 bg-s-warn" />
                    ) : (
                      <Label className="bg-s-warn px-1 text-s-on-ember">{entry.badge}</Label>
                    )
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* the shell's status line: one lamp, one word, one toggle */}
      <div
        className={cx(
          "flex shrink-0 items-center gap-2 border-t border-s-line py-2",
          isCollapsed ? "flex-col gap-1.5 px-0" : "px-3",
        )}
      >
        <Led
          tone={status === "working" ? "warn" : status === "error" ? "bad" : status === "done" ? "ok" : "neutral"}
          pulse={status === "working"}
          title={statusText}
        />
        {isCollapsed ? null : <span className="min-w-0 flex-1 truncate text-s-soft">{statusText}</span>}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          disabled={compact === true}
          title={
            compact === true
              ? "窗口太窄，导航栏只能显示图标"
              : isCollapsed
                ? "展开导航栏"
                : "收起导航栏"
          }
          className="s-btn s-btn--ghost min-h-0 px-1.5 py-1 text-s-faint hover:text-s-bright"
        >
          <Icon name="chevronRight" size={14} className={isCollapsed ? undefined : "rotate-180"} />
        </button>
      </div>
    </aside>
  )
}
