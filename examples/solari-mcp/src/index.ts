#!/usr/bin/env node
/**
 * solari-mcp — Solari's cloud browsers, sandboxes and desktops as MCP tools.
 *
 * The entry point's real job is the shutdown contract. An MCP server over stdio
 * does not get a graceful goodbye: the client force-quits it when the user
 * closes the app, the terminal, or the laptop lid. Every one of those paths has
 * to end with the remote VMs released, because none of them end with the user
 * remembering to.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { loadConfig } from "./config.js"
import { Registry } from "./registry.js"
import { registerAdminTools } from "./tools/admin.js"
import { registerBrowserTools } from "./tools/browser.js"
import { registerDesktopTools } from "./tools/desktop.js"
import { registerSandboxTools } from "./tools/sandbox.js"

// stdout is the MCP wire protocol. Anything printed there corrupts the stream,
// so all logging goes to stderr — including from libraries that don't know that.
const log = (s: string) => process.stderr.write(`[solari-mcp] ${s}\n`)

async function main(): Promise<void> {
  const config = loadConfig()
  const registry = new Registry(config)

  const server = new McpServer(
    { name: "solari-mcp", version: "0.1.0" },
    {
      instructions:
        "Solari gives you three kinds of remote machine. Pick by what you need:\n" +
        "  • a WEB PAGE → browser_* (scraping, forms, anything Playwright would do)\n" +
        "  • to RUN CODE → sandbox_* (an isolated Linux microVM, boots in ~1s)\n" +
        "  • a SCREEN → desktop_* (GUI apps, computer use, anything that must be clicked)\n\n" +
        "These are real, billable VMs. Close what you open — browser_close, sandbox_stop, desktop_stop — " +
        "rather than leaving a session for the reaper. If a call reports a concurrency limit, do not retry it: " +
        "call solari_sessions to see what is running, then solari_gc to release orphans.",
    },
  )

  registerBrowserTools(server, registry)
  registerSandboxTools(server, registry)
  registerDesktopTools(server, registry)
  registerAdminTools(server, registry)

  registry.start()

  // --- the shutdown contract -------------------------------------------------
  let closing = false
  const teardown = async (why: string, code: number) => {
    if (closing) return
    closing = true
    log(`${why} — releasing sessions`)
    await registry.shutdown()
    process.exit(code)
  }

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => void teardown(sig, 0))
  }
  // The client closing the pipe is the normal way this server dies. It arrives
  // as EOF on stdin, not as a signal, and it is the single most likely moment
  // for a VM to be orphaned.
  process.stdin.on("close", () => void teardown("stdin closed", 0))
  process.stdin.on("end", () => void teardown("stdin ended", 0))

  process.on("uncaughtException", (err) => {
    log(`uncaught exception: ${String(err)}`)
    void teardown("uncaught exception", 1)
  })
  process.on("unhandledRejection", (err) => {
    log(`unhandled rejection: ${String(err)}`)
    void teardown("unhandled rejection", 1)
  })

  await server.connect(new StdioServerTransport())
  log(
    `ready — max ${config.maxSessions} concurrent, idle reap ${config.idleMs}ms, hard ceiling ${config.maxSessionMs}ms`,
  )
}

main().catch((err) => {
  process.stderr.write(`[solari-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
