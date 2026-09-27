import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildSystemPrompt } from "../src/agent/prompt"
import { getTool, toolAllowedInMode, toolSchemas } from "../src/agent/tools"
import { dataFile } from "../src/config"
import { createSession, deleteSession, getSession, loadPersistedSessions, setSessionMode } from "../src/sessions"

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${
      ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`
    }`,
  )
}

const TAG = `modecheck-${Date.now().toString(36)}`
const sessionDir = path.join(path.dirname(dataFile), "sessions")

console.log("--- plan 的白名单：显式列出，所以没列到的一律被拦")
for (const name of ["read", "list", "grep", "fetch", "skill", "ask", "spawn_agents", "memory", "note"]) {
  check(`plan 允许 ${name}`, toolAllowedInMode(name, "plan"), true)
}
for (const name of ["write", "edit", "bash"]) {
  check(`plan 拦 ${name}`, toolAllowedInMode(name, "plan"), false)
}
check("plan 拦 MCP 工具", toolAllowedInMode("mcp__files__write", "plan"), false)
// 这一条是白名单的意义所在：将来新增的工具默认在 plan 下不可用，而不是默认可用
check("plan 拦一个还没出现过的工具（fail-closed）", toolAllowedInMode("some-future-tool", "plan"), false)

check("agent 放行 write", toolAllowedInMode("write", "agent"), true)
check("agent 放行 bash", toolAllowedInMode("bash", "agent"), true)
check("agent 放行 MCP", toolAllowedInMode("mcp__files__write", "agent"), true)

console.log("--- schema 层：这些工具干脆不提供给模型")
const planNames = toolSchemas("plan").map((schema) => schema.function.name)
const agentNames = toolSchemas("agent").map((schema) => schema.function.name)
check("plan 没有 write", planNames.includes("write"), false)
check("plan 没有 edit", planNames.includes("edit"), false)
check("plan 没有 bash", planNames.includes("bash"), false)
check("plan 没有 MCP 工具", planNames.some((name) => name.startsWith("mcp__")), false)
check("plan 仍有 read", planNames.includes("read"), true)
check("plan 仍有子智能体", planNames.includes("spawn_agents"), true)
check("agent 有 write", agentNames.includes("write"), true)
check("agent 有 bash", agentNames.includes("bash"), true)

console.log("--- 拦的是执行，不是查找（模型硬调也要过同一道关）")
check("write 仍在注册表里", Boolean(getTool("write")), true)
check("bash 仍在注册表里", Boolean(getTool("bash")), true)

console.log("--- system prompt：plan 必须自报只读")
const planPrompt = buildSystemPrompt({ memory: [], workspace: "/tmp", mode: "plan" })
check("写明「计划（只读）」", planPrompt.includes("计划（只读）"), true)
check("点名 shell 被禁用", planPrompt.includes("shell"), true)
check("告诉模型切到执行模式", planPrompt.includes("执行"), true)

const agentPrompt = buildSystemPrompt({ memory: [], workspace: "/tmp", mode: "agent" })
check("agent 模式没有这个块", agentPrompt.includes("计划（只读）"), false)
const defaultPrompt = buildSystemPrompt({ memory: [], workspace: "/tmp" })
check("不传 mode 等于 agent（老调用点不受影响）", defaultPrompt.includes("计划（只读）"), false)

console.log("--- 会话：默认 agent，切换会落盘")
const session = createSession(process.cwd())
check("新会话默认 agent", session.mode, "agent")
check("切换返回新的信息", setSessionMode(session.id, "plan")?.mode, "plan")
check("内存里也变了", getSession(session.id)?.mode, "plan")
const file = path.join(sessionDir, `${session.id}.json`)
check(
  "落盘了（重启不丢）",
  (JSON.parse(fs.readFileSync(file, "utf8")) as { mode?: string }).mode,
  "plan",
)
check("未知会话返回 undefined", setSessionMode("does-not-exist", "plan"), undefined)
deleteSession(session.id)
check("清理掉测试会话", fs.existsSync(file), false)

console.log("--- 旧会话文件（没有 mode 字段）读回来是 agent")
const legacyID = `${TAG}-legacy`
const legacyFile = path.join(sessionDir, `${legacyID}.json`)
fs.writeFileSync(
  legacyFile,
  JSON.stringify({
    id: legacyID,
    title: "legacy",
    workspace: process.cwd(),
    createdAt: Date.now(),
    messages: [],
  }),
  "utf8",
)
loadPersistedSessions()
check("没有 mode 的老文件 = agent，不是只读", getSession(legacyID)?.mode, "agent")
deleteSession(legacyID)
check("清掉了这个临时文件", fs.existsSync(legacyFile), false)

console.log("--- 两个不能被子智能体绕过的执行点（源码哨兵）")
// 这两处无法用行为测试便宜地覆盖（跑一轮需要假 LLM），但它们一旦被删掉，plan 模式就静默
// 失效了 —— 和 AGENTS 第 4 节说的「字段不落盘/读不回」是同一类静默故障。
const here = path.dirname(fileURLToPath(import.meta.url))
const loopSource = fs.readFileSync(path.join(here, "..", "src", "agent", "loop.ts"), "utf8")
const subagentsSource = fs.readFileSync(path.join(here, "..", "src", "subagents.ts"), "utf8")
check("loop 在执行前按模式拦截", loopSource.includes("toolAllowedInMode(tool.name, session.mode)"), true)
check("loop 把模式带进 system prompt", loopSource.includes("mode: session.mode"), true)
check("loop 按模式过滤 schema", loopSource.includes("toolSchemas(session.mode)"), true)
check("子智能体继承父会话的模式", subagentsSource.includes("sub.mode = parent.mode"), true)

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
