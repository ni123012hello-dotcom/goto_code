// Agent Skills: a folder with a SKILL.md (YAML frontmatter + body) plus optional
// references/ scripts/ data/ alongside it.
//
// The format's whole point is progressive disclosure: only the name and description reach
// the prompt, and the body is loaded on demand by the `skill` tool. A skill whose body is
// 5k tokens therefore costs about 30 tokens until it is actually used.
//
// Two roots, in precedence order:
//   1. <workspace>/.agents/skills - project skills. This is the canonical location the
//      `skills` CLI (vercel-labs/skills) writes to for every agent it calls "universal"
//      (`npx skills add <repo> -a universal`), so anything installed that way is picked up
//      with no extra step. `gt skills add` targets it.
//   2. .data/skills - personal skills. User content, like everything else in .data, so they
//      are not part of any repository and do not ship with it.
//
// The project root wins on a name clash: the skill that lives beside the code is the one
// written for it.

import fs from "node:fs"
import path from "node:path"
import { dataFile } from "./config"
import { logger } from "./log"

export type SkillSource = "project" | "personal"

export type Skill = {
  name: string
  description: string
  /** absolute path, so the agent can read scripts/ and references/ with the normal tools */
  dir: string
  file: string
  source: SkillSource
}

export type SkillRoot = {
  source: SkillSource
  dir: string
}

/** Relative to the workspace. One constant, because the installer and the reader have to
 *  agree on it exactly: this is the path the CLI knows as the "universal" agent. */
export const PROJECT_SKILLS_DIR = ".agents/skills"

// same convention as sessions/, memory/, notes/: everything lives beside settings.json
const personalRoot = path.join(path.dirname(dataFile), "skills")

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_DESCRIPTION = 1_500

/** Total size of the block, header included. A description runs ~150 chars, so this fits
 *  roughly 25 skills; the per-description cap is what keeps one pathological repo from
 *  eating every request. */
export const PROMPT_BUDGET_CHARS = 4_000

export function personalSkillsDir(): string {
  return personalRoot
}

export function projectSkillsDir(workspace: string): string | undefined {
  const root = String(workspace ?? "").trim()
  if (!root) return undefined
  return path.resolve(root, ...PROJECT_SKILLS_DIR.split("/"))
}

/** Project first: it shadows the personal root on a name clash. */
export function skillRoots(workspace: string): SkillRoot[] {
  const roots: SkillRoot[] = []
  const project = projectSkillsDir(workspace)
  if (project) roots.push({ source: "project", dir: project })
  roots.push({ source: "personal", dir: personalRoot })
  return roots
}

/** Some editors (and PowerShell's Set-Content) write a UTF-8 BOM. It is not part of the
 *  content, but it does break a `^---` match, which silently turns a valid skill into
 *  "no description in frontmatter". Drop it before anything reads the text. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Only the flat `key: value` lines that matter. A YAML parser is not worth a dependency
 *  for six known keys, and anything nested (metadata:) is ignored on purpose. */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!block) return {}

  const out: Record<string, string> = {}
  for (const line of block[1].split(/\r?\n/)) {
    if (/^\s/.test(line)) continue // nested under a parent key
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!pair) continue
    out[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, "")
  }
  return out
}

export function listSkills(workspace: string): Skill[] {
  const seen = new Set<string>()
  const skills: Skill[] = []

  for (const root of skillRoots(workspace)) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true })
    } catch {
      continue // a root that does not exist is the normal case
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const file = path.join(root.dir, entry.name, "SKILL.md")
      let text: string
      try {
        text = stripBom(fs.readFileSync(file, "utf8"))
      } catch {
        continue
      }

      const meta = frontmatter(text)
      const name = (meta.name || entry.name).trim()
      // a skill whose names disagree is more likely broken than intentional
      if (!SKILL_NAME.test(name)) {
        logger.warn("skill", "skipping: invalid name", { dir: entry.name, name, source: root.source })
        continue
      }
      // the project root is walked first, so a local override shadows the personal one
      if (seen.has(name)) continue

      const description = (meta.description ?? "").slice(0, MAX_DESCRIPTION)
      if (!description) {
        logger.warn("skill", "skipping: no description in frontmatter", { name, source: root.source })
        continue
      }

      seen.add(name)
      skills.push({ name, description, dir: path.join(root.dir, entry.name), file, source: root.source })
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export function readSkill(workspace: string, name: string): { skill: Skill; body: string } | undefined {
  const wanted = String(name ?? "").trim().toLowerCase()
  if (!wanted) return undefined

  const skill = listSkills(workspace).find((candidate) => candidate.name === wanted)
  if (!skill) return undefined

  const text = stripBom(fs.readFileSync(skill.file, "utf8"))
  // hand back everything after the frontmatter: the model already has the description
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
  return { skill, body }
}

/** What is in the skill folder, and whether it wants dependencies installed first.
 *  A skill is user content: its deps belong inside its own directory, not in this project's
 *  package.json, and .data/ is gitignored so they never ship. */
export function skillLayout(dir: string): { entries: string[]; install: string | null } {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { entries: [], install: null }
  }

  const names = entries
    .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
    .filter((name) => name !== "node_modules/")
    .sort()

  const has = (file: string) => entries.some((entry) => entry.isFile() && entry.name === file)
  const install = has("package.json")
    ? "npm install"
    : has("requirements.txt")
      ? "pip install -r requirements.txt"
      : has("pyproject.toml")
        ? "pip install ."
        : null

  return { entries: names, install }
}

const SKILLS_HEAD = [
  "## 可用 skill",
  "",
  "下面是已安装的 skill。**它们是按需加载的，正文还不在你的上下文里。**",
  "判断某个 skill 对当前任务有用时，先用 `skill` 工具把它载入（name 参数见下表），再照它做。",
  "不要凭描述猜正文内容。",
  "",
]

export type SkillPromptPlan = {
  /** the `- **name** — description` lines that fit the budget */
  lines: string[]
  injected: string[]
  omitted: string[]
  /** characters the block takes, head included */
  chars: number
}

/** Which skills land in the prompt block, and how big that block is. Exported so the UI can
 *  show the same decision instead of re-deriving the budget arithmetic. */
export function skillPromptPlan(workspace: string): SkillPromptPlan {
  const skills = listSkills(workspace)
  const lines: string[] = []
  const injected: string[] = []
  const omitted: string[] = []
  let used = SKILLS_HEAD.join("\n").length

  for (const skill of skills) {
    const line = `- **${skill.name}** — ${skill.description}`
    if (used + line.length > PROMPT_BUDGET_CHARS) {
      omitted.push(skill.name)
      continue
    }
    used += line.length + 1
    lines.push(line)
    injected.push(skill.name)
  }

  return { lines, injected, omitted, chars: used }
}

/** The block that goes in the system prompt: names and descriptions only, never bodies.
 *  Bounded, because a machine can easily hold 30 skills and their descriptions add up. */
export function skillsForPrompt(workspace: string): string {
  const plan = skillPromptPlan(workspace)
  if (plan.lines.length === 0 && plan.omitted.length === 0) return ""

  const lines = [...plan.lines]
  if (plan.omitted.length > 0) {
    lines.push("", `（还有 ${plan.omitted.length} 个 skill 因描述太长没列出来，用 \`skill\` 工具按名字仍可加载）`)
  }

  return [...SKILLS_HEAD, ...lines].join("\n")
}
