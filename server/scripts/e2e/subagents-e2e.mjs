// 端到端：多智能体。
//   1. agent 调 spawn_agents → 弹出请求（不直接创建，必须先问用户）
//   2. 允许后创建子会话，父子关系、任务、独立对话都对
//   3. 子智能体各自跑一轮，摘要回到主对话
//   4. 拒绝时什么都不创建
//   5. 上限校验、级联删除
import { spawn } from "node:child_process"
import http from "node:http"
import path from "node:path"
import { ENTRY, resolveTsx, ROOT } from "./harness.mjs"

const TSX = resolveTsx()
const BASE = "http://127.0.0.1:8792"
const FAKE_PORT = 9930

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`)
}

const seen = []
const fake = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* ignore */
    }
    const messages = parsed.messages ?? []
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    const text = typeof lastUser?.content === "string" ? lastUser.content : ""
    seen.push(text.slice(0, 40))

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const chunk = (delta, extra = {}) =>
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, ...extra }] })}\n\n`)

    // 按【最后一条】消息判断阶段。"请求里出现过 tool 消息"是错的：第一轮之后它就永远为真，
    // 于是第二次 prompt 会被当成"工具刚返回"，永远不会再发起 spawn。
    const last = messages[messages.length - 1]
    const lastIsToolResult = last?.role === "tool"
    if (lastIsToolResult) {
      // 工具结果回来了 → 主 agent 收尾
      chunk({ role: "assistant", content: "汇总完成。" })
    } else if (text.includes("开始多智能体")) {
      // 主 agent 的第一次调用 → 要求开两个子智能体
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_spawn_1", type: "function", function: { name: "spawn_agents", arguments: "" } }],
      })
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: JSON.stringify({ tasks: ["把 A 做完，产出一个文件", "把 B 查清楚，给出结论"] }) },
          },
        ],
      })
      chunk({}, { finish_reason: "tool_calls" })
    } else if (text.includes("把 A 做完")) {
      // 子智能体也拿到了 spawn_agents 工具，但它必须被拒绝 —— 否则就是无限递归
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_nested", type: "function", function: { name: "spawn_agents", arguments: "" } }],
      })
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ tasks: ["孙任务"] }) } }] })
      chunk({}, { finish_reason: "tool_calls" })
    } else if (text.includes("把 B 查清楚") && !lastIsToolResult) {
      // 子智能体 B 要跑一条命令 —— 这会触发权限弹窗
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: "bash", arguments: "" } }],
      })
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "echo subagent-ran" }) } }] })
      chunk({}, { finish_reason: "tool_calls" })
    } else {
      // 子智能体的一轮
      chunk({ role: "assistant", content: `完成：${text.slice(0, 20)}` })
    }
    chunk({}, { finish_reason: "stop" })
    res.write("data: [DONE]\n\n")
    res.end()
  })
})

const server = spawn(process.execPath, [TSX, ENTRY], {
  cwd: path.join(ROOT, "server"),
  env: { ...process.env, PORT: "8792" },
  stdio: ["ignore", "pipe", "pipe"],
})
let log = ""
server.stdout.on("data", (c) => (log += c))
server.stderr.on("data", (c) => (log += c))

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

function sse(sessionID) {
  const events = []
  const controller = new AbortController()
  void fetch(`${BASE}/api/sessions/${sessionID}/events`, { signal: controller.signal })
    .then(async (res) => {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const line = block.split("\n").find((l) => l.startsWith("data:"))
          if (!line) continue
          try {
            events.push(JSON.parse(line.slice(5).trim()))
          } catch {
            /* keep-alive */
          }
        }
      }
    })
    .catch(() => undefined)
  return { events, close: () => controller.abort() }
}

async function waitIdle(id) {
  for (let i = 0; i < 120; i += 1) {
    await sleep(250)
    const list = await api("GET", "/api/sessions")
    if (list.body.find((s) => s.id === id)?.running === false) return true
  }
  return false
}

let original = null
let parentID = null

