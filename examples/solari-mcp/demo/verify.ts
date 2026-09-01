/**
 * Evidence bundle builder — the flagship demo for solari-mcp.
 *
 *   SOLARI_API_KEY=slr_live_... npx tsx demo/verify.ts demo/claims.example.json
 *
 * What it does, and just as importantly what it refuses to do:
 *
 *   BROWSER  Open each source page once, capture a full-page screenshot and the
 *            page text, and hash the text. The hash is what makes the bundle
 *            auditable — re-run it later and a changed hash tells you the vendor
 *            moved the goalposts.
 *   SANDBOX  Ship the raw captures into a disposable microVM and score them
 *            there. Third-party page text plus fork-editable scoring logic is
 *            exactly the combination you do not want running on your laptop.
 *
 *   It never fills in a form, never emails anyone, and never requests a quote.
 *   An agent that submits "Contact Sales" forms on behalf of a company that has
 *   not agreed to be contacted is a spam cannon, however good the demo looks.
 *
 * The other deliberate choice is the verdict vocabulary: `supported`,
 * `not_found`, `unreachable`. There is no `refuted`. Absence of a term on a
 * pricing page is not evidence that a product lacks the feature, and a tool that
 * blurs those two produces confident nonsense.
 */

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"

interface Source {
  id: string
  vendor: string
  url: string
}
interface Claim {
  id: string
  vendor: string
  sourceId: string
  text: string
  match: string[]
  requireAll?: boolean
}
interface Spec {
  subject: string
  sources: Source[]
  claims: Claim[]
}

type Verdict = "supported" | "not_found" | "unreachable"

interface Capture {
  text: string
  sha256: string
  capturedAt: string
  screenshot: string
  finalUrl: string
  error?: string
}

const specPath = process.argv[2] ?? "demo/claims.example.json"
const outDir = process.argv[3] ?? "demo/out"

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

/** Find `term` in `text` and return the sentence-ish window around it. */
function excerptAround(text: string, term: string, radius = 140): string | undefined {
  const i = text.toLowerCase().indexOf(term.toLowerCase())
  if (i === -1) return undefined
  return text.slice(Math.max(0, i - radius), Math.min(text.length, i + term.length + radius))
}

async function main(): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set.")

  const spec = JSON.parse(await (await import("node:fs/promises")).readFile(specPath, "utf8")) as Spec
  await mkdir(join(outDir, "screenshots"), { recursive: true })

  console.log(`\n${spec.subject}`)
  console.log(`${spec.sources.length} sources · ${spec.claims.length} claims\n`)

  // --- capture -------------------------------------------------------------
  const captures = new Map<string, Capture>()
  const solari = new Solari({ apiKey })
  const browser = await solari.launch()
  try {
    const page = await browser.newPage()
    for (const source of spec.sources) {
      const shotPath = join(outDir, "screenshots", `${source.id}.png`)
      process.stdout.write(`  capturing ${source.vendor.padEnd(16)} ${source.url} … `)
      try {
        await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 45_000 })
        // Give lazy pricing tables a moment; many are client-rendered.
        await page.waitForTimeout(2_500)
        const text = await page.locator("body").innerText()
        const shot = await page.screenshot({ type: "png", fullPage: true })
        await writeFile(shotPath, shot)
        captures.set(source.id, {
          text,
          sha256: sha256(text),
          capturedAt: new Date().toISOString(),
          screenshot: `screenshots/${basename(shotPath)}`,
          finalUrl: page.url(),
        })
        console.log(`ok (${text.length} chars, ${(shot.length / 1024).toFixed(0)}KB)`)
      } catch (err) {
        // An unreachable page is a result, not a crash. Recording it honestly is
        // the whole difference between a research tool and a research anecdote.
        captures.set(source.id, {
          text: "",
          sha256: "",
          capturedAt: new Date().toISOString(),
          screenshot: "",
          finalUrl: source.url,
          error: err instanceof Error ? err.message.split("\n")[0] : String(err),
        })
        console.log(`UNREACHABLE (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`)
      }
    }
  } finally {
    await browser.close()
    // Without this the loopback retry proxy keeps the event loop alive and the
    // process hangs after printing its last line.
    await solari.close()
  }

  // --- adjudicate ----------------------------------------------------------
  const results = spec.claims.map((claim) => {
    const source = spec.sources.find((s) => s.id === claim.sourceId)
    const cap = captures.get(claim.sourceId)
    if (!source || !cap || cap.error) {
      return {
        ...claim,
        url: source?.url ?? "",
        verdict: "unreachable" as Verdict,
        capturedAt: cap?.capturedAt ?? new Date().toISOString(),
        pageSha256: cap?.sha256 ?? "",
        screenshot: cap?.screenshot ?? "",
        reason: cap?.error ?? "source not found in spec",
      }
    }
    const hits = claim.match
      .map((term) => ({ term, excerpt: excerptAround(cap.text, term) }))
      .filter((h) => h.excerpt !== undefined)
    const satisfied = claim.requireAll ? hits.length === claim.match.length : hits.length > 0
    return {
      ...claim,
      url: cap.finalUrl,
      verdict: (satisfied ? "supported" : "not_found") as Verdict,
      capturedAt: cap.capturedAt,
      pageSha256: cap.sha256,
      screenshot: cap.screenshot,
      matchedTerm: hits[0]?.term,
      excerpt: hits[0]?.excerpt,
    }
  })

  const bundle = {
    subject: spec.subject,
    capturedAt: new Date().toISOString(),
    sources: spec.sources.map((s) => ({ ...s, sha256: captures.get(s.id)?.sha256 ?? "" })),
    claims: results,
  }
  await writeFile(join(outDir, "evidence.json"), JSON.stringify(bundle, null, 2))

  // --- score, in a sandbox -------------------------------------------------
  console.log("\n  scoring in a sandbox … ")
  const client = new SolariClient({ apiKey })
  const sandbox = await client.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 })
  let report: string
  try {
    await sandbox.connect()
    await sandbox.files.mkdir("/work")
    await sandbox.files.write("/work/evidence.json", JSON.stringify(bundle))
    await sandbox.files.write(
      "/work/analyse.py",
      await (await import("node:fs/promises")).readFile("demo/analyse.py", "utf8"),
    )
    const run = await sandbox.commands.run("python3", { args: ["/work/analyse.py"], cwd: "/work" })
    if (run.exitCode !== 0) throw new Error(`analyse.py exited ${run.exitCode}: ${run.stderr}`)
    report = await sandbox.files.readText("/work/report.md")
  } finally {
    // kill(), not close(). close() would leave the VM running.
    await sandbox.kill()
  }

  await writeFile(join(outDir, "report.md"), report)

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `\n  supported ${counts.supported ?? 0} · not found ${counts.not_found ?? 0} · unverifiable ${counts.unreachable ?? 0}`,
  )
  console.log(`\n  ${outDir}/report.md`)
  console.log(`  ${outDir}/evidence.json`)
  console.log(`  ${outDir}/screenshots/\n`)
}

main().catch((err) => {
  console.error("\nfailed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
