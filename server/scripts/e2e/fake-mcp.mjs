// A minimal MCP server over stdio, for tests.
//
// Speaks just enough JSON-RPC 2.0 to exercise the client: initialize, tools/list (paginated on
// purpose, so the cursor loop is covered) and tools/call. `--crash` makes it die immediately,
// which is how the "server is gone" path gets tested.
//
// It is also a well-behaved server in one specific way that matters: it exits when stdin
// closes, which is what the spec asks for and what makes stopMcpServers() able to reclaim the
// process even through a cmd.exe wrapper.

import readline from "node:readline"

if (process.argv.includes("--crash")) process.exit(3)

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "what to echo" } },
      required: ["text"],
    },
  },
  { name: "big", description: "Return far more text than the output bound allows.", inputSchema: { type: "object", properties: {} } },
  { name: "boom", description: "Always reports a tool error.", inputSchema: { type: "object", properties: {} } },
  { name: "hang", description: "Never answers.", inputSchema: { type: "object", properties: {} } },
]

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const rl = readline.createInterface({ input: process.stdin })
rl.on("close", () => process.exit(0))

rl.on("line", (line) => {
  if (!line.trim()) return

  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  const { id, method, params } = message

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      },
    })
    return
  }

  if (method === "notifications/initialized") return

  if (method === "tools/list") {
    // two pages, to prove the client follows nextCursor
    if (!params || !params.cursor) {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS.slice(0, 2), nextCursor: "page-2" } })
    } else {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS.slice(2) } })
    }
    return
  }

  if (method === "tools/call") {
    const name = params && params.name
    if (name === "hang") return // deliberately never answers
    if (name === "boom") {
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "boom: the server refused" }] } })
      return
    }
    if (name === "big") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "x".repeat(30_000) }] } })
      return
    }
    const text = params && params.arguments ? params.arguments.text : ""
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${text}` }] } })
    return
  }

  if (typeof method === "string" && id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method: ${method}` } })
  }
})
