import type { ButtonHTMLAttributes, ReactNode } from "react"

/* ============================================================================
 * Primitives.
 *
 * Every component in the app renders through these, so the visual language has
 * exactly one place to change. They carry no behaviour beyond what a plain
 * element would — no wrappers that swallow events, no hidden state.
 * ==========================================================================*/

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ")
}

/* --------------------------------------------------------------------------
 * Icons
 *
 * Hand-drawn on a 24px grid, stroked rather than filled: a stroked glyph keeps
 * the same optical weight at every size, which is what lets one icon sit in a
 * 32px rail row and a 22px button without looking like two different families.
 * No icon library — the whole set is under 2KB and the app stays dependency-free.
 * ------------------------------------------------------------------------*/

export type IconName =
  | "chat"
  | "folder"
  | "tree"
  | "note"
  | "memory"
  | "plug"
  | "terminal"
  | "tune"
  | "panel"
  | "plus"
  | "refresh"
  | "close"
  | "stop"
  | "send"
  | "trash"
  | "pencil"
  | "check"
  | "warn"
  | "help"
  | "chevronRight"
  | "chevronDown"
  | "copy"
  | "download"
  | "search"
  | "clock"
  | "spark"
  | "sun"
  | "moon"

const ICONS: Record<IconName, string[]> = {
  chat: ["M4.5 5.5h15v10.6h-8.8L6.6 19.9v-3.8H4.5z"],
  folder: ["M3.8 6.6h5.2l2 2.4h9.2v9.7H3.8z"],
  tree: ["M4.2 5.2h15.6v13.6H4.2z", "M4.2 9.4h15.6", "M8.6 13h7"],
  note: ["M6.2 3.8h7.6l4 4v12.4H6.2z", "M13.8 3.8v4.2h4"],
  memory: [
    "M7.6 7.6h8.8v8.8H7.6z",
    "M10.4 3.7v3.9",
    "M13.6 3.7v3.9",
    "M10.4 16.4v3.9",
    "M13.6 16.4v3.9",
    "M3.7 10.4h3.9",
    "M3.7 13.6h3.9",
    "M16.4 10.4h3.9",
    "M16.4 13.6h3.9",
  ],
  plug: ["M9 3.7v4.5", "M15 3.7v4.5", "M6.5 8.2h11v3.3a5.5 5.5 0 0 1-11 0z", "M12 17v3.3"],
  terminal: ["M3.8 5.2h16.4v13.6H3.8z", "M7.4 9.7l2.7 2.3-2.7 2.3", "M12.9 14.3h4.2"],
  tune: ["M4 7.4h5.2", "M13.4 7.4h6.6", "M4 12h10", "M18 12h2", "M4 16.6h2.4", "M10.6 16.6h9.4"],
  panel: ["M4.2 5.2h15.6v13.6H4.2z", "M9.8 5.2v13.6"],
  plus: ["M12 5.2v13.6", "M5.2 12h13.6"],
  refresh: ["M20 12a8 8 0 1 1-2.5-5.8", "M19.8 4.6v4.6h-4.6"],
  close: ["M6.2 6.2l11.6 11.6", "M17.8 6.2L6.2 17.8"],
  stop: ["M6.8 6.8h10.4v10.4H6.8z"],
  send: ["M12 19.2V5.2", "M6.2 11l5.8-5.8L17.8 11"],
  trash: ["M4.8 7h14.4", "M9.4 7V4.4h5.2V7", "M6.9 7l1 12.6h8.2L17.1 7"],
  pencil: ["M4.6 19.4l1-4.2L16.2 4.6l3.2 3.2L8.8 18.4z", "M14.6 6.2l3.2 3.2"],
  check: ["M5.2 12.4l4.6 4.6L18.8 7.6"],
  warn: ["M12 4.4l8.6 15.2H3.4z", "M12 10v4.6", "M12 17.3v.1"],
  help: [
    "M12 20.6a8.6 8.6 0 1 0 0-17.2 8.6 8.6 0 0 0 0 17.2z",
    "M9.6 9.7a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.7v.5",
    "M12 17.2v.1",
  ],
  chevronRight: ["M9.6 5.8l6.2 6.2-6.2 6.2"],
  chevronDown: ["M5.8 9.6l6.2 6.2 6.2-6.2"],
  copy: ["M9.2 9.2h10.6v10.6H9.2z", "M14.8 9.2V4.2H4.2v10.6h5"],
  download: ["M12 4.2v11.2", "M7.4 11l4.6 4.6L16.6 11", "M4.4 19.8h15.2"],
  search: ["M10.6 17.2a6.6 6.6 0 1 0 0-13.2 6.6 6.6 0 0 0 0 13.2z", "M15.6 15.6l3.9 3.9"],
  clock: ["M12 20.6a8.6 8.6 0 1 0 0-17.2 8.6 8.6 0 0 0 0 17.2z", "M12 7.4V12l3.2 2"],
  spark: ["M12 3.6l2.1 6.3 6.3 2.1-6.3 2.1L12 20.4l-2.1-6.3L3.6 12l6.3-2.1z"],
  sun: [
    "M12 15.3a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6z",
    "M12 2.8v2.5",
    "M12 18.7v2.5",
    "M2.8 12h2.5",
    "M18.7 12h2.5",
    "M5.5 5.5l1.8 1.8",
    "M16.7 16.7l1.8 1.8",
    "M18.5 5.5l-1.8 1.8",
    "M7.3 16.7l-1.8 1.8",
  ],
  moon: ["M20.2 14.4A8.6 8.6 0 0 1 9.6 3.8a8.8 8.8 0 1 0 10.6 10.6z"],
}

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.5,
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}) {
  return (
    <svg
      className={cx("shrink-0", className)}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name].map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  )
}

