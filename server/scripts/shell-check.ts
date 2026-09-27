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

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "goto-shell-"))

function context() {
  const chunks: string[] = []
  return {
    chunks,
    ctx: {
      session: { id: "shell-test", workspace } as unknown as Session,
      signal: new AbortController().signal,
      part: {} as ToolPart,
      stream: (chunk: string) => chunks.push(chunk),
      ask: async () => "",
    },
  }
}

async function run(command: string) {
  const tool = getTool("bash")
  if (!tool) throw new Error("bash tool missing")
  const { chunks } = context()
  const result = await tool.run({ command }, context().ctx)
  void chunks
  return result
}

async function main() {
  console.log("--- 基本执行")
  const hello = await run("echo hello")
  check("输出正确", hello.output.trim(), "hello")
  check("退出码 0", hello.title, "exit 0")

  console.log("--- && 是否可用（5.1 不支持，7 支持）")
  const chained = await run("echo one && echo two")
  check("&& 串联生效", chained.output.includes("one") && chained.output.includes("two"), true)

  console.log("--- 中文输出不能乱码（编码前置的唯一理由）")
  const chinese = await run('echo "中文测试 你好"')
  check("中文原样返回", chinese.output.includes("中文测试 你好"), true)
  console.log(`        ${JSON.stringify(chinese.output.trim())}`)

  console.log("--- 文件系统里的中文名")
  await run('Set-Content -Path "中文文件.txt" -Value "内容" -Encoding utf8')
  const listed = await run("Get-ChildItem -Name")
  check("中文文件名正确", listed.output.includes("中文文件.txt"), true)

  console.log("--- stderr 重定向用 2>$null")
  const redirected = await run("Write-Error 'boom' 2>$null; echo after")
  check("2>$null 生效且不中断", redirected.output.includes("after"), true)
  check("错误没混进输出", redirected.output.includes("boom"), false)

  console.log("--- 环境变量用 $env:")
  const env = await run("echo $env:USERNAME")
  check("$env: 展开成功", env.output.trim().length > 0, true)

  console.log("--- 工作目录就是 workspace")
  const pwd = await run("(Get-Location).Path")
  check("cwd 正确", path.resolve(pwd.output.trim()), path.resolve(workspace))

  console.log("--- 退出码透传")
  const failed = await run("exit 3")
  check("非零退出码", failed.title, "exit 3")

  console.log("--- 别名的确可用（模型会本能地用这些）")
  const aliases = await run("ls; cat 中文文件.txt; pwd")
  check("ls/cat/pwd 别名都能跑", aliases.output.includes("内容"), true)

  console.log("--- mkdir 不需要 -p")
  const mk = await run('mkdir deep\\nested -Force; Test-Path deep\\nested')
  check("mkdir 建出多层", mk.output.includes("True"), true)
  const noJunk = await run("Get-ChildItem -Name")
  check("没有建出叫 -p 的目录", noJunk.output.includes("-p"), false)

  console.log("--- 大输出必须被截断（整文件 dump 是最吃上下文的模式）")
  // 实测：一轮 179KB 的工具输出里，前 10 条全是 Get-Content <file> -Raw
  const huge = await run('"x" * 30000')
  check("30000 字符被砍到 8000 上限附近", huge.output.length < 12_000, true)
  check("说明了原始大小", huge.output.includes("was 30000 chars"), true)
  check("截断提示指向 read 工具", huge.output.includes("use the read tool instead"), true)

  fs.rmSync(workspace, { recursive: true, force: true })

  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
