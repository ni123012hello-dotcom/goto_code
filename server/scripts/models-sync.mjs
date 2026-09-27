#!/usr/bin/env node
// Refreshes the vendored model registry.
//
// goto ships no model dataset of its own: the numbers live in models.dev, an open MIT
// database of context windows, output caps and prices. Without it every model falls back to
// one global guess (128k / 4096), which is wrong for nearly all of them - a small local
// model gets a budget three times its real window, and a 1M-window model compacts for no
// reason.
//
// The file is COMMITTED (not fetched at runtime) so the app stays offline: this project's
// first promise is that it talks to nothing except the endpoint you configured. Run this
// only when you want newer numbers.
//
//   pnpm -C server models:sync
//
// Writes the upstream bytes VERBATIM, so the committed file is byte-identical to
// https://models.dev/api.json and a refresh is a clean diff.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SOURCE = "https://models.dev/api.json"
const LICENSE = "MIT, Copyright (c) 2025 models.dev"

const vendorDir = fileURLToPath(new URL("../vendor/", import.meta.url))
const dataFile = path.join(vendorDir, "models.dev.json")
const metaFile = path.join(vendorDir, "models.dev.meta.json")

const response = await fetch(SOURCE)
if (!response.ok) {
  console.error(`[models] ${SOURCE} returned ${response.status} ${response.statusText}`)
  process.exit(1)
}

const text = await response.text()
let parsed
try {
  parsed = JSON.parse(text)
} catch (error) {
  console.error(`[models] response is not JSON: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

// Refuse to write something that is not the shape we expect. A truncated download or an
// error page that happens to parse would silently poison every budget in the app.
const providers = Object.keys(parsed)
if (providers.length < 50) {
  console.error(`[models] only ${providers.length} providers - that is not the real file, refusing to write`)
  process.exit(1)
}
let models = 0
for (const provider of providers) models += Object.keys(parsed[provider]?.models ?? {}).length
if (models < 500) {
  console.error(`[models] only ${models} models - that is not the real file, refusing to write`)
  process.exit(1)
}

fs.mkdirSync(vendorDir, { recursive: true })
fs.writeFileSync(dataFile, text, "utf8")

// The upstream file carries no generation date, so the UI cannot tell how stale it is
// without this sidecar.
fs.writeFileSync(
  metaFile,
  `${JSON.stringify(
    {
      source: SOURCE,
      license: LICENSE,
      fetchedAt: new Date().toISOString().slice(0, 10),
      providers: providers.length,
      models,
      bytes: Buffer.byteLength(text, "utf8"),
    },
    null,
    2,
  )}\n`,
  "utf8",
)

console.log(`[models] wrote ${path.relative(process.cwd(), dataFile)}`)
console.log(`[models] ${providers.length} providers, ${models} models, ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB`)
console.log(`[models] meta: ${JSON.stringify(JSON.parse(fs.readFileSync(metaFile, "utf8")))}`)
