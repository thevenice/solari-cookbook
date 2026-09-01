/**
 * Fleet tools: see what is actually running, and clean up what shouldn't be.
 *
 * These exist because the interesting failure is not "my session leaked" — it
 * is "my session leaked three crashes ago and I have no idea". The gateway can
 * list every sandbox and desktop on the account, so `solari_gc` can release
 * orphans this process never created: the ones left behind when an MCP client
 * was force-quit, a laptop slept, or an earlier script forgot its `kill()`.
 *
 * `solari_gc` defaults to a dry run. A tool that destroys infrastructure should
 * make the model say so twice.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { Registry } from "../registry.js"
import { explain, failure, ms, text } from "../util.js"

export function registerAdminTools(server: McpServer, reg: Registry): void {
  server.registerTool(
    "solari_sessions",
    {
      title: "List sessions",
      description:
        "Show every session this server owns, plus every sandbox and desktop running on the Solari account — " +
        "including ones started by other processes. Call this first when anything reports a concurrency limit.",
      inputSchema: {
        account: z
          .boolean()
          .optional()
          .describe("Also query the gateway for account-wide sessions. Defaults to true."),
      },
      annotations: { title: "List sessions", readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }) => {
      const cfg = reg.config
      const mine = reg.list()
      const lines: string[] = []

      lines.push(
        `Owned by this server: ${mine.length}/${cfg.maxSessions} ` +
          `(idle reap ${ms(cfg.idleMs)}, hard ceiling ${ms(cfg.maxSessionMs)})`,
      )
      if (mine.length === 0) lines.push("  (none)")
      for (const s of mine) {
        lines.push(`  ${s.id}  ${s.kind.padEnd(7)}  age ${ms(s.ageMs).padStart(6)}  idle ${ms(s.idleMs).padStart(6)}  ${s.calls} calls  — ${s.note}`)
      }

      if (account !== false) {
        try {
          const owned = new Set(mine.map((s) => s.id))
          const rows: string[] = []
          let n = 0
          for await (const s of reg.apiClient().sandboxes.listAll({ state: "running" })) {
            n++
            const tag = owned.has(s.sandboxId) ? "ours" : "ORPHAN?"
            rows.push(`  ${s.sandboxId}  ${s.kind.padEnd(7)}  ${String(s.cpu)}cpu/${s.memMb}MiB  expires ${s.expiresAt}  [${tag}]`)
            if (n >= 100) break
          }
          lines.push("", `Running on the account (sandboxes + desktops): ${n}`)
          lines.push(...(rows.length ? rows : ["  (none)"]))
          lines.push(
            "",
            "Note: cloud browser sessions are not listed by this endpoint — it covers sandboxes and desktops only.",
          )
        } catch (err) {
          lines.push("", `Account-wide listing failed: ${explain(err)}`)
        }
      }
      return text(lines.join("\n"))
    },
  )

  server.registerTool(
    "solari_gc",
    {
      title: "Release orphaned sessions",
      description:
        "Find sandboxes and desktops running on the account that this server does not own — leftovers from crashed " +
        "processes or force-quit clients — and release them. Runs as a DRY RUN unless confirm is true.",
      inputSchema: {
        confirm: z.boolean().optional().describe("Actually kill them. Defaults to false (dry run)."),
        olderThanMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only consider sessions whose expiry is at least this far out; leaves fresh ones alone."),
      },
      annotations: { title: "Release orphaned sessions", readOnlyHint: false, destructiveHint: true },
    },
    async ({ confirm, olderThanMs }) => {
      try {
        const owned = new Set(reg.list().map((s) => s.id))
        const client = reg.apiClient()
        const orphans: Array<{ id: string; kind: string; expiresAt: string }> = []

        for await (const s of client.sandboxes.listAll({ state: "running" })) {
          if (owned.has(s.sandboxId)) continue
          if (olderThanMs) {
            const remaining = Date.parse(s.expiresAt) - Date.now()
            if (Number.isFinite(remaining) && remaining < olderThanMs) continue
          }
          orphans.push({ id: s.sandboxId, kind: s.kind, expiresAt: s.expiresAt })
          if (orphans.length >= 100) break
        }

        if (!orphans.length) return text("No orphaned sandboxes or desktops. Nothing to release.")

        const listing = orphans.map((o) => `  ${o.id}  ${o.kind}  expires ${o.expiresAt}`).join("\n")
        if (!confirm) {
          return text(
            `DRY RUN — ${orphans.length} session(s) not owned by this server:\n\n${listing}\n\n` +
              "These are still billing. Re-run with confirm: true to release them. " +
              "If another process on this account is legitimately using one, do not.",
          )
        }

        const results = await Promise.allSettled(orphans.map((o) => client.sandboxes.kill(o.id)))
        const ok = results.filter((r) => r.status === "fulfilled").length
        const failed = results.length - ok
        return text(
          `Released ${ok} session(s)${failed ? `, ${failed} failed` : ""}.\n\n${listing}`,
        )
      } catch (err) {
        return failure(explain(err))
      }
    },
  )
}
