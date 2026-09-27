import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type OpenAI from "openai"
import type { Message, ToolPart } from "../../shared/protocol"
import { config } from "../src/config"
import { getTool, MAX_OUTPUT } from "../src/agent/tools"
import { compactIfNeeded, lastUsage, prune, projectedTokens, select, supersedeReads } from "../src/agent/compact"
import { createSession, deleteSession, newMessage, newTextPart, type Session } from "../src/sessions"
import {
  COMPACTION_BUFFER,
  isOverflow,
  limitsFromConfig,
  preserveRecentBudget,
  usable,
  usageCount,
  type Limits,
} from "../src/agent/overflow"

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

function usage(input: number, output = 0) {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

console.log(`环境: context=${config.contextWindow} maxOutput=${config.maxOutputTokens} ` +
  `inputLimit=${config.contextInputLimit} reserved=${config.compactionReserved}`)

console.log("--- 预算必须真的把 buffer 留出来")
const limits = limitsFromConfig()
check("预算 = context - COMPACTION_BUFFER", usable(limits), config.contextWindow - COMPACTION_BUFFER)
check("buffer 是 20000", COMPACTION_BUFFER, 20_000)
check("不再是 context - maxOutput 那种几乎没有余量的算法",
  usable(limits) < config.contextWindow - config.maxOutputTokens, true)
check("至少留出 20k 余量", config.contextWindow - usable(limits) >= 20_000, true)

console.log("--- 用户显式声明 inputLimit 时按声明的算")
const declared: Limits = { context: config.contextWindow, inputLimit: 100_000, maxOutputTokens: 4096, reserved: 4096 }
check("usable = inputLimit - reserved", usable(declared), 95_904)

console.log("--- isOverflow 边界")
check("刚好到预算就算溢出", isOverflow({ tokens: usage(usable(limits)), limits, auto: true }), true)
check("差 1 不算", isOverflow({ tokens: usage(usable(limits) - 1), limits, auto: true }), false)
check("auto=false 时永不溢出", isOverflow({ tokens: usage(10_000_000), limits, auto: false }), false)

console.log("--- usageCount 的取值顺序")
check("优先用 total", usageCount({ total: 999, input: 1, output: 1, reasoning: 0, cache: { read: 1, write: 1 } }), 999)
check("没有 total 就求和", usageCount({ input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }), 19)

console.log("--- 保留尾巴的预算")
// clamp(usable * 0.25, 2000, 15000) -> 15000 for a 108k budget
check("默认是 usable 的 25%，且被夹在 2000..15000", preserveRecentBudget(limits), 15_000)
check("可以显式指定", preserveRecentBudget(limits, 4_321), 4_321)

console.log("--- select 只保留预算内的尾巴，并报告断点")
function buildMessages(turns: number, charsPerTurn: number): Message[] {
  const messages: Message[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      id: `u${turn}`,
      sessionID: "s",
      role: "user",
      createdAt: turn * 2,
      parts: [{ id: `u${turn}-t`, type: "text", text: `问题 ${turn}` }],
    })
    messages.push({
      id: `a${turn}`,
      sessionID: "s",
      role: "assistant",
      createdAt: turn * 2 + 1,
      parts: [{ id: `a${turn}-t`, type: "text", text: "x".repeat(charsPerTurn) }],
    })
  }
  return messages
}

// each assistant turn is ~20000 chars ≈ 5000 tokens by the length/4 estimator
const messages = buildMessages(3, 20_000)
const selection = select({ messages, limits, preserveOverride: 6_000 })
check("尾巴从最后一个 user 开始", selection.tailStartId, "u2")
check("head 只含前两轮共 4 条", selection.head.length, 4)

const roomy = select({ messages, limits, preserveOverride: 15_000 })
check("预算放宽则保留更多", roomy.tailStartId, "u1")
// estimate() runs over JSON.stringify, so the per-part metadata counts too: each
// assistant turn lands at ~5050 tokens, so three of them (15150) just miss 15000
check("head 只含第 1 轮", roomy.head.length, 2)
check("被折叠的正是第 1 轮", roomy.head.map((message) => message.id), ["u0", "a0"])

const nothing = select({ messages, limits, preserveOverride: 1 })
check("预算太小则没有可保留的尾巴", nothing.tailStartId, undefined)
check("head 退化为全部消息", nothing.head.length, messages.length)

