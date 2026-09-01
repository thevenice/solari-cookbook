/**
 * The session registry — the reason this server exists.
 *
 * An MCP server hands a language model the keys to real, billable VMs. Models
 * open things and forget them; MCP clients kill the server process without
 * warning when you quit the app. Every leak path below is one the Solari SDK
 * documents and then, correctly, leaves to the caller:
 *
 *   1. `close()` is not `kill()`. On a sandbox or desktop, `close()` drops your
 *      local control channel and leaves the VM running until its idle timeout.
 *      Only `kill()` / `destroy()` ends it. A model reading the method list
 *      will pick `close()` roughly every time.
 *   2. `timeoutMs` is a ROLLING idle window, not a deadline — it resets on every
 *      use. An agent that polls a session never lets it expire. So the registry
 *      keeps its own hard `maxSessionMs` ceiling, which is the only clock here
 *      that cannot be reset from the outside.
 *   3. The TypeScript browser client keeps a loopback proxy open for connection
 *      retries. Without a final `solari.close()` the process hangs at exit
 *      instead of exiting — which, for a server, means the client thinks it is
 *      shutting you down and the VMs quietly keep billing.
 *   4. A browser's `browser.close()` releases its session; closing only the
 *      underlying Playwright browser would hold the slot to the plan deadline.
 *
 * So: one place owns every handle, knows the correct teardown for each kind,
 * reaps on idle and on a hard deadline, caps concurrency, and tears everything
 * down on any exit path. Tools never hold a handle of their own.
 */

import { Solari, type BrowserSession } from "@solarisdk/browser"
import { SolariClient, type Desktop, type Sandbox } from "@solarisdk/sdk"

import type { Config } from "./config.js"
import { ms, withDeadline } from "./util.js"

export type Kind = "browser" | "sandbox" | "desktop"

interface Entry {
  id: string
  kind: Kind
  createdAt: number
  lastUsedAt: number
  calls: number
  note: string
  release: () => Promise<void>
}

export type ReleaseReason = "requested" | "idle" | "deadline" | "shutdown"

export interface SessionInfo {
  id: string
  kind: Kind
  note: string
  ageMs: number
  idleMs: number
  calls: number
}

export class SessionLimitError extends Error {}
export class UnknownSessionError extends Error {}

export class Registry {
  readonly config: Config

  #browserClient?: Solari
  #apiClient?: SolariClient
  #entries = new Map<string, Entry>()
  #sweeper?: NodeJS.Timeout
  #shuttingDown = false
  /** Sessions the reaper closed, kept so a later tool call can say why. */
  #reaped = new Map<string, { reason: ReleaseReason; at: number }>()

  constructor(config: Config) {
    this.config = config
  }

  /** Browser client. Constructed lazily so a sandbox-only run never dials it. */
  browserClient(): Solari {
    this.#browserClient ??= new Solari({ apiKey: this.config.apiKey })
    return this.#browserClient
  }

  /** Sandbox + desktop client. */
  apiClient(): SolariClient {
    this.#apiClient ??= new SolariClient({ apiKey: this.config.apiKey, baseUrl: this.config.baseUrl })
    return this.#apiClient
  }

  start(): void {
    this.#sweeper = setInterval(() => void this.sweep(), this.config.sweepMs)
    this.#sweeper.unref?.()
  }

  size(): number {
    return this.#entries.size
  }

