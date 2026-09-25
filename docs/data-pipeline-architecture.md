# Stox Data Pipeline Architecture Review

**Scope:** institutional-grade redesign of `lib/finance/` — provider benchmark, root cause of the pre-2009 historical-depth wall, TTM/MRQ calculation engine, and a concrete implementation blueprint.

**Status (updated again):** the SEC EDGAR integration described throughout this document (`providers/sec-edgar.ts`) was **removed entirely** per explicit request — the app no longer makes any requests to SEC EDGAR. §4's implementation blueprint has since been **built**: `providers/eodhd.ts` now exists, opt-in via `EODHD_API_KEY`, wired into `aggregate.ts`'s merge priority as the lowest-priority layer (Yahoo → FMP → EODHD) exactly as scoped below. It is unverified against a live key (this sandbox has no network egress to eodhd.com — see that file's own doc comment) and therefore not yet exercised end-to-end; spot-check the field mappings against a real response before relying on it for a specific ticker. §§1-2 below are kept as historical record of the prior (SEC EDGAR-based) architecture and describe the OLD pipeline, not the current one — see CLAUDE.md's Data layer section for the current, accurate picture. The TTM engine (§3) is unaffected by any of this and remains shipped as described.

---

## 1. Current pipeline, as-built (historical — SEC EDGAR since removed, see Status above)

`getFundamentals()` in `lib/finance/yahoo.ts` used to fan out to three sources in parallel per request:

| Source | File | Role | Depth |
|---|---|---|---|
| ~~SEC EDGAR (`companyfacts` XBRL API)~~ *(removed)* | ~~`providers/sec-edgar.ts`~~ | Was primary — audited, as-filed statements | Was 10–20 fiscal years for established large filers, but **never earlier than ~2009** (see §2) |
| Yahoo Finance (`yahoo-finance2`) | `yahoo.ts` | Now the primary source for every ticker | ~4–5 fiscal years annual, more for quarterly |
| Financial Modeling Prep | `providers/fmp.ts` | Now the only secondary gap-filler, entirely opt-in via `FMP_API_KEY` | Up to 30 years on paid tiers, capped at 5 years annual on the free tier |

`aggregate.ts`'s `mergeYearsBySource()` combines them per fiscal year with fixed priority (now just Yahoo > FMP), merging **whole rows**, never individual fields across sources within the same period — deliberate, to avoid blending incompatible line-item definitions from different providers. This is also why a single missing/zero field from the top-priority source can win an entire period over a better-populated lower-priority source; the fabricated-$0-revenue bug fixed earlier in this project was exactly that failure mode.

---

## 2. Root cause of the pre-2009 depth wall

This is a **source limitation, not an integration bug**. `sec-edgar.ts` has no hardcoded start-year cutoff anywhere in `periodEndDateFromLabel`/`annualSeries`/`quarterlySeries` — they walk whatever fiscal years exist in the `companyfacts` payload with no floor.

The wall exists because SEC's XBRL mandate was phased in by filer size:

- Large accelerated filers (public float ≥ $700M): fiscal periods ending **after June 15, 2009**.
- Accelerated filers: fiscal periods ending after June 15, 2010.
- All remaining filers (including smaller foreign private issuers): fiscal periods ending after June 15, 2011.

`data.sec.gov`'s `companyfacts` API is built entirely from structured XBRL, so for periods before a filer's mandate date there is genuinely nothing machine-readable to fetch — regardless of how far back the filer's actual 10-K/10-Q text filings go (EDGAR's full-text archive itself reaches back to the mid-1990s, but only as unstructured HTML/plain text). A small number of early-adopter filers voluntarily tagged a year or two earlier, which is why AT&T's SEC-sourced data floors around 2007 instead of a clean 2009 — that's the genuine edge of what SEC ever received in structured form from that filer, not a parsing gap on our side.

**iCharts reaching back to 1987 for the same company is not pulling from SEC's structured API at all** — it has to be sourced from a vendor that has separately digitized/licensed pre-XBRL filing data (financial-statement extraction from scanned/OCR'd or manually keyed historical filings). There is no additional EDGAR request shape, endpoint, or tag mapping that unlocks this — confirmed against SEC's own developer documentation and Financial Statement Data Sets (which likewise start Q1 2009).