/* -------------------------------------------------------------------------- */

export type Tone = "neutral" | "key" | "warn" | "ok" | "bad"

/** Text colour for a tone. `neutral` deliberately has no colour of its own. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-s-soft",
  key: "text-s-ember",
  warn: "text-s-warn",
  ok: "text-s-moss",
  bad: "text-s-rust",
}

/** Filled chip: solid block, dark glyph. Reserved for state that must be seen. */
const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-s-line bg-s-card text-s-soft",
  key: "border-s-ink bg-s-ink text-s-on-ink",
  warn: "border-s-warn bg-s-warn text-s-on-ember",
  ok: "border-s-moss bg-s-moss text-s-on-moss",
  bad: "border-s-rust bg-s-rust text-s-on-rust",
}

/** Outlined chip: rim only, so "on" reads as a lit edge rather than a badge. */
const TONE_OUTLINE: Record<Tone, string> = {
  neutral: "border-s-line text-s-faint",
  key: "border-s-ember text-s-ember",
  warn: "border-s-warn text-s-warn",
  ok: "border-s-moss text-s-moss",
  bad: "border-s-rust text-s-rust",
}

/** The raw colour for a status lamp. Used where a fill cannot carry the state. */
const TONE_LED: Record<Tone, string> = {
  neutral: "var(--color-s-faint)",
  key: "var(--color-s-ember)",
  warn: "var(--color-s-warn)",
  ok: "var(--color-s-moss)",
  bad: "var(--color-s-rust)",
}

/* --------------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------------*/

export type BtnVariant = "plain" | "key" | "bad" | "ok" | "warn" | "ghost"

const BTN_VARIANT: Record<BtnVariant, string> = {
  plain: "",
  key: "s-btn--primary",
  bad: "s-btn--danger",
  ok: "s-btn--ok",
  warn: "s-btn--warn",
  ghost: "s-btn--ghost",
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant
  /** compact: 22px tall instead of 28, for dense rails and table rows */
  sm?: boolean
  /** latched / selected — presses the button into the surface */
  on?: boolean
  /** a leading glyph; the label is what a dense rail drops first, not the icon */
  icon?: IconName
}

