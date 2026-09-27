import fs from "node:fs"
import path from "node:path"
import type { NoteSection } from "../../shared/protocol"
import { estimate } from "./agent/tokens"
import { dataFile } from "./config"
import { logger } from "./log"

const notesDir = path.join(path.dirname(dataFile), "notes")

/** Canonical section order. Also the injection priority: the most fundamental
 *  sections come first, so when the budget runs out what gets dropped is peripheral. */
export const NOTE_SKELETON = ["应用是什么", "目标与功能", "使用指南", "架构与约定", "注意事项"]

const FILE_HEADER = `# 笔记

<!-- 由 goto 维护，也可以直接手改。每节带更新时间。 -->
`

const SECTION = /^##\s+(.+?)\s*$/
const META = /^<!--\s*updated=(\S+)\s+session=(\S+)\s*-->$/
const WORKSPACE = /^<!--\s*workspace=(.*?)\s*-->$/

/** One note per conversation. The id is a session id, so the file lives in its own
 *  directory rather than next to the session json. */
export function notesFile(sessionID: string): string {
  const safe = sessionID.replace(/[^A-Za-z0-9-]/g, "")
  return path.join(notesDir, `${safe}.md`)
}

function tokensOf(body: string): number {
  return estimate(body)
}

export function orderSections(sections: NoteSection[]): NoteSection[] {
  const rank = (name: string) => {
    const index = NOTE_SKELETON.indexOf(name)
    return index === -1 ? NOTE_SKELETON.length : index
  }

  return [...sections].sort((a, b) => {
    const byRank = rank(a.name) - rank(b.name)
    if (byRank !== 0) return byRank
    // custom sections fall back to newest first
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  })
}

export function parseNote(text: string): { workspace: string | null; sections: NoteSection[] } {
  const sections: NoteSection[] = []
  let workspace: string | null = null
  let current: NoteSection | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()

    const ws = WORKSPACE.exec(line.trim())
    if (ws && !current) {
      workspace = ws[1].trim() || null
      continue
    }

    const heading = SECTION.exec(line)
    if (heading) {
      current = { name: heading[1].trim(), body: "", tokens: 0 }
      sections.push(current)
      continue
    }

    if (!current) continue

    const meta = META.exec(line.trim())
    if (meta && !current.body) {
      current.updatedAt = meta[1]
      current.sessionID = meta[2]
      continue
    }

    if (line.startsWith("<!--") && !current.body) continue
    if (line.startsWith("#") && !current.body) continue

    current.body = current.body ? `${current.body}\n${line}` : line
  }

  for (const section of sections) {
    section.body = section.body.replace(/\s+$/, "")
    section.tokens = tokensOf(section.body)
  }

  return { workspace, sections }
}

export function renderNote(sections: NoteSection[], workspace: string | null): string {
  const head = workspace ? `${FILE_HEADER}\n<!-- workspace=${workspace} -->\n` : FILE_HEADER

  const body = orderSections(sections)
    .map((section) => {
      const meta =
        section.updatedAt && section.sessionID
          ? `<!-- updated=${section.updatedAt} session=${section.sessionID} -->\n`
          : ""
      return `## ${section.name}\n${meta}${section.body}\n`
    })
    .join("\n")

  return `${head}\n${body}`
}

export function loadNote(sessionID: string): { workspace: string | null; sections: NoteSection[] } {
  try {
    return parseNote(fs.readFileSync(notesFile(sessionID), "utf8"))
  } catch {
    return { workspace: null, sections: [] }
  }
}

export function readNoteText(sessionID: string): string {
  try {
    return fs.readFileSync(notesFile(sessionID), "utf8")
  } catch {
    return `${FILE_HEADER}\n`
  }
}

function persist(sessionID: string, sections: NoteSection[], workspace: string | null): void {
  const file = notesFile(sessionID)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, renderNote(sections, workspace), "utf8")
}

export function writeNoteText(sessionID: string, text: string): { workspace: string | null; sections: NoteSection[] } {
  const parsed = parseNote(text)
  persist(sessionID, parsed.sections, parsed.workspace)
  logger.info("note", "saved from ui", { sessionID, sections: parsed.sections.length })
  return parsed
}

