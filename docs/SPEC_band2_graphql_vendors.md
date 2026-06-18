# Implementation Spec — Band 2 (Part 2): GraphQL Vendors — Uttermost & Moe's

> Hand to Claude Code alongside the project context. Goal: add scrapers for the two GraphQL-SPA vendors — Uttermost and Moe's Home — using a direct-`/graphql` call first, Playwright only as fallback. Build on a fresh feature branch `feat/band2-graphql-vendors` off `main`. Same per-vendor registry pattern as the static vendors.

---

## 1. Goal & context

Triage found Uttermost and Moe's serve a near-empty HTML shell — all product data loads via a **GraphQL call after JavaScript runs**. No product data in static HTML, but (per triage) **no bot protection** on either, so Playwright works cleanly as a fallback.

**Preferred approach: call the GraphQL endpoint directly** (no browser) → clean JSON → fast and reliable. **Fallback: Playwright** render-then-parse if the direct call doesn't pan out.

- Uttermost: Magento/Venia PWA. Try `uttermost.com/graphql`.
- Moe's: React/Apollo SPA. Try its `/graphql` endpoint.

Both register as vendor adapters (by domain) behind the existing registry; unknown domains still use the generic scraper. Reuse the `VendorScraper` interface + registry from the static-vendors work.

---

## 2. Approach: a 3-tier fetch per vendor (cheap → heavy)

For each of these two vendors, the adapter tries in order:

```
1. DIRECT GraphQL  — POST the product query to the /graphql endpoint, parse JSON.   (cheapest, preferred)
2. PLAYWRIGHT      — render the page, let JS run, read window state / rendered DOM.  (dependable fallback)
3. FAIL gracefully — return whatever fields were obtained; missing fields = "" for user to fill.
```

Do NOT make these vendors depend ONLY on the direct GraphQL call — it's an internal endpoint that can change. Playwright is the safety net.

---

## 3. Step A — discover the query (investigation, do this first per vendor)

Before coding the direct call, you must learn the exact GraphQL request the site makes. For each vendor, on a real product page:
- Open browser dev tools → Network tab → filter for the `graphql` request(s).
- Capture: the endpoint URL, the query/operation body, required variables (usually a product SKU/URL-key/ID parsed from the page URL), and any required headers (e.g. `Store`, `Content-Type: application/json`, sometimes a store/locale header for Magento).
- Identify where in the JSON response the name / dimensions / description / images live.
- (The Playwright MCP or a quick manual inspection is ideal for this.)

Record the discovered query + response shape as a comment in the adapter, so it's maintainable when the site changes.

**Reality check:** if reproducing the direct call proves fiddly (auth tokens, signed requests, persisted-query hashes), don't sink hours into it — fall back to the Playwright tier for that vendor and move on. The direct call is an optimization, not a requirement.

---

## 4. Step B — implement each adapter

### 4a. Uttermost (`uttermost.com`)
- Magento/Venia → Magento GraphQL. Parse the SKU/url-key from the product URL.
- Try `POST uttermost.com/graphql` with the product query (likely a `products(filter: {...})` query returning name, description, media gallery, and custom/spec attributes).
- **Dimensions:** Magento often stores dims as custom attributes or in the description/spec area — capture whatever holds the dimension string, verbatim.
- **Images:** from the media gallery entries in the response.
- Fallback: Playwright render → read product data.

### 4b. Moe's Home (`moeshome.com`)
- React/Apollo SPA. Parse product handle/slug from the URL.
- Try its `/graphql` endpoint with the product query (Apollo/Shopify-style — name, description, dimensions field/metafield, images).
- **Dimensions:** capture the dimension field/metafield verbatim.
- **Images:** from the response image list.
- Fallback: Playwright render → read product data.

---

## 5. Output contract (unchanged)
Each adapter returns the same `ScrapeResult` (name, dimensions, description, images[]) as the static vendors. Everything downstream — image selection, hero background removal, supporting images, generation — is unchanged.

- **Dimensions:** verbatim, never normalized (same rule as always).
- **Missing description/dimensions:** return `""`; user fills in via the UI (don't crash, don't block generation).

---

## 6. Related note — partial-data fallback (LOGGED ISSUE, not fixed here)
There is a known general gap: the scraper currently treats a static fetch as "success" if it gets *some* data (e.g. name + images), even when a required field like dimensions is missing — so it doesn't escalate to the heavier path. This surfaced with Anthropologie. It is NOT in scope for this task, but be aware: for these GraphQL vendors, define "success" as "got the fields we need," and escalate (direct → Playwright) when required fields are missing — not only when the page looks blocked. (The broader fix to the generic scraper's success condition is a separate task.)

---

## 7. Edge cases / gotchas
- **GraphQL endpoint requires specific headers** (Magento often needs a `Store` header / specific content-type) — replicate what the real request sends.
- **Persisted/automatic-persisted queries** — some Apollo setups send a query hash instead of the full query. If so, send the full query in the POST body (most servers accept it) or fall back to Playwright.
- **Internal endpoint may change** — keep Playwright fallback working; don't hard-depend on the direct call.
- **Rate/abuse** — keep requests modest; this is an internal endpoint, not a public API.
- **Variants** — scrape the product as presented at the given URL; don't enumerate every variant (out of scope).
- **Unknown domain** → generic fallback unchanged (no regression).

---

## 8. Definition of done
- Pasting an Uttermost product URL returns name, dimensions (verbatim), description, and images, and generates a correct editable slide — via direct GraphQL if it works, else via Playwright.
- Same for a Moe's Home product URL.
- Each adapter tries direct GraphQL first and cleanly falls back to Playwright when needed.
- Missing fields (e.g. dimensions not exposed) come through as `""` and the slide still generates; user can fill in.
- Static vendors (Four Hands/Rowe/York), Pottery Barn/Anthropologie, and unknown-domain fallback all still work (no regression).

---

## 9. Out of scope
- Surya (Cloudflare-blocked — needs paid unblocker; deferred pending client volume confirmation).
- The general partial-data fallback fix to the generic scraper (separate task; see §6).
- Variant/colour/size enumeration.
- Deploy / DB work.

---

## 10. Suggested commit breakdown (small, runnable steps)
1. **Investigate Uttermost** — capture its GraphQL endpoint, query, variables, headers, and response shape (dev tools / MCP). Throwaway probe in `backend/spikes/`. Document findings. No adapter yet.
2. **Uttermost adapter** — direct GraphQL call (from step 1 findings) → parse fields; Playwright fallback. Register by domain. Test on 2–3 real product URLs → generated slide.
3. **Investigate Moe's** — same discovery for its `/graphql`.
4. **Moe's adapter** — direct GraphQL → parse; Playwright fallback. Register. Test end-to-end.
5. Regression check: static vendors + Pottery Barn + Anthropologie + unknown domain still work.