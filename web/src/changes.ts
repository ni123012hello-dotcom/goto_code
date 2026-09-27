import type { Message, ToolPart } from "@shared/protocol"

export type ChangeKind = "new" | "modified" | "failed"
export type ChangedFile = { kind: ChangeKind; count: number }

/** One write/edit the agent performed, with the patch it produced. */
export type ChangeEntry = {
  /** the part id, stable across re-renders */
  id: string
  /** workspace-relative, forward slashes - the same spelling the file tree uses */
  path: string
  tool: string
  kind: ChangeKind
  diff?: string
  error?: string
}

/** The tree keys nodes by a workspace-relative path with forward slashes, but a tool call
 *  may pass "src\\a.ts", "./src/a.ts" or an absolute path in full-access mode. Map the
 *  tool's spelling onto the tree's, and drop anything we cannot place. */
export function normalizeWorkspacePath(raw: string, workspace: string): string | null {
  let value = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  if (!value) return null

  const root = workspace.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (root && value.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    value = value.slice(root.length + 1)
  } else if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) {
    // absolute and not under the workspace: nothing in the tree to mark
    return null
  }

  return value.replace(/\/+$/, "")
}

function isWriteOrEdit(part: Message["parts"][number]): part is ToolPart {
  return part.type === "tool" && (part.tool === "write" || part.tool === "edit")
}

function kindOf(part: ToolPart): ChangeKind {
  if (part.status === "error") return "failed"
  // write reports "Created X" or "Updated X" in its output; edit only ever modifies
  if (part.tool === "edit" || !(part.output ?? "").startsWith("Created")) return "modified"
  return "new"
}

/** Every write/edit in the transcript, oldest first. Both shells derive their picture of
 *  "what the agent just wrote" from this, so they can never disagree. */
export function changesOf(messages: Message[], workspace: string): ChangeEntry[] {
  const entries: ChangeEntry[] = []

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isWriteOrEdit(part)) continue

      const raw = (part.input as { path?: unknown } | undefined)?.path
      if (typeof raw !== "string") continue
      const path = normalizeWorkspacePath(raw, workspace)
      if (!path) continue

      entries.push({ id: part.id, path, tool: part.tool, kind: kindOf(part), diff: part.diff, error: part.error })
    }
  }

  return entries
}

/** The same set collapsed per file, which is what the tree marks rows with. */
export function changedFilesOf(messages: Message[], workspace: string): Map<string, ChangedFile> {
  const map = new Map<string, ChangedFile>()

  for (const entry of changesOf(messages, workspace)) {
    const previous = map.get(entry.path)
    map.set(entry.path, {
      // a failure anywhere in the file's history keeps the row flagged
      kind: previous?.kind === "failed" || entry.kind === "failed" ? "failed" : entry.kind,
      count: (previous?.count ?? 0) + 1,
    })
  }

  return map
}

/** Grows on every write/edit, which is what makes the tree refetch while the agent works. */
export function fileRevisionOf(messages: Message[]): number {
  return messages.reduce(
    (total, message) => total + message.parts.filter(isWriteOrEdit).length,
    0,
  )
}
