import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { FilePart } from "../../shared/protocol"
import { config, dataFile } from "./config"
import { logger } from "./log"

const fileDir = path.join(path.dirname(dataFile), "files")

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

// rough: OpenAI bills a 1024x1024 image at ~1400 tokens. We do not parse real
// dimensions, so this is a flat stand-in used only for tail budgeting; the
// authoritative number always comes from the provider's reported usage.
export const IMAGE_TOKEN_ESTIMATE = 1_200

export function imageMimeFor(file: string): string | undefined {
  return IMAGE_MIME[path.extname(file).toLowerCase()]
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/")
}

export function sanitizeName(name: string): string {
  const base = path.basename(name || "file").replace(/[^\w.\-]+/g, "_")
  return base.slice(0, 80) || "file"
}

function filePath(fileID: string): string {
  // fileID is always a uuid we generated, but refuse anything path-like anyway
  const safe = fileID.replace(/[^A-Za-z0-9-]/g, "")
  return path.join(fileDir, safe)
}

export function storeFile(input: {
  data: Buffer
  mime: string
  filename: string
}): FilePart {
  const fileID = randomUUID()
  fs.mkdirSync(fileDir, { recursive: true })
  fs.writeFileSync(filePath(fileID), input.data)

  logger.info("file", "stored", {
    fileID,
    mime: input.mime,
    filename: input.filename,
    bytes: input.data.length,
  })

  return {
    id: randomUUID(),
    type: "file",
    mime: input.mime,
    filename: sanitizeName(input.filename),
    size: input.data.length,
    fileID,
  }
}

export function readFileBytes(fileID: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath(fileID))
  } catch {
    return undefined
  }
}

export function readFileBase64(fileID: string): string | undefined {
  return readFileBytes(fileID)?.toString("base64")
}

export function fileExists(fileID: string): boolean {
  return fs.existsSync(filePath(fileID))
}

// the mime is only recorded on the FilePart, so sniff it back from the bytes when
// serving. enough for the image formats the read tool and the upload endpoint accept.
export function sniffMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif"
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp"
  return "application/octet-stream"
}

export function maxUploadBytes(): number {
  return config.maxUploadBytes
}