### Provider benchmark for pre-2009 depth

| Provider | Depth for major US tickers | Mechanism | Pricing (as researched) |
|---|---|---|---|
| **EODHD (EOD Historical Data)** | Confirmed into the **1980s** for large-cap tickers (e.g. AAPL fundamentals from 1985) | Licenses/digitizes pre-XBRL filing data — not SEC's structured API | Fundamentals Data Feed: €59.99/mo or €599.90/yr. Free tier: 20 calls/day, 1-year depth only (not usable for this) |
| Intrinio | ~2007–2008 for large/mid caps | Sources from SEC filings/XBRL | Same ~2009-era wall as SEC EDGAR directly |
| Polygon.io | "10+ years" from SEC filings | Sources from SEC filings/XBRL | Same ~2009-era wall as SEC EDGAR directly |
| Financial Modeling Prep | Up to 30 years claimed on paid tiers; 5 years on free tier | Unclear/proprietary; paid-tier claim not independently verified against a specific 1980s ticker | Free tier already integrated (opt-in via `FMP_API_KEY`); paid tier pricing not confirmed in this pass |

**Recommendation:** EODHD is the only researched provider with *demonstrated* depth into the 1980s, and it's demonstrated via a different sourcing mechanism (licensed/digitized historical filings) than SEC EDGAR, Intrinio, or Polygon — all three of which fundamentally share our own ~2009 XBRL wall and would not solve this problem even as a full swap-in. If matching iCharts' 1987-era depth for legacy tickers is a real requirement (versus "as deep as SEC EDGAR genuinely allows, clearly labeled"), EODHD is the concrete provider to budget for. FMP's paid-tier 30-year claim is worth a small paid-tier trial before EODHD if cost is the deciding factor, since it's already wired into this codebase — but it has not been independently verified against a specific pre-2009 ticker the way EODHD has.

---

## 3. TTM & financial-statement pipeline — now standardized (shipped)

### Problem this closes

TTM (Trailing Twelve Months) previously came exclusively from Yahoo's own `fundamentalsTimeSeries({type: "trailing"})` endpoint. That's a real, live figure when available, but a single-source dependency: if that one Yahoo endpoint failed, rate-limited, or simply didn't cover a given symbol, the TTM column silently disappeared — even though this app's own multi-source quarterly pipeline (SEC EDGAR 10-Qs + Yahoo + FMP, already merged by `aggregate.ts`) frequently has all four of the most recent quarters sitting right there.

### Design

New module: **`lib/finance/ttm.ts`**

```ts
export function computeTrailingTwelveMonths<T extends { fiscalYear: string }>(
  quarterlyRows: T[],
  config: { sumKeys: (keyof T & string)[]; latestKeys?: (keyof T & string)[] }
): T | null
```

- Parses each row's `"YYYY-Qn"` fiscal-quarter label into a linear index (`year*4 + (quarter-1)`), which stays exactly 1 apart between consecutive quarters even across a calendar-year boundary.
- Takes the four most recent quarters and **requires them to be strictly consecutive**. If fewer than four quarters exist, or there's a gap (a quarter no source reported), it returns `null` rather than fabricating a partial/understated TTM — a missing TTM bar is a better failure mode than a silently-wrong one.
- Flow fields (revenue, net income, operating cash flow, EPS, dividends/share, etc.) are **summed** across the four quarters — the standard TTM convention.
- Point-in-time fields (diluted shares outstanding) are taken from the **single latest quarter**, not summed, since summing a share count four times is meaningless.
- Balance Sheet already correctly uses "MRQ" (Most Recent Quarter actual balance) rather than a TTM sum, since balance-sheet items are snapshots, not flows — this was already correct and is unchanged.

### Wiring (`yahoo.ts`, inside `getFundamentals()`)

The quarterly merge block (`incomeQuarterly`/`balanceQuarterly`/`cashFlowQuarterly`, each already merged Yahoo > FMP by `mergeYearsBySource` — SEC EDGAR has since been removed from this priority chain, see Status above) now runs **before** the trailing/TTM-append step, so the merged quarterly data is available as a fallback:

