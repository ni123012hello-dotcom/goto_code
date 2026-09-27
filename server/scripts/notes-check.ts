import fs from "node:fs"
import path from "node:path"
import type { NoteSection, ToolPart } from "../../shared/protocol"
import { getTool } from "../src/agent/tools"
import {
  loadNote,
  NOTE_SKELETON,
  notesFile,
  noteTokens,
  orderSections,
  parseNote,
  removeSection,
  renderNote,
  renderNoteForPrompt,
  updateSection,
  writeNoteText,
} from "../src/notes"
import type { Session } from "../src/sessions"

let failures = 0
const created: string[] = []

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${
      ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`
    }`,
  )
}

const runID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let counter = 0
function noteID(): string {
  counter += 1
  const id = `note-${runID}-${counter}`
  created.push(notesFile(id))
  return id
}

// an assertion that throws would otherwise skip the cleanup at the bottom and leave
// orphan files in the real .data/notes/ — this has actually happened
process.on("exit", () => {
  for (const file of created) fs.rmSync(file, { force: true })
})

const WORKSPACE = "C:\\code\\demo"

function ctx(sessionID: string) {
  return {
    // the note belongs to the conversation, so the tool reads the id off the session.
    // subscribers is needed because a successful write emits note.changed to it.
    session: { id: sessionID, workspace: WORKSPACE, folderID: "irrelevant", subscribers: new Set() } as unknown as Session,
    signal: new AbortController().signal,
    part: {} as ToolPart,
    stream: () => undefined,
    ask: async () => "",
  }
}

async function noteTool(sessionID: string, input: Record<string, unknown>) {
  const tool = getTool("note")
  if (!tool) throw new Error("note tool missing")
  return tool.run(input, ctx(sessionID))
}

function bigBody(tokens: number): string {
  return "x".repeat(tokens * 4)
}