  /**
   * Check the concurrency cap BEFORE creating anything remote. Creating first
   * and rejecting after would be the leak this whole file exists to prevent.
   */
  assertCapacity(): void {
    if (this.#entries.size >= this.config.maxSessions) {
      const open = [...this.#entries.values()]
        .map((e) => `  ${e.id} (${e.kind}, idle ${ms(Date.now() - e.lastUsedAt)}) — ${e.note}`)
        .join("\n")
      throw new SessionLimitError(
        `Refusing to open another session: ${this.#entries.size} of ${this.config.maxSessions} ` +
          `allowed are already open.\n\n${open}\n\n` +
          "Close one you are finished with (`browser_close` / `sandbox_stop` / `desktop_stop`), " +
          "or raise SOLARI_MCP_MAX_SESSIONS if you genuinely need more in parallel.",
      )
    }
  }

  register(kind: Kind, id: string, note: string, release: () => Promise<void>): void {
    const now = Date.now()
    this.#entries.set(id, { id, kind, createdAt: now, lastUsedAt: now, calls: 0, note, release })
  }

  /** Fetch a live handle's entry, refreshing its idle clock. */
  #touch(id: string, kind: Kind): Entry {
    const entry = this.#entries.get(id)
    if (!entry) {
      const reaped = this.#reaped.get(id)
      if (reaped) {
        throw new UnknownSessionError(
          `Session ${id} was released ${ms(Date.now() - reaped.at)} ago (reason: ${reaped.reason}). ` +
            "Open a new one; the old id will never come back.",
        )
      }
      const open = [...this.#entries.values()].map((e) => `${e.id} (${e.kind})`).join(", ") || "none"
      throw new UnknownSessionError(`No session ${id}. Currently open: ${open}.`)
    }
    if (entry.kind !== kind) {
      throw new UnknownSessionError(`Session ${id} is a ${entry.kind}, not a ${kind}.`)
    }
    entry.lastUsedAt = Date.now()
    entry.calls += 1
    return entry
  }

  // --- typed handle accessors -------------------------------------------------
  // The handle lives on the entry's closure, not in a field, so nothing outside
  // the registry can hold a reference past release.

  #handles = new Map<string, unknown>()

  attach(id: string, handle: unknown): void {
    this.#handles.set(id, handle)
  }

  /**
   * Generic typed accessor. Tools that wrap a handle in something richer (the
   * browser tools pair a session with its current page) ask for their own type.
   */
  handleFor<T>(id: string, kind: Kind): T {
    this.#touch(id, kind)
    return this.#handles.get(id) as T
  }

  browserSession(id: string): BrowserSession {
    this.#touch(id, "browser")
    return (this.#handles.get(id) as { session: BrowserSession }).session
  }

  sandbox(id: string): Sandbox {
    this.#touch(id, "sandbox")
    return this.#handles.get(id) as Sandbox
  }

  desktop(id: string): Desktop {
    this.#touch(id, "desktop")
    return this.#handles.get(id) as Desktop
  }

  list(): SessionInfo[] {
    const now = Date.now()
    return [...this.#entries.values()].map((e) => ({
      id: e.id,
      kind: e.kind,
      note: e.note,
      ageMs: now - e.createdAt,
      idleMs: now - e.lastUsedAt,
      calls: e.calls,
    }))
  }

  /** Release one session. Idempotent, and never throws at the caller. */
  async release(id: string, reason: ReleaseReason = "requested"): Promise<boolean> {
    const entry = this.#entries.get(id)
    if (!entry) return false
    this.#entries.delete(id)
    this.#handles.delete(id)
    this.#reaped.set(id, { reason, at: Date.now() })
    try {
      await withDeadline(entry.release(), 15_000, `release of ${entry.kind} ${id}`)
    } catch (err) {
      process.stderr.write(`[solari-mcp] release of ${id} failed: ${String(err)}\n`)
    }
    return true
  }

  /**
   * Reap idle sessions and sessions past the hard ceiling.
   *
   * The ceiling is the important half: `timeoutMs` on the Solari side is a
   * rolling idle window that an active agent resets forever, so without a clock
   * the agent cannot touch, "the model got stuck in a loop" and "the VM ran all
   * night" are the same incident.
   */
  async sweep(): Promise<SessionInfo[]> {
    if (this.#shuttingDown) return []
    const now = Date.now()
    const doomed: Array<{ info: SessionInfo; reason: ReleaseReason }> = []
    for (const e of this.#entries.values()) {
      const info: SessionInfo = {
        id: e.id,
        kind: e.kind,
        note: e.note,
        ageMs: now - e.createdAt,
        idleMs: now - e.lastUsedAt,
        calls: e.calls,
      }
      if (info.ageMs >= this.config.maxSessionMs) doomed.push({ info, reason: "deadline" })
      else if (info.idleMs >= this.config.idleMs) doomed.push({ info, reason: "idle" })
    }
    for (const d of doomed) {
      process.stderr.write(
        `[solari-mcp] reaping ${d.info.kind} ${d.info.id} (${d.reason}: age ${ms(d.info.ageMs)}, idle ${ms(d.info.idleMs)})\n`,
      )
      await this.release(d.info.id, d.reason)
    }
    return doomed.map((d) => d.info)
  }

  /**
   * Tear everything down. Runs on every exit path, is safe to call twice, and
   * is bounded — an unreachable gateway must not stop the process from dying.
   */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return
    this.#shuttingDown = true
    if (this.#sweeper) clearInterval(this.#sweeper)

    const ids = [...this.#entries.keys()]
    if (ids.length) {
      process.stderr.write(`[solari-mcp] shutting down; releasing ${ids.length} session(s)\n`)
    }
    await Promise.all(ids.map((id) => this.release(id, "shutdown")))

    // REQUIRED for the browser client: it holds a loopback proxy server open for
    // the connection-retry path, and that handle keeps the event loop alive.
    // Skip it and the process refuses to exit.
    if (this.#browserClient) {
      await withDeadline(this.#browserClient.close(), 5_000, "browser client close")
    }
  }
}
