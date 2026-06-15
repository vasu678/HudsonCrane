# Spec — Band 2 Step 1: Vendor Triage

> Hand to Claude Code alongside the project context. Goal: before writing ANY new scraping code, classify the firm's 6 real vendors so we know the actual shape of Band 2 (easy scraping vs. bot-blocking vs. trade-login). This is investigation, not feature-building. Output is a filled-in table + a recommendation.

---

## 1. Why this first

The client gave us their real vendor list. One fact dominates: **Four Hands is ~50% of their purchases** — it matters more than the other five combined. Before committing to a Band 2 plan, we need to know, per vendor: (a) is the page auto-scrapable, and (b) is the product info public or behind a trade login. That answer decides whether Band 2 is a week of easy work or a much bigger login-handling project. **Do not build per-vendor scrapers yet — just investigate.**

The vendors (priority order):
1. **Four Hands** ← ~50% of purchases, highest priority
2. Rowe Furniture
3. Uttermost
4. Surya
5. Moe's Home Furnishings
6. York Wallcoverings

---

## 2. What to check for each vendor

Pick one representative product URL per vendor (a normal product page). For each, determine two things:

### Check A — Is it auto-scrapable, and how?
- Run a quick static check: `curl -s "<url>" | grep -i "og:image\|application/ld+json\|og:title"`.
  - Product data present in raw HTML → **STATIC** (cheap httpx path works).
  - Raw HTML mostly empty / data missing → needs the **PLAYWRIGHT** (browser) path.
- If even Playwright is blocked (challenge page, CAPTCHA, PerimeterX/Akamai/Cloudflare interstitial) → **BLOCKED** (would need a paid unblocker).

### Check B — Is the product info PUBLIC or TRADE-LOGIN-GATED?
Visit the product page **logged out** (incognito) and look at what's actually shown:
- Are the **name, dimensions, description, and images** all visible without logging in? → **PUBLIC**.
- Is key info missing/hidden, or does it say "log in for pricing / trade access / to view details"? → **GATED** (data lives behind a designer/trade account).
- Note specifically *which* fields are gated (e.g., "images public, dimensions gated").

### Check C — Field availability (quick notes)
For the public fields, note whether each of these is cleanly extractable: **name / dimensions / description / images**. Note where dimensions live (some put them in a spec table, some in description text) and how many images are available.

---

## 3. Fill in this table

| Vendor | Sample URL | A: Static / Playwright / Blocked | B: Public / Gated (which fields) | C: name·dims·desc·images notes |
|---|---|---|---|---|
| Four Hands |  |  |  |  |
| Rowe Furniture |  |  |  |  |
| Uttermost |  |  |  |  |
| Surya |  |  |  |  |
| Moe's Home |  |  |  |  |
| York Wallcoverings |  |  |  |  |

---

## 4. How to run it (tooling)
- Use the existing scraper (`backend/app/scraping/scraper.py`) to attempt each URL and log what it gets back (which path fired, what fields came out).
- For Check B (public vs gated), a human eyeball in an incognito browser is the reliable method — the logged-out page is the source of truth. (A scraper hitting it anonymously sees the same thing the logged-out user sees, so compare scraper output to what's visible logged-out.)
- The Playwright MCP / a quick Playwright run can help inspect page structure for the static-vs-JS call. Keep any throwaway probe scripts in `backend/spikes/` — do NOT add per-vendor production scrapers in this task.

---

## 5. What the result tells us (decision tree)

After the table is filled:

- **Mostly STATIC + PUBLIC** (best case) → Band 2 is easy. Add each vendor behind the `scrape(url) -> ProductSlideInput` interface, mostly reusing existing logic. No paid services needed. Probably a few days.
- **Some BLOCKED** → those vendors need the paid unblocker (ScraperAPI/Zyte/Bright Data) behind a config switch. Only adopt it if a vendor the firm actually uses is blocked. Cost sign-off from client.
- **Some/many GATED (trade login)** → this is the big fork. Auto-scraping can't reach login-gated data, and an unblocker doesn't help. Handling it means operating with the firm's vendor credentials (authenticated sessions) — a much larger, security-sensitive piece of work. If this is common across their vendors, it becomes its own mini-project + a scope/cost conversation with the client. **Flag it; do not build it in Band 2 without that conversation.**

**Special weight:** whatever Four Hands turns out to be drives the priority. If Four Hands is static+public, half their volume is trivially covered. If Four Hands is gated, the trade-login fork jumps to the top of the priority list.

---

## 6. Deliverable for this task
1. The filled-in table (§3).
2. A 3–5 line recommendation: which bucket the vendors mostly fall into, whether we need the paid unblocker, and whether trade-login handling is a real required piece — plus the suggested Band 2 order (Four Hands first).

NO production scrapers, no unblocker integration, no login handling in this task. Investigation + recommendation only. Those builds come after, informed by this.