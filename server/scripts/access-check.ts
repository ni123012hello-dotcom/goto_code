import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AccessMode, ToolPart } from "../../shared/protocol"
import { buildSystemPrompt } from "../src/agent/prompt"
import { getTool } from "../src/agent/tools"
import { dataFile } from "../src/config"
import { previewFile } from "../src/preview"
import { resolveInside, safeRelativePath, secretReason } from "../src/safety"
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "goto-access-"))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goto-outside-"))
const outsideFile = path.join(outside, "secret.txt")
fs.writeFileSync(outsideFile, "外部文件内容\n", "utf8")
fs.writeFileSync(path.join(root, "inside.txt"), "工作区内内容\n", "utf8")
fs.writeFileSync(path.join(root, ".env"), "TOKEN=sk-secret-abcdef\n", "utf8")
fs.writeFileSync(path.join(root, ".env.example"), "TOKEN=sk-placeholder\n", "utf8")

function ctx(mode: AccessMode, workspace = root) {
  return {
    session: { id: "access-test", workspace, accessMode: mode } as unknown as Session,
    signal: new AbortController().signal,
    part: {} as ToolPart,
    stream: () => undefined,
    ask: async () => "",
  }
}

async function attempt(mode: AccessMode, tool: string, input: Record<string, unknown>, workspace = root) {
  const def = getTool(tool)
  if (!def) throw new Error(`missing tool ${tool}`)
  try {
    return { ok: true as const, result: await def.run(input, ctx(mode, workspace)) }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  console.log("--- safety.resolveInside 本身")
  check("工作区内正常", path.resolve(resolveInside(root, "inside.txt")), path.resolve(root, "inside.txt"))
  let escaped = ""
  try {
    resolveInside(root, outsideFile)
  } catch (error) {
    escaped = error instanceof Error ? error.message : String(error)
  }
  check("越界被拒", escaped.startsWith("Refusing"), true)
  check("错误信息指向开关", escaped.includes("完全访问"), true)
  console.log(`        ${escaped}`)
  check("allowOutside 时放行", path.resolve(resolveInside(root, outsideFile, true)), path.resolve(outsideFile))

  console.log("--- 默认（工作区模式）拒绝外部路径")
  const denied = await attempt("workspace", "read", { path: outsideFile })
  check("read 被拒", denied.ok, false)
  check("报错提示怎么放开", denied.ok === false && denied.message.includes("完全访问"), true)

  const deniedWrite = await attempt("workspace", "write", { path: path.join(outside, "x.txt"), content: "x" })
  check("write 被拒", deniedWrite.ok, false)
  check("没有偷偷建出文件", fs.existsSync(path.join(outside, "x.txt")), false)

  const deniedList = await attempt("workspace", "list", { path: outside })
  check("list 被拒", deniedList.ok, false)

  const deniedGrep = await attempt("workspace", "grep", { pattern: "内容", path: outside })
  check("grep 被拒", deniedGrep.ok, false)

  console.log("--- 工作区内的相对路径两种模式都能用")
  const insideWorkspace = await attempt("workspace", "read", { path: "inside.txt" })
  check("工作区模式可读", insideWorkspace.ok && insideWorkspace.result.output.includes("工作区内内容"), true)
  const insideFull = await attempt("full", "read", { path: "inside.txt" })
  check("完全访问也可读", insideFull.ok && insideFull.result.output.includes("工作区内内容"), true)

  console.log("--- 完全访问模式放行")
  const allowed = await attempt("full", "read", { path: outsideFile })
  check("read 成功", allowed.ok, true)
  check("读到外部内容", allowed.ok === true && allowed.result.output.includes("外部文件内容"), true)

  const target = path.join(outside, "created.txt")
  const written = await attempt("full", "write", { path: target, content: "写进去了\n" })
  check("write 成功", written.ok, true)
  check("文件真的建出来了", fs.existsSync(target), true)

  const edited = await attempt("full", "edit", { path: target, oldString: "写进去了", newString: "改过了" })
  check("edit 成功", edited.ok, true)
  check("内容已改", fs.readFileSync(target, "utf8").includes("改过了"), true)

  const listed = await attempt("full", "list", { path: outside, pattern: "*.txt" })
  check("list 成功", listed.ok, true)
  check("列出了外部文件", listed.ok === true && listed.result.output.includes("secret.txt"), true)

  const grepped = await attempt("full", "grep", { pattern: "外部文件", path: outside })
  check("grep 成功", grepped.ok, true)
  check("搜到了内容", grepped.ok === true && grepped.result.output.includes("secret.txt"), true)

  console.log("--- 密钥路径：不给模型，完全访问也不给")
  // settings.json 里是明文 apiKey。工作区就是这个仓库时（真发生过）它落在工作区内，
  // 所以「工作区受限」根本挡不住，必须单独拦。
  const dataDir = path.dirname(dataFile)
  const repoRoot = path.dirname(dataDir)

  const dataAbs = await attempt("full", "read", { path: path.join(dataDir, "settings.json") })
  check("绝对路径读 settings.json 被拒", dataAbs.ok, false)
  check("拒绝原因点明是密钥目录", dataAbs.ok === false && dataAbs.message.includes("数据目录"), true)

  const dataRel = await attempt("full", "read", { path: ".data/settings.json" }, repoRoot)
  check("工作区即本仓库时相对路径也被拒", dataRel.ok, false)

  const dataList = await attempt("full", "list", { path: ".data" }, repoRoot)
  check("list 进不去 .data", dataList.ok, false)

  const dataGrep = await attempt("full", "grep", { pattern: "apiKey", path: ".data" }, repoRoot)
  check("grep 进不去 .data", dataGrep.ok, false)

  const dataWrite = await attempt("full", "write", { path: ".data/pwned.json", content: "x" }, repoRoot)
  check("写 .data 也被拒", dataWrite.ok, false)
  check("没有真的写出文件", fs.existsSync(path.join(dataDir, "pwned.json")), false)

  // .data/skills 是用户写的指令内容，不是密钥库。skill 工具会把那个目录交给模型，
  // 让它用 read / bash 去看 references/ 和跑 scripts/ —— 所以它必须开着。
  console.log("--- .data/skills 是唯一豁免（否则个人 skill 的附带文件读不了）")
  const inSkills = (...parts: string[]) => path.join(dataDir, "skills", ...parts)
  check("skill 目录本身放行", secretReason(inSkills()), null)
  check("skill 正文放行", secretReason(inSkills("my-skill", "SKILL.md")), null)
  check("skill 里的 references 放行", secretReason(inSkills("my-skill", "references", "api.md")), null)
  check("但 settings.json 仍被拒", secretReason(path.join(dataDir, "settings.json")) !== null, true)
  check("providers.json 仍被拒", secretReason(path.join(dataDir, "providers.json")) !== null, true)
  check("mcp.json 仍被拒", secretReason(path.join(dataDir, "mcp.json")) !== null, true)
  check("sessions 目录仍被拒", secretReason(path.join(dataDir, "sessions", "x.json")) !== null, true)
  check(".data 根目录本身仍被拒", secretReason(dataDir) !== null, true)

  console.log("--- .env：读不行，写可以")
  const envRead = await attempt("full", "read", { path: ".env" })
  check("读 .env 被拒（完全访问也不放开）", envRead.ok, false)
  check("拒绝原因点明是环境变量文件", envRead.ok === false && envRead.message.includes("环境变量"), true)

  const envDodge = await attempt("full", "read", { path: "sub/../.env" })
  check("换个路径写法绕不过（先归一化再判断）", envDodge.ok, false)

  const envUpper = await attempt("full", "read", { path: ".ENV" })
  check("大小写也绕不过", envUpper.ok, false)

  const envExample = await attempt("full", "read", { path: ".env.example" })
  check(".env.example 是模板，可以读", envExample.ok, true)

  const envWrite = await attempt("full", "write", { path: ".env.local", content: "A=1\n" })
  check("写一份新的 .env 是正常设置步骤，放行", envWrite.ok, true)

  console.log("--- 预览（review 席唯一的文件内容通道）也要拦")
  let previewBlocked = ""
  try {
    await previewFile(repoRoot, ".data/settings.json")
  } catch (error) {
    previewBlocked = error instanceof Error ? error.message : String(error)
  }
  check("预览 .data 被拒", previewBlocked.includes("不提供预览"), true)
  check("普通文件仍然可以预览", (await previewFile(root, "inside.txt")).text.includes("工作区内内容"), true)

  console.log("--- 检索不会把密钥带出来（钉住：谁把 dot 打开谁就红）")
  // 两个后端默认都跳过点文件/点目录（fast-glob 的 dot 默认 false，rg 也要 --hidden 才搜隐藏项），
  // 所以 .env / .data 的内容不会出现在命中里。这条断言就是那个行为的下限。
  const leakGrep = await attempt("full", "grep", { pattern: "sk-secret-abcdef" })
  check("grep 搜不到 .env 里的值", leakGrep.ok === true && leakGrep.result.output.includes("sk-secret-abcdef"), false)
  const visibleGrep = await attempt("full", "grep", { pattern: "工作区内内容" })
  check("普通文件照样搜得到", visibleGrep.ok === true && visibleGrep.result.output.includes("工作区内内容"), true)

  console.log("--- system prompt 会告知当前范围")
  const restricted = buildSystemPrompt({ memory: [], workspace: root, accessMode: "workspace" })
  check("受限模式写明限制", restricted.includes("工作区受限"), true)
  check("受限模式给了出路", restricted.includes("完全访问"), true)
  const full = buildSystemPrompt({ memory: [], workspace: root, accessMode: "full" })
  check("完全访问模式明确说明", full.includes("完全访问已开启"), true)
  check("两种模式的提示不同", restricted !== full, true)

  console.log("--- 未指定时默认受限")
  const fallback = buildSystemPrompt({ memory: [], workspace: root })
  check("默认是工作区受限", fallback.includes("工作区受限"), true)

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })

  console.log("--- safeRelativePath：拖来的相对路径必须逐段清洗")
  // 拖文件夹进来时每个文件都带一段相对路径，任何一段都可能被构造
  check("普通相对路径原样保留", safeRelativePath("proj/src/a.ts"), "proj/src/a.ts")
  check("反斜杠归一化", safeRelativePath("proj\\src\\a.ts"), "proj/src/a.ts")
  check("开头的斜杠被吃掉", safeRelativePath("/etc/passwd"), "etc/passwd")
  check("盘符被毁掉", safeRelativePath("C:/Windows/x"), "C_/Windows/x")
  check("中间的 .. 被丢掉", safeRelativePath("a/../../b.txt"), "a/b.txt")
  check("整段都是 .. 时返回空", safeRelativePath("../.."), "")
  check("单点被丢掉", safeRelativePath("./a/./b"), "a/b")
  check("空的返回空", safeRelativePath("   "), "")
  check("每段都去非法字符", safeRelativePath("a b/<c>?.txt"), "a b/_c__.txt")

  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
