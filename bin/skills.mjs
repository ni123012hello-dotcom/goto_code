#!/usr/bin/env node
// `gt skills <command>` - run the official skills CLI (vercel-labs/skills) against the
// workspace goto is configured to use, so skills land where the agent actually reads them.
//
// goto reads two roots (server/src/skills.ts): <workspace>/.agents/skills and <data>/skills.
// The CLI calls the first one the "universal" agent, so installs here are forced to
// -a universal. Project skills belong beside the code, so this targets the workspace and
// not the personal root - that is also why they travel with the repository.
//
// npx is invoked as `node <npx-cli.js>` rather than through a shell: the arguments come
// from the command line, and Node concatenates instead of escaping when a shell is in play.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DATA = path.join(ROOT, ".data")
const SKILLS_SUBDIR = path.join(".agents", "skills")

function readWorkspace() {
  try {
    // .env is a fallback for the stored setting, same precedence as server/src/settings.ts
    const envFile = path.join(ROOT, ".env")
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile)
  } catch {
    // an unreadable .env is not worth failing over
  }

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf8"))
    if (typeof raw?.workspace === "string" && raw.workspace.trim()) return path.resolve(raw.workspace.trim())
  } catch {
    // no settings yet: fall through to the environment, then the cwd
  }

  const fromEnv = process.env.WORKSPACE_DIR?.trim()
  return fromEnv ? path.resolve(fromEnv) : process.cwd()
}

function npxCli() {
  const bin = path.dirname(process.execPath)
  return [
    path.join(bin, "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ].find((candidate) => fs.existsSync(candidate))
}

function hasFlag(list, ...names) {
  return list.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)))
}

function help() {
  console.log(`
  gt skills add <repo|local path>   install skills into the configured workspace
                                    (forces -a universal --copy, which is where goto reads)
  gt skills list                    list installed skills
  gt skills remove [name]           uninstall
  gt skills update [name]           update
  gt skills find [query]            search
  gt skills help                    this text

  Anything after the command is forwarded to the official skills CLI:
    gt skills add vercel-labs/agent-skills
    gt skills add vercel-labs/agent-skills --skill web-design-guidelines
    gt skills list

  --workspace <dir>   target another workspace (default: the one in settings)
`)
}

const argv = process.argv.slice(2)
let sub = (argv.shift() ?? "").toLowerCase()

if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
  help()
  process.exit(0)
}

// our own flag, stripped before anything reaches the CLI
let workspaceOverride
const flags = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === "--workspace") {
    workspaceOverride = argv[index + 1]
    index += 1
    continue
  }
  if (arg.startsWith("--workspace=")) {
    workspaceOverride = arg.slice("--workspace=".length)
    continue
  }
  flags.push(arg)
}

const workspace = workspaceOverride ? path.resolve(workspaceOverride) : readWorkspace()

if (sub === "add") {
  if (flags.length === 0) {
    console.error("[gt] missing source: gt skills add <repo|local path>, e.g. gt skills add vercel-labs/agent-skills")
    process.exit(1)
  }
  // universal == .agents/skills, which is where goto looks; the rest are the CLI's defaults
  if (!hasFlag(flags, "-a", "--agent")) flags.push("-a", "universal")
  if (!hasFlag(flags, "--copy", "--no-copy")) flags.push("--copy")
  if (!hasFlag(flags, "-y", "--yes", "--all")) flags.push("-y")
} else if (["remove", "rm", "update"].includes(sub)) {
  if (!hasFlag(flags, "-a", "--agent")) flags.push("-a", "universal")
}

if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  console.error(`[gt] workspace does not exist: ${workspace}`)
  console.error(`[gt] set the workspace in the settings, or pass --workspace <dir>.`)
  process.exit(1)
}

const target = path.join(workspace, SKILLS_SUBDIR)
console.log(`[gt] workspace:  ${workspace}`)
console.log(`[gt] skill dir:  ${target}`)

const cli = npxCli()
const cliArgs = ["-y", "skills@latest", sub, ...flags]

if (!cli) {
  // no shell, so a missing npx-cli means we cannot run it safely - hand the user the command
  console.error("[gt] cannot find npm's npx-cli.js. Run it yourself:")
  console.error(`  cd "${workspace}"`)
  console.error(`  npx ${cliArgs.join(" ")}`)
  process.exit(1)
}

console.log(`[gt] npx ${["skills", ...cliArgs.slice(2)].join(" ")}\n`)

const result = spawnSync(process.execPath, [cli, ...cliArgs], { cwd: workspace, stdio: "inherit" })

if (result.status === 0 && sub === "add") {
  console.log(`\n[gt] done. goto re-reads the skill dir every turn, so the next one can use it.`)
}

process.exit(result.status ?? 1)
