import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { dataFile } from "../src/config"
import {
  PROMPT_BUDGET_CHARS,
  listSkills,
  personalSkillsDir,
  projectSkillsDir,
  readSkill,
  skillLayout,
  skillRoots,
  skillsForPrompt,
} from "../src/skills"

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

// .data/ persists across runs, so every name this test creates has to be unique to it
const TAG = `zzskillscheck${Date.now().toString(36)}`

// a disposable "workspace": the project root is <workspace>/.agents/skills, exactly what
// the skills CLI writes to, and it must not be pointed at anything real
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "goto-skills-"))
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "goto-skills-empty-"))
const projectRoot = path.join(ws, ".agents", "skills")

// the personal root is the real .data/skills: we only ever add our own uniquely named
// directories there, and take them away again below
const personalRoot = personalSkillsDir()
const made: string[] = []

function makeSkill(root: string, folder: string, lines: string[], body = "the body text"): string {
  const dir = path.join(root, folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${lines.join("\n")}\n---\n\n# ${folder}\n\n${body}\n`, "utf8")
  made.push(dir)
  return dir
}

function rawSkill(root: string, folder: string, content: string): string {
  const dir = path.join(root, folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8")
  made.push(dir)
  return dir
}

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
  // never remove anything we did not put there: only drop the personal root when it is empty
  try {
    if (fs.existsSync(personalRoot) && fs.readdirSync(personalRoot).length === 0) {
      fs.rmSync(personalRoot, { recursive: true })
    }
  } catch {
    // leaving an empty directory behind is not worth failing the run
  }
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(empty, { recursive: true, force: true })
}

// an assertion that throws at the end must not leave test skills behind
process.on("exit", cleanup)

console.log("--- 根目录")
check("项目根是工作区下的 .agents/skills", projectSkillsDir(ws), path.join(ws, ".agents", "skills"))
check("空工作区没有项目根", projectSkillsDir("   "), undefined)
check("项目在前、个人在后", skillRoots(ws).map((root) => root.source), ["project", "personal"])
check("个人根紧邻 settings.json", personalSkillsDir(), path.join(path.dirname(dataFile), "skills"))
check("没有工作区时只剩个人根", skillRoots("").map((root) => root.source), ["personal"])
check("项目根随工作区变化", projectSkillsDir(path.join(ws, "other")), path.join(ws, "other", ".agents", "skills"))

console.log("--- 发现（两个根都要扫）")
const alphaDir = makeSkill(projectRoot, `${TAG}-alpha`, [
  `name: ${TAG}-alpha`,
  "description: project alpha description",
])
const personalDir = makeSkill(personalRoot, `${TAG}-personal`, [
  `name: ${TAG}-personal`,
  "description: personal skill description",
])

const alpha = listSkills(ws).find((skill) => skill.name === `${TAG}-alpha`)
check("项目 skill 被发现", Boolean(alpha), true)
check("来源标成 project", alpha?.source, "project")
check("目录指到工作区里那个", alpha?.dir, alphaDir)
check("描述解析正确", alpha?.description, "project alpha description")

const personal = listSkills(ws).find((skill) => skill.name === `${TAG}-personal`)
check("个人 skill 被发现", Boolean(personal), true)
check("来源标成 personal", personal?.source, "personal")
check("个人目录正确", personal?.dir, personalDir)

const names = listSkills(ws).map((skill) => skill.name)
check("按名字排序", [...names].sort((a, b) => a.localeCompare(b)), names)

console.log("--- 项目覆盖个人")
makeSkill(personalRoot, `${TAG}-alpha`, [`name: ${TAG}-alpha`, "description: personal twin that must lose"])
const shadowed = listSkills(ws).filter((skill) => skill.name === `${TAG}-alpha`)
check("重名只出现一次", shadowed.length, 1)
check("赢的是项目那份", shadowed[0]?.source, "project")
check("描述也取项目那份", shadowed[0]?.description, "project alpha description")

console.log("--- 坏数据要被跳过，而不是让整个列表挂掉")
makeSkill(projectRoot, `${TAG}-badname`, [`name: ${TAG}-BAD`, "description: uppercase is invalid"])
check(
  "非法名字（大写）被跳过",
  listSkills(ws).some((skill) => skill.name.startsWith(`${TAG}-bad`)),
  false,
)

const longName = "z".repeat(65)
makeSkill(projectRoot, `${TAG}-longname`, [`name: ${longName}`, "description: too long a name"])
check("超长名字被跳过", listSkills(ws).some((skill) => skill.name === longName), false)

makeSkill(projectRoot, `${TAG}-nodesc`, [`name: ${TAG}-nodesc`])
check("缺 description 被跳过", listSkills(ws).some((skill) => skill.name === `${TAG}-nodesc`), false)

rawSkill(projectRoot, `${TAG}-nofm`, "# no frontmatter here\n")
check("没有 frontmatter 被跳过", listSkills(ws).some((skill) => skill.name === `${TAG}-nofm`), false)

rawSkill(
  projectRoot,
  `${TAG}-bom`,
  `\uFEFF---\nname: ${TAG}-bom\ndescription: written with a byte order mark\n---\n\nbody\n`,
)
check(
  "带 BOM 的 SKILL.md 仍能解析",
  listSkills(ws).find((skill) => skill.name === `${TAG}-bom`)?.description,
  "written with a byte order mark",
)

fs.writeFileSync(path.join(projectRoot, "loose.md"), "not a skill", "utf8")
check("根目录下的散文件不算 skill", listSkills(ws).some((skill) => skill.name === "loose"), false)

console.log("--- 目录不存在时静默跳过")
check("不存在的项目根不报错", listSkills(empty).some((skill) => skill.source === "project"), false)

console.log("--- readSkill")
const read = readSkill(ws, `${TAG}-alpha`)
check("找得到", Boolean(read), true)
check("body 不含 frontmatter", read?.body.startsWith("---"), false)
check("body 含正文", read?.body.includes("the body text"), true)
check("body 不含 description 行", read?.body.includes("project alpha description"), false)
check("名字大小写不敏感", Boolean(readSkill(ws, `${TAG}-ALPHA`)), true)
check("未知名字返回 undefined", readSkill(ws, `${TAG}-missing`), undefined)
check("空名字返回 undefined", readSkill(ws, "   "), undefined)
check("路径穿越式的名字找不到", readSkill(ws, `../${TAG}-alpha`), undefined)

console.log("--- 注入 prompt 的只有名字和描述")
// enough long descriptions to blow the prompt budget on purpose
for (let index = 0; index < 8; index += 1) {
  makeSkill(projectRoot, `${TAG}-bulk${index}`, [
    `name: ${TAG}-bulk${index}`,
    `description: ${"d".repeat(900)}`,
  ])
}

const prompt = skillsForPrompt(ws)
check("列出名字", prompt.includes(`**${TAG}-alpha**`), true)
check("列出描述", prompt.includes("project alpha description"), true)
check("不含任何正文", prompt.includes("the body text"), false)
check(
  "别的项目根读不到这里的项目 skill",
  skillsForPrompt(empty).includes(`${TAG}-bulk`),
  false,
)

const omitted = /还有 (\d+) 个 skill/.exec(prompt)
check("描述太多时有省略提示", Boolean(omitted), true)
check("省略数量大于 0", omitted ? Number(omitted[1]) > 0 : false, true)
check(
  `总量被预算兜住（<= ${PROMPT_BUDGET_CHARS} + 200）`,
  prompt.length <= PROMPT_BUDGET_CHARS + 200,
  true,
)

console.log("--- skillLayout（依赖提示）")
const layoutDir = path.join(projectRoot, `${TAG}-layout`)
fs.mkdirSync(path.join(layoutDir, "references"), { recursive: true })
fs.mkdirSync(path.join(layoutDir, "scripts"), { recursive: true })
fs.writeFileSync(path.join(layoutDir, "references", "a.md"), "x", "utf8")
fs.writeFileSync(path.join(layoutDir, "scripts", "run.py"), "x", "utf8")
made.push(layoutDir)

check("列出 references/", skillLayout(layoutDir).entries.includes("references/"), true)
check("列出 scripts/", skillLayout(layoutDir).entries.includes("scripts/"), true)
check("没有依赖文件时不提示安装", skillLayout(layoutDir).install, null)

fs.writeFileSync(path.join(layoutDir, "package.json"), "{}", "utf8")
check("有 package.json 提示 npm install", skillLayout(layoutDir).install, "npm install")
fs.rmSync(path.join(layoutDir, "package.json"))
fs.writeFileSync(path.join(layoutDir, "requirements.txt"), "", "utf8")
check("有 requirements.txt 提示 pip", skillLayout(layoutDir).install, "pip install -r requirements.txt")
check("不存在的目录返回空", skillLayout(path.join(projectRoot, "does-not-exist")), {
  entries: [],
  install: null,
})

cleanup()
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
