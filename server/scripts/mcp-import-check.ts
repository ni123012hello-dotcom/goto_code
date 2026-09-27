import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { dataFile } from "../src/config"
import {
  discoverMcpServers,
  importMcpServers,
  joinSplitPaths,
  splitCommandString,
  stripJsonComments,
} from "../src/mcp-import"
import { listMcpServers, mcpFilePath, runnableMcpServers, upsertMcpServer } from "../src/mcp"

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

// the real store must survive the run
const storePath = mcpFilePath()
const backup = fs.existsSync(storePath) ? fs.readFileSync(storePath, "utf8") : null
// start from an empty store so the run does not depend on what the real one happens to hold
fs.rmSync(storePath, { force: true })

// a throwaway HOME, so no real agent config is ever read or written
const home = fs.mkdtempSync(path.join(os.tmpdir(), "goto-home-"))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "goto-ws-"))

// a real file whose name contains a space, for the path-join signal
fs.mkdirSync(path.join(workspace, "my app"), { recursive: true })
fs.writeFileSync(path.join(workspace, "my app", "server.js"), "// nope", "utf8")

function write(relative: string, content: string): void {
  const file = path.join(home, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf8")
}

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try {
    if (backup === null) fs.rmSync(storePath, { force: true })
    else fs.writeFileSync(storePath, backup, "utf8")
  } catch {
    // nothing useful to do while exiting
  }
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
}
process.on("exit", cleanup)

process.env.GOTO_TEST_TOKEN = "t0ken-from-env"

// opencode: array command, remote, a string command with an unquoted spaced path, and {env:}
write(
  ".config/opencode/opencode.json",
  JSON.stringify({
    mcp: {
      "oc-array": { type: "local", command: ["uvx", "blender-mcp"], enabled: true, environment: { HOST: "localhost" } },
      "oc-string": { type: "local", command: "node C:/prog folder/index.js", enabled: true, environment: {} },
      "oc-parenthesis": {
        type: "local",
        command: "node C:/Users/x/新建文件夹 (5)/apps/mcp/src/index.ts",
        enabled: true,
      },
      "oc-envref": { type: "local", command: ["node", "x.js"], environment: { TOKEN: "{env:GOTO_TEST_TOKEN}" } },
      "oc-remote": { type: "remote", url: "https://localhost:3000/bb-mcp", enabled: true },
      "oc-off": { type: "local", command: ["node", "off.js"], enabled: false },
    },
  }),
)

// opencode.jsonc with comments, to prove the stripper works
write(
  ".config/opencode/opencode.jsonc",
  `{
  // this one is enabled
  "mcp": {
    "oc-jsonc": { "type": "local", "command": ["node", "jsonc.js"], "enabled": true }
  }
}`,
)

// the shape Claude Desktop / Claude Code / Cursor share
write(
  ".claude.json",
  JSON.stringify({
    mcpServers: {
      "claude-ok": { command: "npx", args: ["-y", "some-server"], env: { KEY: "value" } },
      "claude-disabled": { command: "node", args: ["x.js"], disabled: true },
      "claude-remote": { url: "https://example.com/mcp" },
    },
  }),
)

// VS Code
write(
  ".vscode/mcp.json",
  JSON.stringify({
    servers: {
      "code-stdio": { type: "stdio", command: "node", args: ["code.js"] },
      "code-http": { type: "http", url: "https://example.com/mcp" },
    },
  }),
)

// a broken file must not stop the others, and must not look like "nothing here"
write(".cursor/mcp.json", "{ this is not json")

console.log("--- 切分与合并（只有字符串形式的命令才需要）")
check("引号内的空格保持完整", splitCommandString('node "C:/prog files/a.js"'), ["node", "C:/prog files/a.js"])
check("单引号同样", splitCommandString("node 'a b.js'"), ["node", "a b.js"])
check("普通空格切分", splitCommandString("uvx blender-mcp"), ["uvx", "blender-mcp"])
check("没有引号但路径存在 → 合并", joinSplitPaths(["node", path.join(workspace, "my"), "app/server.js"]), [
  "node",
  `${path.join(workspace, "my")} app/server.js`,
])
check("括号开头 → 合并（Windows 的「文件夹 (2)」惯例）", joinSplitPaths(["node", "C:/x/新建文件夹", "(5)/a.js"]), [
  "node",
  "C:/x/新建文件夹 (5)/a.js",
])
check(
  "本来就是完整路径就不动它",
  joinSplitPaths(["node", path.join(workspace, "my app", "server.js")]),
  ["node", path.join(workspace, "my app", "server.js")],
)

