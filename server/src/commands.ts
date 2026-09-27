import { applyMemoryDelta, loadMemory, type MemoryEntry } from "./memory"
import { emit, newMessage, newTextPart, sessionScope, setTitle, type Session } from "./sessions"

export type Command = {
  name: string
  aliases: string[]
  usage: string
  description: string
  run: (context: { session: Session; args: string }) => string | Promise<string>
}

function splitEntry(text: string): { key: string; value: string } {
  const index = text.indexOf("::")
  if (index === -1) return { key: "", value: text.trim() }
  return { key: text.slice(0, index).trim(), value: text.slice(index + 2).trim() }
}

function describe(entry: MemoryEntry): string {
  return entry.key ? `**${entry.key}** :: ${entry.value}` : entry.value
}

const remember: Command = {
  name: "remember",
  aliases: ["mem", "记忆", "记住"],
  usage: "/remember <内容>",
  description: "写入一条长期记忆，来源标记为 user（永不自动清理）",
  run({ session, args }) {
    const text = args.trim()

    if (!text) {
      return [
        "用法：`/remember <内容>`",
        "",
        "也可以带标签：`/remember 包管理器 :: 用 pnpm，不要用 npm`",
        "",
        `不带参数时（\`/remember\`）不会写任何东西 —— 请直接把要记的内容写在本条指令后面。`,
      ].join("\n")
    }

    const { key, value } = splitEntry(text)
    if (!value) return "内容为空，没有写入。"

    const result = applyMemoryDelta(
      sessionScope(session),
      [{ key, value, source: "user" }],
      [],
      { status: "active" },
    )
    const entry = result.added[0]

    if (!entry) {
      const existing = result.entries.find(
        (candidate) => candidate.value === value && (key ? candidate.key === key : true),
      )
      return existing
        ? `已存在同样的记忆，没有重复写入：\n\n- \`[${existing.id}]\` ${describe(existing)}`
        : "没有写入（内容为空）。"
    }

    return [
      "已写入长期记忆。",
      "",
      `- \`[${entry.id}]\` ${describe(entry)}`,
      "",
      "来源标记为 `user`：注入时归入「已确认」组，且不会被自动清理。",
      `要删除用 \`/forget ${entry.id}\`。`,
    ].join("\n")
  },
}

const forget: Command = {
  name: "forget",
  aliases: ["删记忆", "遗忘"],
  usage: "/forget <id 或 内容片段>",
  description: "删除一条长期记忆",
  run({ session, args }) {
    const query = args.trim()
    if (!query) return "用法：`/forget <id 或 内容片段>`\n\n先 `/memory` 查看当前有哪些记忆。"

    const entries = loadMemory(sessionScope(session))
    if (entries.length === 0) return "当前没有长期记忆。"

    const needle = query.toLowerCase()
    const exact = entries.filter((entry) => entry.id === query)
    const matches =
      exact.length > 0
        ? exact
        : entries.filter(
            (entry) =>
              entry.value.toLowerCase().includes(needle) || entry.key.toLowerCase().includes(needle),
          )

    if (matches.length === 0) return `没找到匹配 \`${query}\` 的记忆。`
    if (matches.length > 1) {
      return [
        `匹配到 ${matches.length} 条，请用更精确的内容或 id：`,
        "",
        ...matches.map((entry) => `- \`[${entry.id}]\` ${describe(entry)}`),
      ].join("\n")
    }

    const target = matches[0]
    applyMemoryDelta(sessionScope(session), [], [target.id])
    return `已删除记忆 \`[${target.id}]\` ${describe(target)}`
  },
}

const memory: Command = {
  name: "memory",
  aliases: ["记忆列表", "memlist"],
  usage: "/memory",
  description: "列出当前所有长期记忆",
  run({ session }) {
    const entries = loadMemory(sessionScope(session))
    if (entries.length === 0) return "当前没有长期记忆。用 `/remember <内容>` 添加。"

    const verified = entries.filter((entry) => !entry.stale && entry.source !== "inferred")
    const inferred = entries.filter((entry) => !entry.stale && entry.source === "inferred")
    const stale = entries.filter((entry) => entry.stale)

    const section = (title: string, list: MemoryEntry[]) =>
      list.length === 0
        ? []
        : [``, `### ${title}（${list.length}）`, ...list.map((entry) => `- \`[${entry.id}] ${entry.source}\` ${describe(entry)}`)]

    return [
      `${entries.length} 条记忆：`,
      ...section("已确认", verified),
      ...section("AI 推断", inferred),
      ...section("已证伪", stale),
    ].join("\n")
  },
}

const help: Command = {
  name: "help",
  aliases: ["帮助", "?"],
  usage: "/help",
  description: "列出所有可用指令",
  run() {
    return ["可用指令：", "", ...commands.map((command) => `- \`${command.usage}\` — ${command.description}`)].join(
      "\n",
    )
  },
}

export const commands: Command[] = [remember, forget, memory, help]

export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text.trim())
  if (!match) return null
  return { name: match[1].toLowerCase(), args: match[2] }
}

export function findCommand(name: string): Command | undefined {
  return commands.find(
    (command) => command.name === name || command.aliases.some((alias) => alias.toLowerCase() === name),
  )
}

export function commandCatalog(): { name: string; aliases: string[]; usage: string; description: string }[] {
  return commands.map(({ name, aliases, usage, description }) => ({ name, aliases, usage, description }))
}

function reply(session: Session, text: string): void {
  const message = newMessage(session, "assistant")
  newTextPart(message, text)
  emit(session, { type: "message.start", message })
}

export async function runCommand(session: Session, text: string): Promise<string> {
  const parsed = parseCommand(text)
  if (!parsed) return "无法解析指令。"

  const command = findCommand(parsed.name)
  if (!command) {
    const known = commands.map((candidate) => `\`/${candidate.name}\``).join("、")
    return `未知指令 \`/${parsed.name}\`。可用：${known}\n\n用 \`/help\` 查看详情。`
  }

  let result: string
  try {
    result = await command.run({ session, args: parsed.args })
  } catch (error) {
    result = `指令执行失败：${error instanceof Error ? error.message : String(error)}`
  }

  reply(session, result)
  return result
}

export function recordCommand(session: Session, text: string): void {
  const message = newMessage(session, "user")
  newTextPart(message, text)
  setTitle(session, text)
  emit(session, { type: "message.start", message })
}
