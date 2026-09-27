import { Kbd, Label, Modal, Rule } from "../ui"

/* ============================================================================
 * Shortcuts.
 *
 * The app has a handful of real keyboard and pointer gestures and, before this,
 * no place that said so. A sheet of them costs one dialog and removes the whole
 * class of "I did not know you could do that".
 *
 * Only gestures that actually exist are listed here — a help sheet that lies is
 * worse than none.
 * ==========================================================================*/

const GROUPS: { title: string; rows: { keys: string[]; what: string }[] }[] = [
  {
    title: "输入框",
    rows: [
      { keys: ["Enter"], what: "发送当前内容" },
      { keys: ["Shift", "Enter"], what: "换行，不发送" },
      { keys: ["Tab"], what: "切换 执行 / 计划 模式；指令菜单打开时先补全指令" },
      { keys: ["/"], what: "行首输入斜杠，列出全部指令" },
      { keys: ["Ctrl", "V"], what: "粘贴图片作为附件（也可以直接拖进来）" },
    ],
  },
  {
    title: "列表与树",
    rows: [
      { keys: ["双击"], what: "项目树里的文件 → 把路径插入输入框" },
      { keys: ["双击"], what: "文件夹名 → 重命名" },
      { keys: ["双击"], what: "子智能体卡片 → 打开它自己的对话窗口" },
      { keys: ["拖动"], what: "把对话拖到文件夹上即移入；文件夹拖到空白处即移到顶层" },
      { keys: ["拖入"], what: "把文件或文件夹拖到项目树上即准备导入（确认后才写盘）" },
    ],
  },
  {
    title: "窗口与面板",
    rows: [
      { keys: ["拖动"], what: "笔记窗口、子智能体窗口的标题栏可移动窗口" },
      { keys: ["双击"], what: "文件夹与项目树之间的分隔条 → 恢复默认高度" },
    ],
  },
]

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="快捷键与手势" note="这里列出的都是真实存在的操作" onClose={onClose} className="max-w-xl">
      <div className="space-y-4">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <div className="flex items-center gap-2 pb-1.5">
              <span className="s-led" style={{ backgroundColor: "var(--color-s-ember)" }} />
              <Label className="text-s-bright">{group.title}</Label>
              <Rule />
            </div>

            <div className="space-y-1">
              {group.rows.map((row, index) => (
                <div key={index} className="flex items-baseline gap-3">
                  <span className="flex w-36 shrink-0 items-center gap-1">
                    {row.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                  <span className="min-w-0 flex-1 text-s-body">{row.what}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="border border-s-line bg-s-well px-2.5 py-2 text-s-faint shadow-[var(--in-1)]">
          面板宽度、导航栏的展开状态、以及米白 / 深色主题，都记在本机浏览器里，换机器不会跟着走。
        </div>
      </div>
    </Modal>
  )
}
