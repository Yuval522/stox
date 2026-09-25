# Alternative Data Sources & Cross-Validation — Feasibility Evaluation

**Scope:** Google Finance integration feasibility, Apple Stocks app backend benchmark, a multi-source data-triangulation/conflict-resolution design, investing.com scraping feasibility, and earnings-freshness/discrepancy-flagging mechanisms for `lib/finance/`.

**Status:** research and evaluation complete for items 1–2 (recommendation: do not integrate Google Finance; Apple Stocks confirms our existing choice of Yahoo, not a new option) and item 4 (recommendation: do not scrape investing.com, same ToS/legal reasoning as item 1). Items 3, 5, and 6 (cross-source triangulation, earnings-aware cache bypass, and discrepancy flagging) are implemented and shipped in `lib/finance/aggregate.ts`, `lib/finance/cache.ts`, `lib/finance/yahoo.ts`, and `components/ticker/SourceAttributionBadge.tsx`.

**Update:** §3 below was written when this app queried three sources (SEC EDGAR, Yahoo, FMP) in parallel. SEC EDGAR has since been removed entirely per explicit request — the app now queries only Yahoo and FMP. The triangulation/majority-vote mechanism §3 describes needs 3+ independent sources to activate (a 2-against-1 majority requires three voters) and is therefore currently dormant code with only two sources configured; the 2-source discrepancy-flagging mechanism (§6) is unaffected and remains active. §3's text below is left as historical record of the original 3-source design.

---

## 1. Google Finance — not viable as an integration target

**Official API: gone, not coming back.** Google shut down the Google Finance API in 2011 and fully decommissioned it on October 20, 2012. There has been no indication since of it returning.

**The only remaining Google-native access point is `GOOGLEFINANCE()`, a Google Sheets formula** — not an API. It has three disqualifying limitations for this app:

1. **Fundamentals coverage is essentially nil.** `GOOGLEFINANCE()` exposes only P/E ratio and EPS — no revenue, no net income, no balance sheet, no cash flow. It cannot replace or cross-check any of the Income/Balance/Cash Flow statement data this app already pulls from Yahoo/FMP; it isn't a fundamentals source at all.
2. **It's not real-time and not documented as an API contract.** Quotes are delayed up to 20 minutes and the function is explicitly a spreadsheet convenience, not a stable service with published rate limits, SLAs, or a terms-of-service grant for embedding in a third-party product.
3. **There is no supported way to call it outside Google Sheets.** Using it here would mean either (a) driving an actual Google Sheet as a scraping intermediary, which is fragile and roundabout, or (b) reverse-engineering the same internal endpoint the formula calls — which is scraping, not integration (see below).

**Scraping the live Google Finance website is the only remaining path, and it's a real liability, not just "fragile."** Beyond the practical issues (page markup and CSS selectors change frequently, breaking scrapers without notice), there is live legal precedent specifically on this point: Google filed a DMCA lawsuit against SerpApi in December 2025 over scraping Google's own properties (hearing scheduled May 2026). Building a production feature on top of unauthorized scraping of a Google product is a direct legal exposure for this app, not a hypothetical one.

**Recommendation: do not integrate Google Finance in any form.** It adds legal risk, has essentially no fundamentals data even if it worked, and every fundamentals gap it might have plugged is already better served by the EODHD path documented in `docs/data-pipeline-architecture.md`.

---

## 2. Apple Stocks app — confirms, rather than expands, the existing provider choice

Apple's built-in iOS Stocks app has **no public API of its own** — it's a native OS app, not a service with documented endpoints. The relevant question was who supplies *its* backend data, to see whether that supplier is worth adopting.

**Finding: Apple Stocks' quote/fundamentals data is Yahoo Finance.** This is corroborated directly by user reports on Apple's own support forums (Apple Community discussions from 2018 through 2023 show users specifically asking Apple to *stop* using Yahoo Finance data in the Stocks app, confirming it was — and per the most recent threads, still is — the active backend). Apple layers its own native UI, watchlist sync (iCloud), and a "Business News" panel sourced separately through Apple News (aggregating outlets like Bloomberg, WSJ, CNBC for headlines, not quote/fundamentals data) on top of that Yahoo feed.

**Implication for this app: we already use the same core data source Apple's Stocks app relies on.** `lib/finance/yahoo.ts` already sits on the identical `yahoo-finance2` data path. There is no separate "Apple-grade" provider to adopt — matching Apple Stocks' reliability/speed is really a question of how well *we* use Yahoo (rate-limit handling, caching, background refresh), which this codebase already addresses via `TtlCache`, `useBackgroundRefresh`, and `useLiveQuotes` (see prior work: the 7s live-quote polling overlay and 60s persisted background refresh on ticker/Watchlist/Portfolio pages). There's no new integration work this finding recommends — it's a validation that the existing Yahoo dependency was the right call, not a gap.

