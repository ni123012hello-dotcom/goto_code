import { useState } from "react"
import type { QuestionRequest } from "@shared/protocol"
import { Btn, Icon, Label, Scrim } from "../ui"

type Props = {
  request: QuestionRequest
  onAnswer: (answer: string, skip: boolean) => void
}

export default function QuestionDialog({ request, onAnswer }: Props) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)

  const submitText = () => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    onAnswer(value, false)
  }

  const pick = (option: string) => {
    if (busy) return
    setBusy(true)
    onAnswer(option, false)
  }

  return (
    <Scrim className="z-60">
      <div className="s-dialog s-enter w-full max-w-xl">
        <div className="s-mark--warn h-1" />

        <div className="s-dialog__head">
          <span className="s-led" style={{ backgroundColor: "var(--color-s-warn)" }} />
          <Label className="text-s-bright">agent 提问</Label>
          <div className="s-hair min-w-0 flex-1" />
          <span className="flex items-center gap-1.5 text-s-warn">
            <Icon name="clock" size={12} />
            <Label className="s-pulse">等待回答</Label>
          </span>
        </div>

        <div className="flex items-start gap-2 border-b border-s-line px-3 py-3">
          <Icon name="help" size={15} className="mt-[3px] shrink-0 text-s-warn" />
          <span className="min-w-0 flex-1 text-s-bright">{request.question}</span>
        </div>

        {request.options.length > 0 ? (
          <div className="border-b border-s-line px-3 py-2.5">
            <Label className="mb-1.5 block text-s-faint">点一个直接回答</Label>
            <div className="flex flex-wrap gap-2">
              {request.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => pick(option)}
                  disabled={busy}
                  className="s-btn max-w-full justify-start text-left disabled:opacity-30"
                >
                  <Icon name="chevronRight" size={12} className="text-s-ember" />
                  {option}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {request.allowFreeText ? (
          <div className="px-3 py-2.5">
            <Label className="mb-1.5 block text-s-faint">
              {request.options.length > 0 ? "或者自己写一个回答" : "输入回答"}
            </Label>
            <textarea
              autoFocus
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  submitText()
                }
              }}
              placeholder="Enter 提交 · Shift+Enter 换行"
              className="s-input s-input--warn max-h-40 w-full resize-none"
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-s-line px-3 py-2.5">
          <span className="min-w-0 flex-1 text-s-faint">
            这个回答会作为工具结果交给 agent，它会继续干活。
          </span>
          <Btn
            onClick={() => {
              if (busy) return
              setBusy(true)
              onAnswer("", true)
            }}
            disabled={busy}
            title="不回答，让 agent 自己判断或换个问法"
          >
            跳过
          </Btn>
          {request.allowFreeText ? (
            <Btn variant="warn" icon="check" onClick={submitText} disabled={busy || !text.trim()}>
              回答
            </Btn>
          ) : null}
        </div>
      </div>
    </Scrim>
  )
}