console.log("--- 回归：触发必须看「即将发送的实际大小」，而不是上一次 API 的报告")
// 症状：上下文一路涨到 100%，压缩却从不触发（全日志 73 轮里 compact:summarized = 0）。
// 原因：判断用的是 lastUsage —— 上一次请求的实测值。而一次工具调用最多返回
// MAX_OUTPUT 字符，一轮十几个 step 下来就能灌满窗口。等判断发生时真实请求早超了，
// 那个旧数字却还在预算之内；唯一一次真的越线，又被「裁剪后推迟摘要」跳过了。
function textSession(turns: number, chars: number) {
  const built: Message[] = []
  for (let index = 0; index < turns; index += 1) {
    built.push({
      id: `u${index}`,
      sessionID: "s",
      role: "user",
      createdAt: index * 2,
      parts: [{ id: `u${index}-t`, type: "text", text: `问题 ${index}` }],
    })
    built.push({
      id: `a${index}`,
      sessionID: "s",
      role: "assistant",
      createdAt: index * 2 + 1,
      parts: [{ id: `a${index}-t`, type: "text", text: "x".repeat(chars) }],
    })
  }
  return built
}

const cap = usable(limits)
// 内容全在 text part 里：prune() 只动 tool part，所以这里不会被裁剪干扰
const bloated = { id: "proj", workspace: process.cwd(), messages: textSession(4, 130_000) } as unknown as Session
const tiny = { id: "tiny", workspace: process.cwd(), messages: textSession(1, 100) } as unknown as Session

const stale = cap - 1_000
check("上一次的报告在预算之内（旧逻辑会放过它）", stale < cap, true)
check("实时投影已超出（新逻辑会触发）", projectedTokens(bloated, stale, 0) >= cap, true)

console.log("--- 投影的三个方向")
check("什么都不动时，不比上次报告更低", projectedTokens(tiny, 50_000, 0) >= 50_000, true)
check("裁剪释放的量直接从投影里扣", projectedTokens(tiny, cap + 50_000, 60_000) < cap, true)
check("不裁剪时就按上次报告算", projectedTokens(tiny, cap + 50_000, 0) >= cap, true)
check("MAX_OUTPUT 已收到 20000 字符", 20_000 < 60_000, true)

console.log("--- 思考内容不计入投影（它永远不会被回传）")
const plain = { id: "r1", workspace: process.cwd(), messages: textSession(1, 100) } as unknown as Session
const thinker = {
  id: "r2",
  workspace: process.cwd(),
  messages: textSession(1, 100).map((message, index, all) =>
    index === all.length - 1 && message.role === "assistant"
      ? { ...message, parts: [{ id: "rp", type: "reasoning" as const, text: "想 ".repeat(20_000) }, ...message.parts] }
      : message,
  ),
} as unknown as Session

// without the exclusion this would be ~45k bigger and trigger compaction for nothing
check("再长的思考也不进投影", projectedTokens(thinker, 0, 0), projectedTokens(plain, 0, 0))

console.log("--- 端到端：旧数字没超、实际已超时，压缩必须真的跑起来")
async function regression() {
  const session = createSession("context-check", process.cwd())
  try {
    const first = newMessage(session, "user")
    newTextPart(first, "开始")
    for (let index = 0; index < 4; index += 1) {
      const assistant = newMessage(session, "assistant")
      newTextPart(assistant, "y".repeat(130_000))
      const next = newMessage(session, "user")
      newTextPart(next, `继续 ${index}`)
    }
    // 上一次 API 的报告：刚好还在预算之内
    session.messages[session.messages.length - 1].tokens = usage(cap - 1_000)

    let summarizeCalls = 0
    const fakeClient = {
      chat: {
        completions: {
          create: async () => {
            summarizeCalls += 1
            return { choices: [{ message: { content: "## Goal\n回归测试\n## Next step\n无" } }] }
          },
        },
      },
    } as unknown as OpenAI

    const reported = lastUsage(session)
    check("旧逻辑看到的是「没超」", isOverflow({ tokens: reported!, limits, auto: true }), false)

    const outcome = await compactIfNeeded({
      session,
      client: fakeClient,
      model: "fake",
      signal: new AbortController().signal,
    })

    check("压缩真的调用了摘要器", summarizeCalls, 1)
    check("结果标记为已摘要", outcome.reason, "summarized")
    check("确实产生了折叠记录", session.messages.some((m) => m.parts.some((p) => p.type === "compaction")), true)
  } finally {
    deleteSession(session.id)
  }
}

