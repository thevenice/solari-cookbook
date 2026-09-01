"""Runs INSIDE the Solari sandbox, not on your laptop.

That is the point of putting it there: the input is text scraped from third-party
web pages, and the scoring logic is the part most likely to be changed by whoever
forks this. Neither belongs in your shell. The sandbox is disposable, isolated,
and gone thirty seconds after the report is written.

Reads /work/evidence.json, writes /work/report.md.
"""

import json
import pathlib
from collections import defaultdict

WORK = pathlib.Path("/work")
bundle = json.loads((WORK / "evidence.json").read_text())

by_vendor = defaultdict(list)
for c in bundle["claims"]:
    by_vendor[c["vendor"]].append(c)

VERDICT_MARK = {"supported": "yes", "not_found": "not found", "unreachable": "unverifiable"}


def confidence(claims):
    """Share of claims we could actually stand behind.

    `not_found` is deliberately NOT scored as a refutation. A pricing page that
    does not mention SAML is evidence that the page does not mention SAML — it is
    not evidence that the product lacks SSO. Conflating those two is how research
    agents end up confidently wrong, so the score only ever counts what was seen.
    """
    verifiable = [c for c in claims if c["verdict"] != "unreachable"]
    if not verifiable:
        return 0.0
    return round(100 * sum(1 for c in verifiable if c["verdict"] == "supported") / len(verifiable), 1)


lines = [
    f"# Evidence bundle — {bundle['subject']}",
    "",
    f"Captured {bundle['capturedAt']} · {len(bundle['sources'])} sources · {len(bundle['claims'])} claims",
    "",
    "Every row below is backed by a timestamped screenshot and a SHA-256 hash of the",
    "page text as captured. Nothing here was inferred by a language model.",
    "",
    "## Summary",
    "",
    "| Vendor | Claims checked | Supported | Not found on page | Unverifiable | Evidence confidence |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
]

for vendor, claims in sorted(by_vendor.items()):
    counts = defaultdict(int)
    for c in claims:
        counts[c["verdict"]] += 1
    lines.append(
        f"| {vendor} | {len(claims)} | {counts['supported']} | {counts['not_found']} | "
        f"{counts['unreachable']} | {confidence(claims)}% |"
    )

lines += ["", "## Claim detail", ""]

for vendor, claims in sorted(by_vendor.items()):
    lines += [f"### {vendor}", ""]
    for c in claims:
        lines.append(f"**{c['text']}** — {VERDICT_MARK[c['verdict']]}")
        lines.append("")
        lines.append(f"- Source: {c['url']}")
        lines.append(f"- Captured: {c['capturedAt']}")
        lines.append(f"- Page text SHA-256: `{c['pageSha256'][:16]}…`")
        lines.append(f"- Screenshot: `{c['screenshot']}`")
        if c.get("excerpt"):
            excerpt = c["excerpt"].replace("\n", " ").strip()
            lines.append(f"- Matched on `{c.get('matchedTerm')}`: “…{excerpt}…”")
        if c["verdict"] == "unreachable":
            lines.append(f"- Reason: {c.get('reason', 'page could not be captured')}")
        lines.append("")

lines += [
    "## How to read this",
    "",
    "- **yes** — the term was found in the page text captured at the timestamp above.",
    "- **not found** — the term was absent from that page. This is *not* a claim that the",
    "  product lacks the feature; it may live on another page, or behind a login.",
    "- **unverifiable** — the page could not be captured (blocked, timed out, moved).",
    "",
    "Re-run the capture and diff the SHA-256 values to detect a page changing under you.",
    "",
]

report_text = "\n".join(lines)
(WORK / "report.md").write_text(report_text)
print(f"wrote report.md ({len(report_text)} bytes)")
