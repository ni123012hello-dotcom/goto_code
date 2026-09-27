import fs from "node:fs/promises"
import { BINARY_SNIFF_BYTES, MAX_OUTPUT, MAX_READ_BYTES, READ_MAX_LINES } from "./agent/tools"
import { resolveInside, secretReason, truncate } from "./safety"

export type FilePreview = {
  path: string
  size: number
  text: string
  /** 1-based line the returned text starts at */
  startLine: number
  totalLines: number
  /** either the window stopped before the end of the file, or the text was cut at MAX_OUTPUT */
  truncated: boolean
  /** a NUL byte in the first block: the UI says so instead of rendering replacement characters */
  binary: boolean
}

async function looksBinary(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/** Read one workspace file for the read-only viewer the review seat uses.
 *
 *  Always confined to the workspace - `resolveInside` is called without allowOutside even when
 *  the conversation has full access. A reviewer's reach must not depend on the control seat's
 *  access mode, and this is that seat's only route to file contents.
 *
 *  The ceilings are imported from tools.ts rather than restated: 8MB before the file is loaded
 *  is an OOM bound (the whole file is read, then windowed), the NUL sniff decides text vs
 *  binary, and 400 lines / 20k chars bound the response. The implementation is deliberately not
 *  shared with the `read` tool, which also attaches images and numbers lines for the model -
 *  a different contract from a viewer, so sharing it would mean contorting both. */
export async function previewFile(workspace: string, relative: string, offset = 1): Promise<FilePreview> {
  const abs = resolveInside(workspace, relative || ".")

  // the same secret guard the agent's own tools use: this is the review seat's only route to
  // file contents, so a shared conversation must not become a way around it
  const secret = secretReason(abs)
  if (secret) throw new Error(`这个文件不提供预览：${secret}`)

  const stat = await fs.stat(abs)
  if (stat.isDirectory()) throw new Error("这是一个目录，不能作为文件预览")

  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_READ_BYTES / 1024 / 1024}MB 的预览上限`,
    )
  }

  if (await looksBinary(abs)) {
    return { path: relative, size: stat.size, text: "", startLine: 1, totalLines: 0, truncated: false, binary: true }
  }

  const raw = await fs.readFile(abs, "utf8")
  const lines = raw.split(/\r?\n/)
  const start = Math.max(0, Math.floor(offset) - 1)
  const end = Math.min(lines.length, start + READ_MAX_LINES)
  const body = truncate(lines.slice(start, end).join("\n"), MAX_OUTPUT)

  return {
    path: relative,
    size: stat.size,
    text: body.text,
    startLine: start + 1,
    totalLines: lines.length,
    truncated: end < lines.length || body.truncated,
    binary: false,
  }
}
