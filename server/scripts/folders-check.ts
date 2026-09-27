import fs from "node:fs"
import path from "node:path"
import { dataFile } from "../src/config"
import { childFolderIDs, createFolder, deleteFolder, descendantFolderIDs, ensureDefaultFolder, getFolder, isDescendant, listFolders, updateFolder } from "../src/folders"

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

function expectThrow(label: string, run: () => unknown, fragment: string) {
  try {
    run()
    check(label, "（没有抛错）", `包含 "${fragment}"`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(label, message.includes(fragment), true)
  }
}

// folders.ts resolves its store relative to the module, NOT to the process cwd. Computing
// this from process.cwd() pointed at server/.data, so the backup was taken from a file that
// never existed, the test mutated the real store, and the restore below never ran because
// the read at the end threw first. Derive it from the same source of truth.
const storeFile = path.join(path.dirname(dataFile), "folders.json")
const backup = fs.existsSync(storeFile) ? fs.readFileSync(storeFile) : null
fs.rmSync(storeFile, { force: true })

console.log("--- 创建与嵌套")
const rootA = createFolder({ name: "项目A" })
const rootB = createFolder({ name: "项目B" })
const child = createFolder({ name: "子目录", parentID: rootA.id })
const grand = createFolder({ name: "孙目录", parentID: child.id })

check("四个节点", listFolders().length, 4)
check("顶层 parentID 为 null", rootA.parentID, null)
check("子节点挂在父上", child.parentID, rootA.id)
check("孙节点挂在子上", grand.parentID, child.id)
check("childFolderIDs 只返回直接子级", childFolderIDs(rootA.id), [child.id])

console.log("--- 子树收集（删除时用它算波及范围）")
check(
  "descendantFolderIDs 含自己与全部后代",
  [...descendantFolderIDs(rootA.id)].sort(),
  [rootA.id, child.id, grand.id].sort(),
)
check("叶子节点只有自己", descendantFolderIDs(grand.id), [grand.id])
check("无关分支不受影响", descendantFolderIDs(rootB.id), [rootB.id])

console.log("--- 同级 order 递增")
check("第二个顶层节点 order=1", rootB.order, 1)
check("子节点 order 独立从 0 开始", child.order, 0)

console.log("--- 名称清洗")
check("空名回退", createFolder({ name: "   " }).name, "未命名")
check("首尾空格被去掉", createFolder({ name: "  有空格  " }).name, "有空格")

console.log("--- 循环嵌套必须被拒绝")
check("isDescendant: 孙在 A 之下", isDescendant(listFolders(), grand.id, rootA.id), true)
check("isDescendant: A 不在孙之下", isDescendant(listFolders(), rootA.id, grand.id), false)

expectThrow("把 A 拖进自己的孙节点", () => updateFolder(rootA.id, { parentID: grand.id }), "own descendant")
expectThrow("把自己设为自己的父节点", () => updateFolder(rootA.id, { parentID: rootA.id }), "own parent")
expectThrow("父节点不存在", () => updateFolder(child.id, { parentID: "nope" }), "Parent folder not found")
check("被拒后结构没变", getFolder(rootA.id)?.parentID, null)

console.log("--- 合法的移动")
updateFolder(grand.id, { parentID: rootB.id })
check("孙节点被移到 B 下", getFolder(grand.id)?.parentID, rootB.id)
updateFolder(grand.id, { parentID: null })
check("移回顶层", getFolder(grand.id)?.parentID, null)

console.log("--- 重命名")
updateFolder(rootB.id, { name: "项目B 改名" })
check("名字已改", getFolder(rootB.id)?.name, "项目B 改名")
updateFolder(rootB.id, { name: "   " })
check("空名不改动", getFolder(rootB.id)?.name, "项目B 改名")

console.log("--- 删除只删自己（上层负责拒绝非空）")
const parent = createFolder({ name: "待删父", parentID: null })
const kept = createFolder({ name: "子", parentID: parent.id })
const before = listFolders().length

check("删除返回被删节点", deleteFolder(parent.id)?.id, parent.id)
check("节点数减 1", listFolders().length, before - 1)
check("子节点还在（由调用方决定是否允许）", getFolder(kept.id)?.name, "子")
check("删除不存在的返回 undefined", deleteFolder("nope"), undefined)

console.log("--- 默认文件夹引导")
// deleting the file would not reset the in-memory cache, so empty it through the API
for (const folder of listFolders()) deleteFolder(folder.id)
check("清空成功", listFolders().length, 0)

const first = ensureDefaultFolder("工作区")
check("首次引导创建一个", listFolders().length, 1)
check("名字来自入参", first.name, "工作区")
check("是顶层节点", first.parentID, null)
const second = ensureDefaultFolder("另一个名字")
check("已有顶层节点时复用", second.id, first.id)
check("数量不变", listFolders().length, 1)

console.log("--- 持久化")
const onDisk = JSON.parse(fs.readFileSync(storeFile, "utf8")) as unknown[]
check("文件已写入", Array.isArray(onDisk), true)
check("文件里节点数与内存一致", onDisk.length, listFolders().length)

if (backup) fs.writeFileSync(storeFile, backup)
else fs.rmSync(storeFile, { force: true })

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
