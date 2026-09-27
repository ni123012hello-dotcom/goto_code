import type { ServerEvent } from "../../shared/protocol"
import { getTool } from "../src/agent/tools"
import { askUser, CANCELLED, resolveQuestion } from "../src/questions"
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

function fakeSession(id: string, events: ServerEvent[]): Session {
  return {
    id,
    subscribers: new Set([(event: ServerEvent) => events.push(event)]),
  } as unknown as Session
}

async function main() {
  console.log("--- 发出提问并等待回答")
  const events: ServerEvent[] = []
  const session = fakeSession("s1", events)
  const controller = new AbortController()

  const pending = askUser({
    session,
    question: "包管理器用哪个？",
    options: ["pnpm", "npm"],
    allowFreeText: true,
    signal: controller.signal,
  })

  const request = events[0]
  check("先发出 question.request", request?.type, "question.request")
  const id = request?.type === "question.request" ? request.request.id : ""
  check("问题透传", request?.type === "question.request" ? request.request.question : null, "包管理器用哪个？")
  check("选项透传", request?.type === "question.request" ? request.request.options : null, ["pnpm", "npm"])
  check("允许自由输入", request?.type === "question.request" ? request.request.allowFreeText : null, true)

  check("回答前未解决", resolveQuestion("not-this-id", "x"), false)
  check("用正确 id 回答", resolveQuestion(id, "pnpm"), true)
  check("拿到的就是回答", await pending, "pnpm")
  check("随后发出 question.resolved", events[1]?.type, "question.resolved")
  check("事件里带回答", events[1]?.type === "question.resolved" ? events[1].answer : null, "pnpm")

  console.log("--- 已解决后重复回答无效")
  check("重复 resolve 返回 false", resolveQuestion(id, "npm"), false)
  check("没有多出事件", events.length, 2)

  console.log("--- 对话中止时提问自动解绑")
  const abortEvents: ServerEvent[] = []
  const c2 = new AbortController()
  const p2 = askUser({
    session: fakeSession("s2", abortEvents),
    question: "这个要吗？",
    options: [],
    allowFreeText: true,
    signal: c2.signal,
  })
  c2.abort()
  check("中止后拿到 CANCELLED", await p2, CANCELLED)
  check("仍然发出 resolved", abortEvents[1]?.type, "question.resolved")
  check("回答是 CANCELLED", abortEvents[1]?.type === "question.resolved" ? abortEvents[1].answer : null, CANCELLED)

  console.log("--- 已经中止的对话不会发出提问")
  const deadEvents: ServerEvent[] = []
  const c3 = new AbortController()
  c3.abort()
  const p3 = askUser({
    session: fakeSession("s3", deadEvents),
    question: "还有人吗？",
    options: [],
    allowFreeText: true,
    signal: c3.signal,
  })
  check("立刻返回 CANCELLED", await p3, CANCELLED)
  check("一个事件都没发", deadEvents.length, 0)

  console.log("--- ask 工具确实走 ctx.ask")
  const tool = getTool("ask")
  check("工具已注册", Boolean(tool), true)

  let captured: { question: string; options: string[]; allowFreeText: boolean } | null = null
  const result = await tool!.run(
    { question: "用哪个？", options: ["a", "b", "   ", "c"] },
    {
      session: fakeSession("s4", []),
      signal: new AbortController().signal,
      part: {} as never,
      stream: () => undefined,
      ask: async (input) => {
        captured = input
        return "a"
      },
    },
  )

  check("问题传给了 ctx.ask", captured?.question, "用哪个？")
  check("空选项被过滤", captured?.options, ["a", "b", "c"])
  check("默认允许自由输入", captured?.allowFreeText, true)
  check("回答成为工具结果", result.output, "a")

  const explicit = await tool!.run(
    { question: "只选不填？", allowFreeText: false },
    {
      session: fakeSession("s5", []),
      signal: new AbortController().signal,
      part: {} as never,
      stream: () => undefined,
      ask: async (input) => {
        captured = input
        return "ok"
      },
    },
  )
  check("显式 false 时不允许自由输入", captured?.allowFreeText, false)
  check("没给选项就是空数组", captured?.options, [])
  check("仍然返回回答", explicit.output, "ok")

  console.log("--- 空问题被拒绝")
  let threw = false
  try {
    await tool!.run({ question: "   " }, {
      session: fakeSession("s6", []),
      signal: new AbortController().signal,
      part: {} as never,
      stream: () => undefined,
      ask: async () => "x",
    })
  } catch {
    threw = true
  }
  check("抛错", threw, true)

  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
