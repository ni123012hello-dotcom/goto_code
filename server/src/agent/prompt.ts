import { formatMemoryForPrompt, type MemoryEntry } from "../memory"
import { skillsForPrompt } from "../skills"
import type { AccessMode, SessionMode } from "../../../shared/protocol"
import { formatProjectFacts, type ProjectFacts } from "./probe"

const SHELL_NOTE =
  process.platform === "win32"
    ? "The shell tool runs PowerShell, not bash. ls/cat/rm/cp/mv/echo/mkdir work as aliases, but write 2>$null instead of 2>/dev/null, $env:VAR instead of $VAR, and use Select-String instead of grep. Check the tool description for whether && is supported before chaining."
    : "The shell tool runs sh."

const BASE_PROMPT = `You are a coding agent working directly inside the user's workspace.

Rules:
- Use the provided tools to inspect real files. Never guess file contents.
- Read files with the read tool, never by printing them in the shell (cat / Get-Content).
  read paginates and line-numbers; a whole-file shell dump can burn a large slice of the
  context window and leaves you no way to page through it.
- Read a file before editing it.
- Prefer small, surgical edits over rewriting whole files.
- After making changes, verify them (run a build, typecheck, or tests) when a command is available.
- Paths are relative to the workspace root. Never use absolute paths.
- ${SHELL_NOTE}
- Keep answers short and report what you actually did.
- Older tool output is replaced by "[Old tool result content cleared]" to free context, and
  reading a file again clears the previous copy of that same file. Nothing is lost: the
  content is still on disk, so just re-run the tool if you need it again.
- Record durable facts with the memory tool as you learn them: user preferences, rules you
  were told, and stable facts you confirmed by inspecting the workspace. Call it yourself and
  keep going - never ask the user whether to remember something, and never say you will
  remember it without calling the tool. Announcing a memory you did not write is a lie.
- If you are genuinely blocked by an ambiguity only the user can resolve, call the ask tool
  and wait for the answer. Do not guess, and do not end the turn with a question in prose -
  a question written as plain text stops the work, the ask tool continues it.`

export type PromptInput = {
  facts?: ProjectFacts
  memory: MemoryEntry[]
  workspace: string
  accessMode?: AccessMode
  /** absent means agent: existing callers keep the behaviour they had before modes existed */
  mode?: SessionMode
  /** pre-rendered, already trimmed to the injection budget */
  note?: string
}

function accessBlock(mode: AccessMode, workspace: string): string {
  if (mode === "full") {
    return `## 文件访问范围

**完全访问已开启。** read / write / edit / list / grep 可以访问这台机器上的任意路径，
绝对路径直接传即可。用户显式打开的这个开关，改动工作区之外的内容前先说明你要改什么。

注意：shell 工具本来就不受工作区限制（它一直只靠权限弹窗约束）。`
  }

  return `## 文件访问范围

**工作区受限。** read / write / edit / list / grep 只能操作 ${workspace} 之内的文件，
越界会被拒绝并报错。

如果任务确实需要访问工作区之外的路径，**不要反复重试**，直接告诉用户：
在输入栏下方把「文件访问」切到「完全访问」。

注意：shell 工具不受这个限制（它靠权限弹窗约束），所以需要临时访问外部路径时也可以用 shell。`
}

/** Only plan mode produces a block. It is the exceptional state and the model has to know about
 *  it; saying nothing in agent mode keeps every request a little cheaper. */
function modeBlock(mode: SessionMode): string | null {
  if (mode !== "plan") return null

  return `## 工作模式：计划（只读）

**这个对话是只读的。** write / edit / shell / MCP 工具全部被禁用，调用会被直接拒绝。

能用的只有：读文件、列目录、搜索、抓网页、载入 skill、记笔记与记忆、派子智能体（它们同样只读）。

任务需要改动时，**先把方案讲清楚**：改哪些文件、改成什么、有什么风险、怎么验证。
然后让用户切到「执行」模式再动手。不要找别的方式绕过（借 shell、MCP 都一样），那只会白费一轮。`
}
export function buildSystemPrompt({
  facts,
  memory,
  workspace,
  accessMode = "workspace",
  mode = "agent",
  note,
}: PromptInput): string {
  const blocks = [BASE_PROMPT]

  // the project-knowledge note frames everything else, so it goes first
  if (note) blocks.push(note)

  const modeText = modeBlock(mode)
  if (modeText) blocks.push(modeText)

  blocks.push(accessBlock(accessMode, workspace))

  if (facts) {
    const rendered = formatProjectFacts(facts)
    if (rendered) blocks.push(`## 工作区探测结果（每次会话重新读取，可信）\n\n${rendered}`)
  }

  const memoryBlock = formatMemoryForPrompt(memory, facts, workspace)
  if (memoryBlock) blocks.push(memoryBlock)

  // skills last: names and descriptions only, never the bodies - that is what makes the
  // format cheap. The skill tool loads one on demand.
  const skills = skillsForPrompt(workspace)
  if (skills) blocks.push(skills)

  return blocks.join("\n\n")
}
