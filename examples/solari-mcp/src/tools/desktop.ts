/**
 * Desktop tools — a sandbox with a screen, for anything that has to be clicked.
 *
 * Two things the cookbook's desktop example learned the hard way, encoded here:
 *
 *  - X11 is not up the instant the session is created. `desktop_start` polls
 *    `health()` until `ready` before it returns, so a model never drives a
 *    display that does not exist yet.
 *  - A click that lands on the wrong window fails SILENTLY. Nothing errors; the
 *    keystrokes just go somewhere else and you get an empty document. So
 *    `desktop_type` deliberately does not accept coordinates: the model must
 *    click, screenshot to confirm focus, then type. Making the unsafe sequence
 *    inexpressible beats documenting it.
 */

import { z } from "zod"
import type { Desktop } from "@solarisdk/sdk"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { Registry } from "../registry.js"
import { clip, explain, failure, fields, png, text } from "../util.js"

const KIND = "desktop" as const

export function registerDesktopTools(server: McpServer, reg: Registry): void {
  server.registerTool(
    "desktop_start",
    {
      title: "Start a desktop",
      description:
        "Boot a Linux desktop with a real GUI and wait until the display is ready. Returns a sessionId and a " +
        "streamUrl — a live VNC view a human can open in a browser to watch the agent work. Finish with desktop_stop.",
      inputSchema: {
        resolution: z.string().optional().describe('e.g. "1280x720". Defaults to 1280x720.'),
        record: z.boolean().optional().describe("Record the session server-side for later playback."),
        timeoutMs: z.number().int().positive().optional(),
        note: z.string().optional(),
      },
      annotations: { title: "Start a desktop", readOnlyHint: false, openWorldHint: true },
    },
    async ({ resolution, record, timeoutMs, note }) => {
      try {
        reg.assertCapacity()
        const desktop = await reg.apiClient().desktops.create({
          resolution: resolution ?? "1280x720",
          ...(record ? { record: true } : {}),
          timeoutMs: timeoutMs ?? 10 * 60_000,
        })

        const id = desktop.sessionId
        // Register BEFORE the readiness poll: if the poll throws or the process
        // dies mid-wait, the registry still owns the session and will reap it.
        reg.register(KIND, id, note ?? "desktop", async () => {
          await desktop.kill().catch(async () => {
            await reg.apiClient().desktops.destroy(id)
          })
        })
        reg.attach(id, desktop)

        await desktop.connect()
        let ready = false
        for (let i = 0; i < 30; i++) {
          const health = await desktop.health().catch(() => undefined)
          if (health?.ready) {
            ready = true
            break
          }
          await new Promise((r) => setTimeout(r, 1_000))
        }
        if (!ready) {
          await reg.release(id, "requested")
          return failure("The desktop never reported a ready display within 30s. Session released; try again.")
        }

        const size = await desktop.display.size().catch(() => undefined)
        return text(
          fields({
            sessionId: id,
            display: size ? `${size.w}x${size.h}` : resolution,
            streamUrl: desktop.streamUrl,
            expiresAt: desktop.expiresAt,
            hint: "Apps available in the default image: mousepad, thunar, chrome, code, libreoffice.",
          }),
        )
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "desktop_screenshot",
    {
      title: "Screenshot the desktop",
      description:
        "Capture the desktop screen. Take one after every click before typing — a click that misses its window " +
        "fails silently, and this is the only way to know it landed.",
      inputSchema: { sessionId: z.string() },
      annotations: { title: "Screenshot the desktop", readOnlyHint: true },
    },
    async ({ sessionId }) => {
      try {
        const desktop = reg.handleFor<Desktop>(sessionId, KIND)
        const shot = await desktop.screenshot({ format: "png" })
        const cursor = await desktop.display.cursor().catch(() => undefined)
        return png(shot, fields({ capturedAt: new Date().toISOString(), cursor: cursor ? `${cursor.x},${cursor.y}` : undefined }))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "desktop_open_app",
    {
      title: "Open an app",
      description:
        "Launch a GUI application by name and return its pid. Fails if the binary is not in the image — the default " +
        "image has mousepad, thunar, chrome, code and libreoffice.",
      inputSchema: { sessionId: z.string(), name: z.string(), args: z.array(z.string()).optional() },
      annotations: { title: "Open an app", readOnlyHint: false },
    },
    async ({ sessionId, name, args }) => {
      try {
        const desktop = reg.handleFor<Desktop>(sessionId, KIND)
        const pid = await desktop.open(name, args ?? [])
        // Give the window manager time to map the window before the model
        // screenshots and starts clicking at coordinates.
        await new Promise((r) => setTimeout(r, 3_000))
        return text(`opened ${name} (pid ${pid}). Screenshot before clicking — the window may not be centred.`)
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "desktop_click",
    {
      title: "Click",
      description:
        "Click at screen coordinates. Follow every click with desktop_screenshot to confirm the intended window " +
        "took focus before you type into it.",
      inputSchema: {
        sessionId: z.string(),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
      },
      annotations: { title: "Click", readOnlyHint: false, destructiveHint: true },
    },
    async ({ sessionId, x, y, button, double }) => {
      try {
        const desktop = reg.handleFor<Desktop>(sessionId, KIND)
        const opts = { humanize: true, ...(button ? { button } : {}) }
        if (double) await desktop.mouse.doubleClick(x, y, opts)
        else await desktop.mouse.click(x, y, opts)
        return text(`${double ? "double-clicked" : "clicked"} at ${x},${y} — screenshot to confirm focus.`)
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "desktop_type",
    {
      title: "Type or press keys",
      description:
        "Type text, or press a key chord, into whatever currently has focus. Takes no coordinates by design: " +
        "click first, screenshot to verify focus, then type.",
      inputSchema: {
        sessionId: z.string(),
        text: z.string().optional().describe("Literal text to type."),
        keys: z.array(z.string()).optional().describe('Key chord, e.g. ["ctrl","s"].'),
      },
      annotations: { title: "Type or press keys", readOnlyHint: false, destructiveHint: true },
    },
    async ({ sessionId, text: body, keys }) => {
      try {
        const desktop = reg.handleFor<Desktop>(sessionId, KIND)
        if (body === undefined && !keys?.length) return failure("Pass `text` or `keys`.")
        if (body !== undefined) await desktop.keyboard.type(body)
        if (keys?.length) await desktop.keyboard.press(keys)
        return text(`typed${body !== undefined ? ` ${body.length} chars` : ""}${keys?.length ? ` + ${keys.join("+")}` : ""}`)
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "desktop_exec",
    {
      title: "Run a command on the desktop",
      description: "Run a shell command inside the desktop VM — handy for setup that would be tedious through the GUI.",
      inputSchema: { sessionId: z.string(), command: z.string(), cwd: z.string().optional() },
      annotations: { title: "Run a command on the desktop", readOnlyHint: false, destructiveHint: true },
    },
    async ({ sessionId, command, cwd }) => {
      try {
        const desktop = reg.handleFor<Desktop>(sessionId, KIND)
        const res = await desktop.exec("sh", { args: ["-c", command], ...(cwd ? { cwd } : {}) })
        const parts = [`exit: ${res.exitCode}`]
        if (res.stdout.trim()) parts.push(`--- stdout ---\n${res.stdout.trimEnd()}`)
        if (res.stderr.trim()) parts.push(`--- stderr ---\n${res.stderr.trimEnd()}`)
        return text(clip(parts.join("\n"), reg.config.maxChars))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "desktop_stop",
    {
      title: "Stop the desktop",
      description: "Destroy the desktop session and free the slot.",
      inputSchema: { sessionId: z.string() },
      annotations: { title: "Stop the desktop", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ sessionId }) => {
      const released = await reg.release(sessionId, "requested")
      return text(released ? `Destroyed desktop ${sessionId}.` : `Desktop ${sessionId} was already gone.`)
    },
  )
}
