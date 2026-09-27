import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listDirectory } from "../src/tree"

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

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goto-tree-"))
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true })
  fs.mkdirSync(path.join(root, "docs"), { recursive: true })
  fs.mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true })
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  fs.mkdirSync(path.join(root, "dist"), { recursive: true })

  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const a = 1\n")
  fs.writeFileSync(path.join(root, "src", "lib", "util.ts"), "export const b = 2\n")
  fs.writeFileSync(path.join(root, "docs", "readme.md"), "hi\n")
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n')
  fs.writeFileSync(path.join(root, "README.md"), "# x\n")
  fs.writeFileSync(path.join(root, "node_modules", "junk", "index.js"), "junk\n")

  return root
}

const root = workspace()

console.log("--- 根目录列举")
const listing = listDirectory(root, "", 400)
const names = listing.nodes.map((node) => `${node.type === "directory" ? "d" : "f"}:${node.name}`)
console.log(`        ${names.join("  ")}`)
check("目录排在文件前面", names.slice(0, 2), ["d:docs", "d:src"])
check("跳过了 node_modules", names.some((name) => name.includes("node_modules")), false)
check("跳过了 .git", names.some((name) => name.includes(".git")), false)
check("跳过了 dist", names.some((name) => name.includes("dist")), false)
check("文件都列出来了", names.filter((name) => name.startsWith("f:")).sort(), [
  "f:README.md",
  "f:package.json",
])
check("没有截断", listing.truncated, false)

console.log("--- 子目录")
const src = listDirectory(root, "src", 400)
check("列出 src 下的目录和文件", src.nodes.map((node) => node.name), ["lib", "index.ts"])
check("返回了绝对路径", path.resolve(src.absolute), path.resolve(root, "src"))

const nested = listDirectory(root, "src/lib", 400)
check("嵌套目录也能列", nested.nodes.map((node) => node.name), ["util.ts"])

console.log("--- 文件大小")
const pkg = listing.nodes.find((node) => node.name === "package.json")
check("文件带 size", pkg?.size, fs.statSync(path.join(root, "package.json")).size)
const dir = listing.nodes.find((node) => node.name === "src")
check("目录不带 size", dir?.size, undefined)

console.log("--- 路径逃逸被拒绝")
let escaped = "（没有抛错）"
try {
  listDirectory(root, "../", 400)
} catch (error) {
  escaped = error instanceof Error ? error.message : String(error)
}
check("上级目录被拒", escaped.startsWith("Refusing"), true)
console.log(`        ${escaped}`)

let deep = "（没有抛错）"
try {
  listDirectory(root, "src/../../..", 400)
} catch (error) {
  deep = error instanceof Error ? error.message : String(error)
}
check("多层穿越被拒", deep.startsWith("Refusing"), true)

console.log("--- 非目录被拒绝")
let notDir = "（没有抛错）"
try {
  listDirectory(root, "package.json", 400)
} catch (error) {
  notDir = error instanceof Error ? error.message : String(error)
}
check("对文件调用被拒", notDir.startsWith("Not a directory"), true)

console.log("--- 截断")
const limited = listDirectory(root, "", 1)
check("只返回 1 条", limited.nodes.length, 1)
check("标记为已截断", limited.truncated, true)

console.log("--- 不存在的目录")
let missing = "（没有抛错）"
try {
  listDirectory(root, "nope", 400)
} catch {
  missing = "threw"
}
check("抛错", missing, "threw")

fs.rmSync(root, { recursive: true, force: true })

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
