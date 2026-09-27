import fs from "node:fs"
import path from "node:path"
import type { Message } from "../../shared/protocol"
import { toChatMessages } from "../src/agent/llm"
import { dataFile } from "../src/config"
import {
  IMAGE_TOKEN_ESTIMATE,
  fileExists,
  imageMimeFor,
  isImageMime,
  readFileBase64,
  readFileBytes,
  sanitizeName,
  sniffMime,
  storeFile,
} from "../src/files"
import type { Session } from "../src/sessions"

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

// smallest structurally-valid headers for each format
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)])
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(64, 1)])
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64, 2)])
const BMP = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(64, 5)])

const stored: string[] = []

console.log("--- 类型识别")
check("png 扩展名", imageMimeFor("a/b/shot.PNG"), "image/png")
check("jpeg 扩展名", imageMimeFor("x.jpeg"), "image/jpeg")
check("webp 扩展名", imageMimeFor("x.webp"), "image/webp")
check("文本文件不是图片", imageMimeFor("a.ts"), undefined)
check("image/ 前缀判定", isImageMime("image/png"), true)
check("非图片 mime", isImageMime("text/plain"), false)

console.log("--- magic bytes 嗅探")
check("png", sniffMime(PNG), "image/png")
check("jpeg", sniffMime(JPEG), "image/jpeg")
check("gif", sniffMime(GIF), "image/gif")
check("webp", sniffMime(WEBP), "image/webp")
check("bmp", sniffMime(BMP), "image/bmp")
check("未知内容回退", sniffMime(Buffer.from("hello world")), "application/octet-stream")

console.log("--- 文件名清洗")
check("剥掉目录", sanitizeName("../../etc/passwd"), "passwd")
check("剥掉 windows 路径", sanitizeName("C:\\Users\\x\\shot.png"), "shot.png")
check("空名回退", sanitizeName(""), "file")
check("非法字符替换", sanitizeName("a b*c?.png"), "a_b_c_.png")

console.log("--- 存取往返")
const part = storeFile({ data: PNG, mime: "image/png", filename: "shot.png" })
stored.push(part.fileID)
check("返回 file 类型", part.type, "file")
check("大小正确", part.size, PNG.length)
check("fileID 存在", fileExists(part.fileID), true)
check("未知 fileID 为 false", fileExists("does-not-exist"), false)
check("字节往返一致", readFileBytes(part.fileID)?.equals(PNG), true)
check("base64 往返一致", readFileBase64(part.fileID), PNG.toString("base64"))
check("不存在的文件读到 undefined", readFileBytes("nope"), undefined)

console.log("--- 关键设计：字节不进消息体")
const serialized = JSON.stringify(part)
check("序列化后不含 base64", serialized.includes(PNG.toString("base64")), false)
check("序列化后不含 data: 前缀", serialized.includes("data:image"), false)
check("但保留了 fileID 引用", serialized.includes(part.fileID), true)
console.log(`        ${serialized}`)

console.log("--- 多模态投递")
function sessionWithFile(): Session {
  const message: Message = {
    id: "m1",
    sessionID: "s",
    role: "user",
    createdAt: 0,
    parts: [{ id: "t1", type: "text", text: "看看这个截图" }, part],
  }
  return { id: "s", workspace: process.cwd(), messages: [message] } as unknown as Session
}

const projected = toChatMessages(sessionWithFile())
check("产出 1 条消息", projected.length, 1)
const content = projected[0].content
check("content 是数组（多模态）", Array.isArray(content), true)
const parts = content as { type: string; text?: string; image_url?: { url: string } }[]
check("第一段是文本", parts[0].type, "text")
check("第二段是图片", parts[1].type, "image_url")
check("图片是 data url", parts[1].image_url?.url.startsWith("data:image/png;base64,"), true)
check("data url 里就是原图字节", parts[1].image_url?.url.endsWith(PNG.toString("base64")), true)

console.log("--- 纯文本消息仍然走字符串（不额外开销）")
const plain = { id: "s", workspace: process.cwd(), messages: [{ id: "m", sessionID: "s", role: "user" as const, createdAt: 0, parts: [{ id: "t", type: "text" as const, text: "hi" }] }] } as unknown as Session
check("content 是字符串", typeof toChatMessages(plain)[0].content, "string")

console.log("--- 图片的 token 估算不是 0")
check("有常量兜底", IMAGE_TOKEN_ESTIMATE > 0, true)

  for (const fileID of stored) {
    // files.ts resolves its directory relative to the module, not the process cwd;
    // process.cwd() pointed at server/.data, so nothing was ever cleaned up here
    const guess = path.join(path.dirname(dataFile), "files", fileID)
    fs.rmSync(guess, { force: true })
  }
console.log(`\n清理了 ${stored.length} 个测试文件`)

console.log(failures === 0 ? "全部通过" : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
