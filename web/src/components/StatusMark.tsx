/* ============================================================================
 * The status mark.
 *
 * This used to be a face: a slab with a brow, two eyes, a wince and a squint.
 * That was personification, and it is gone. What replaces it is a plain
 * instrument — a lit slab holding a three-bar level meter.
 *
 * It keeps everything the face was actually for. "Is it working?" is the most
 * asked question in the app, and it is still answered by the meter alone:
 *
 *   idle      three bars at rest, dim            — nothing is happening
 *   working   the bars step in sequence, ember   — it is doing something
 *   done      three bars at full height, moss    — the turn landed
 *   error     full height with the middle bar    — something broke, and you can
 *             broken, rust                         see where
 *
 * A meter also survives the sizes a face does not: at 16px a brow is mud, while
 * three bars of different heights still read as "busy".
 * ==========================================================================*/

export type StatusState = "idle" | "working" | "error" | "done"

const LABEL: Record<StatusState, string> = {
  idle: "待命",
  working: "正在处理",
  error: "出错了",
  done: "已完成",
}

export default function StatusMark({
  state = "idle",
  size = 22,
  hint,
}: {
  state?: StatusState
  size?: number
  /** overrides the tooltip, e.g. to name the sub-agent being watched */
  hint?: string
}) {
  const tip = hint ?? LABEL[state]

  return (
    <span
      className="s-signal"
      data-state={state}
      style={{ width: size, height: size }}
      title={tip}
      role="img"
      aria-label={tip}
    >
      <span className="s-signal__meter" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </span>
  )
}
