#!/usr/bin/env node
// `gt mcp ...` - manage MCP servers through the running goto server.
//
// There is no MCP panel in the web UI yet, and the one-time confirmation is exactly the kind of
// thing that must not be reachable only by hand-written curl. So this talks to the HTTP API,
// which means goto has to be running.
//
// Output is English on purpose: a cmd.exe console at the default code page mangles anything
// else, and that is where this command gets run.

const PORT = process.env.PORT || "8787"
const BASE = `http://127.0.0.1:${PORT}`

function help() {
  console.log(`
  gt mcp list              servers goto knows about, plus what other agents have
  gt mcp import [name...]  take servers from opencode / Claude / Cursor / VS Code
                           (imported servers are NOT confirmed - see 'confirm')
  gt mcp confirm <id>      approve this exact command line, once
                           add --force if its paths do not exist (it will not run anyway)
  gt mcp off <id>          stop running it, keep the approval
  gt mcp on <id>           start it again (needs an existing approval)
  gt mcp remove <id>       forget it entirely
  gt mcp help              this text

  A server never runs until it is confirmed here. Why: mcp.ts's trust model.
`)
}

async function api(pathname, options = {}) {
  let response
  try {
    response = await fetch(`${BASE}${pathname}`, options)
  } catch {
    throw new Error(`cannot reach goto on ${BASE} - is it running? (start it with \`gt\`)`)
  }

  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  return body
}

const json = (value, method = "PUT") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
})

function state(server, status) {
  const live = status.find((entry) => entry.id === server.id)
  if (server.needsTrust) return "NEEDS CONFIRM"
  if (!server.enabled) return "off"
  if (!live) return "starting"
  if (live.status === "failed") return `FAILED (${live.error ?? "unknown"})`
  if (live.status === "ready") return `ready, ${live.tools} tools`
  return live.status
}

async function show() {
  const { list, status, path } = await api("/api/mcp")
  console.log(`config: ${path}\n`)

  if (list.length === 0) {
    console.log("no servers configured")
  } else {
    console.log("configured:")
    for (const server of list) {
      console.log(`  ${server.id.padEnd(18)} ${state(server, status).padEnd(28)} ${[server.command, ...server.args].join(" ")}`)
    }
    if (list.some((server) => server.needsTrust)) {
      console.log("\nconfirm with: gt mcp confirm <id>   (approves one exact command line)")
    }
  }

  const { servers } = await api("/api/mcp/discover")
  const available = servers.filter((server) => !server.imported)
  if (available.length > 0) {
    console.log("\nfound in other agents' configs (not imported):")
    for (const server of available) {
      const detail = server.problem
        ? `SKIPPED: ${server.problem}`
        : [server.command, ...server.args].join(" ")
      console.log(`  ${server.name.padEnd(18)} ${detail}`)
      for (const warning of server.warnings) console.log(`  ${" ".repeat(18)} ! ${warning}`)
      if (server.from) console.log(`  ${" ".repeat(18)} from ${server.from}`)
    }
    console.log(`\nimport with: gt mcp import${available.some((s) => !s.problem) ? "" : " <name>"}`)
  }
}

async function main() {
  const [command = "list", ...rest] = process.argv.slice(2)

  if (command === "help" || command === "-h" || command === "--help") {
    help()
    return
  }

  if (command === "list" || command === "ls") {
    await show()
    return
  }

  if (command === "import") {
    const result = await api("/api/mcp/import", json(rest.length > 0 ? { names: rest } : {}, "POST"))
    if (result.imported.length > 0) console.log(`imported: ${result.imported.join(", ")}`)
    else console.log("nothing imported")
    for (const skipped of result.skipped) console.log(`skipped: ${skipped.name} - ${skipped.reason}`)
    console.log(`\nNothing imported is confirmed. Run: gt mcp confirm <id>`)
    return
  }

  const [id, ...extra] = rest
  if (!id) {
    console.error(`usage: gt mcp ${command} <id>`)
    process.exitCode = 1
    return
  }

  if (command === "confirm") {
    // the acknowledgement is this command: it approves the command line as it stands now.
    // --force is for definitions that provably cannot work (paths that do not exist).
    const force = extra.includes("--force")
    const result = await api("/api/mcp", json({ id, acknowledge: true, enabled: true, ...(force ? { force: true } : {}) }))
    const server = result.list.find((entry) => entry.id === id)
    if (!server) throw new Error(`no such server: ${id}`)
    console.log(`confirmed: ${server.id} -> ${[server.command, ...server.args].join(" ")}`)
    console.log("it will start on the next reload; check with: gt mcp list")
    return
  }

  if (command === "off") {
    await api("/api/mcp", json({ id, enabled: false }))
    console.log(`stopped: ${id} (approval kept, so 'gt mcp on' needs no re-confirm)`)
    return
  }

  if (command === "on") {
    const result = await api("/api/mcp", json({ id, enabled: true }))
    const server = result.list.find((entry) => entry.id === id)
    console.log(server?.needsTrust ? `still needs confirm: gt mcp confirm ${id}` : `started: ${id}`)
    return
  }

  if (command === "remove" || command === "rm") {
    await api(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" })
    console.log(`removed: ${id}`)
    return
  }

  console.error(`unknown command: ${command}`)
  help()
  process.exitCode = 1
}

main().catch((error) => {
  console.error(`[gt] ${error.message}`)
  process.exit(1)
})