```ts
const incomeTrailing =
  toTrailingIncomeRow(trailingIncomeRows, summary) ??
  computeTrailingTwelveMonths(incomeQuarterly, {
    sumKeys: ["totalRevenue", "grossProfit", "operatingIncome", "netIncome", "eps", "dividendsPerShare"],
    latestKeys: ["sharesOutstandingDiluted"],
  });
if (incomeTrailing) income.push(incomeTrailing);

const cashFlowTrailing =
  toTrailingCashFlowRow(trailingCashFlowRows) ??
  computeTrailingTwelveMonths(cashFlowQuarterly, {
    sumKeys: ["operatingCashFlow", "freeCashFlow", "stockBasedCompensation", "capitalExpenditures", "netIncome"],
  });
if (cashFlowTrailing) cashFlow.push(cashFlowTrailing);
```

Yahoo's own dedicated trailing fetch is still preferred when it succeeds (occasionally fresher than the latest filed quarter). The new engine is a fallback, not a replacement — this makes TTM **universal**: any symbol with four consecutive merged quarters from *any combination* of SEC EDGAR, Yahoo, or FMP now gets a TTM bar, instead of TTM depending on one specific Yahoo endpoint succeeding.

This also directly fixes the "clean mapping... without label shifts or duplicated/stale values" requirement: because it consumes the *already deduped and fiscal-quarter-labeled* `incomeQuarterly`/`cashFlowQuarterly` arrays (the same arrays that back the Quarterly chart view, and the same ones the fiscal-vs-calendar quarter-labeling fix already hardened against duplicate/mislabeled periods), the TTM fallback can't independently reintroduce a labeling bug — it inherits whichever labeling correctness the quarterly pipeline already has.

### Verified

`npx tsc --noEmit`, `npx next lint`, and `npx next build` all pass clean against this change (see commit for this file).

---

## 4. EODHD deep-history layer — implemented (unverified live)

This section originally described a not-yet-built blueprint; it's now a description of what actually shipped.

1. `providers/eodhd.ts` mirrors `providers/fmp.ts`'s opt-in shape: `EODHD_API_KEY` env var, `isEodhdConfigured()` returning `false` when unset (a true no-op, same pattern FMP already uses), and `fetchEodhdFundamentals()` (one combined call — EODHD's real endpoint returns every statement, annual and quarterly, together, unlike FMP's six separate endpoints) plus `eodhdIncomeToYears`/`eodhdBalanceToYears`/`eodhdCashFlowToYears` mapping into the same `IncomeStatementYear[]`/`BalanceSheetYear[]`/`CashFlowYear[]` shapes the rest of the pipeline already expects.
2. Wired into `aggregate.ts`'s `mergeYearsBySource` priority chains as the **lowest** priority (Yahoo → FMP → EODHD) in all six call sites inside `getFundamentals()` (`yahoo.ts`) — annual and quarterly income/balance/cash-flow.
3. Because `mergeYearsBySource` keys by fiscal year and already tags every row with `dataSource` for the existing UI attribution badges, no panel code needed to change — a ticker with EODHD depth simply gains additional older rows tagged `"eodhd"` (`SOURCE_LABELS` in `aggregate.ts`, "EOD Historical Data") once `EODHD_API_KEY` is set.
4. The source-attribution badges (already shipped, §6 of `alt-data-sources-evaluation.md`) continue to show exactly which years came from which source — no separate "document the floor" step needed, that mechanism already exists and now also covers this third source.

**Not yet done:** live verification against a real `EODHD_API_KEY` and a real ticker. This sandbox has no network egress to eodhd.com (same restriction as every other third-party provider integration built in this codebase — see `providers/fmp.ts`/`providers/alphaVantage.ts`'s own doc comments), so the field names in `EodhdPeriodRow` (`providers/eodhd.ts`) follow EODHD's publicly documented response shape but are not independently confirmed against a live response. Before relying on this for a specific ticker: get a real key, hit `/fundamentals/{SYMBOL}.US`, and diff the actual JSON keys against `EodhdPeriodRow`'s field list — fix any mismatch there rather than anywhere else in the pipeline (the merge/aggregate/UI layers are all generic over `dataSource` and need no changes regardless of what EODHD's exact field names turn out to be).