---

## 3. Multi-source cross-validation & conflict resolution — implemented

### Design (historical — written when SEC EDGAR was still a source; see Update note above)

Every statement fetch used to query SEC EDGAR, Yahoo, and (when configured) FMP **in parallel**, regardless of which one ended up "winning" a given fiscal year under the existing priority-order merge (`mergeYearsBySource` in `aggregate.ts`). That meant the data needed to cross-check providers against each other was already being fetched and then discarded — this change put it to use instead of throwing it away. With SEC EDGAR since removed, this app now only ever fetches Yahoo and (when configured) FMP in parallel.

**What changed:** `mergeYearsBySource()` gained an optional `anchorField` parameter. When provided, and when a given fiscal year has data from **all three** sources, the function compares each source's value for that one anchor field (the statement's single most universally-defined figure — `totalRevenue` for income, `totalAssets` for balance, `operatingCashFlow` for cash flow) instead of blindly trusting priority order:

- If the two *lower*-priority sources agree closely with each other (within 2%) but the priority winner diverges sharply from **both** of them (>8% from each), that's a 2-against-1 majority against the winner — treated as a real signal, not routine provider noise, and the row is demoted to the next-best source instead.
- Demotion swaps the **whole row**, never individual fields — preserving this codebase's existing, deliberate "never blend fields across sources" principle (the same principle that made the earlier fabricated-$0-revenue bug fixable by widening one source's own tag coverage, not by borrowing fields from another source). The `dataSource` attribution tag is updated to reflect whichever source actually won after the check, so the UI badges stay accurate.
- Every other case — fewer than 3 sources present for that year, or a genuine 3-way disagreement with no 2-source majority — leaves the original priority order untouched and does **not** silently pick a "resolution." This is deliberate: with no clear corroboration, an algorithmic tie-break would just be a guess, and this codebase's standing principle (established across the revenue-derivation fix, the TTM gap-detection in `ttm.ts`, and the historical-depth honesty in `sec-edgar.ts`) is to avoid fabricating confidence where none exists.

**Anomaly/stale-figure flagging:** when a demotion happens, a `console.warn` fires (dev-only, matching the existing `warnIfYearsLookStale`/`warnIfDuplicateValuesAcrossYears` diagnostic conventions already in this file) naming the outlier source, its value, and the two corroborating sources' values — so a developer can immediately see *which* provider was wrong for *which* year, not just that "something disagreed."

**Missing-year gap detection** (the "pre-2009 gap" part of the ask) doesn't need new code: `mergeYearsBySource` already unions every year any source reports (nothing is dropped for lack of a "vote"), and the existing per-year source-attribution badges plus `logSourceBreakdown` already show exactly where each source's coverage starts and stops. This was originally written to describe SEC EDGAR/Yahoo/FMP converging on the same floor year as the signal of a real structural depth wall (see `docs/data-pipeline-architecture.md`); with SEC EDGAR removed, Yahoo and FMP's own ~4-5 year caps are simply this app's fundamentals-depth ceiling — there's no deeper source to compare against anymore.

### Where it's wired in

All six `mergeYearsBySource` call sites in `getFundamentals()` (`yahoo.ts`) pass an anchor field: `income`/`incomeQuarterly` → `totalRevenue`, `balance`/`balanceQuarterly` → `totalAssets`, `cashFlow`/`cashFlowQuarterly` → `operatingCashFlow`. The anchor field still drives the 2-source discrepancy-flagging mechanism (§6) even now that only two sources exist.

### Why this activates rarely in practice, by design

FMP is opt-in (`FMP_API_KEY`) and most deployments won't have it configured, so with SEC EDGAR removed, the 3-source condition for the majority-vote triangulation above is now effectively never met (this app has at most 2 sources — Yahoo and FMP) — the system runs the original 2-source (or 1-source) priority merge instead, unchanged. This is intentional: the override is a genuine majority-vote mechanism, and a majority vote needs three independent voters to mean anything. The code path remains in place (harmless, dormant) rather than removed, in case a third source is ever added.

### Verified

`npx tsc --noEmit`, `npx next lint`, and `npx next build` all pass clean against this change (see commit for `lib/finance/aggregate.ts` and `lib/finance/yahoo.ts`).

---

## 4. investing.com as a secondary source — not integrated (ToS/legal risk)

A later request asked for `investing.com` specifically as a scraping fallback to catch fresh earnings faster. Declined for the same reason Google Finance was declined in §1: investing.com's Terms of Service explicitly prohibit automated scraping of their data, and this project already has a documented policy (§1 above) of not building production features on top of unauthorized scraping — the risk profile is identical (fragile markup-dependent parsing, no stable contract, real legal exposure), not a new consideration specific to this site. Confirmed with the user directly before any implementation work started; the two mechanisms below (already-integrated, ToS-compliant sources only) were built instead.

