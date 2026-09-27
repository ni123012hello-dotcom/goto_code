import fs from "node:fs"
import path from "node:path"
import { dataFile } from "../src/config"
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  loadPersistedSessions,
  newMessage,
  newTextPart,
  newToolPart,
  persistSession,
  rewindTo,
  scheduleSave,
  sessionScope,
  setSessionModel,
  subscribe,
  toInfo,
} from "../src/sessions"

const SAVE_DEBOUNCE_MS = 400

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

const sessionDir = path.join(path.dirname(dataFile), "sessions")

const session = createSession(process.cwd())
const user = newMessage(session, "user")
newTextPart(user, "持久化往返测试")
const assistant = newMessage(session, "assistant")
newTextPart(assistant, "收到")
const tool = newToolPart(assistant, "read", "call-1", { path: "README.md" })
tool.status = "done"
tool.output = "file contents"
session.allowedTools.add("bash")
session.title = "往返测试会话"
persistSession(session)

console.log("--- 文件已落盘")
const file = path.join(sessionDir, `${session.id}.json`)
check("会话文件存在", fs.existsSync(file), true)

const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>

console.log("--- 序列化正确性")
check("id 一致", raw.id, session.id)
check("标题一致", raw.title, "往返测试会话")
check("消息条数", (raw.messages as unknown[]).length, 2)
check("workspace 一致", raw.workspace, session.workspace)

const messages = raw.messages as { role: string; parts: { type: string; text?: string; output?: string }[] }[]
check("user 文本完整", messages[0].parts[0].text, "持久化往返测试")
check("assistant 文本完整", messages[1].parts[0].text, "收到")
check("tool part 保留", messages[1].parts[1].type, "tool")
check("tool 输出保留", messages[1].parts[1].output, "file contents")

// a Set serializes to {} if it is not spread first — this would silently lose
// the session's "always allow" grants on restart
check("allowedTools 是数组而非空对象", raw.allowedTools, ["bash"])

console.log("--- 读取路径")
const loaded = loadPersistedSessions()
check("加载不抛错且返回数字", typeof loaded, "number")
check("会话仍在内存里", Boolean(getSession(session.id)), true)
check("scope 用会话 id", sessionScope(session).sessionID, session.id)
check("列表里能查到", listSessions().some((item) => item.id === session.id), true)

console.log("--- 删除后不会被挂起的防抖保存复活")
const doomed = createSession(process.cwd())
const doomedFile = path.join(sessionDir, `${doomed.id}.json`)
const doomedMessage = newMessage(doomed, "user")
newTextPart(doomedMessage, "这条保存还没落盘")
scheduleSave(doomed)
deleteSession(doomed.id)
check("文件已删除", fs.existsSync(doomedFile), false)

await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 250))
check("等过防抖窗口后仍是删除状态（没有僵尸文件）", fs.existsSync(doomedFile), false)
check("内存里也没了", getSession(doomed.id), undefined)

console.log("--- 每个会话的模型覆盖")
check("默认没有覆盖", toInfo(session).model, undefined)
check("设置成功", setSessionModel(session.id, "gpt-x")?.model, "gpt-x")
check("写进内存了", getSession(session.id)?.model, "gpt-x")
check("首尾空格被去掉", setSessionModel(session.id, "  spaced  ")?.model, "spaced")
check("空字符串清除覆盖，回到跟随全局", setSessionModel(session.id, "")?.model, undefined)
check("清除后内存里也没了", getSession(session.id)?.model, undefined)
check("未知会话返回 undefined", setSessionModel("does-not-exist", "x"), undefined)

setSessionModel(session.id, "persisted-model")
persistSession(session)
const withModel = JSON.parse(fs.readFileSync(file, "utf8")) as { model?: string }
check("模型会落盘（重启后还在）", withModel.model, "persisted-model")
check("落盘后 toInfo 也能读到", toInfo(getSession(session.id)!).model, "persisted-model")

console.log("--- 重新编辑：回退到某条 user 消息（编辑后重发的第一步）")
const events: string[] = []
subscribe(session, (event) => events.push(event.type))

check("回退前有 2 条消息", session.messages.length, 2)
check("回退到 assistant 会被拒绝", rewindTo(session, assistant.id), { ok: false, reason: "not-user" })
check("被拒后消息没变", session.messages.length, 2)
check("未知 id 会被拒绝", rewindTo(session, "does-not-exist"), { ok: false, reason: "not-found" })

check("回退到 user 成功", rewindTo(session, user.id), { ok: true, removed: 2 })
check("该消息及其之后全部丢弃", session.messages.length, 0)
check("发了 snapshot 让其他窗口同步", events.includes("snapshot"), true)

// 落盘必须同步，否则重启会把被丢弃的消息复活
const rewound = JSON.parse(fs.readFileSync(file, "utf8")) as { messages: unknown[] }
check("磁盘上也已经丢弃", rewound.messages.length, 0)

console.log("--- 清理")
// 必须走 deleteSession：直接 rmSync 不会取消防抖定时器，文件会被写回来
deleteSession(session.id)
check("文件已删除", fs.existsSync(file), false)

await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 250))
check("等过防抖窗口后依然不存在", fs.existsSync(file), false)

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
