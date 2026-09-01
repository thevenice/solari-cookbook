# solari-mcp

**Solari's cloud browsers, sandboxes and desktops as MCP tools — with a session
registry that will not let an agent leave your VMs running.**

Point Claude Desktop, Cursor, Cline or any MCP client at this server and your
agent can browse the web, run code in an isolated microVM, and click around a
real Linux GUI. Six lines of config, no glue code.

```jsonc
{
  "mcpServers": {
    "solari": {
      "command": "npx",
      "args": ["-y", "solari-mcp"],
      "env": { "SOLARI_API_KEY": "slr_live_…" }
    }
  }
}
```

---

## Why this exists

Wrapping an SDK in MCP tools is a two-hour job. The part that takes longer, and
the part this repo is actually about, is that **an MCP server hands a language
model the keys to real, billable VMs** — and models are bad at cleanup in
exactly the ways this API punishes.

Four leak paths, all of which the Solari SDK documents and then, correctly,
leaves to the caller:

**1. `close()` is not `kill()`.** On a sandbox or desktop, `close()` drops your
local control channel and leaves the VM running until its idle timeout. Only
`kill()` ends it. A model picking from an autocomplete list will choose
`close()` nearly every time.

**2. `timeoutMs` is a rolling idle window, not a deadline.** It resets on every
use. So an agent stuck in a polling loop keeps the session alive *forever* — the
built-in timeout can never fire, because the thing that would trigger it is the
thing that isn't happening. "The model got stuck in a loop" and "the VM ran all
night" are the same incident.

**3. The MCP client kills your process without warning.** Quit the app, close
the laptop, and the server gets EOF on stdin — not a signal, not a shutdown
hook. That is the single most likely moment for a VM to be orphaned, and it
happens on a laptop that is now asleep and cannot clean up after itself.

**4. The TypeScript browser client keeps a loopback proxy open.** Skip the final
`solari.close()` and the process never exits. For a server, "never exits" means
the client believes it has shut you down while your sessions keep billing.

So every handle is owned by one registry that knows the correct teardown for
each kind, reaps on idle **and** on a hard ceiling the agent cannot reset, caps
concurrency *before* creating anything remote, and tears down on every exit
path — SIGINT, SIGTERM, SIGHUP, stdin EOF, uncaught exception, unhandled
rejection.

And for the sessions that leaked before you installed this: `solari_gc` lists
every sandbox and desktop running on your account, marks the ones this server
doesn't own, and releases them. Dry run by default.

---

## Tools

| Tool | What it does |
| --- | --- |
| `browser_open` | Launch a cloud browser. Stealth, managed proxy, captcha solving, profiles, recording. |
| `browser_goto` | Navigate and report where you landed. |
| `browser_read` | Page text, links, or HTML — scoped by selector, clipped to stay context-safe. |
| `browser_act` | Click, fill, press, select, wait. Playwright selectors, so `text=Sign in` works. |
| `browser_screenshot` | PNG plus URL and UTC capture time, so a shot can stand as dated evidence. |
| `browser_close` | Release the session; returns the replay URL if recording was on. |
| `sandbox_start` | Boot an isolated Linux microVM (~1s). |
| `sandbox_exec` | Run a command. Shell syntax works — see the note below. |
| `sandbox_run_code` | Stateful kernel: variables and imports persist across calls. |
| `sandbox_files` | Read, write, list, mkdir, remove. |
| `sandbox_preview` | Public https URL for a port inside the VM. |
| `sandbox_stop` | Destroy the VM. |
| `desktop_start` | Boot a GUI desktop and **wait for the display to be ready**. Returns a live VNC `streamUrl` a human can watch. |
| `desktop_screenshot` | Capture the screen. |
| `desktop_open_app` | Launch an app by name and let the window map. |
| `desktop_click` | Click at coordinates. |
| `desktop_type` | Type text or press a chord — into whatever has focus. |
| `desktop_exec` | Shell command inside the desktop VM. |
| `desktop_stop` | Destroy the session. |
| `solari_sessions` | What this server owns, **plus** everything running on the account. |
| `solari_gc` | Release orphans. Dry run unless `confirm: true`. |

### Gotchas encoded, not documented

