/** Response shaping and error mapping shared by every tool. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

/** Clip long output so one `sandbox_exec` can't blow the model's context. */
export function clip(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  const keep = Math.floor(maxChars / 2)
  return (
    s.slice(0, keep) +
    `\n\n…[${s.length - maxChars} characters elided by solari-mcp]…\n\n` +
    s.slice(s.length - keep)
  )
}

export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] }
}

export function png(bytes: Uint8Array, note?: string): CallToolResult {
  const content: CallToolResult["content"] = [
    { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
  ]
  if (note) content.push({ type: "text", text: note })
  return { content }
}

export function failure(body: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: body }] }
}

/** Render `key: value` lines — compact and stable for a model to parse. */
export function fields(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n")
}

/**
 * Turn an SDK error into something a model can act on.
 *
 * Solari's typed errors carry the interesting cases. `ConcurrencyLimitExceeded`
 * in particular is not a bug — it means sessions are already running, quite
 * possibly orphans from an earlier crashed process — so the message points at
 * the tool that fixes it rather than inviting a blind retry.
 */
export function explain(err: unknown): string {
  const e = err as { name?: string; code?: string; status?: number; message?: string }
  const name = e?.name ?? "Error"
  const code = e?.code
  const msg = e?.message ?? String(err)

  if (code === "ConcurrencyLimitExceeded" || name === "ConcurrencyLimitError") {
    return (
      `${msg}\n\n` +
      "Your plan's concurrent-session limit is already used up. Call " +
      "`solari_sessions` to see what is running on the account — including " +
      "sessions this server does not own — and `solari_gc` to release orphans. " +
      "Do not retry this call until something has been released."
    )
  }
  if (code === "FeatureRequiresPlan" || name === "PlanError") {
    return `${msg}\n\nThis option is not on the current Solari plan. Retry without it rather than looping.`
  }
  if (name === "AuthError" || e?.status === 401 || e?.status === 403) {
    return `${msg}\n\nSOLARI_API_KEY was rejected. Check the key in the MCP server's env block.`
  }
  if (name === "NoCapacityError") {
    return `${msg}\n\nNo capacity right now. Wait a few seconds before retrying — this one is genuinely transient.`
  }
  if (name === "TimeoutError") {
    return `${msg}\n\nThe call timed out. The session may still be alive; check with \`solari_sessions\`.`
  }
  return `${name}: ${msg}`
}

/** Never let a teardown hang the process. */
export async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          process.stderr.write(`[solari-mcp] ${label} did not finish in ${ms}ms; moving on\n`)
          resolve(undefined)
        }, ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function ms(n: number): string {
  if (n < 1000) return `${n}ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.round(n / 60_000)}m`
}
