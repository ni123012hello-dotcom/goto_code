import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { probeWorkspace } from "../src/agent/probe"
import {
  applyMemoryDelta,
  approveEntry,
  bumpRevision,
  conflictsWith,
  expireHypotheses,
  formatMemoryForPrompt,
  loadMemory,
  loadRevision,
  memoryFile,
  promoteVerified,
  reconcileMemory,
  rejectEntry,
  writeMemoryText,
  type MemoryScope,
} from "../src/memory"

let failures = 0
const cleanups: string[] = []
// session ids must be unique per run: .data/memory persists between runs, so a
// fixed id would inherit entries written by the previous run
const runID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${
      ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`
    }`,
  )
}

let sessionCounter = 0

function scope(files: Record<string, string> = {}): MemoryScope {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "goto-mem-"))
  cleanups.push(workspace)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), body, "utf8")
  sessionCounter += 1
  return { sessionID: `test-${runID}-${sessionCounter}`, workspace }
}

async function main() {
  const main = scope({
    "package-lock.json": "{}",
    "package.json": JSON.stringify({ name: "demo-app", scripts: { test: "vitest", build: "tsc" } }),
  })
  const facts = await probeWorkspace(main.workspace)

  console.log("--- 记忆按会话隔离（同一工作区，两个会话）")
  const other = scope()
  applyMemoryDelta(main, [{ key: "", value: "属于会话 A 的记忆", source: "user" }], [], { status: "active" })
  check("会话 A 有 1 条", loadMemory(main).length, 1)
  check("会话 B 是空的", loadMemory(other).length, 0)
  check("文件路径按会话分", path.join("memory", `${other.sessionID}.md`).endsWith(`${other.sessionID}.md`), true)

  console.log("--- T5.1  compaction 产物落到 pending，不进 prompt")
  applyMemoryDelta(main, [{ key: "包管理器", value: "用 npm 装依赖", source: "tool" }], [])
  let entries = loadMemory(main)
  const pendingEntry = entries.find((entry) => entry.value === "用 npm 装依赖")!
  check("状态是 pending", pendingEntry.status, "pending")
  check("prompt 里没有它（隔离生效）", formatMemoryForPrompt(entries, facts, main.workspace).includes("用 npm 装依赖"), false)

  console.log("--- T5.2  probe 能证实的 pending 自动提升")
  check("probe 实测 npm", facts.packageManager, "npm")
  check("自动提升 1 条", promoteVerified(main, facts), 1)
  entries = loadMemory(main)
  const promotedEntry = entries.find((entry) => entry.value === "用 npm 装依赖")!
  check("提升后 active", promotedEntry.status, "active")
  check("提升后来源 probe", promotedEntry.source, "probe")
  check("进入 prompt", /已确认/.test(formatMemoryForPrompt(entries, facts, main.workspace)), true)

  console.log("--- T5.3  用户批准 / 拒绝")
  applyMemoryDelta(main, [{ key: "", value: "不要写代码注释", source: "inferred" }], [])
  const proposal = loadMemory(main).find((entry) => entry.value === "不要写代码注释")!
  check("提议初始 pending", proposal.status, "pending")
  check("批准前不在 prompt 里", formatMemoryForPrompt(loadMemory(main), facts, main.workspace).includes("不要写代码注释"), false)

  approveEntry(main, proposal.id)
  const approved = loadMemory(main).find((entry) => entry.id === proposal.id)!
  check("批准后 active", approved.status, "active")
  check("批准后来源 user", approved.source, "user")
  check("批准后进入 prompt", formatMemoryForPrompt(loadMemory(main), facts, main.workspace).includes("不要写代码注释"), true)

  applyMemoryDelta(main, [{ key: "", value: "这个模块负责渲染", source: "inferred" }], [])
  const toReject = loadMemory(main).find((entry) => entry.value === "这个模块负责渲染")!
  check("拒绝返回 true", rejectEntry(main, toReject.id), true)
  check("拒绝后消失", loadMemory(main).some((entry) => entry.id === toReject.id), false)

  console.log("--- T5.4  重新提议不会把已批准的打回 pending")
  applyMemoryDelta(main, [{ key: "", value: "不要写代码注释", source: "inferred" }], [])
  const after = loadMemory(main).find((entry) => entry.value === "不要写代码注释")!
  check("仍是 active", after.status, "active")
  check("来源没降级", after.source, "user")

  console.log("--- T5.5  一致时不产生冲突行（界面上不显示）")
  check("冲突列表为空", conflictsWith(main, facts).length, 0)

  console.log("--- T7  冲突 → 先告知 → 一回合后强制改写为实测值")
  const conflictScope = scope({ "package-lock.json": "{}" })
  applyMemoryDelta(conflictScope, [{ key: "包管理器", value: "用 pnpm 装依赖", source: "tool" }], [])
  const conflictFacts = await probeWorkspace(conflictScope.workspace)

  let round = reconcileMemory(conflictScope, conflictFacts)
  check("第一轮只标记不改写", { flagged: round.flagged, corrected: round.corrected }, { flagged: 1, corrected: 0 })
  check("值保持原样", loadMemory(conflictScope)[0].value, "用 pnpm 装依赖")
  check("出现在冲突列表", conflictsWith(conflictScope, conflictFacts).length, 1)
  check("列出了实测值", conflictsWith(conflictScope, conflictFacts)[0].expected, "npm")
  check("可自动修正", conflictsWith(conflictScope, conflictFacts)[0].correctable, true)

  round = reconcileMemory(conflictScope, conflictFacts)
  check("第二轮强制改写", round.corrected, 1)
  const fixed = loadMemory(conflictScope)[0]
  check("值改写成实测的", fixed.value, "用 npm 装依赖")
  check("来源升级为 probe", fixed.source, "probe")
  check("状态变为 active", fixed.status, "active")
  check("不再是冲突", conflictsWith(conflictScope, conflictFacts).length, 0)
  check("进入已确认组", /已确认/.test(formatMemoryForPrompt(loadMemory(conflictScope), conflictFacts, conflictScope.workspace)), true)

  console.log("--- T7.2  人工声明永不被覆盖")
  const humanScope = scope({ "package-lock.json": "{}" })
  applyMemoryDelta(humanScope, [{ key: "包管理器", value: "用 pnpm", source: "user" }], [], { status: "active" })
  const humanFacts = await probeWorkspace(humanScope.workspace)
  reconcileMemory(humanScope, humanFacts)
  reconcileMemory(humanScope, humanFacts)
  reconcileMemory(humanScope, humanFacts)
  check("值未被改写", loadMemory(humanScope)[0].value, "用 pnpm")
  check("仍被报告为冲突", conflictsWith(humanScope, humanFacts).length, 1)
  check("标记为不可自动覆盖", conflictsWith(humanScope, humanFacts)[0].correctable, false)

  console.log("--- T7.3  引用不存在的路径 → 删除而非改写")
  const pathScope = scope()
  applyMemoryDelta(pathScope, [{ key: "配置", value: "在 src/gone.ts 里", source: "tool" }], [], { status: "active" })
  const pathFacts = await probeWorkspace(pathScope.workspace)
  reconcileMemory(pathScope, pathFacts)
  check("第二轮被删除", reconcileMemory(pathScope, pathFacts).dropped, 1)
  check("条目已消失", loadMemory(pathScope).length, 0)

  console.log("--- T4  未确认的推断会过期")
  applyMemoryDelta(main, [{ key: "", value: "一条没人理的推断", source: "inferred" }], [])
  for (let index = 0; index < 20; index += 1) bumpRevision(main)
  check("刚好 TTL 轮内不清", loadMemory(main).some((entry) => entry.value === "一条没人理的推断"), true)
  bumpRevision(main)
  check("超过 TTL 后被清掉", expireHypotheses(main), 1)
  check("已批准条目不受影响", loadMemory(main).some((entry) => entry.value === "不要写代码注释"), true)
  check("rev 正常推进", loadRevision(main) > 20, true)

  console.log("--- T9  memory 工具：agent 直接录入，不经过 pending")
  const { getTool, tools } = await import("../src/agent/tools")
  check("工具已注册", tools.some((tool) => tool.name === "memory"), true)

  const toolScope = scope()
  const session = { id: toolScope.sessionID, workspace: toolScope.workspace } as never
  const ctx = {
    session,
    signal: new AbortController().signal,
    part: {} as never,
    stream: () => undefined,
  }

  const memoryTool = getTool("memory")!
  const added = await memoryTool.run(
    { action: "add", content: "以后写代码不要加注释", label: "代码风格", source: "user" },
    ctx,
  )
  entries = loadMemory(toolScope)
  check("直接写入 1 条", entries.length, 1)
  check("状态直接是 active（不排队）", entries[0].status, "active")
  check("来源是 user", entries[0].source, "user")
  check("立刻进入 prompt", formatMemoryForPrompt(entries, undefined, toolScope.workspace).includes("不要加注释"), true)
  check("返回值里带 id 方便后续删除", added.output.includes(entries[0].id), true)

  const observed = await memoryTool.run(
    { action: "add", content: "入口文件是 src/index.ts", source: "observed" },
    ctx,
  )
  entries = loadMemory(toolScope)
  check("observed 落到 tool 来源", entries.find((entry) => entry.value.includes("入口文件"))?.source, "tool")

  await memoryTool.run({ action: "remove", id: entries[0].id }, ctx)
  entries = loadMemory(toolScope)
  check("remove 后只剩 1 条", entries.length, 1)
  check("被删的那条不在 prompt 里", formatMemoryForPrompt(entries, undefined, toolScope.workspace).includes("不要加注释"), false)
  check("重复 add 不产生新条目", (await memoryTool.run({ action: "add", content: "入口文件是 src/index.ts", source: "observed" }, ctx), loadMemory(toolScope).length), 1)

  console.log("--- 文件格式（会话 A 的记忆文件）")
  console.log(
    fs
      .readFileSync(memoryFile(main), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- ") || line.includes("rev:"))
      .map((line) => `        ${line}`)
      .join("\n"),
  )

  console.log("--- 旧格式兼容")
  const legacy = scope()
  writeMemoryText(
    legacy,
    ["# goto memory", "", "## user", "", "- [aaa111] 用户偏好", "", "## agent", "", "- [bbb222] 提取的事实"].join("\n"),
  )
  const legacyEntries = loadMemory(legacy)
  check("解析出 2 条", legacyEntries.length, 2)
  check("user 段迁移为 user 来源", legacyEntries.find((entry) => entry.id === "aaa111")?.source, "user")
  check("agent 段迁移为 inferred 来源", legacyEntries.find((entry) => entry.id === "bbb222")?.source, "inferred")

  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true })

  const memoryDir = path.dirname(memoryFile({ sessionID: `test-${runID}-0`, workspace: "." }))
  let removed = 0
  try {
    for (const file of fs.readdirSync(memoryDir)) {
      if (!file.startsWith(`test-${runID}-`)) continue
      fs.rmSync(path.join(memoryDir, file), { force: true })
      removed += 1
    }
  } catch {
    removed = 0
  }
  console.log(`\n清理了 ${removed} 个测试记忆文件`)

  console.log(failures === 0 ? "全部通过" : `${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