A comment in a README gets read once. These are built into the tool surface so
the wrong thing is hard to express:

- **`commands.run` is not shell-interpreted.** `run("ls -la")` looks for a
  binary literally named `ls -la`. `sandbox_exec` therefore takes a command
  *line* and runs it under `sh -c` by default, because that is what a model
  means when it writes one.
- **A desktop click that misses its window fails silently.** Nothing errors; the
  keystrokes go elsewhere and you get an empty document. So `desktop_type` takes
  **no coordinates** — you must click, screenshot to confirm focus, then type.
  Making the unsafe sequence inexpressible beats warning about it.
- **X11 isn't up when the session is created.** `desktop_start` polls `health()`
  until ready before returning, so a model never drives a display that doesn't
  exist yet.
- **Recording is per session, not per account.** Set at open time or the replay
  endpoint 404s forever — so `browser_close` polls for the upload but bounded,
  and says which mistake you probably made.
- **Concurrency errors are not retryable.** `explain()` maps
  `ConcurrencyLimitExceeded` to an instruction to call `solari_sessions` and
  `solari_gc` instead of looping.

---

## Guardrails

All optional; these are the defaults.

| Variable | Default | What it does |
| --- | --- | --- |
| `SOLARI_MCP_MAX_SESSIONS` | `3` | Refuse to open more. Checked *before* anything remote is created. |
| `SOLARI_MCP_IDLE_MS` | `300000` | Reap a session after 5 min with no tool call. |
| `SOLARI_MCP_MAX_SESSION_MS` | `1800000` | Hard lifetime ceiling. The one clock an agent cannot reset. |
| `SOLARI_MCP_SWEEP_MS` | `20000` | Reaper interval. |
| `SOLARI_MCP_MAX_CHARS` | `8000` | Clip page text and command output before it reaches the model. |

---

## The demo: audit-grade evidence bundles

`demo/verify.ts` is a real use case built on the same primitives — a vendor
**claim verifier** for anyone who has to justify a buying decision.

```bash
SOLARI_API_KEY=slr_live_… npx tsx demo/verify.ts demo/claims.example.json
```

Give it a list of claims and the pages that should support them. It opens each
page in a **cloud browser**, captures a full-page screenshot and the page text,
and SHA-256 hashes the text. Then it ships the raw captures into a **sandbox**
and scores them there — third-party page text plus fork-editable scoring logic
is precisely what you don't want executing on your laptop. Out comes
`report.md`, `evidence.json`, and a directory of screenshots.

Three design decisions worth arguing about:

**There is no `refuted` verdict.** Only `supported`, `not_found` and
`unreachable`. A pricing page that doesn't mention SAML is evidence that the
page doesn't mention SAML — not evidence the product lacks SSO. Research agents
go confidently wrong at exactly this join, so the score only ever counts what
was actually seen.

**`unreachable` is a first-class result.** A blocked or moved page is recorded
as unverifiable, not silently dropped and not hallucinated around.

**It contacts nobody.** No form filling, no quote requests, no "Contact Sales"
automation. An agent that submits enquiry forms on behalf of a company that
hasn't agreed to be contacted is a spam cannon, however good the demo looks.

The hashes are the point of the whole thing: re-run the capture in a month, diff
the SHA-256 values, and you know precisely which vendor moved the goalposts.

> The server exposes all three Solari primitives; this demo uses two, because
> reading public web pages doesn't need a screen. Bolting a desktop step onto it
> would have made a better screenshot and a worse example.

---

## Verifying it

`scripts/smoke.ts` drives the real server over the real MCP protocol against the
real API — no mocks.

```bash
SOLARI_API_KEY=slr_live_… npm run smoke
```

It checks the tool surface, a full browser flow, a sandbox flow, that the
concurrency cap refuses the session *over* the limit, that a stale session id
produces an actionable error — and, last and most importantly, that after the
client disconnects **nothing is left running on the account**.

---

## Development

```bash
npm install
npm run typecheck
npm run build
npm run dev        # stdio server on stdin/stdout
```

Requires Node ≥ 20 and a Solari API key from
[console.getsolari.com](https://console.getsolari.com).

MIT, same as the cookbook.
