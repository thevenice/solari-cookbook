/**
 * Cloud browser tools.
 *
 * Design notes that matter for a model-facing surface:
 *
 *  - One page per session. Multi-tab state is a reliable way to confuse an LLM
 *    ("which tab am I on?"), and nothing here needs it. `browser_open` creates
 *    the page; every later call operates on it.
 *  - `browser.close()` releases the Solari session as well as the browser.
 *    Closing only the underlying Playwright browser would hold the slot until
 *    the plan deadline, so the registry's release closure calls this one.
 *  - Reads are clipped. A single `browser_read` on a busy page can otherwise
 *    return a hundred kilobytes of nav-bar text and evict the actual task from
 *    the model's context.
 */

import { z } from "zod"
import type { BrowserSession } from "@solarisdk/browser"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { Registry } from "../registry.js"
import { clip, explain, failure, fields, png, text } from "../util.js"

type Page = Awaited<ReturnType<BrowserSession["newPage"]>>
interface Handle {
  session: BrowserSession
  page: Page
}

const KIND = "browser" as const

export function registerBrowserTools(server: McpServer, reg: Registry): void {
  server.registerTool(
    "browser_open",
    {
      title: "Open a cloud browser",
      description:
        "Launch a Solari cloud browser and open a page. Returns a sessionId used by every other browser_* tool. " +
        "Stealth mode, managed proxy egress and session recording are opt-in. Always finish with browser_close.",
      inputSchema: {
        url: z.string().url().optional().describe("Navigate here immediately after launching."),
        stealth: z.boolean().optional().describe("Enable the runtime stealth shim. Required for proxy and captcha."),
        captcha: z.boolean().optional().describe("Managed captcha solving. Requires stealth."),
        proxy: z
          .string()
          .optional()
          .describe('Managed proxy egress, e.g. "us", "gb", or "smart". Requires stealth.'),
        recording: z
          .boolean()
          .optional()
          .describe("Record the session for replay. Must be set at open time — it cannot be turned on later."),
        profileId: z.string().optional().describe("Attach a stored browser profile (cookies + localStorage)."),
        note: z.string().optional().describe("Short human label, shown in solari_sessions."),
      },
      annotations: { title: "Open a cloud browser", readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        reg.assertCapacity()
        const solari = reg.browserClient()
        const session = await solari.launch({
          ...(args.stealth ? { stealth: true } : {}),
          ...(args.captcha ? { captcha: true } : {}),
          ...(args.proxy ? { proxy: args.proxy } : {}),
          ...(args.recording ? { recording: true } : {}),
          ...(args.profileId ? { profileId: args.profileId } : {}),
        })
        let page: Page
        try {
          page = await session.newPage()
        } catch (err) {
          // Never leave a session behind because the page failed to open.
          await session.close().catch(() => {})
          throw err
        }

        const id = session.id
        reg.register(KIND, id, args.note ?? args.url ?? "browser", async () => {
          await session.close()
        })
        reg.attach(id, { session, page } satisfies Handle)

        let landed: string | undefined
        let title: string | undefined
        if (args.url) {
          await page.goto(args.url, { waitUntil: "domcontentloaded" })
          landed = page.url()
          title = await page.title()
        }

        return text(
          fields({
            sessionId: id,
            url: landed,
            title,
            expiresAt: session.expiresAt,
            proxy: session.proxy ? `${session.proxy.country} / ${session.proxy.tier ?? "residential"}` : undefined,
            recording: args.recording ? "on — replay available from browser_close" : undefined,
          }),
        )
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "browser_goto",
    {
      title: "Navigate",
      description: "Navigate the session's page to a URL and report where it landed.",
      inputSchema: {
        sessionId: z.string(),
        url: z.string().url(),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle", "commit"])
          .optional()
          .describe("Defaults to domcontentloaded. Use networkidle for SPA-heavy pages."),
      },
      annotations: { title: "Navigate", readOnlyHint: false, openWorldHint: true },
    },
    async ({ sessionId, url, waitUntil }) => {
      try {
        const { page } = reg.handleFor<Handle>(sessionId, KIND)
        const res = await page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded" })
        return text(fields({ url: page.url(), title: await page.title(), status: res?.status() }))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "browser_read",
    {
      title: "Read the page",
      description:
        "Extract content from the current page: visible text, links, or raw HTML. Pass a CSS selector to scope it. " +
        "Output is clipped to keep it context-safe.",
      inputSchema: {
        sessionId: z.string(),
        mode: z.enum(["text", "links", "html"]).default("text"),
        selector: z.string().optional().describe("CSS selector to read instead of the whole page."),
      },
      annotations: { title: "Read the page", readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId, mode, selector }) => {
      try {
        const { page } = reg.handleFor<Handle>(sessionId, KIND)
        const max = reg.config.maxChars

        if (mode === "links") {
          const links = await page.$$eval("a[href]", (els) =>
            els
              .map((el) => ({
                text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
                href: (el as HTMLAnchorElement).href,
              }))
              .filter((l) => l.href.startsWith("http")),
          )
          const seen = new Set<string>()
          const lines: string[] = []
          for (const l of links) {
            if (seen.has(l.href)) continue
            seen.add(l.href)
            lines.push(`${l.text || "(no text)"} → ${l.href}`)
          }
          return text(clip(`${lines.length} unique links\n\n${lines.join("\n")}`, max))
        }

        const target = selector ? page.locator(selector).first() : page.locator("body")
        const body = mode === "html" ? await target.innerHTML() : await target.innerText()
        return text(clip(`url: ${page.url()}\n\n${body.replace(/\n{3,}/g, "\n\n").trim()}`, max))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "browser_act",
    {
      title: "Act on the page",
      description:
        "Interact with the page: click an element, fill an input, press a key, or select an option. " +
        "Selectors are Playwright selectors, so text engines work: click with \"text=Sign in\".",
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(["click", "fill", "press", "select", "wait_for"]),
        selector: z.string().optional().describe("Required for every action except press."),
        value: z.string().optional().describe("Text to fill, key to press, or option value to select."),
        timeoutMs: z.number().int().positive().optional(),
      },
      annotations: { title: "Act on the page", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ sessionId, action, selector, value, timeoutMs }) => {
      try {
        const { page } = reg.handleFor<Handle>(sessionId, KIND)
        const opts = timeoutMs ? { timeout: timeoutMs } : {}

        if (action === "press") {
          if (!value) return failure("press needs `value` — the key to press, e.g. \"Enter\".")
          if (selector) await page.locator(selector).first().press(value, opts)
          else await page.keyboard.press(value)
          return text(`pressed ${value}\nurl: ${page.url()}`)
        }

        if (!selector) return failure(`${action} needs a \`selector\`.`)
        const loc = page.locator(selector).first()

        switch (action) {
          case "click":
            await loc.click(opts)
            break
          case "fill":
            if (value === undefined) return failure("fill needs `value`.")
            await loc.fill(value, opts)
            break
          case "select":
            if (value === undefined) return failure("select needs `value`.")
            await loc.selectOption(value, opts)
            break
          case "wait_for":
            await loc.waitFor({ state: "visible", ...opts })
            break
        }
        return text(fields({ action, selector, url: page.url(), title: await page.title() }))
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot the page",
      description:
        "Capture the current page as a PNG. The reply carries the image plus the URL and a UTC capture timestamp, " +
        "so a screenshot can stand as dated evidence for a claim rather than just a picture.",
      inputSchema: {
        sessionId: z.string(),
        fullPage: z.boolean().optional().describe("Capture the whole scrollable page rather than the viewport."),
        selector: z.string().optional().describe("Screenshot just this element."),
      },
      annotations: { title: "Screenshot the page", readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId, fullPage, selector }) => {
      try {
        const { page } = reg.handleFor<Handle>(sessionId, KIND)
        const shot = selector
          ? await page.locator(selector).first().screenshot({ type: "png" })
          : await page.screenshot({ type: "png", fullPage: fullPage ?? false })
        const stamp = new Date().toISOString()
        return png(
          shot,
          fields({ url: page.url(), title: await page.title(), capturedAt: stamp, bytes: shot.length }),
        )
      } catch (err) {
        return failure(explain(err))
      }
    },
  )

  server.registerTool(
    "browser_close",
    {
      title: "Close the browser",
      description:
        "Close the browser and release the Solari session. If the session was opened with recording, this also " +
        "returns a replay URL — the upload is async, so it polls briefly before giving up.",
      inputSchema: {
        sessionId: z.string(),
        replay: z.boolean().optional().describe("Fetch the replay URL. Only works if opened with recording: true."),
      },
      annotations: { title: "Close the browser", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ sessionId, replay }) => {
      try {
        // Resolve the client before release, since release drops the handle.
        const solari = reg.browserClient()
        const released = await reg.release(sessionId, "requested")
        if (!released) return text(`Session ${sessionId} was already closed.`)
        if (!replay) return text(`Closed ${sessionId} and released the session.`)

        // The replay upload happens after release, so a single attempt usually
        // 404s. Poll — but bounded, because a session opened without
        // `recording: true` will 404 forever and an unbounded loop would hang.
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const url = await solari.sessions.getReplayUrl(sessionId)
            return text(fields({ closed: sessionId, replayUrl: url.url, expiresInSeconds: url.expiresInSeconds }))
          } catch {
            await new Promise((r) => setTimeout(r, 3_000))
          }
        }
        return text(
          `Closed ${sessionId}, but no replay after 30s. Recording is per session, not per account — ` +
            "if the session was not opened with `recording: true`, the replay endpoint 404s forever.",
        )
      } catch (err) {
        return failure(explain(err))
      }
    },
  )
}