export function Btn({ variant = "plain", sm, on, icon, className, children, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      data-on={on ? "true" : undefined}
      className={cx("s-btn", BTN_VARIANT[variant], sm && "s-btn--sm", className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={sm ? 12 : 14} /> : null}
      {children}
    </button>
  )
}

/** An icon-only button. Square, and it says what it is in the tooltip. */
export function IconBtn({
  name,
  size = 14,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { name: IconName; size?: number }) {
  return (
    <button type="button" className={cx("s-btn s-btn--ghost min-h-0 px-1.5 py-1", className)} {...rest}>
      <Icon name={name} size={size} />
    </button>
  )
}

/** Segmented control: a sunken track with one raised thumb. */
export function Seg({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("s-seg", className)}>{children}</div>
}

export function SegItem({
  on,
  tone,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean; tone?: "warn" | "danger" | "ok" }) {
  return (
    <button type="button" data-on={on ? "true" : undefined} data-tone={tone} className={className} {...rest}>
      {children}
    </button>
  )
}

/* --------------------------------------------------------------------------
 * Marks: lamps, chips, tags, hairlines
 * ------------------------------------------------------------------------*/

/** A real dot of colour. The smallest honest way to report a state.
 *  `hollow` draws a ring instead of a fill — see the note on `.s-led--hollow`
 *  for why a light palette needs the pair. */
export function Led({
  tone = "neutral",
  pulse,
  hollow,
  title,
}: {
  tone?: Tone
  pulse?: boolean
  hollow?: boolean
  title?: string
}) {
  return (
    <span
      title={title}
      className={cx("s-led", hollow && "s-led--hollow", pulse && "s-pulse")}
      style={{ color: TONE_LED[tone], backgroundColor: hollow ? undefined : TONE_LED[tone] }}
    />
  )
}

export function Chip({
  tone = "neutral",
  filled,
  className,
  title,
  children,
}: {
  tone?: Tone
  filled?: boolean
  className?: string
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={cx("s-chip shrink-0", filled ? TONE_CHIP[tone] : TONE_OUTLINE[tone], className)}
    >
      {children}
    </span>
  )
}

/** The industrial seam: monospace, upper case, tracked, tiny. Every field name.
 *
 *  `caps={false}` is for text that is *data* rather than a field name. `.s-tag`
 *  upper-cases whatever it renders, which is right for our own labels (WS,
 *  MODEL) and wrong for anything whose case is part of its meaning: a file path
 *  would read C:\USERS\…, an MCP tool `mcp__srv__createIssue` would read
 *  MCP__SRV__CREATEISSUE, and a slash command would advertise `/REMEMBER` —
 *  which is not a command. When in doubt, ask: did we write this string, or did
 *  the disk or the API? */
export function Label({
  className,
  title,
  caps = true,
  children,
}: {
  className?: string
  title?: string
  caps?: boolean
  children: ReactNode
}) {
  return (
    <span title={title} className={cx("s-tag shrink-0", !caps && "normal-case", className)}>
      {children}
    </span>
  )
}

/** A keyboard cap. Only ever rendered next to the action it triggers. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="s-tag inline-flex min-w-[18px] items-center justify-center border border-s-line bg-s-well px-1 py-px text-s-soft shadow-[var(--in-1)]">
      {children}
    </kbd>
  )
}

/** A hairline that eats the remaining width — the cheapest hierarchy there is. */
export function Rule({ className }: { className?: string }) {
  return <div className={cx("s-hair min-w-0 flex-1", className)} />
}

/** A raised card. Anything that has to lift off the page it sits on. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("s-card", className)}>{children}</div>
}

/** A sunken well. Fields, code, readouts. */
export function Well({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("s-well", className)}>{children}</div>
}

/* --------------------------------------------------------------------------
 * Composition
 * ------------------------------------------------------------------------*/

/** A titled band inside a surface: a tone tick, a tag, a rule, an optional note. */
export function Band({
  label,
  note,
  tone = "neutral",
  children,
}: {
  label: string
  note?: string
  tone?: Tone
  children?: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="s-led h-2.5 w-0.5" style={{ backgroundColor: TONE_LED[tone] }} />
        <Label className={TONE_TEXT[tone]}>{label}</Label>
        <Rule />
        {note ? <Label className="text-s-faint">{note}</Label> : null}
      </div>
      {children ? <div className="mt-1">{children}</div> : null}
    </div>
  )
}

/** ok / warn / err bar. Reads as a strip of colour on the edge of a surface. */
export function Notice({
  tone = "ok",
  label,
  className,
  children,
}: {
  tone?: "ok" | "warn" | "bad"
  label?: string
  className?: string
  children: ReactNode
}) {
  const bar = tone === "ok" ? "bg-s-moss" : tone === "warn" ? "s-mark--warn" : "s-mark"
  const text = tone === "ok" ? "text-s-moss" : tone === "warn" ? "text-s-warn" : "text-s-rust"
  const wash =
    tone === "ok"
      ? "bg-s-moss/5 border-s-moss/40"
      : tone === "warn"
        ? "bg-s-warn/5 border-s-warn/40"
        : "bg-s-rust/5 border-s-rust/40"

  return (
    <div className={cx("flex items-stretch", className)}>
      <div className={cx("w-1 shrink-0", bar)} />
      <div
        className={cx(
          "flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 border border-l-0 px-2.5 py-1.5 break-words",
          wash,
          text,
        )}
      >
        {label ? <Label>{label}</Label> : null}
        <span className="min-w-0 flex-1">{children}</span>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
 * Dialogs
 * ------------------------------------------------------------------------*/

/** Opaque floor change. No blur — this app has no glass in it. */
export function Scrim({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("s-scrim fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4", className)}>
      {children}
    </div>
  )
}

export function DialogHead({
  badge,
  badgeTone = "key",
  title,
  note,
  onClose,
  children,
}: {
  badge?: string
  badgeTone?: Tone
  title: ReactNode
  note?: ReactNode
  onClose?: () => void
  children?: ReactNode
}) {
  return (
    <div className="s-dialog__head">
      <span className="s-led" style={{ backgroundColor: TONE_LED[badgeTone] }} />
      {badge ? <Label className={cx("px-1.5 py-0.5", TONE_CHIP[badgeTone])}>{badge}</Label> : null}
      <Label className="text-s-bright">{title}</Label>
      {note ? <span className="min-w-0 truncate text-s-faint">{note}</span> : null}
      <Rule />
      {children}
      {onClose ? (
        <IconBtn name="close" onClick={onClose} className="text-s-faint hover:text-s-bright" title="关闭" />
      ) : null}
    </div>
  )
}

export function DialogFoot({ note, children }: { note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="s-dialog__foot">
      {note ? <span className="min-w-0 flex-1 truncate text-s-faint">{note}</span> : null}
      {children}
    </div>
  )
}

/** A blocking modal: scrim, shell, head, body, foot. */
export function Modal({
  badge,
  badgeTone,
  title,
  note,
  onClose,
  footerNote,
  footer,
  className,
  bodyClassName,
  tone,
  children,
}: {
  badge?: string
  badgeTone?: Tone
  title: ReactNode
  note?: ReactNode
  onClose?: () => void
  footerNote?: ReactNode
  footer?: ReactNode
  className?: string
  bodyClassName?: string
  tone?: "key" | "bad"
  children?: ReactNode
}) {
  return (
    <Scrim>
      <div
        className={cx(
          "s-dialog s-enter flex max-h-[85vh] w-full flex-col",
          tone === "bad" && "s-dialog--danger",
          tone === "key" && "s-dialog--primary",
          className ?? "max-w-xl",
        )}
      >
        <DialogHead badge={badge} badgeTone={badgeTone} title={title} note={note} onClose={onClose} />
        <div className={cx("min-h-0 flex-1 overflow-y-auto px-3 py-3", bodyClassName)}>{children}</div>
        {footer ? <DialogFoot note={footerNote}>{footer}</DialogFoot> : null}
      </div>
    </Scrim>
  )
}

/* --------------------------------------------------------------------------
 * Fields
 * ------------------------------------------------------------------------*/

export const FIELD = "s-input"

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
        <span className="s-led mt-[5px]" style={{ backgroundColor: "var(--color-s-ember)" }} />
        <Label className="text-s-bright">{label}</Label>
        {hint ? <span className="s-tag text-s-faint">{hint}</span> : null}
      </div>
      {children}
    </label>
  )
}

/** An empty state that does not look like a broken render. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-s-faint">{children}</div>
}
