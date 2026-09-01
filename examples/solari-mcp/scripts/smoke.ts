/**
 * End-to-end smoke test — drives the real server over the real MCP protocol
 * against the real Solari API. No mocks: if this passes, an agent client will
 * work too.
 *
 *   SOLARI_API_KEY=slr_live_... npm run smoke
 *
 * The last check is the one that matters most: after the client disconnects,
 * nothing may be left running on the account.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

// Load .env if present, so `npm run smoke` works with no shell ceremony.
// Twelve lines beats a dependency for one key.
try {
  const envFile = new URL("../.env", import.meta.url)
  const raw = await (await import("node:fs/promises")).readFile(envFile, "utf8")
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m?.[1] && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "")
  }
} catch {
  // no .env — rely on the ambient environment
}

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("SOLARI_API_KEY is not set. Put it in examples/solari-mcp/.env or export it.")
  process.exit(1)
}

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`)
  }
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
}

function isError(res: unknown): boolean {
  return Boolean((res as { isError?: boolean }).isError)
}

function idFrom(body: string, field: string): string {
  const m = body.match(new RegExp(`^${field}:\\s*(\\S+)`, "m"))
  if (!m?.[1]) throw new Error(`could not find ${field} in:\n${body}`)
  return m[1]
}

// Spawn the BUILT server, exactly as an MCP client would. Running the
// TypeScript sources directly would test a code path no user ever takes.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ...process.env, SOLARI_API_KEY: apiKey, SOLARI_MCP_MAX_SESSIONS: "2" } as Record<string, string>,
  stderr: "inherit",
})

const client = new Client({ name: "solari-mcp-smoke", version: "0.1.0" })

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args })
}

async function main(): Promise<void> {
  await client.connect(transport)

  console.log("\n== protocol ==")
  const { tools } = await client.listTools()
  check(`server exposes tools (${tools.length})`, tools.length >= 15)
  for (const expected of ["browser_open", "sandbox_start", "desktop_start", "solari_sessions", "solari_gc"]) {
    check(`tool ${expected} present`, tools.some((t) => t.name === expected))
  }

  console.log("\n== browser ==")
  const opened = await call("browser_open", { url: "https://example.com", note: "smoke" })
  check("browser_open succeeded", !isError(opened), textOf(opened))
  const browserId = idFrom(textOf(opened), "sessionId")

  const read = await call("browser_read", { sessionId: browserId, mode: "text" })
  check("browser_read returns page text", textOf(read).includes("Example Domain"), textOf(read).slice(0, 200))

  const links = await call("browser_read", { sessionId: browserId, mode: "links" })
  check("browser_read links mode works", !isError(links))

  const shot = await call("browser_screenshot", { sessionId: browserId })
  const shotContent = (shot as { content: Array<{ type: string }> }).content
  check("browser_screenshot returns an image", shotContent.some((c) => c.type === "image"))
  check("screenshot carries a capture timestamp", textOf(shot).includes("capturedAt"))

  console.log("\n== guardrails ==")
  const s1 = await call("sandbox_start", { note: "smoke-1" })
  check("sandbox_start succeeded", !isError(s1), textOf(s1))
  const sandboxId = idFrom(textOf(s1), "sandboxId")

  // Two sessions are open and the cap is two, so the third must be refused —
  // and refused BEFORE anything remote is created.
  const s2 = await call("sandbox_start", { note: "should-be-refused" })
  check("concurrency cap refuses the third session", isError(s2), textOf(s2).slice(0, 160))
  check("refusal names the open sessions", textOf(s2).includes(browserId) || textOf(s2).includes(sandboxId))

  const badSession = await call("browser_read", { sessionId: "does-not-exist", mode: "text" })
  check("unknown session id gives an actionable error", isError(badSession))

  console.log("\n== sandbox ==")
  // The gotcha: a naive `run("ls -la")` would look for a binary named "ls -la".
  const shellCmd = await call("sandbox_exec", { sandboxId, command: "echo hello | tr a-z A-Z" })
  check("sandbox_exec handles shell syntax", textOf(shellCmd).includes("HELLO"), textOf(shellCmd))

  const code1 = await call("sandbox_run_code", { sandboxId, code: "x = 6 * 7", language: "python" })
  check("sandbox_run_code accepts code", !isError(code1), textOf(code1))

  const wrote = await call("sandbox_files", { sandboxId, action: "write", path: "/tmp/smoke.txt", content: "ok\n" })
  check("sandbox_files write", !isError(wrote), textOf(wrote))
  const readBack = await call("sandbox_files", { sandboxId, action: "read", path: "/tmp/smoke.txt" })
  check("sandbox_files read round-trips", textOf(readBack).includes("ok"), textOf(readBack))

  console.log("\n== fleet visibility ==")
  const sessions = await call("solari_sessions", {})
  const sessionsText = textOf(sessions)
  check("solari_sessions lists the browser", sessionsText.includes(browserId))
  check("solari_sessions lists the sandbox", sessionsText.includes(sandboxId))

  console.log("\n== teardown ==")
  const closed = await call("browser_close", { sessionId: browserId })
  check("browser_close releases", !isError(closed), textOf(closed))
  const closedAgain = await call("browser_close", { sessionId: browserId })
  check("browser_close is idempotent", !isError(closedAgain))
  const stopped = await call("sandbox_stop", { sandboxId })
  check("sandbox_stop kills the VM", !isError(stopped), textOf(stopped))

  const after = await call("solari_sessions", {})
  check("no sessions owned after teardown", textOf(after).includes("Owned by this server: 0"), textOf(after).slice(0, 300))

  const gc = await call("solari_gc", {})
  check(
    "no orphans left on the account",
    textOf(gc).includes("No orphaned"),
    textOf(gc).slice(0, 400),
  )

  await client.close()

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

main().catch(async (err) => {
  console.error("\nsmoke run threw:", err)
  await client.close().catch(() => {})
  process.exit(1)
})