async function main() {
  await new Promise((r) => fake.listen(FAKE_PORT, r))
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    try { if ((await fetch(`${BASE}/api/sessions`)).ok) break } catch {}
  }

  original = (await api("GET", "/api/settings")).body

  // 跑真实回合需要 key，而接口不返回原文，脚本没有能力还原一个被自己覆盖的 key。
  // 所以：没有 key 就跳过，绝不往配置里写一个假的。
  if (!original.hasApiKey) {
    console.log("SKIP  这个实例还没配 apiKey，而本脚本会跑真实回合。先配一个 key 再跑。")
    server.kill()
    fake.close()
    process.exit(0)
  }
  check("设置里暴露了上限", original.max, 5)
  await api("PUT", "/api/settings", { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, model: "fake" })

  const folderID = (await api("GET", "/api/folders")).body[0].id
  parentID = (await api("POST", "/api/sessions", { folderID })).body.id
  const stream = sse(parentID)
  await sleep(600)

  console.log("--- 拒绝：什么都不该被创建")
  await api("POST", `/api/sessions/${parentID}/prompt`, { text: "开始多智能体（拒绝版）" })
  let request = null
  for (let i = 0; i < 40 && !request; i += 1) {
    await sleep(250)
    request = stream.events.find((e) => e.type === "spawn.request")
  }
  check("弹出了生成请求", Boolean(request), true)
  check("请求里带了两个任务", request?.request?.tasks?.length, 2)
  await api("POST", `/api/spawns/${request.request.id}`, { allowed: false })
  await waitIdle(parentID)

  let all = (await api("GET", "/api/sessions")).body
  check("拒绝后没有子会话", all.filter((s) => s.parentID === parentID).length, 0)
  check("主 agent 收到了「被取消」", JSON.stringify((await api("GET", `/api/sessions/${parentID}`)).body).includes("cancelled"), true)

  console.log("--- 允许：创建并跑完两个子智能体")
  stream.events.length = 0
  await api("POST", `/api/sessions/${parentID}/prompt`, { text: "开始多智能体（允许版）" })
  request = null
  for (let i = 0; i < 40 && !request; i += 1) {
    await sleep(250)
    request = stream.events.find((e) => e.type === "spawn.request")
  }
  check("再次弹出生成请求", Boolean(request), true)
  check("建议串行", request?.request?.parallel, false)
  const allowed = await api("POST", `/api/spawns/${request.request.id}`, { allowed: true, parallel: false })
  check("允许返回 200", allowed.status, 200)

  // 子智能体 B 会调 bash，而权限弹窗只订阅了活动会话 —— 请求必须被转发到【主对话】的流上，
  // 否则它会白等 5 分钟超时然后失败（这是修过的一个真 bug）
  let permission = null
  for (let i = 0; i < 60 && !permission; i += 1) {
    await sleep(250)
    permission = stream.events.find((e) => e.type === "permission.request")
  }
  check("子智能体的权限请求出现在主对话的流上", Boolean(permission), true)
  check("并且标明了是哪个子智能体在问", String(permission?.request?.title ?? "").includes("子智能体"), true)
  if (permission) {
    const answered = await api("POST", `/api/permissions/${permission.request.id}`, { response: "once" })
    check("批准返回 200", answered.status, 200)
  }

  check("主对话跑完了", await waitIdle(parentID), true)

  all = (await api("GET", "/api/sessions")).body
  const kids = all.filter((s) => s.parentID === parentID)
  check("创建了两个子智能体", kids.length, 2)
  check("带上了任务", kids.map((s) => s.task).sort(), ["把 A 做完，产出一个文件", "把 B 查清楚，给出结论"].sort())
  check("子智能体不出现在顶层（有 parentID）", all.filter((s) => !s.parentID).some((s) => kids.some((k) => k.id === s.id)), false)

  for (const kid of kids) {
    const detail = (await api("GET", `/api/sessions/${kid.id}`)).body
    const assistant = detail.messages.filter((m) => m.role === "assistant")
    check(`子智能体 ${kid.task?.slice(0, 4)} 有独立对话`, assistant.length > 0, true)
    // A 被要求去开孙智能体（应该被拒），B 调了 bash（应该真的执行）
    const expect = kid.task?.includes("把 A") ? "不能再开子智能体" : "subagent-ran"
    check(`  └ 内容符合预期`, JSON.stringify(assistant).includes(expect), true)
  }

  const parentDetail = JSON.stringify((await api("GET", `/api/sessions/${parentID}`)).body)
  check("摘要回到了主对话（任务 A）", parentDetail.includes("把 A 做完"), true)
  check("摘要回到了主对话（任务 B）", parentDetail.includes("把 B 查清楚"), true)
  check("主 agent 收尾了", parentDetail.includes("汇总完成"), true)
  check("推了 subagents.changed", stream.events.filter((e) => e.type === "subagents.changed").length > 0, true)

  console.log("--- 只允许一层：子智能体不能再开子智能体")
  const kidA = kids.find((s) => s.task?.includes("把 A"));
  const nested = (await api("GET", `/api/sessions/${kidA.id}`)).body;
  check("嵌套调用被拒绝", JSON.stringify(nested).includes("不能再开子智能体"), true);
  check("没有出现孙会话", all.filter((s) => s.parentID === kidA.id).length, 0);

  console.log("--- 级联删除")
  await api("DELETE", `/api/sessions/${parentID}`)
  all = (await api("GET", "/api/sessions")).body
  check("父会话没了", all.some((s) => s.id === parentID), false)
  check("子会话也没了", kids.some((k) => all.some((s) => s.id === k.id)), false)
  parentID = null

  console.log("--- 边界")
  check("未知 spawn id → 404", (await api("POST", "/api/spawns/nope", { allowed: true })).status, 404)

  stream.close()
}

main()
  .catch((e) => { failures += 1; console.log(`FAIL 异常: ${e.stack}`); console.log(log.split("\n").slice(-14).join("\n")) })
  .finally(async () => {
    if (parentID) await api("DELETE", `/api/sessions/${parentID}`).catch(() => undefined)
    if (original) await api("PUT", "/api/settings", { baseURL: original.baseURL, model: original.model }).catch(() => undefined)
    server.kill()
    fake.close()
    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
    process.exit(failures === 0 ? 0 : 1)
  })
