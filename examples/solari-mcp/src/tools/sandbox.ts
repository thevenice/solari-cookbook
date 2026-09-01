/**
 * Sandbox tools — a microVM for running code the agent wrote.
 *
 * The gotcha this file exists to absorb: `commands.run(cmd, { args })` is NOT
 * shell-interpreted. `run("ls -la")` looks for a binary literally named
 * "ls -la" and fails with ENOENT. A model will write that line on its first
 * try, every time. So `sandbox_exec` takes a `command` string and a `shell`
 * flag, and when `shell` is on (the default, because it is what a model means)
 * it runs `sh -c` explicitly.
 */

import { z } from "zod"
import type { Sandbox } from "@solarisdk/sdk"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { Registry } from "../registry.js"
import { clip, explain, failure, fields, text } from "../util.js"

const KIND = "sandbox" as const

export function registerSandboxTools(server: McpServer, reg: Registry): void {
  server.registerTool(
    "sandbox_start",
    {
      title: "Start a sandbox",
      description:
        "Boot a Solari sandbox — an isolated Linux microVM, ready in about a second. Use it to run code, " +
        "process data, or execute anything untrusted. Returns a sandboxId. Always finish with sandbox_stop.",
      inputSchema: {
        template: z.string().optional().describe('Template id. Defaults to "base".'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Solari-side rolling idle window. Note solari-mcp also enforces a hard lifetime ceiling."),
        envs: z.record(z.string(), z.string()).optional().describe("Environment variables injected into the guest."),
        note: z.string().optional().describe("Short human label, shown in solari_sessions."),
      },
      annotations: { title: "Start a sandbox", readOnlyHint: false, openWorldHint: true },
    },
    async ({ template, timeoutMs, envs, note }) => {
      try {
        reg.assertCapacity()
        const sandbox = await reg.apiClient().sandboxes.create({
          template: template ?? "base",
          timeoutMs: timeoutMs ?? 10 * 60_000,
          ...(envs ? { envs } : {}),
        })
        try {
          // Opens the control channel. Files, git and code.run need it; a bare
          // command could take the one-shot HTTP path, but every session here
          // will want files sooner or later.
          await sandbox.connect()
        } catch (err) {
          await sandbox.kill().catch(() => {})
          throw err
        }

        const id = sandbox.sandboxId
        // kill(), not close(). close() would drop only our local control channel
        // and leave the VM running until its idle timeout.
        reg.register(KIND, id, note ?? template ?? "base", async () => {
          await sandbox.kill()
        })
        reg.attach(id, sandbox)
        return text(fields({ sandboxId: id, template: template ?? "base", expiresAt: sandbox.expiresAt }))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "sandbox_exec",
    {
      title: "Run a command",
      description:
        "Run a shell command in the sandbox and return its exit code, stdout and stderr. " +
        "Pipes, globs and redirection work by default (the command runs under `sh -c`).",
      inputSchema: {
        sandboxId: z.string(),
        command: z.string().describe('Full command line, e.g. "pip install httpx && python -c \'import httpx\'".'),
        shell: z
          .boolean()
          .optional()
          .describe("Run under `sh -c`. Defaults to true. Set false to exec a binary directly with argv."),
        args: z.array(z.string()).optional().describe("argv, used only when shell is false."),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
      annotations: { title: "Run a command", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ sandboxId, command, shell, args, cwd, timeoutMs }) => {
      try {
        const sandbox = reg.handleFor<Sandbox>(sandboxId, KIND)
        const useShell = shell ?? true
        const res = useShell
          ? await sandbox.commands.run("sh", {
              args: ["-c", command],
              ...(cwd ? { cwd } : {}),
              ...(timeoutMs ? { timeoutMs } : {}),
            })
          : await sandbox.commands.run(command, {
              ...(args ? { args } : {}),
              ...(cwd ? { cwd } : {}),
              ...(timeoutMs ? { timeoutMs } : {}),
            })
        const max = reg.config.maxChars
        const parts = [`exit: ${res.exitCode}`]
        if (res.stdout.trim()) parts.push(`--- stdout ---\n${res.stdout.trimEnd()}`)
        if (res.stderr.trim()) parts.push(`--- stderr ---\n${res.stderr.trimEnd()}`)
        if (!res.stdout.trim() && !res.stderr.trim()) parts.push("(no output)")
        return text(clip(parts.join("\n"), max))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "sandbox_run_code",
    {
      title: "Run code in a kernel",
      description:
        "Execute code in a stateful kernel — variables, imports and dataframes persist across calls with the same " +
        "contextId. This is the right tool for iterative analysis; sandbox_exec is the right tool for one-off commands. " +
        "matplotlib figures come back as structured chart data alongside the image.",
      inputSchema: {
        sandboxId: z.string(),
        code: z.string(),
        language: z.enum(["python", "javascript", "typescript", "bash", "r"]).optional(),
        contextId: z.string().optional().describe("Reuse a kernel from a previous call to keep state."),
      },
      annotations: { title: "Run code in a kernel", readOnlyHint: false, destructiveHint: true },
    },
    async ({ sandboxId, code, language, contextId }) => {
      try {
        const sandbox = reg.handleFor<Sandbox>(sandboxId, KIND)
        let stdout = ""
        let stderr = ""
        const res = await sandbox.runCode(code, {
          ...(language ? { language } : {}),
          ...(contextId ? { contextId } : {}),
          onStdout: (d) => (stdout += d),
          onStderr: (d) => (stderr += d),
        })

        const parts: string[] = []
        if (res.error) {
          const e = res.error
          parts.push(typeof e === "string" ? `error: ${e}` : `error: ${e.name ?? "Error"}: ${e.message ?? ""}`)
          if (typeof e !== "string" && e.traceback) parts.push(e.traceback)
        }
        if (stdout.trim()) parts.push(`--- stdout ---\n${stdout.trimEnd()}`)
        if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.trimEnd()}`)
        for (const item of res.results ?? []) {
          const keys = Object.keys(item as unknown as Record<string, unknown>).filter((k) => k !== "png")
          if (keys.length) parts.push(`--- result ---\n${clip(JSON.stringify(item, null, 2), 2000)}`)
        }
        if (res.charts?.length) parts.push(`charts: ${res.charts.map((c) => c.type).join(", ")}`)
        if (!parts.length) parts.push("(no output)")
        return text(clip(parts.join("\n"), reg.config.maxChars))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "sandbox_files",
    {
      title: "Sandbox files",
      description: "Read, write or list files inside the sandbox.",
      inputSchema: {
        sandboxId: z.string(),
        action: z.enum(["read", "write", "list", "mkdir", "remove"]),
        path: z.string(),
        content: z.string().optional().describe("Required for write."),
      },
      annotations: { title: "Sandbox files", readOnlyHint: false, destructiveHint: true },
    },
    async ({ sandboxId, action, path, content }) => {
      try {
        const sandbox = reg.handleFor<Sandbox>(sandboxId, KIND)
        switch (action) {
          case "read":
            return text(clip(await sandbox.files.readText(path), reg.config.maxChars))
          case "write":
            if (content === undefined) return failure("write needs `content`.")
            await sandbox.files.write(path, content)
            return text(`wrote ${content.length} bytes to ${path}`)
          case "list": {
            const entries = await sandbox.files.list(path)
            return text(
              clip(
                entries.map((e) => `${e.dir ? "d" : "-"} ${String(e.size).padStart(9)}  ${e.name}`).join("\n") ||
                  "(empty)",
                reg.config.maxChars,
              ),
            )
          }
          case "mkdir":
            await sandbox.files.mkdir(path)
            return text(`created ${path}`)
          case "remove":
            await sandbox.files.remove(path, true)
            return text(`removed ${path}`)
        }
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "sandbox_preview",
    {
      title: "Expose a port",
      description:
        "Get a public https URL for a server running inside the sandbox — e.g. a dev server on :3000. " +
        "Useful for handing a human something to look at.",
      inputSchema: { sandboxId: z.string(), port: z.number().int().min(1).max(65535) },
      annotations: { title: "Expose a port", readOnlyHint: true, openWorldHint: true },
    },
    async ({ sandboxId, port }) => {
      try {
        const sandbox = reg.handleFor<Sandbox>(sandboxId, KIND)
        const preview = await sandbox.previewUrl(port)
        return text(fields({ port, url: preview.url, token: preview.token }))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "sandbox_stop",
    {
      title: "Stop the sandbox",
      description: "Destroy the sandbox VM and free the slot.",
      inputSchema: { sandboxId: z.string() },
      annotations: { title: "Stop the sandbox", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ sandboxId }) => {
      const released = await reg.release(sandboxId, "requested")
      return text(released ? `Killed sandbox ${sandboxId}.` : `Sandbox ${sandboxId} was already gone.`)
    },
  )
}
