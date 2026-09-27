import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ToolPart } from "../../shared/protocol"
import { getTool } from "../src/agent/tools"
import type { Session } from "../src/sessions"

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

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "goto-inject-"))
const marker = path.join(workspace, "PWNED.txt")
const payload = `x & echo PWNED>"${marker}" & echo y`

function clean() {
  fs.rmSync(marker, { force: true })
}

console.log("--- 先复现漏洞：shell:true 会把参数当命令解释")
clean()
spawnSync(`${process.execPath} -e 0 ${payload}`, { shell: true, encoding: "utf8" })
check("shell:true 下注入会被执行（这就是要修的东西）", fs.existsSync(marker), true)
clean()

console.log("--- 修法原理：不带 shell 时参数原样传递")
const literal = spawnSync(
  process.execPath,
  ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", payload],
  { encoding: "utf8" },
)
check("参数逐字到达子进程", JSON.parse(literal.stdout)[0], payload)
check("没有任何东西被执行", fs.existsSync(marker), false)

console.log("--- grep 工具端到端：注入载荷不会生效")
const tool = getTool("grep")
check("grep 工具存在", Boolean(tool), true)

async function grep(pattern: string) {
  return tool!.run(
    { pattern },
    {
      session: { id: "inject-test", workspace, accessMode: "workspace" } as unknown as Session,
      signal: new AbortController().signal,
      part: {} as ToolPart,
      stream: () => undefined,
      ask: async () => "",
    },
  )
}

const result = await grep(payload)
check("没有创建标记文件", fs.existsSync(marker), false)
check("只是当成没匹配到的正则", result.title.includes("No matches") || result.title.includes("0 matches"), true)

console.log("--- 以 - 开头的 pattern 不会被当成 flag")
const dashed = await grep("--pre=calc")
check("带 -- 之后按字面处理", fs.existsSync(marker), false)
check("没有崩", typeof dashed.output, "string")

console.log("--- 正常搜索仍然可用")
fs.writeFileSync(path.join(workspace, "hello.ts"), "export const needle = 1\n", "utf8")
const normal = await grep("needle")
check("搜到了内容", normal.output.includes("needle"), true)

console.log("--- 灾难性回溯的 pattern 不能卡死服务端")
// rg 不在 PATH 时走 JS 回退；那里如果用 new RegExp(pattern).test() 原地跑，一次指数级回溯
// 就会冻住整个事件循环 —— UI 都按不动，更别说中止。现在它在子进程里跑，超时就杀。
// (a+)+$ 对「一长串 a 后面跟一个非 a」是指数级的；行长恰好压在单行上限内，保证真会回溯。
process.env.GREP_TIMEOUT_MS = "1500"
fs.writeFileSync(path.join(workspace, "redos.txt"), `${"a".repeat(3999)}b`, "utf8")

const startedAt = Date.now()
let redosMessage = ""
try {
  await grep("(a+)+$")
} catch (error) {
  redosMessage = error instanceof Error ? error.message : String(error)
}
const elapsed = Date.now() - startedAt
check("被超时掐掉而不是挂住", redosMessage.includes("timed out"), true)
check("秒级返回（说明是子进程被杀，不是无限回溯）", elapsed < 6_000, true)

// and the guard must not have broken the normal path after it
const after = await grep("needle")
check("超时之后正常搜索依然可用", after.output.includes("needle"), true)

fs.rmSync(workspace, { recursive: true, force: true })

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
