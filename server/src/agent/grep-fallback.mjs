// The JavaScript fallback for the grep tool, run in its own process.
//
// Why a separate process: the pattern comes from the model, and a RegExp test cannot be
// interrupted. A pattern with catastrophic backtracking - (a+)+$ against a long line - would
// freeze the server's event loop and nothing else could run, including the UI that would let the
// user stop it. In its own process the worst case is this child being killed.
//
// Invoked as: node grep-fallback.mjs <root> <pattern> <include|""> <ignoredJson>
// Writes one JSON object to stdout. Arguments arrive as argv entries (no shell), so the pattern
// is never re-parsed as anything but data.

import fs from "node:fs/promises"
import path from "node:path"
import fg from "fast-glob"

const [root, pattern, include, ignoredJson] = process.argv.slice(2)

const MAX_FILES = 2000
const MAX_HITS = 200
// A long line is where backtracking gets expensive, so no single test sees more than this
const MAX_LINE = 4000

try {
  const re = new RegExp(pattern)
  const ignore = JSON.parse(ignoredJson || "[]")

  const files = await fg(include || "**/*", { cwd: root, ignore, onlyFiles: true, suppressErrors: true })
  const hits = []

  for (const file of files.slice(0, MAX_FILES)) {
    if (hits.length >= MAX_HITS) break

    let content
    try {
      content = await fs.readFile(path.join(root, file), "utf8")
    } catch {
      continue // unreadable files are not a grep failure
    }

    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const subject = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line
      if (re.test(subject)) {
        hits.push(`${file}:${index + 1}: ${subject.trim()}`)
        if (hits.length >= MAX_HITS) break
      }
    }
  }

  process.stdout.write(JSON.stringify({ hits }))
} catch (error) {
  // includes "Invalid regular expression: ..." from new RegExp
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
}
