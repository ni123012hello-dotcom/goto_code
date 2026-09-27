import fs from "node:fs/promises"
import path from "node:path"

export type ProjectFacts = {
  name?: string
  packageManager?: string
  languages: string[]
  scripts: Record<string, string>
}

const LOCKFILES: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
]

const LANGUAGE_MARKERS: [string, string][] = [
  ["tsconfig.json", "TypeScript"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["pom.xml", "Java"],
  ["build.gradle", "Java/Kotlin"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
]

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export async function probeWorkspace(workspace: string): Promise<ProjectFacts> {
  const facts: ProjectFacts = { languages: [], scripts: {} }

  const pkg = await readJson(path.join(workspace, "package.json"))
  if (pkg) {
    if (typeof pkg.name === "string") facts.name = pkg.name
    const scripts = pkg.scripts
    if (scripts && typeof scripts === "object") {
      for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
        if (typeof value === "string") facts.scripts[key] = value
      }
    }
  }

  for (const [file, manager] of LOCKFILES) {
    if (await exists(path.join(workspace, file))) {
      facts.packageManager = manager
      break
    }
  }

  for (const [file, language] of LANGUAGE_MARKERS) {
    if (await exists(path.join(workspace, file))) facts.languages.push(language)
  }

  return facts
}

export function formatProjectFacts(facts: ProjectFacts): string {
  const lines: string[] = []

  if (facts.name) lines.push(`- project name: ${facts.name}`)
  if (facts.packageManager) lines.push(`- package manager: ${facts.packageManager}`)
  if (facts.languages.length > 0) lines.push(`- languages: ${[...new Set(facts.languages)].join(", ")}`)

  const scripts = Object.entries(facts.scripts)
  if (scripts.length > 0) {
    const runner = facts.packageManager ?? "npm"
    const rendered = scripts
      .slice(0, 12)
      .map(([name]) => `${runner} run ${name}`)
      .join(", ")
    lines.push(`- available scripts: ${rendered}`)
  }

  return lines.join("\n")
}
