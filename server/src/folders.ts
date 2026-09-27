import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { FolderNode } from "../../shared/protocol"
import { dataFile } from "./config"
import { logger } from "./log"

const storeFile = path.join(path.dirname(dataFile), "folders.json")

let cache: FolderNode[] | null = null

function read(): FolderNode[] {
  if (cache) return cache

  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8")) as unknown
    cache = Array.isArray(parsed)
      ? (parsed as FolderNode[]).filter(
          (node) => node && typeof node.id === "string" && typeof node.name === "string",
        )
      : []
  } catch {
    cache = []
  }

  return cache
}

function write(nodes: FolderNode[]): void {
  cache = nodes
  fs.mkdirSync(path.dirname(storeFile), { recursive: true })
  fs.writeFileSync(storeFile, `${JSON.stringify(nodes, null, 2)}\n`, "utf8")
}

function nextOrder(nodes: FolderNode[], parentID: string | null): number {
  const siblings = nodes.filter((node) => node.parentID === parentID)
  return siblings.reduce((max, node) => Math.max(max, node.order), -1) + 1
}

export function listFolders(): FolderNode[] {
  return [...read()].sort((a, b) => a.order - b.order)
}

export function getFolder(id: string): FolderNode | undefined {
  return read().find((node) => node.id === id)
}

export function createFolder(input: { name: string; parentID?: string | null }): FolderNode {
  const nodes = read()
  const parentID = input.parentID ?? null

  if (parentID && !nodes.some((node) => node.id === parentID)) {
    throw new Error(`Parent folder not found: ${parentID}`)
  }

  const node: FolderNode = {
    id: randomUUID(),
    name: input.name.trim() || "未命名",
    parentID,
    order: nextOrder(nodes, parentID),
  }

  write([...nodes, node])
  logger.info("folder", "created", { id: node.id, name: node.name, parentID })
  return node
}

export function updateFolder(id: string, patch: { name?: string; parentID?: string | null }): FolderNode | undefined {
  const nodes = read()
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) return undefined

  if (typeof patch.name === "string" && patch.name.trim()) node.name = patch.name.trim()

  if (patch.parentID !== undefined) {
    const parentID = patch.parentID

    if (parentID === id) throw new Error("A folder cannot be its own parent")
    if (parentID && !nodes.some((candidate) => candidate.id === parentID)) {
      throw new Error(`Parent folder not found: ${parentID}`)
    }
    // dropping a folder into its own subtree would orphan the whole branch
    if (parentID && isDescendant(nodes, parentID, id)) {
      throw new Error("Cannot move a folder into its own descendant")
    }

    if (node.parentID !== parentID) {
      node.parentID = parentID
      node.order = nextOrder(nodes, parentID)
    }
  }

  write(nodes)
  logger.info("folder", "updated", { id, name: node.name, parentID: node.parentID })
  return node
}

export function isDescendant(nodes: FolderNode[], candidateID: string, ancestorID: string): boolean {
  let cursor = nodes.find((node) => node.id === candidateID)

  while (cursor?.parentID) {
    if (cursor.parentID === ancestorID) return true
    cursor = nodes.find((node) => node.id === cursor?.parentID)
  }

  return false
}

export function childFolderIDs(id: string): string[] {
  return read()
    .filter((node) => node.parentID === id)
    .map((node) => node.id)
}

/** the folder plus every folder beneath it, breadth first */
export function descendantFolderIDs(id: string): string[] {
  const nodes = read()
  const collected = [id]
  const queue = [id]

  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const node of nodes) {
      if (node.parentID !== current) continue
      collected.push(node.id)
      queue.push(node.id)
    }
  }

  return collected
}

export function deleteFolder(id: string): FolderNode | undefined {
  const nodes = read()
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) return undefined

  write(nodes.filter((candidate) => candidate.id !== id))
  logger.info("folder", "deleted", { id, name: node.name })
  return node
}

export function ensureDefaultFolder(name: string): FolderNode {
  const existing = listFolders().find((node) => node.parentID === null)
  if (existing) return existing

  const created = createFolder({ name })
  logger.info("folder", "bootstrap default folder", { id: created.id, name: created.name })
  return created
}