console.log("--- read 默认分页（整文件返回等于一次 shell dump）")
// 实测：一轮 179KB 全是 `Get-Content <file> -Raw`。read 有分页能力，但默认返回整份，
// 所以模型没有理由用它 —— 这里保证它默认只给一段，并告诉模型怎么接着读。
async function readPaging() {
  const workspace = path.join(os.tmpdir(), `goto-read-${Date.now()}`)
  fs.mkdirSync(workspace, { recursive: true })
  const file = path.join(workspace, "big.txt")
  fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n"), "utf8")

  const tool = getTool("read")
  if (!tool) throw new Error("read tool missing")
  const part = { id: "p", type: "tool", callID: "c", tool: "read", input: {}, status: "running" } as ToolPart
  const result = await tool.run(
    { path: "big.txt" },
    {
      session: { id: "x", workspace, accessMode: "workspace" } as unknown as Session,
      signal: new AbortController().signal,
      part,
      stream: () => undefined,
      ask: async () => "",
    },
  )

  check("默认只返回 400 行", result.output.includes("lines 1-400 of 1000"), true)
  check("告诉模型下一个 offset", result.output.includes("offset=401"), true)
  check("行号还在", result.output.includes("    1| line 1"), true)

  const tail = await tool.run(
    { path: "big.txt", offset: 401 },
    {
      session: { id: "x", workspace, accessMode: "workspace" } as unknown as Session,
      signal: new AbortController().signal,
      part,
      stream: () => undefined,
      ask: async () => "",
    },
  )
  check("从 401 接着读", tail.output.includes("lines 401-800 of 1000"), true)
  check("还没有截断提示时不留尾巴", tail.output.includes("of 1000"), true)

  const last = await tool.run(
    { path: "big.txt", offset: 801 },
    {
      session: { id: "x", workspace, accessMode: "workspace" } as unknown as Session,
      signal: new AbortController().signal,
      part,
      stream: () => undefined,
      ask: async () => "",
    },
  )
  check("读到结尾就没有继续提示了", last.output.includes("Continue with offset"), false)

  fs.rmSync(workspace, { recursive: true, force: true })
}

console.log("--- read 的防护：目录 / 超大 / 二进制")
// read 会先把整个文件读进内存再分页，所以文件本身必须有上限；一个几 GB 的文件会先 OOM。
async function readGuards() {
  const workspace = path.join(os.tmpdir(), `goto-read-guard-${Date.now()}`)
  fs.mkdirSync(path.join(workspace, "sub"), { recursive: true })

  const tool = getTool("read")
  if (!tool) throw new Error("read tool missing")
  const part = { id: "p", type: "tool", callID: "c", tool: "read", input: {}, status: "running" } as ToolPart
  const ctx = {
    session: { id: "x", workspace, accessMode: "workspace" } as unknown as Session,
    signal: new AbortController().signal,
    part,
    stream: () => undefined,
    ask: async () => "",
  }

  async function messageFor(target: string): Promise<string> {
    try {
      await tool!.run({ path: target }, ctx)
      return ""
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  check("目录被拒绝（不是当成空文件读）", (await messageFor("sub")).includes("is a directory"), true)

  // sparse: huge by reported size, almost free on disk
  const big = path.join(workspace, "huge.txt")
  fs.writeFileSync(big, "")
  fs.truncateSync(big, 8 * 1024 * 1024 + 1)
  check(
    "超大文件在读之前就被拒（否则会先 OOM）",
    (await messageFor("huge.txt")).includes("over the 8MB limit"),
    true,
  )

  const binary = path.join(workspace, "blob.txt")
  fs.writeFileSync(binary, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x00]))
  check("二进制（含 NUL）被拒绝", (await messageFor("blob.txt")).includes("binary"), true)

  fs.rmSync(workspace, { recursive: true, force: true })
}

console.log("--- 同路径重读：新的一份留下，旧的副本清掉")
// 实测：一个会话把 index.html 读了三次，三份全留在上下文里，前两次共 28.8k 字符
// 是纯重复。而且过期的副本不只是浪费 —— 模型可能照着旧内容去改文件。
function toolPart(id: string, tool: string, path: string, output: string): ToolPart {
  return { id, type: "tool", callID: `c-${id}`, tool, input: { path }, status: "done", output }
}

function fixture(id: string, parts: ToolPart[]): Session {
  const user: Message = {
    id: `${id}-u`,
    sessionID: id,
    role: "user",
    createdAt: 0,
    parts: [{ id: `${id}-ut`, type: "text", text: "go" }],
  }
  const assistant: Message = { id: `${id}-a`, sessionID: id, role: "assistant", createdAt: 1, parts }
  return { id, workspace: "/ws", messages: [user, assistant], subscribers: new Set() } as unknown as Session
}