async function main() {
  console.log("--- 空笔记")
  const empty = noteID()
  check("没有任何小节", loadNote(empty).sections, [])
  check("空笔记不注入", renderNoteForPrompt(empty, 5000, WORKSPACE).text, "")

  console.log("--- 解析 / 渲染往返")
  const sections: NoteSection[] = [
    { name: "注意事项", body: "别删 .data", updatedAt: "2026-09-19T10:00:00.000Z", sessionID: "aaa11111", tokens: 0 },
    { name: "应用是什么", body: "一个本地 agent", updatedAt: "2026-09-19T11:00:00.000Z", sessionID: "bbb22222", tokens: 0 },
  ]
  const rendered = renderNote(sections, WORKSPACE)
  const parsed = parseNote(rendered)
  check("工作区被记录", parsed.workspace, WORKSPACE)
  check("小节数一致", parsed.sections.length, 2)
  check("小节名保留", parsed.sections.map((s) => s.name).sort(), ["应用是什么", "注意事项"])
  check("正文保留", parsed.sections.find((s) => s.name === "应用是什么")?.body, "一个本地 agent")
  check("时间保留", parsed.sections.find((s) => s.name === "注意事项")?.updatedAt, "2026-09-19T10:00:00.000Z")
  check("来源会话保留", parsed.sections.find((s) => s.name === "注意事项")?.sessionID, "aaa11111")

  console.log("--- 手改过的文件（缺 meta 行）也能解析")
  const handEdited = parseNote("# 笔记\n\n## 我的小节\n随便写的东西\n第二行\n")
  check("解析出手写小节", handEdited.sections.length, 1)
  check("正文完整", handEdited.sections[0].body, "随便写的东西\n第二行")
  check("没有时间也不报错", handEdited.sections[0].updatedAt, undefined)
  check("工作区为 null", handEdited.workspace, null)

  console.log("--- 固定骨架顺序（决定注入优先级）")
  const shuffled: NoteSection[] = [
    { name: "注意事项", body: "c", tokens: 1 },
    { name: "使用指南", body: "b", tokens: 1 },
    { name: "应用是什么", body: "a", tokens: 1 },
  ]
  check("按骨架排序", orderSections(shuffled).map((s) => s.name), ["应用是什么", "使用指南", "注意事项"])
  const custom: NoteSection[] = [
    { name: "自定义A", body: "x", updatedAt: "2026-01-01T00:00:00.000Z", tokens: 1 },
    { name: "自定义B", body: "y", updatedAt: "2026-09-01T00:00:00.000Z", tokens: 1 },
    { name: "应用是什么", body: "z", tokens: 1 },
  ]
  check(
    "非骨架小节排在后面，且按时间倒序",
    orderSections(custom).map((s) => s.name),
    ["应用是什么", "自定义B", "自定义A"],
  )
  check("骨架内容符合预期", NOTE_SKELETON.length, 5)

  console.log("--- upsert 与删除")
  const upsert = noteID()
  updateSection(upsert, "应用是什么", "第一版", WORKSPACE)
  check("创建成功", loadNote(upsert).sections.length, 1)
  updateSection(upsert, "应用是什么", "第二版", WORKSPACE)
  const after = loadNote(upsert).sections
  check("覆盖而不是追加", after.length, 1)
  check("内容已更新", after[0].body, "第二版")
  check("记录的会话就是拥有它的那个", after[0].sessionID, upsert.slice(0, 8))
  check("删除返回 true", removeSection(upsert, "应用是什么"), true)
  check("删除后为空", loadNote(upsert).sections.length, 0)
  check("删不存在的返回 false", removeSection(upsert, "没有这节"), false)

  console.log("--- 对话之间互不可见（一个对话一份笔记）")
  const a = noteID()
  const b = noteID()
  updateSection(a, "应用是什么", "A 的内容", WORKSPACE)
  check("A 有内容", loadNote(a).sections.length, 1)
  check("B 是空的", loadNote(b).sections.length, 0)

  console.log("--- 注入：目录永远在，正文按骨架填充")
  const budget = noteID()
  updateSection(budget, "应用是什么", "这是应用说明", WORKSPACE)
  updateSection(budget, "使用指南", "pnpm install", WORKSPACE)

  const inject = renderNoteForPrompt(budget, 5000, WORKSPACE)
  check("两节都注入了", inject.injected, ["应用是什么", "使用指南"])
  check("没有未注入的", inject.omitted.length, 0)
  check("正文真的在", inject.text.includes("这是应用说明") && inject.text.includes("pnpm install"), true)
  check("带上了核实提醒", inject.text.includes("当起点，不要当事实"), true)
  check("告诉它怎么更新", inject.text.includes("note 工具更新"), true)

  console.log("--- 注入预算：超了就列出未注入的")
  const huge = noteID()
  for (const [index, name] of NOTE_SKELETON.entries()) {
    updateSection(huge, name, bigBody(index === 0 ? 200 : 3000), WORKSPACE)
  }
  const capped = renderNoteForPrompt(huge, 5000, WORKSPACE)
  check("第一节一定进得去", capped.injected[0], "应用是什么")
  check("有被挤出去的", capped.omitted.length > 0, true)
  check("未注入的也列出来了", capped.text.includes("[未注入]"), true)
  check("总数对得上", capped.injected.length + capped.omitted.length, NOTE_SKELETON.length)
  console.log(`        注入 ${capped.injected.length} 节，未注入 ${capped.omitted.length} 节`)
  console.log(`        ${capped.text.split("\n").find((l) => l.includes("[未注入]"))?.trim().slice(0, 90)}`)

  console.log("--- 文件可以无限大")
  const endless = noteID()
  for (let index = 0; index < 40; index += 1) {
    updateSection(endless, `小节${index}`, bigBody(500), WORKSPACE)
  }
  check("40 节都存下来了", loadNote(endless).sections.length, 40)
  check("总量远超注入预算", noteTokens(loadNote(endless).sections) > 5000, true)
  const endlessInjection = renderNoteForPrompt(endless, 5000, WORKSPACE)
  check("但注入仍然有界", endlessInjection.injected.length < 40, true)

  console.log("--- 用户直接编辑（原始 markdown）")
  const raw = noteID()
  writeNoteText(raw, `# 笔记\n\n<!-- workspace=${WORKSPACE} -->\n\n## 应用是什么\n手写的\n`)
  check("从原始文本解析成功", loadNote(raw).sections[0].body, "手写的")

  console.log("--- note 工具")
  const tooled = noteID()
  const outlineEmpty = await noteTool(tooled, { action: "outline" })
  check("空笔记的 outline 给建议", outlineEmpty.output.includes("还没有笔记"), true)

  const updated = await noteTool(tooled, {
    action: "update",
    section: "应用是什么",
    body: "一个本地 agent，给程序员用。",
  })
  check("update 成功", updated.title.includes("应用是什么"), true)
  check("落盘了", loadNote(tooled).sections.length, 1)

  const outline = await noteTool(tooled, { action: "outline" })
  check("outline 列出小节", outline.output.includes("应用是什么"), true)
  check("outline 带 token 数", outline.output.includes("tok"), true)

  const read = await noteTool(tooled, { action: "read", section: "应用是什么" })
  check("read 返回正文", read.output, "一个本地 agent，给程序员用。")

  const missing = await noteTool(tooled, { action: "read", section: "不存在" })
  check("read 不存在时不抛错", missing.title, "not found")

  const removed = await noteTool(tooled, { action: "remove", section: "应用是什么" })
  check("remove 成功", removed.title.includes("removed"), true)
  check("确实删了", loadNote(tooled).sections.length, 0)

  let threw = false
  try {
    await noteTool(tooled, { action: "update", section: "x", body: "   " })
  } catch {
    threw = true
  }
  check("空正文被拒", threw, true)

  threw = false
  try {
    await noteTool(tooled, { action: "nonsense" })
  } catch {
    threw = true
  }
  check("未知 action 被拒", threw, true)

  console.log("--- 工作区变了要能察觉")
  const stale = noteID()
  updateSection(stale, "使用指南", "旧命令", "C:\\code\\old")
  const staleInjection = renderNoteForPrompt(stale, 5000, "C:\\code\\new")
  check("提示工作区已变", staleInjection.text.includes("很可能已经过期"), true)

  for (const file of created) fs.rmSync(file, { force: true })
  console.log(`\n清理了 ${created.length} 个测试笔记文件`)

  console.log(failures === 0 ? "全部通过" : `${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