export function updateSection(
  sessionID: string,
  name: string,
  body: string,
  workspace: string | null,
): NoteSection[] {
  const held = loadNote(sessionID)
  const clean = name.trim()
  if (!clean) throw new Error("section name is required")

  const trimmed = body.trim()
  const existing = held.sections.find((section) => section.name === clean)
  const next: NoteSection = {
    name: clean,
    body: trimmed,
    updatedAt: new Date().toISOString(),
    // the owning conversation is the author now, so this just records which note it is
    sessionID: sessionID.slice(0, 8),
    tokens: tokensOf(trimmed),
  }

  const sections = existing
    ? held.sections.map((section) => (section.name === clean ? next : section))
    : [...held.sections, next]

  persist(sessionID, sections, workspace ?? held.workspace)
  logger.info("note", "section updated", { sessionID, section: clean, tokens: next.tokens })
  return sections
}

export function removeSection(sessionID: string, name: string): boolean {
  const held = loadNote(sessionID)
  const clean = name.trim()
  const sections = held.sections.filter((section) => section.name !== clean)
  if (sections.length === held.sections.length) return false

  persist(sessionID, sections, held.workspace)
  logger.info("note", "section removed", { sessionID, section: clean })
  return true
}

export function noteTokens(sections: NoteSection[]): number {
  return sections.reduce((total, section) => total + section.tokens + estimate(section.name) + 6, 0)
}

export type NoteInjection = {
  text: string
  injected: string[]
  omitted: { name: string; tokens: number }[]
}

/**
 * Builds the prompt block. The outline is always present so the reading agent knows
 * the whole document exists even when the bodies do not fit, then sections are added
 * in canonical order until the budget is spent.
 */
export function renderNoteForPrompt(
  sessionID: string,
  budget: number,
  workspace: string | null,
): NoteInjection {
  const { workspace: recorded, sections } = loadNote(sessionID)
  if (sections.length === 0) return { text: "", injected: [], omitted: [] }

  const ordered = orderSections(sections)
  const outlineCost = ordered.reduce((total, section) => total + estimate(section.name) + 12, 0)

  let remaining = Math.max(0, budget - outlineCost)
  const injected: NoteSection[] = []
  const omitted: { name: string; tokens: number }[] = []

  for (const section of ordered) {
    if (section.tokens <= remaining) {
      injected.push(section)
      remaining -= section.tokens
    } else {
      omitted.push({ name: section.name, tokens: section.tokens })
    }
  }

  const lines: string[] = [
    "## 本对话的笔记（你自己写给后面几轮的交接）",
    "",
    "这是**这个对话**维护的笔记，描述的是**这个项目本身** —— 它是什么、怎么用、要注意什么。",
    "只有这个对话会读到它，别的对话看不到。",
    "",
    "**把它当起点，不要当事实。** 涉及文件路径、命令、版本号的地方，用工具核实一遍再动手；",
    "标注时间较旧的小节尤其要重新确认。",
    "",
  ]

  // a note written against a different workspace is the strongest staleness signal
  // there is, so it goes at the top rather than buried in a section
  if (recorded && workspace && recorded !== workspace) {
    lines.push(
      `> ⚠ 这份笔记是在 \`${recorded}\` 写的，但当前工作区是 \`${workspace}\`。`,
      "> 内容很可能已经过期，一切以实际代码为准。",
      "",
    )
  }

  if (injected.length > 0) {
    for (const section of injected) {
      const when = section.updatedAt ? `（${section.updatedAt.slice(0, 10)} 由 ${section.sessionID} 写）` : ""
      lines.push(`### ${section.name}${when}`, "", section.body, "")
    }
  } else {
    lines.push("（笔记内容超出本次注入预算，以下小节都未展开）", "")
  }

  if (omitted.length > 0) {
    const list = omitted.map((item) => `${item.name}（${item.tokens} tok）`).join("、")
    lines.push(`**[未注入] ${list}** —— 需要时用 \`note(action:"read", section:"…")\` 读取。`, "")
  }

  lines.push("完成阶段性工作时用 note 工具更新它；不要记录「这次改了什么」。")

  return {
    text: lines.join("\n"),
    injected: injected.map((section) => section.name),
    omitted,
  }
}

export function noteWorkspace(sessionID: string): string | null {
  return loadNote(sessionID).workspace
}
