import { useState } from "react"
import { IconBtn, Label, Rule, Scrim, Seg, SegItem, cx, type IconName } from "../ui"
import McpPanel from "./McpPanel"
import SkillPanel from "./SkillPanel"

type Props = {
  sessionID: string | null
  onClose: () => void
}

const TABS: { id: "mcp" | "skill"; label: string; icon: IconName; hint: string }[] = [
  { id: "mcp", label: "MCP 工具", icon: "plug", hint: "外部的第三方工具进程，需要你确认一次才会启动" },
  { id: "skill", label: "技能", icon: "memory", hint: "按需加载的说明文档，决定 agent 会哪些专门套路" },
]

type TabID = (typeof TABS)[number]["id"]

/** Both tabs are "what can the agent do beyond its built-ins", so they share one dialog.
 *  Each panel owns its own data and footer; the shell only picks a tab and bumps `reload`. */
export default function ExtensionsDialog({ sessionID, onClose }: Props) {
  const [tab, setTab] = useState<TabID>("mcp")
  const [reload, setReload] = useState(0)
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0]

  return (
    <Scrim>
      <div className="s-dialog s-enter flex max-h-[85vh] w-full max-w-3xl flex-col">
        <div className="s-dialog__head">
          <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
          <Label className="text-s-bright">扩展能力</Label>
          <span className="min-w-0 truncate text-s-faint">超出内置工具之外，agent 还能用什么</span>
          <Rule />
          <IconBtn name="refresh" title="重新读取" onClick={() => setReload((value) => value + 1)} />
          <IconBtn name="close" title="关闭" onClick={onClose} className="hover:text-s-bright" />
        </div>

        {/* a real two-position switch: a sunken track with one raised thumb */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-s-line px-3 py-2">
          <Seg>
            {TABS.map((entry) => (
              <SegItem key={entry.id} on={tab === entry.id} onClick={() => setTab(entry.id)} title={entry.hint}>
                <Label className={cx(tab === entry.id ? "text-s-bright" : undefined)}>{entry.label}</Label>
              </SegItem>
            ))}
          </Seg>
          <span className="min-w-0 flex-1 truncate text-s-faint">{current.hint}</span>
        </div>

        {tab === "mcp" ? <McpPanel reloadToken={reload} /> : <SkillPanel sessionID={sessionID} reloadToken={reload} />}
      </div>
    </Scrim>
  )
}
