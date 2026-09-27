import type { PermissionResponse, PermissionRequest } from "@shared/protocol"
import { Btn, Icon, Label } from "../ui"

type Props = {
  request: PermissionRequest
  onRespond: (response: PermissionResponse) => void
}

/** Docked bottom-left, not centred: the transcript stays readable while the
 *  agent waits, and it never covers what it is asking about.
 *
 *  The three answers are ordered by blast radius, not by alphabet: the safest
 *  is on the right where the eye lands last, and the widest ("always") is in the
 *  middle where it cannot be hit by muscle memory aimed at the primary. */
export default function PermissionDialog({ request, onRespond }: Props) {
  return (
    <div className="fixed bottom-4 left-4 z-60 w-[26rem] max-w-[calc(100vw-2rem)]">
      <div className="s-dialog s-dialog--primary s-enter w-full">
        <div className="s-mark h-1" />

        <div className="s-dialog__head">
          <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
          <Label className="text-s-bright">需要你批准</Label>
          <div className="s-hair min-w-0 flex-1" />
          <span className="flex items-center gap-1.5 text-s-warn">
            <Icon name="clock" size={12} />
            <Label className="s-pulse">agent 在等</Label>
          </span>
        </div>

        <div className="flex items-start gap-2 border-b border-s-line px-3 py-2">
          <Icon name="warn" size={14} className="mt-[3px] shrink-0 text-s-warn" />
          <span className="min-w-0 flex-1 text-s-bright">{request.title}</span>
        </div>

        <pre className="max-h-64 overflow-auto border-b border-s-line bg-s-well px-3 py-2 leading-[1.6] whitespace-pre-wrap text-s-body">
          {request.detail}
        </pre>

        <div className="flex flex-wrap items-center justify-end gap-2 px-3 py-2.5">
          <Btn variant="bad" icon="close" onClick={() => onRespond("reject")} title="拒绝这次调用">
            拒绝
          </Btn>
          <Btn onClick={() => onRespond("always")} title="这个工具在本会话内不再询问">
            本会话总是允许
          </Btn>
          <Btn variant="key" icon="check" onClick={() => onRespond("once")} title="只批准这一次">
            允许一次
          </Btn>
        </div>
      </div>
    </div>
  )
}