## 5. Earnings-aware cache bypass — implemented

**The actual problem this solves:** `getFundamentals()`'s cache (`fundamentalsCache` in `yahoo.ts`) is fine-grained enough (~5 minutes) that it was never the real cause of "we're still showing last quarter's numbers days after earnings." The real cause is a client-side cache that has no way to know a new quarter now exists upstream — it just serves whatever it last fetched until the TTL naturally expires, then re-fetches (and may well get the same stale answer again if nothing changed in between).

**The fix:** `getEarningsFreshnessEpoch()` runs a cheap, single-module `quoteSummary` probe (`calendarEvents` only — a small fraction of the cost of the full multi-source fetch) ahead of every `getFundamentals()` call, deriving an ISO-date "freshness epoch" from the most recent PAST earnings-call date Yahoo reports. That epoch is folded directly into the cache key (`fundamentals:{SYMBOL}:{epoch}`). As long as a symbol hasn't crossed a new earnings date, the epoch — and therefore the key — stays constant, so caching behaves exactly as before. The moment a new earnings date is crossed, the key changes, `fundamentalsCache.getOrSet` naturally treats it as a miss, and a real, fresh, cross-source-validated fetch runs — with the now-superseded previous key explicitly evicted (`TtlCache.delete`, added for this) so long-lived server processes don't leak stale-keyed entries across many earnings cycles. The probe itself is wrapped in its own 60-second cache so a burst of page loads for the same symbol doesn't trigger a probe per request.

**Honest limitation, stated plainly:** this guarantees Stox *asks* its upstream providers again as soon as the calendar date arrives — it cannot guarantee Yahoo/FMP have already indexed the brand-new quarter at that exact moment; that indexing lag lives entirely on the provider side and no client-side cache policy can close it. What this closes is Stox's *own* added delay on top of whatever the providers already have. A genuinely sub-minute, guaranteed-fresh feed (matching a real institutional terminal) would require a paid low-latency provider (Polygon.io, Finnhub, etc.) as an additional source — not implemented here since no such credential was provided; the architecture (`mergeYearsBySource`'s layer/priority model) already supports adding one the same way Yahoo/FMP were added, whenever a key becomes available.

## 6. Cross-source discrepancy flagging — implemented

`mergeYearsBySource`'s existing triangulation (§3) only acts when *three* sources are present and two of them corroborate each other against a clear outlier — by design, since a 2-against-1 majority is real evidence, while a plain 2-source disagreement isn't enough to know which one is right. That left a real gap: when exactly two sources report the same period with materially different figures (the most common real-world trigger being exactly the freshness case above — one provider has already indexed a just-released quarter and the other hasn't caught up), the merge silently picked the priority winner and said nothing.

**The fix:** every merged row now carries an optional `dataDiscrepancy: boolean` field, set whenever 2+ sources' `anchorField` values for that period differ beyond the existing 8% outlier tolerance — independent of, and computed before, the 3-source demotion check, so it also catches disagreement the demotion logic never even looks at (e.g. two lower-priority sources disagreeing with each other while the winner is untouched). This is deliberately "flag, don't guess": with no third corroborating source, there's no principled way to auto-correct, so the mismatch is surfaced instead — both as a dev-console `console.warn` (matching this file's existing diagnostic conventions) and, for the first time, as a real user-visible signal: `SourceAttributionBadge` now renders an amber "Sources disagree: {period(s)} — verify before relying on it" line whenever any rendered period carries the flag, directly on the Income/Balance/Cash Flow panels rather than only in server logs a user never sees.

---

## Sources

- [Google Finance API and the Best Alternatives for Developers (2026)](https://scrapfly.io/blog/posts/guide-to-google-finance-api)
- [Google Finance API: What Happened + 2026 Alternatives | ScrapeBadger](https://scrapebadger.com/blog/google-finance-api-what-happened-to-it-and-what-to-use-in-2026)
- [GoogleFinance Function Advanced Tutorial 2026 | Coupler.io Blog](https://blog.coupler.io/googlefinance-function-advanced-tutorial/)
- [GOOGLEFINANCE Alternative: 1,000+ Functions for Google Sheets | MarketXLS](https://marketxls.com/blog/googlefinance-alternative)
- [Stocks App still Uses Yahoo Finance which… — Apple Community](https://discussions.apple.com/thread/253827975)
- [Stocks app still using yahoo finance — Apple Community](https://discussions.apple.com/thread/254750718)
- [Stocks: change Yahoo Finance to Ap… | Apple Developer Forums](https://developer.apple.com/forums/thread/103983)
