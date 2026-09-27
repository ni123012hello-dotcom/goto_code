import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { config, dataFile } from "../src/config"
import {
  MAX_TOOL_NAME,
  MCP_TOOL_PREFIX,
  definitionFingerprint,
  deleteMcpServer,
  isMcpTool,
  listMcpServers,
  mcpFilePath,
  mcpToolName,
  needsTrustMcpServers,
  publicMcpServers,
  runnableMcpServers,
  upsertMcpServer,
} from "../src/mcp"
import { requiresApproval } from "../src/permissions"
import { maskKey } from "../src/settings"

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

function catches(label: string, fn: () => unknown, needle: string) {
  let message = ""
  try {
    fn()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(label, message.includes(needle), true)
}

// .data/ persists across runs: every name this test writes carries a unique tag
const TAG = `mcpcheck-${Date.now().toString(36)}`
const SECRET = `s3cr3t-${TAG}`

// the real store must survive the run. mcp.ts reads from disk on every call (no cache), so
// putting the original bytes back is enough.
const storePath = mcpFilePath()
const backup = fs.existsSync(storePath) ? fs.readFileSync(storePath, "utf8") : null

let restored = false
function restore() {
  if (restored) return
  restored = true
  try {
    if (backup === null) fs.rmSync(storePath, { force: true })
    else fs.writeFileSync(storePath, backup, "utf8")
  } catch {
    // nothing useful to do while exiting
  }
}
// a crash mid-test must not leave test servers behind
process.on("exit", restore)

function reset(): void {
  fs.rmSync(storePath, { force: true })
}

console.log("--- 存储位置与空状态")
check("配置就在 settings.json 旁边", storePath, path.join(path.dirname(dataFile), "mcp.json"))
reset()
check("文件不存在时返回空列表", listMcpServers(), [])

console.log("--- 新增的 server 一律 fail-closed")
const alpha = upsertMcpServer({
  name: `${TAG} alpha`,
  command: "node",
  args: ["server.js", "--flag", 42, null],
})
check("id 由名字推导", alpha.id.startsWith(TAG), true)
check("id 符合工具名约束", /^[a-z0-9][a-z0-9-]{0,31}$/.test(alpha.id), true)
check("默认不启用", alpha.enabled, false)
check("默认未确认", alpha.trusted, false)
check("args 只保留字符串", alpha.args, ["server.js", "--flag"])
check("文件已落盘", fs.existsSync(storePath), true)
check("读回与写入一致", listMcpServers()[0].id, alpha.id)
check("没有 runnable 的 server", runnableMcpServers().length, 0)

console.log("--- 启用 != 批准：不开 acknowledge 只是「待确认」，跑不起来")
const enabledOnly = upsertMcpServer({ id: alpha.id, enabled: true })
check("可以标记为启用", enabledOnly.enabled, true)
check("但拿不到信任", enabledOnly.trusted, false)
check("标成待确认", enabledOnly.needsTrust, true)
check("而且真的不会跑", runnableMcpServers().length, 0)

const confirmed = upsertMcpServer({ id: alpha.id, enabled: true, acknowledge: true })
check("确认后启用", confirmed.enabled, true)
check("确认后受信任", confirmed.trusted, true)
check("不再需要确认", confirmed.needsTrust, false)
check("进入 runnable", runnableMcpServers().map((s) => s.id), [alpha.id])

console.log("--- 确认时不批准「明知跑不通」的命令")
// 批准一条指向不存在路径的命令，等于批准一个不可能运行的东西。发现阶段是 warning，
// 到了「确认」这一下（唯一有人在看命令行的时刻）就变成一道闸。
const phantom = upsertMcpServer({
  id: `${TAG}-phantom`,
  name: `${TAG} phantom`,
  command: path.join(os.tmpdir(), "goto-missing-dir", "server.js"),
  enabled: true,
})
check("可以建，但未受信任", phantom.trusted, false)
check("也标出了原因", phantom.enabled, true)
catches(
  "确认缺路径的命令会被拒",
  () => upsertMcpServer({ id: phantom.id, acknowledge: true, enabled: true }),
  "refusing to confirm",
)
check("被拒后仍未受信任", listMcpServers().find((s) => s.id === phantom.id)?.trusted, false)

const forced = upsertMcpServer({ id: phantom.id, acknowledge: true, enabled: true, force: true })
check("force 可以越过这道闸（是减速带不是墙）", forced.trusted, true)

catches(
  "env 里的路径不存在同样会拦",
  () =>
    upsertMcpServer({
      id: `${TAG}-envenv`,
      name: `${TAG} envenv`,
      command: "node",
      env: { CONFIG_PATH: path.join(os.tmpdir(), "goto-missing-config.json") },
      acknowledge: true,
      enabled: true,
    }),
  "missing path",
)

// the block above leaves a trusted+enabled server behind; later assertions count runnable
// servers, so it has to go
deleteMcpServer(phantom.id)
check("清理掉这个测试 server", listMcpServers().some((s) => s.id === phantom.id), false)

console.log("--- 关掉不丢信任，改定义才丢")
const off = upsertMcpServer({ id: alpha.id, enabled: false })
check("可以停用", off.enabled, false)
check("停用后仍然受信任", off.trusted, true)
check("停用后不 runnable", runnableMcpServers().length, 0)

upsertMcpServer({ id: alpha.id, enabled: true })
check("重新启用不需要再确认", listMcpServers()[0].enabled, true)

const reEnv = upsertMcpServer({ id: alpha.id, env: { TOKEN: SECRET } })
check("换 token 不影响信任（会轮换）", reEnv.trusted, true)

const moved = upsertMcpServer({ id: alpha.id, args: ["other.js"] })
check("改 args 会撤掉信任", moved.trusted, false)
check("并且标记为待确认", moved.needsTrust, true)
check("改完就不 runnable 了", runnableMcpServers().length, 0)

upsertMcpServer({ id: alpha.id, args: ["server.js", "--flag"], acknowledge: true })
check("重新确认后恢复", runnableMcpServers().map((s) => s.id), [alpha.id])

const retargeted = upsertMcpServer({ id: alpha.id, command: "node2" })
check("改 command 同样撤掉信任", retargeted.trusted, false)

upsertMcpServer({ id: alpha.id, acknowledge: true })
const relocated = upsertMcpServer({ id: alpha.id, cwd: "/tmp" })
check("改 cwd 也撤掉信任", relocated.trusted, false)

console.log("--- 一个有确认记录的 server 改定义：不抛错，但立刻停跑")
const before = upsertMcpServer({ id: alpha.id, enabled: true, acknowledge: true })
check("先确认并启用", before.trusted && before.enabled, true)
const edited = upsertMcpServer({ id: alpha.id, command: "node3", enabled: true })
check("改定义不报错", edited.command, "node3")
check("但信任被撤回", edited.trusted, false)
check("仍然标成待确认", edited.needsTrust, true)
check("而且已经不在 runnable 里", runnableMcpServers().length, 0)

console.log("--- 指纹：确定性 + 换行参不歧义")
check(
  "同样的定义给同样的指纹",
  definitionFingerprint("node", ["a", "b"], "/x"),
  definitionFingerprint("node", ["a", "b"], "/x"),
)
check(
  "参数边界不会撞车",
  definitionFingerprint("node", ["a b"], "/x") === definitionFingerprint("node", ["a", "b"], "/x"),
  false,
)

console.log("--- 手改文件不能自我授权")
reset()
const trustedFor = definitionFingerprint("node", ["evil.js"], "")
fs.writeFileSync(
  storePath,
  JSON.stringify({
    servers: [
      // claims to be trusted, but the record of what was confirmed is missing
      { id: "a1", command: "node", args: ["evil.js"], enabled: true, trusted: true },
      // trusted with a fingerprint that does not match what is written next to it
      { id: "a2", command: "node", args: ["evil.js"], enabled: true, trusted: true, fingerprint: "deadbeef" },
      // a genuine record
      { id: "a3", command: "node", args: ["evil.js"], enabled: true, trusted: true, fingerprint: trustedFor },
    ],
  }),
  "utf8",
)
const handRolled = listMcpServers()
check("没有指纹的 trusted:true 不算数", handRolled.find((s) => s.id === "a1")?.trusted, false)
check("指纹对不上的不算数", handRolled.find((s) => s.id === "a2")?.trusted, false)
check("指纹对得上的才算", handRolled.find((s) => s.id === "a3")?.trusted, true)
check("只有那一个能跑", runnableMcpServers().map((s) => s.id), ["a3"])
check("另外两个进入待确认", needsTrustMcpServers().map((s) => s.id).sort(), ["a1", "a2"])

console.log("--- 显式 id / 非法 id")
reset()
const beta = upsertMcpServer({ id: `${TAG}-beta`, name: "beta", command: "node", enabled: true, acknowledge: true })
check("合法 id 被采用", beta.id, `${TAG}-beta`)

const gamma = upsertMcpServer({ id: "Bad_ID", name: `${TAG} gamma`, command: "node" })
check("非法 id 不落盘成原名", gamma.id === "Bad_ID", false)
check("非法 id 被推导成合法的", /^[a-z0-9][a-z0-9-]{0,31}$/.test(gamma.id), true)

catches("缺 command 会被拒绝", () => upsertMcpServer({ name: "no command" }), "command is required")

console.log("--- env：空值 = 保持原值（和 apiKey 同一条规则）")
const withSecret = upsertMcpServer({ id: beta.id, env: { TOKEN: SECRET, PLAIN: "not-a-secret" } })
check("首次写入存下来", withSecret.env.TOKEN, maskKey(SECRET))
const kept = upsertMcpServer({ id: beta.id, env: { TOKEN: "" } })
check("空值不清空原值", listMcpServers().find((s) => s.id === beta.id)?.env.TOKEN, SECRET)
check("空值也不新增空变量", Object.hasOwn(kept.env, "TOKEN"), true)

console.log("--- 下发到浏览器的永远是掩码")
const serialized = JSON.stringify(publicMcpServers())
check("原始密钥不出现在响应里", serialized.includes(SECRET), false)
check("但变量名和掩码在", serialized.includes("TOKEN"), true)

console.log("--- 坏文件要能自愈（旧文件/手改）")
reset()
fs.writeFileSync(
  storePath,
  JSON.stringify({
    servers: [
      { id: "BAD ID", name: `${TAG} repaired`, command: "node" },
      { name: "no command at all" },
      { command: "node", args: ["ok", 7, null], env: { A: "x", B: 3 }, enabled: "yes" },
      "garbage",
    ],
  }),
  "utf8",
)
const healed = listMcpServers()
check("丢掉没有 command 的条目", healed.length, 2)
check("非法 id 被修好", healed.every((s) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(s.id)), true)
check("args 里的非字符串被清掉", healed.find((s) => s.command === "node" && s.args.length === 1)?.args, ["ok"])
check("env 只保留字符串值", healed.find((s) => s.env.A === "x")?.env, { A: "x" })
check("enabled 非布尔按不启用处理", healed.find((s) => s.env.A === "x")?.enabled, false)
check("手改的条目一律未受信任", healed.every((s) => !s.trusted), true)

console.log("--- 删除")
reset()
const doomed = upsertMcpServer({ name: `${TAG} doomed`, command: "node" })
check("删除成功", deleteMcpServer(doomed.id), true)
check("删完就没了", listMcpServers().length, 0)
check("删不存在的返回 false", deleteMcpServer(doomed.id), false)

console.log("--- 工具命名")
check("前缀常量", MCP_TOOL_PREFIX, "mcp__")
check("命名规则 mcp__<server>__<tool>", mcpToolName("github", "list_issues"), "mcp__github__list_issues")
check("刚好 64 字符可以通过", mcpToolName("a".repeat(32), "b".repeat(25)).length, MAX_TOOL_NAME)
catches("65 字符会抛错", () => mcpToolName("a".repeat(32), "b".repeat(26)), "exceeds")

check("识别 MCP 工具名", isMcpTool("mcp__github__list_issues"), true)
check("别的不误判：mcp", isMcpTool("mcp"), false)
check("别的不误判：mcpfoo", isMcpTool("mcpfoo"), false)
check("别的不误判：只有前缀", isMcpTool("mcp__"), false)
check("别的不误判：内置工具", isMcpTool("bash"), false)
check("大小写敏感（MCP__ 不算）", isMcpTool("MCP__github__x"), false)

console.log("--- 权限模型：MCP 的批准在 server 级，不在每次调用")
check("bash 仍要被批准（无回归）", requiresApproval("bash"), true)
check("没进名单的普通工具不弹窗", requiresApproval(`${TAG}-internal-tool`), false)
// MCP 工具不逐次弹窗是刻意的：批准发生在 server 级、并且被指纹钉死在一条具体命令行上。
// 一个「定义改过」的 server 根本进不了 runnable，所以不存在未批准的 MCP 工具能走到这里。
check("MCP 工具不在这里逐次弹窗", requiresApproval("mcp__github__list_issues"), false)
check("它没有偷偷进 PERMISSION_TOOLS", config.permissionTools.includes("mcp__github__list_issues"), false)

restore()
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