console.log("--- JSONC 注释")
check("行注释被去掉", stripJsonComments('{"a": 1} // tail').includes("tail"), false)
check("块注释被去掉", stripJsonComments('{"a": /* x */ 1}').includes("x"), false)
check("字符串里的 // 保留", stripJsonComments('{"a": "http://x"}').includes("http://x"), true)

console.log("--- 发现")
const found = discoverMcpServers({ home, workspace })
const byName = (name: string) => found.find((entry) => entry.name === name)

check("数组命令原样读入", byName("oc-array")?.command, "uvx")
check("数组命令的其余部分是 args", byName("oc-array")?.args, ["blender-mcp"])
check("环境变量带过来", byName("oc-array")?.env, { HOST: "localhost" })
check("来源文件被记下", byName("oc-array")?.from.endsWith("opencode.json"), true)
check("来源类型被记下", byName("oc-array")?.kind, "opencode")

check("remote 被列出来但标为不可导入", String(byName("oc-remote")?.problem).includes("stdio"), true)
check("remote 不会伪装成可导入", byName("oc-remote")?.imported, false)

check("{env:VAR} 被展开", byName("oc-envref")?.env.TOKEN, "t0ken-from-env")
check("enabled:false 带过来", byName("oc-off")?.enabled, false)

check("jsonc 注释里的配置也能读到", byName("oc-jsonc")?.command, "node")

check("Claude 形态能读", byName("claude-ok")?.args, ["-y", "some-server"])
check("Claude 的 disabled:true 变成 enabled:false", byName("claude-disabled")?.enabled, false)
check("Claude 的 url 条目标为不可导入", String(byName("claude-remote")?.problem).includes("stdio"), true)

check("VS Code stdio 能读", byName("code-stdio")?.command, "node")
check("VS Code http 标为不可导入", String(byName("code-http")?.problem).includes("stdio"), true)

check("带空格的字符串命令被合并回来", byName("oc-parenthesis")?.args, ["C:/Users/x/新建文件夹 (5)/apps/mcp/src/index.ts"])
check("字符串命令会记下原文", byName("oc-parenthesis")?.splitFrom?.startsWith("node C:/Users/x"), true)
check("切不对的会给出警告", (byName("oc-string")?.warnings.length ?? 0) > 0, true)

console.log("--- 导入：绝不自动获得信任")
fs.rmSync(storePath, { force: true })
const result = importMcpServers({ home, workspace })
check("导入成功的是那些 stdio 的", result.imported.includes("oc-array"), true)
check("remote 被跳过并说明原因", result.skipped.some((s) => s.name === "oc-remote"), true)

const imported = listMcpServers().find((server) => server.id === "oc-array")
check("落盘了", Boolean(imported), true)
check("命令拼装正确", [imported?.command, ...(imported?.args ?? [])], ["uvx", "blender-mcp"])
check("**未受信任**", imported?.trusted, false)
check("**不会跑**", runnableMcpServers().length, 0)
check("可以关闭的仍然关闭", listMcpServers().find((s) => s.id === "oc-off")?.enabled, false)

console.log("--- 幂等：重复导入不产生重复条目")
const before = listMcpServers().length
importMcpServers({ home, workspace })
check("条数不变", listMcpServers().length, before)

console.log("--- 重复导入不会撤掉已有的确认")
const target = listMcpServers().find((server) => server.id === "oc-array")
upsertMcpServer({
  id: "oc-array",
  command: target!.command,
  args: target!.args,
  acknowledge: true,
})
check("先人工确认", listMcpServers().find((s) => s.id === "oc-array")?.trusted, true)
importMcpServers({ home, workspace })
check("再导入一次，确认还在", listMcpServers().find((s) => s.id === "oc-array")?.trusted, true)

console.log("--- 只导入指定的几个")
fs.rmSync(storePath, { force: true })
const selected = importMcpServers({ home, workspace, names: ["claude-ok"] })
check("只导入了那一个", selected.imported, ["claude-ok"])
check("别的没进来", listMcpServers().map((s) => s.id), ["claude-ok"])

cleanup()
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