const dupParts = [
  toolPart("r1", "read", "src/a.ts", "old a"),
  toolPart("r2", "read", "src/b.ts", "b"),
  toolPart("r3", "read", "./src/a.ts", "newer a"),
  toolPart("g1", "grep", "src/a.ts", "a grep, not a read"),
]
const dupSession = fixture("dup", dupParts)
supersedeReads(dupSession, "src/a.ts", "r3")

check("旧的同路径 read 被清掉", dupParts[0].compactedAt !== undefined, true)
check("另一个文件不受影响", dupParts[1].compactedAt, undefined)
check("当前这一份留着", dupParts[2].compactedAt, undefined)
check("同样路径写法的 grep 不误伤", dupParts[3].compactedAt, undefined)

// 路径写法（./a.ts vs a.ts）不能成为旧副本的护身符
const spellingParts = [
  toolPart("s1", "read", "src/a.ts", "older"),
  toolPart("s2", "read", "./src/a.ts", "newest"),
]
supersedeReads(fixture("spelling", spellingParts), "./src/a.ts", "s2")
check("用另一种写法请求也能顶掉旧副本", spellingParts[0].compactedAt !== undefined, true)

console.log("--- prune 现在也回收当前轮（单轮 179KB 就是这么攒出来的）")
// 旧逻辑 `turnCount < 2` 让整个当前轮豁免，所以一轮 30 步读多少留多少。按配置的窗口
// 造数据，这样无论 PRUNE_PROTECT 被设成多少，断言都成立。
const perPartChars = 20_000
const partCount = Math.ceil(((config.pruneProtect + config.pruneMinimum) * 4) / perPartChars) + 2
const liveParts = Array.from({ length: partCount }, (_, i) =>
  toolPart(`t${i}`, "read", `f${i}.txt`, "x".repeat(perPartChars)),
)

const freed = prune(fixture("prune", liveParts))
check("当前轮里的旧输出也会被回收（旧逻辑一根毫毛都不动）", freed > 0, true)
check("最新的一份必须留着", liveParts[liveParts.length - 1].compactedAt, undefined)
check("最旧的一份被清掉", liveParts[0].compactedAt !== undefined, true)

// supersedeReads 会跳着清（只清同路径的旧副本），所以「遇到已清的就停」会把更旧的
// 输出永久留在上下文里 —— 扫描必须跳过它，而不是把它当作边界。
const sandwiched = [
  toolPart("old0", "read", "f0.txt", "x".repeat(perPartChars)),
  { ...toolPart("mid", "read", "f0.txt", "x".repeat(perPartChars)), compactedAt: 1 },
  ...Array.from({ length: partCount }, (_, i) => toolPart(`n${i}`, "read", `n${i}.txt`, "x".repeat(perPartChars))),
]
prune(fixture("sandwich", sandwiched))
check("已清的部分不会挡住更旧输出的回收", sandwiched[0].compactedAt !== undefined, true)
check("已清的部分保持原样（没有被重新盖章）", sandwiched[1].compactedAt, 1)

console.log("--- skill 正文也有上限（原来是唯一没有上限的工具）")
// 正文原来是原样内联的：一个真身是 60k 字符参考文档的 skill，一次调用就能把上下文灌爆。
async function skillBound() {
  const workspace = path.join(os.tmpdir(), `goto-skill-${Date.now()}`)
  const dir = path.join(workspace, ".agents", "skills", "big-skill")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: big-skill\ndescription: 测试用的大技能\n---\n${"y".repeat(60_000)}`,
    "utf8",
  )

  const tool = getTool("skill")
  if (!tool) throw new Error("skill tool missing")
  const result = await tool.run(
    { name: "big-skill" },
    {
      session: { id: "x", workspace, accessMode: "workspace" } as unknown as Session,
      signal: new AbortController().signal,
      part: { id: "p", type: "tool", callID: "c", tool: "skill", input: {}, status: "running" } as ToolPart,
      stream: () => undefined,
      ask: async () => "",
    },
  )

  check("正文被截断到 MAX_OUTPUT 以内", result.output.length <= MAX_OUTPUT + 400, true)
  check("截断提示把模型指回原文件", result.output.includes("SKILL.md"), true)

  fs.rmSync(workspace, { recursive: true, force: true })
}

void regression()
  .then(readPaging)
  .then(readGuards)
  .then(skillBound)
  .then(() => {
    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
    process.exit(failures === 0 ? 0 : 1)
  })
