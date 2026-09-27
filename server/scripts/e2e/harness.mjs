// Shared plumbing for the end-to-end scripts.
//
// These drive a real server over HTTP plus a fake OpenAI-compatible endpoint, because the
// unit suites cannot cover routes, SSE or the agent loop. See AGENTS.md section 8.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** repo root, derived from this file so nothing is tied to one machine */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

export const ENTRY = path.join(ROOT, "server", "src", "index.ts")

/** tsx is not a direct dependency, so find whichever version pnpm installed */
export function resolveTsx() {
  const base = path.join(ROOT, "node_modules", ".pnpm")
  if (!fs.existsSync(base)) throw new Error("node_modules missing — run pnpm install first")
  const hit = fs.readdirSync(base).find((name) => name.startsWith("tsx@"))
  if (!hit) throw new Error("tsx not found in node_modules/.pnpm — run pnpm install first")
  return path.join(base, hit, "node_modules", "tsx", "dist", "cli.mjs")
}
