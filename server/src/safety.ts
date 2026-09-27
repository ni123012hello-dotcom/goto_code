import path from "node:path"
import { dataFile } from "./config"

export function resolveInside(root: string, target: string, allowOutside = false): string {
  const abs = path.resolve(root, target)
  if (allowOutside) return abs

  const rel = path.relative(root, abs)
  if (rel === "") return abs
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to touch path outside the workspace: ${target}. ` +
        `Use a path inside ${root}, or ask the user to switch file access to 完全访问 below the input bar.`,
    )
  }
  return abs
}

export function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/")
}

/** Turns a user-supplied relative path into something safe to join under a root.
 *  Drops drive letters, leading slashes and every "." / ".." segment — a dropped folder
 *  can contain arbitrarily nested paths, and each segment has to survive on its own.
 *  Returns "" when nothing usable is left. */
export function safeRelativePath(raw: string): string {
  return String(raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    // eslint-disable-next-line no-control-regex
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_"))
    .join("/")
}

export type SecretAccess = "read" | "write"

// a fresh .env is a normal setup step; .env.example and friends are templates people commit
const ENV_ALLOWED_SUFFIXES = [".example", ".sample", ".template", ".dist"]

/** Why this path must never reach the model, or null when it is fine.
 *
 *  Two families:
 *   - goto's own .data store: settings.json holds the API key, providers.json holds one per
 *     saved endpoint, mcp.json's env holds server tokens. Nothing in there is ever something
 *     the agent needs, yet when the workspace IS this repository the directory sits inside the
 *     workspace, so "workspace-limited" does not keep it out.
 *   - .env files: the conventional place a project keeps its secrets.
 *
 *  This is NOT a security boundary and must not be described as one. `bash` is a shell and can
 *  read anything, which is precisely why it stays behind a permission prompt. What this closes
 *  is the *silent* channel: read/list/grep/write/edit never ask, so those are what an injected
 *  page (fetch, or an MCP server's output) would use to walk the key out.
 *
 *  `access` exists because writing a fresh .env leaks nothing while reading one is the whole
 *  attack. It defaults to the restrictive answer, so a caller that forgets it fails safe. */
export function secretReason(absolute: string, access: SecretAccess = "read"): string | null {
  const dataDir = path.dirname(dataFile)
  const relative = path.relative(dataDir, absolute)
  const insideData = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  if (insideData) {
    // .data/skills is exempt: it is user-authored instruction content, not a secret store.
    // The skill tool hands the model that directory precisely so it can read references/
    // and run scripts/ with the normal tools, so blocking it broke personal skills.
    const withinSkills = path.relative(path.join(dataDir, "skills"), absolute)
    const insideSkills = withinSkills === "" || (!withinSkills.startsWith("..") && !path.isAbsolute(withinSkills))
    if (!insideSkills) return "goto 自己的数据目录（settings / providers / mcp 里存着密钥）"
  }

  if (access === "write") return null

  const name = path.basename(absolute).toLowerCase()
  const envFile = name === ".env" || name.startsWith(".env.")
  if (envFile && !ENV_ALLOWED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return "环境变量文件（通常存放密钥）"
  }

  return null
}

export const IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/.next/**",
  "**/build/**",
  "**/.goto/**",
]

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`, truncated: true }
}
