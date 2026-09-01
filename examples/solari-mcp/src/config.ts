/**
 * Configuration, resolved once at startup from the environment.
 *
 * Note the SDK's own rule: "No SDK constructor reads `process.env`." That is
 * correct for a library and wrong for a server binary, so reading env is this
 * file's whole job — nothing below `src/config.ts` ever touches `process.env`.
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

export interface Config {
  apiKey: string
  baseUrl: string
  maxSessions: number
  idleMs: number
  maxSessionMs: number
  sweepMs: number
  maxChars: number
}

export function loadConfig(): Config {
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      "SOLARI_API_KEY is not set. Grab a key at https://console.getsolari.com " +
        "and put it in the MCP server's `env` block (see README).",
    )
  }
  return {
    apiKey,
    baseUrl: process.env.SOLARI_BASE_URL?.trim() || "https://api.getsolari.com",
    maxSessions: int("SOLARI_MCP_MAX_SESSIONS", 3),
    idleMs: int("SOLARI_MCP_IDLE_MS", 5 * 60_000),
    maxSessionMs: int("SOLARI_MCP_MAX_SESSION_MS", 30 * 60_000),
    sweepMs: int("SOLARI_MCP_SWEEP_MS", 20_000),
    maxChars: int("SOLARI_MCP_MAX_CHARS", 8_000),
  }
}
