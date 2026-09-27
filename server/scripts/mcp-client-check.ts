// Transport-level checks for MCP: a real child process, a real JSON-RPC exchange over stdio.
//
// Set before the first import of anything that reads config: the timeout test would otherwise
// have to wait the production 30s.
process.env.MCP_TIMEOUT_MS = "1500"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeServer = path.join(here, "e2e", "fake-mcp.mjs")

const { mcpFilePath, upsertMcpServer, listMcpServers } = await import("../src/mcp")
const { mcpStatus, mcpTools, startMcpServers, stopMcpServers } = await import("../src/mcp-client")
const { getTool, toolSchemas } = await import("../src/agent/tools")

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

const storePath = mcpFilePath()
const backup = fs.existsSync(storePath) ? fs.readFileSync(storePath, "utf8") : null

// the cmd.exe wrapper exercises the one path that cannot use a plain spawn
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goto-mcp-"))
const wrapper = path.join(tmp, "fake-mcp.cmd")
// .cmd files must be CRLF or the tag jumps go wrong
fs.writeFileSync(wrapper, `@echo off\r\nnode "${fakeServer}" %*\r\n`, "utf8")

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  stopMcpServers()
  try {
    if (backup === null) fs.rmSync(storePath, { force: true })
    else fs.writeFileSync(storePath, backup, "utf8")
  } catch {
    // nothing useful to do while exiting
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}
// a crash mid-test must not leave test servers or child processes behind
process.on("exit", cleanup)

async function runTool(name: string, input: Record<string, unknown> = {}) {
  const tool = getTool(name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool.run(input, {} as never)
}

fs.rmSync(storePath, { force: true })

console.log("--- 配置两个 server：一个直接 spawn，一个走 .cmd")
const direct = upsertMcpServer({
  id: "direct",
  name: "direct",
  command: process.execPath,
  args: [fakeServer],
  enabled: true,
  acknowledge: true,
})
const viaCmd = upsertMcpServer({
  id: "viacmd",
  name: "viacmd",
  command: wrapper,
  // only one tool, to prove the per-server allowlist is applied
  tools: ["echo"],
  enabled: true,
  acknowledge: true,
})
check("两个都已确认", [direct.trusted, viaCmd.trusted], [true, true])

console.log("--- 启动 + 发现工具（含 tools/list 分页）")
const started = await startMcpServers()
check("两个都 ready", started.map((s) => s.status).sort(), ["ready", "ready"])
check("直连 server 拿到全部 4 个工具", mcpStatus().find((s) => s.id === "direct")?.tools, 4)
check("走 .cmd 的 server 也在跑", mcpStatus().find((s) => s.id === "viacmd")?.tools, 1)

const names = mcpTools().map((t) => t.fullName)
check("工具名带前缀和 server id", names.includes("mcp__direct__echo"), true)
check("分页拿到的第二页也在", names.includes("mcp__direct__hang"), true)
check("白名单外的不出现", names.includes("mcp__viacmd__big"), false)
check("白名单内的出现", names.includes("mcp__viacmd__echo"), true)
check("总共 5 个", names.length, 5)

console.log("--- schema 进入了请求")
const schemaNames = toolSchemas("agent").map((s) => s.function.name)
check("MCP 工具在 schema 列表里", schemaNames.includes("mcp__direct__echo"), true)
check("内置工具没有被顶掉", schemaNames.includes("bash"), true)
check(
  "schema 用的是服务器给的参数定义",
  (toolSchemas("agent").find((s) => s.function.name === "mcp__direct__echo")?.function.parameters as { required?: string[] })
    ?.required,
  ["text"],
)

console.log("--- 调用")
const echoed = await runTool("mcp__direct__echo", { text: "hello" })
check("结果文本回灌", echoed.output, "echo: hello")
check("标题标出来源", echoed.title, "direct/echo")

const viaCmdResult = await runTool("mcp__viacmd__echo", { text: "through cmd" })
check("经 cmd.exe 也能正常往返", viaCmdResult.output, "echo: through cmd")

console.log("--- 输出上界被强制执行")
const big = await runTool("mcp__direct__big")
check("超大输出被截断", big.output.includes("[truncated"), true)
check("截断后不超过上限", big.output.length < 20_100, true)

console.log("--- 工具报错走错误路径")
let boomMessage = ""
try {
  await runTool("mcp__direct__boom")
} catch (error) {
  boomMessage = error instanceof Error ? error.message : String(error)
}
check("isError 变成抛错", boomMessage.includes("the server refused"), true)

console.log("--- 卡死不回：超时就放弃，不拖着整个回合")
const startedAt = Date.now()
let hangMessage = ""
try {
  await runTool("mcp__direct__hang")
} catch (error) {
  hangMessage = error instanceof Error ? error.message : String(error)
}
const waited = Date.now() - startedAt
check("超时后抛错", hangMessage.includes("timed out"), true)
check("按照 MCP_TIMEOUT_MS 放弃（<5s）", waited < 5_000, true)

console.log("--- 未知工具不会被当成 MCP 工具")
check("没注册过的 mcp__ 名字查不到", getTool("mcp__direct__nope"), undefined)

console.log("--- 停掉之后不再提供工具")
stopMcpServers()
check("工具列表空了", mcpTools().length, 0)
check("getTool 也查不到了", getTool("mcp__direct__echo"), undefined)
check("状态回到 disabled", mcpStatus().every((s) => s.status === "disabled"), true)

console.log("--- 起不来的 server：报告失败，不刷屏重启")
upsertMcpServer({ id: "crashy", name: "crashy", command: process.execPath, args: [fakeServer, "--crash"], enabled: true, acknowledge: true })
const failed = await startMcpServers()
check("失败的被标出来", failed.find((s) => s.id === "crashy")?.status, "failed")
check("失败原因有记录", Boolean(failed.find((s) => s.id === "crashy")?.error), true)
check("健康的不受牵连", failed.filter((s) => s.status === "ready").length, 2)

// the important part: a server that is down offers nothing, so the model is never handed a
// tool it cannot call
check("它的工具不会被提供", mcpTools().some((t) => t.server === "crashy"), false)
check("getTool 也查不到", getTool("mcp__crashy__echo"), undefined)
check("但状态里能看到它失败了", mcpStatus().find((s) => s.id === "crashy")?.status, "failed")

console.log("--- 定义改了就立刻停跑（指纹失效）")
const edited = upsertMcpServer({ id: "direct", args: [fakeServer, "--flag"] })
check("信任被撤回", edited.trusted, false)
stopMcpServers()
const afterEdit = await startMcpServers()
check("改过的 server 不再启动", afterEdit.some((s) => s.id === "direct"), false)
check("但另一个还在跑", afterEdit.find((s) => s.id === "viacmd")?.status, "ready")

console.log("--- 手改 mcp.json 也不能自我授权")
stopMcpServers()
const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as { servers: Record<string, unknown>[] }
for (const server of raw.servers) {
  if (server.id === "viacmd") {
    server.command = process.execPath
    server.args = [fakeServer]
  }
}
fs.writeFileSync(storePath, JSON.stringify(raw, null, 2), "utf8")
check("手改过的 server 未受信任", listMcpServers().find((s) => s.id === "viacmd")?.trusted, false)
const afterHandEdit = await startMcpServers()
check("它不会被启动", afterHandEdit.some((s) => s.id === "viacmd"), false)

cleanup()
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
