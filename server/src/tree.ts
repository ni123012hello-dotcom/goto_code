import fs from "node:fs"
import path from "node:path"
import { resolveInside } from "./safety"

// directories that would drown the tree and are never the thing you are looking for
const SKIP = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  ".data",
])

export type TreeNode = {
  name: string
  path: string
  type: "file" | "directory"
  size?: number
}

function readEntries(
  absolute: string,
  toPath: (name: string) => string,
  limit: number,
): { nodes: TreeNode[]; truncated: boolean } {
  const stat = fs.statSync(absolute)
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${absolute}`)

  const nodes: TreeNode[] = []

  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue

    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: toPath(entry.name), type: "directory" })
      continue
    }

    if (!entry.isFile()) continue

    let size: number | undefined
    try {
      size = fs.statSync(path.join(absolute, entry.name)).size
    } catch {
      size = undefined
    }

    nodes.push({ name: entry.name, path: toPath(entry.name), type: "file", size })
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  })

  return { nodes: nodes.slice(0, limit), truncated: nodes.length > limit }
}

export function listDirectory(
  workspace: string,
  relative: string,
  limit: number,
): { nodes: TreeNode[]; truncated: boolean; absolute: string } {
  // resolveInside throws when the path escapes the workspace, which is the whole
  // point of routing every workspace listing through it
  const absolute = resolveInside(workspace, relative || ".")
  const listing = readEntries(absolute, (name) => (relative ? `${relative}/${name}` : name), limit)
  return { ...listing, absolute }
}
