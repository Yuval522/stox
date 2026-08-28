/**
 * Multi-source aggregation for historical financial statements.
 *
 * Rather than trusting a single provider for a fiscal year's income
 * statement / balance sheet / cash flow row, getFundamentals() (yahoo.ts)
 * fetches from up to three sources in parallel and this file merges them
 * whole-row-per-fiscal-year (never blending individual fields from
 * different sources within the same year — that risks mixing incompatible
 * line-item definitions) in a fixed priority order:
 *
 *   1. SEC EDGAR (sec-edgar.ts)  — audited XBRL data straight from 10-K/20-F
 *      filings, typically 10+ years deep for any SEC-registered filer.
 *      This is what makes a genuine "10 Years" / "All Available" range
 *      selection actually mean something, instead of being capped by
 *      whatever a single quote-data API happens to return.
 *   2. Yahoo Finance (yahoo.ts)  — recent years, and the *only* source for
 *      tickers SEC doesn't register (foreign-only listings with no US ADR).
 *   3. Financial Modeling Prep (providers/fmp.ts) — opt-in (needs
 *      FMP_API_KEY), last-resort fallback for whatever gap remains; its
 *      free tier caps history at ~5 years so it rarely adds depth beyond
 *      what Yahoo already covers, but occasionally fills an isolated
 *      missing year within that recent window.
 *
 * Every merged row keeps a `dataSource` tag so the UI can show exactly
 * where each year's numbers came from (see summarizeYearSources /
 * formatSourceSummary, used by the Income/Balance/Cash Flow panel badges).
 *
 * Data triangulation: priority order is the default tie-breaker, but
 * mergeYearsBySource's optional `anchorField` lets it actually cross-check
 * providers against each other for years all three cover, and demote a
 * clear 2-against-1 outlier instead of trusting priority blindly — see
 * that function's doc comment for the exact mechanism and thresholds.
 *
 * Discrepancy flagging: separately from the 2-against-1 demotion above
 * (which needs 3 sources to know which one is likely wrong), ANY period
 * where 2+ sources disagree beyond tolerance on `anchorField` gets a
 * `dataDiscrepancy: true` tag on the merged row — this is deliberately
 * "flag, don't guess": with only 2 disagreeing sources there's no
 * majority to trust, so rather than silently picking the priority winner
 * and saying nothing, the row carries a visible signal (rendered by
 * SourceAttributionBadge) that this period's figures haven't been
 * corroborated yet. The most common real-world trigger is exactly the
 * freshness case this exists for: a just-released quarter where one
 * provider has already indexed the new numbers and another hasn't caught
 * up, so their same-labeled period genuinely differs.
 */

import type { CashFlowYear, FinancialDataSource, IncomeStatementYear, PricePoint } from "./types";

export interface YearRow {
  fiscalYear: string;
  dataSource?: FinancialDataSource;
  /** See the doc comment on this same field in types.ts (IncomeStatementYear et al.) for the full mechanism. */
  dataDiscrepancy?: boolean;
}

export interface SourceLayer<T extends YearRow> {
  source: FinancialDataSource;
  years: T[];
}

/**
 * Global cash-flow sign convention + Free Cash Flow standardization (live
 * request: "audit and standardize how CapEx, SBC, and OCF are parsed and
 * signed across all providers ... a unified, foolproof FCF formula
 * globally, preventing any sign inversions, field-mapping errors, or
 * discrepancies against official reports for all assets").
 *
 * Every provider (Yahoo, SEC EDGAR, FMP) exposes its own "free cash flow"
 * figure computed by that provider's own, undocumented definition — not
 * guaranteed to agree with either of the other two, or with the company's
 * own reported figure. Since this app merges cash-flow rows WHOLE-ROW-PER-
 * FISCAL-YEAR by source priority (mergeYearsBySource below), trusting each
 * provider's own FCF field verbatim means the exact same company's FCF
 * trend could show a discontinuity, or even flip sign, purely because the
 * winning source for one year differs from the winning source for the
 * adjacent year — with no real business reason behind it. Same risk, one
 * level down, for CapEx/SBC sign: a provider that (or a future API
 * version that) reports CapEx as a positive "amount spent" instead of a
 * negative investing outflow would silently ADD to Free Cash Flow instead
 * of subtracting, understating leverage on FCF-based ratios everywhere
 * downstream (FCF Yield, P/FCF, DCF inputs — see valuation-methods.ts /
 * fair-value.ts) without any visible error.
 *
 * The fix is structural, not per-source: every one of this app's three
 * CashFlowYear-mapping functions (mapCashFlowRow/fmpCashFlowToYears in
 * yahoo.ts, toSecCashFlowRows in providers/sec-edgar.ts) — and the TTM
 * rollup engine (ttm.ts) that sums 4 quarters of already-mapped rows —
 * MUST go through these three functions and nothing else:
 *   - normalizeCapex(): forces CapEx to always be <= 0 (an investing
 *     outflow), regardless of the raw sign a provider happens to report.
 *   - normalizeStockBasedComp(): forces SBC to always be >= 0 (a non-cash
 *     addback to net income), same rationale.
 *   - computeFreeCashFlow(): the ONE formula for FCF used everywhere in
 *     this codebase — Operating Cash Flow + CapEx (CapEx already
 *     guaranteed negative by normalizeCapex()) — so every fiscal year,
 *     every quarter, and every TTM row, from every source, for every
 *     symbol, is provably self-consistent (freeCashFlow ===
 *     operatingCashFlow + capitalExpenditures, always) instead of each
 *     provider's own possibly-divergent figure.
 * No provider's own `freeCashFlow` field is ever read anywhere in the
 * CashFlowYear pipeline (annual rows, quarterly rows, or TTM rollups) as of
 * this fix — grep for `.freeCashFlow` on a raw provider response type (not
 * a `CashFlowYear`) to confirm before touching this again. The one
 * intentional exception is `toMetrics()` in yahoo.ts, which falls back to
 * Yahoo's own pre-netted `financialData.freeCashflow` summary field ONLY
 * when no structured cash-flow row (from any source) exists at all for
 * that symbol — that module exposes a single already-netted number with no
 * separate CapEx field to normalize, so there is nothing to recompute; it
 * never participates in a historical series next to unified-formula rows,
 * only stands in alone as a last resort. See the comment at that call site.
 */
/**
 * The fiscal year a period ending on `end` belongs to, given the company's
 * fiscal year end MONTH (0-11, Date.getMonth() convention — 0 for a
 * January fiscal year end, 11 for December/calendar-fiscal). A fiscal year
 * is conventionally NAMED after the calendar year in which it ENDS, so a
 * period's own end-date calendar year is only the right fiscal-year number
 * when that period ends in or before the fiscal year-end month within that
 * same calendar year; otherwise it belongs to the fiscal year that will
 * conclude the FOLLOWING calendar year. Mathematically a no-op for the
 * overwhelming majority of December-fiscal-year filers (every month is
 * always <= 11, so this never rolls the year forward) — the effect is
 * confined entirely to non-calendar-fiscal-year filers: NVDA (~January),
 * MSFT (~June), AAPL (~September), CRM/Salesforce (~January), among others.
 *
 * The single shared implementation of this formula — yahoo.ts's
 * makeFiscalQuarterLabelFn (Yahoo quarterly rows) and sec-edgar.ts's
 * quarterlySeries/quarterlySeriesDetailed (SEC EDGAR quarterly rows) both
 * call this rather than each carrying their own copy of the arithmetic, so
 * the two sources can never independently drift on what fiscal year a
 * given period-end date belongs to. That matters because mergeYearsBySource
 * below dedups/merges quarterly rows across sources by exact fiscalYear-
 * label STRING match — both sources computing the identical label for the
 * identical real period is what makes that matching work at all, instead
 * of silently producing duplicate near-identical rows under two adjacent,
 * seemingly-distinct labels (see yahoo.ts's makeFiscalQuarterLabelFn doc
 * comment for the exact NVDA/AAPL/MSFT bug this class of mismatch caused
 * once already, on the quarter-NUMBER side; this fixes the equivalent bug
 * on the quarter-YEAR side, root-caused via a CRM/Salesforce report —
 * FYE January 31 — where SEC EDGAR's quarterly rows for one fiscal year
 * were splitting across two different label-year prefixes, breaking
 * synthesizeIncomeQ4/synthesizeCashFlowQ4/synthesizeBalanceQ4's
 * `${annualLabel}-Q1/Q2/Q3` lookups for any such company).
 */
export function fiscalYearForPeriodEnd(end: Date, fiscalYearEndMonth: number): number {
  return end.getMonth() > fiscalYearEndMonth ? end.getFullYear() + 1 : end.getFullYear();
}

export function normalizeCapex(raw: number): number {
  const abs = Math.abs(raw);
  return abs === 0 ? 0 : -abs; // avoid a stray "-0" reaching formatters/UI
}

export function normalizeStockBasedComp(raw: number): number {
  return Math.abs(raw);
}

/** CapEx must already be sign-normalized (<= 0) via normalizeCapex() before calling this — see the module doc comment above for why. */
export function computeFreeCashFlow(operatingCashFlow: number, capitalExpendituresNegative: number): number {
  return operatingCashFlow + capitalExpendituresNegative;
}

/** Relative difference between two finite numbers, symmetric and 0..~2 scale (not clamped). */
function relativeDifference(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

// Cross-source triangulation thresholds — see mergeYearsBySource's
// `anchorField` doc comment. AGREEMENT: how close two independent sources
// must be to count as "corroborating" each other (loose enough to absorb
// normal rounding/restatement noise between two real providers).
// OUTLIER: how far the priority winner must diverge from BOTH corroborating
// sources before it's treated as the odd one out rather than a genuine,
// if-slightly-different, real figure. Deliberately wide apart (2% vs 8%) so
// this only fires on clear-cut cases, not routine provider-to-provider
// variance.
const CROSS_VALIDATION_AGREEMENT_TOLERANCE = 0.02;
const CROSS_VALIDATION_OUTLIER_TOLERANCE = 0.08;
/** Same floor as warnIfDuplicateValuesAcrossYears — sub-$1M anchor values are too close to
 *  noise/rounding for a percentage comparison to mean anything. */
const CROSS_VALIDATION_MIN_MAGNITUDE = 1_000_000;

/**
 * Merges ordered source layers into one fiscal-year timeline. For each
 * fiscal year, the first layer (in priority order) that has a row wins —
 * later layers only fill years earlier ones are missing entirely, so a
 * single year's figures always come from one consistent, real filing/API
 * response rather than a patchwork of fields from different providers.
 *
 * Data-triangulation override (the `anchorField` option): every layer is
 * fetched in parallel regardless of who ultimately wins (see
 * getFundamentals() in yahoo.ts), so for any fiscal year where 3 sources
 * all report data, this function can — and now does — actually compare
 * them instead of blindly trusting priority order. If the two
 * lower-priority sources agree closely with each other on `anchorField`
 * (e.g. totalRevenue for income, totalAssets for balance,
 * operatingCashFlow for cash flow) but the would-be winner diverges
 * sharply from BOTH of them, that's a 2-against-1 majority against the
 * "winner" — a real signal, not routine provider noise — so the row is
 * demoted to the next-best (whole-row, still un-blended — see this file's
 * module doc comment) source instead. This only ever activates with 3
 * genuinely present sources for the same year (rare when FMP is
 * unconfigured, by design — see CROSS_VALIDATION_* thresholds), and when
 * it doesn't activate, behavior is byte-for-byte identical to the
 * original priority-order merge. Omitting `anchorField` entirely (existing
 * call sites that haven't opted in) preserves the original behavior
 * exactly.
 *
 * Zero-field backfill (the `backfillZeroFields` option): live bug reports
 * against AT&T found `grossProfit`/`operatingIncome` (income) and
 * `totalLiabilities` (balance) coming back as a hard `0` from SEC EDGAR for
 * an operating company with real, positive revenue/assets — not because
 * the value is genuinely zero, but because that filer simply doesn't tag
 * the specific XBRL concept toSecIncomeRows/toSecBalanceRows (sec-edgar.ts)
 * looks for (e.g. a cost-of-revenue tag variant this app doesn't check),
 * so the derivation silently falls back to 0. Because mergeYearsBySource
 * otherwise selects a WHOLE row per year, that fabricated 0 wins outright
 * even when Yahoo/FMP have a real, non-zero number for that one field —
 * their whole row loses priority for the year, so their good data for
 * this field is never consulted either. `backfillZeroFields` closes that
 * specific gap: for a listed field, if the winning row's value is exactly
 * 0, and ANY other source's row for the same year has a real (finite,
 * non-zero) value for that field, that one field gets patched onto a copy
 * of the winning row — every other field, and the row's `dataSource`
 * attribution, stays exactly as the winner reported it. This is
 * deliberately narrower than "blend fields across sources": it only ever
 * fires on a 0 (a value that structurally can't be a differing-but-valid
 * figure, only an absence), never on a genuine disagreement between two
 * real numbers — so it doesn't reopen the "mixing incompatible line-item
 * definitions" risk this file's whole-row design otherwise avoids. Only
 * apply this to fields that are essentially never legitimately exactly
 * zero for a real operating company (Gross Profit, Operating Income,
 * Total Liabilities) — never to a field where 0 can be a genuine, correct
 * value (e.g. Total Debt for a debt-free company, or Stock-Based
 * Compensation for a company with no equity comp program).
 */
export function mergeYearsBySource<T extends YearRow>(
  label: string,
  symbol: string,
  layers: SourceLayer<T>[],
  options?: { anchorField?: keyof T & string; backfillZeroFields?: (keyof T & string)[] }
): T[] {
  const anchorField = options?.anchorField;
  const backfillZeroFields = options?.backfillZeroFields;
  const candidatesByYear = new Map<string, { source: FinancialDataSource; row: T }[]>();
  for (const layer of layers) {
    for (const row of layer.years) {
      const list = candidatesByYear.get(row.fiscalYear) ?? [];
      list.push({ source: layer.source, row });
      candidatesByYear.set(row.fiscalYear, list);
    }
  }

  const byYear = new Map<string, T>();
  for (const [fiscalYear, candidates] of candidatesByYear) {
    let winner = candidates[0]; // highest-priority source that has this year — default/original behavior

    // Discrepancy flag: independent of (and computed before) the 3-source
    // outlier-demotion below — even a plain 2-source disagreement, which
    // isn't enough evidence to know which provider is right, is still
    // worth surfacing rather than silently picking the priority winner and
    // saying nothing. Computed across ALL candidates for this period, not
    // just the eventual winner, so it also catches disagreement between
    // two lower-priority sources the demotion logic never even inspects.
    let dataDiscrepancy = false;
    if (anchorField) {
      const anchorValues = candidates
        .map((c) => Number(c.row[anchorField]))
        .filter((v) => Number.isFinite(v) && Math.abs(v) >= CROSS_VALIDATION_MIN_MAGNITUDE);
      outer: for (let i = 0; i < anchorValues.length; i++) {
        for (let j = i + 1; j < anchorValues.length; j++) {
          if (relativeDifference(anchorValues[i], anchorValues[j]) > CROSS_VALIDATION_OUTLIER_TOLERANCE) {
            dataDiscrepancy = true;
            break outer;
          }
        }
      }
      if (dataDiscrepancy && process.env.NODE_ENV !== "production") {
        console.warn(
          `[Stox] ${label}(${symbol}) ${fiscalYear}: sources disagree on "${anchorField}" beyond ` +
            `tolerance — ${candidates.map((c) => `${c.source}=${Number(c.row[anchorField]).toLocaleString("en-US")}`).join(", ")}.`
        );
      }
    }

    if (anchorField && candidates.length >= 3) {
      const withAnchor = candidates
        .map((c) => ({ ...c, value: Number(c.row[anchorField]) }))
        .filter((c) => Number.isFinite(c.value) && Math.abs(c.value) >= CROSS_VALIDATION_MIN_MAGNITUDE);
      const top = withAnchor.find((c) => c.source === winner.source);
      const others = withAnchor.filter((c) => c.source !== winner.source);
      if (top && others.length >= 2) {
        const othersAgree = relativeDifference(others[0].value, others[1].value) < CROSS_VALIDATION_AGREEMENT_TOLERANCE;
        const winnerIsOutlier =
          relativeDifference(top.value, others[0].value) > CROSS_VALIDATION_OUTLIER_TOLERANCE &&
          relativeDifference(top.value, others[1].value) > CROSS_VALIDATION_OUTLIER_TOLERANCE;
        if (othersAgree && winnerIsOutlier) {
          const demoted = winner;
          winner = others[0]; // the higher-priority of the two agreeing, corroborating sources
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[Stox] ${label}(${symbol}) ${fiscalYear}: "${anchorField}" from ${demoted.source} ` +
                `(${Number(demoted.row[anchorField]).toLocaleString("en-US")}) is an outlier vs. ` +
                `${others[0].source} and ${others[1].source}, which agree with each other ` +
                `(${others[0].value.toLocaleString("en-US")} vs. ${others[1].value.toLocaleString("en-US")}) — ` +
                `using ${winner.source}'s row for this year instead of the default priority order.`
            );
          }
        }
      }
    }

    if (backfillZeroFields && backfillZeroFields.length > 0) {
      let patchedRow: T | null = null;
      for (const field of backfillZeroFields) {
        const currentVal = Number(winner.row[field]);
        if (!Number.isFinite(currentVal) || currentVal !== 0) continue; // only patch a genuine, suspicious 0
        const donor = candidates.find((c) => {
          if (c.source === winner.source) return false;
          const v = Number(c.row[field]);
          return Number.isFinite(v) && v !== 0;
        });
        if (!donor) continue;
        patchedRow = { ...(patchedRow ?? winner.row), [field]: donor.row[field] };
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[Stox] ${label}(${symbol}) ${fiscalYear}: "${field}" from ${winner.source} was 0 — ` +
              `backfilled from ${donor.source}'s value (${Number(donor.row[field]).toLocaleString("en-US")}) ` +
              `for this field only. Every other field still comes from ${winner.source}.`
          );
        }
      }
      if (patchedRow) winner = { source: winner.source, row: patchedRow };
    }

    byYear.set(fiscalYear, {
      ...winner.row,
      dataSource: winner.source,
      dataDiscrepancy: dataDiscrepancy || undefined,
    });
  }

  // String comparison, not Number() subtraction — `fiscalYear` is either a
  // bare year ("2023") or a quarter label ("2023-Q2", see quarterLabel() /
  // quarterlySeries()), and Number("2023-Q2") is NaN. Plain lexicographic
  // comparison sorts both correctly: same-length year strings compare in
  // numeric order, and "YYYY-Qn" keys compare correctly too since the year
  // prefix dominates and Q1 < Q2 < Q3 < Q4 as characters.
  const merged = [...byYear.values()].sort((a, b) => a.fiscalYear.localeCompare(b.fiscalYear));
  logSourceBreakdown(label, symbol, merged);
  warnIfYearsLookStale(label, symbol, merged);
  warnIfDuplicateValuesAcrossYears(label, symbol, merged);
  return merged;
}

export interface SourceRun {
  source: FinancialDataSource;
  from: string;
  to: string;
}

/**
 * Collapses a merged, chronologically-sorted row list into contiguous
 * same-source runs (e.g. rows tagged sec-edgar for 2016-2023 then yahoo for
 * 2024-2026 become two runs) — shared by both the dev-log line below and
 * the UI attribution badge (see IncomeStatementPanel.tsx etc.) so the two
 * never drift out of sync with each other.
 */
export function summarizeYearSources<T extends YearRow>(rows: T[]): SourceRun[] {
  const runs: SourceRun[] = [];
  for (const row of rows) {
    if (!row.dataSource) continue; // untagged (mock/demo data) — nothing to attribute
    const last = runs[runs.length - 1];
    if (last && last.source === row.dataSource) {
      last.to = row.fiscalYear;
    } else {
      runs.push({ source: row.dataSource, from: row.fiscalYear, to: row.fiscalYear });
    }
  }
  return runs;
}

export const SOURCE_LABELS: Record<FinancialDataSource, string> = {
  "sec-edgar": "SEC EDGAR",
  yahoo: "Yahoo Finance",
  fmp: "Financial Modeling Prep",
};

/** Human-readable one-liner, e.g. "2016-2023: SEC EDGAR · 2024-2026: Yahoo Finance". */
export function formatSourceSummary(runs: SourceRun[]): string {
  return runs
    .map((r) => `${r.from === r.to ? r.from : `${r.from}–${r.to}`}: ${SOURCE_LABELS[r.source]}`)
    .join(" · ");
}

/**
 * Deliberately always-on (not gated behind NODE_ENV like this codebase's
 * other dev-only diagnostics, e.g. warnIfFiscalYearGaps in yahoo.ts) —
 * source attribution is a requested transparency feature, not noise to
 * silence in production, and it's one line per statement fetch rather than
 * per-row spam.
 */
function logSourceBreakdown<T extends YearRow>(label: string, symbol: string, rows: T[]): void {
  if (rows.length === 0) {
    console.info(`[Stox] ${label}(${symbol}): no data from any source`);
    return;
  }
  const summary = formatSourceSummary(summarizeYearSources(rows));
  console.info(`[Stox] ${label}(${symbol}): ${rows.length} year(s) — ${summary}`);
}

/**
 * Cross-check added after an external audit report claimed a systemic
 * "+2 year" fiscal-label shift across every ticker (e.g. GOOGL's real
 * FY2021 revenue allegedly showing up labeled "2023"). Investigated and
 * NOT reproduced against this codebase: every fiscal-year string in this
 * pipeline is read directly from the row's own actual reported period —
 * annualLabel()/quarterLabel() in yahoo.ts pull `date.getFullYear()` off
 * the real Date each fundamentalsTimeSeries row carries, and
 * annualSeries()/quarterlySeries() in providers/sec-edgar.ts key off each
 * XBRL fact's own `fy` field (falling back to its `end` date) — there is
 * no "currentYear - N" anchor-arithmetic anywhere in this file or those
 * two, which is what the report's root-cause hypothesis would require.
 * Cross-referencing the report's own worked AAPL example against this
 * repo's mock-data.ts (the one payload fully inspectable here) also
 * contradicts it: "2023" already holds Apple's real FY2023 revenue
 * ($383.285B), not FY2025's.
 *
 * Kept as a standing safeguard regardless — a genuinely stale/misconfigured
 * deployment (e.g. SEC_EDGAR_CONTACT unset *and* Yahoo rate-limited) could
 * still produce the surface symptom the report described: real, correctly
 * labeled, but old data silently presented as current. A gap this large is
 * worth surfacing loudly during development rather than only being caught
 * by an ad hoc diff against a live provider payload. Dev-only, like the
 * neighboring warnIfFiscalYearGaps() in yahoo.ts — this is a diagnostic
 * for catching data-freshness regressions during development, not a
 * user-facing signal.
 */
function warnIfYearsLookStale<T extends YearRow>(label: string, symbol: string, rows: T[]): void {
  if (process.env.NODE_ENV === "production") return;
  // Bare year strings only ("2023") — quarterly ("2023-Q2") and trailing
  // ("TTM"/"MRQ") labels correctly fall out of Number.isFinite here, same
  // filter convention as warnIfFiscalYearGaps in yahoo.ts.
  const numericYears = rows.map((r) => Number(r.fiscalYear)).filter((y) => Number.isFinite(y));
  if (numericYears.length === 0) return;
  const newest = Math.max(...numericYears);
  const currentYear = new Date().getFullYear();
  // A filer's most recent annual filing can legitimately lag the current
  // calendar year by close to a year (e.g. a December-FY filer's 10-K for
  // last year isn't on file until well into Q1/Q2 of this one) — 2+ years
  // behind is the specific signature the external audit described, so
  // that's the threshold flagged here rather than anything tighter.
  if (currentYear - newest >= 2) {
    console.warn(
      `[Stox] ${label}(${symbol}): newest fiscal year label is ${newest}, ` +
        `${currentYear - newest} years behind the current calendar year (${currentYear}). ` +
        `Could be a genuinely slow/incomplete data source, or a labeling bug — verify ` +
        `against a raw provider payload (SEC EDGAR's companyfacts API, or Yahoo's ` +
        `fundamentalsTimeSeries) before trusting it.`
    );
  }
}

/**
 * Dev-only fingerprint check added after a user-reported bug (NVDA's
 * fullscreen Total Revenues chart showing "2026" = $61B, independently
 * verified via web search to be wrong — NVIDIA's real FY2026 revenue was
 * $215.9B, while $61B numerically matches NVIDIA's real FY2024 revenue of
 * $60.922B almost exactly). The exact upstream root cause couldn't be
 * pinned down without live network access to Yahoo/SEC EDGAR in this
 * environment, and per this file's standing principle, guessing at a "fix"
 * risks silently corrupting otherwise-correct data — worse than the
 * original bug. This instead detects the specific fingerprint a
 * label/merge collision of this kind would leave behind: two DIFFERENT,
 * adjacent fiscal-year rows carrying the same (or near-identical) value
 * for the same large-magnitude metric. Real companies essentially never
 * report an unchanged dollar figure for revenue/income two years running,
 * so a match here is far more likely to mean one row's fiscal-year label
 * is wrong than a genuine flat year.
 */
function warnIfDuplicateValuesAcrossYears<T extends YearRow>(label: string, symbol: string, rows: T[]): void {
  if (process.env.NODE_ENV === "production") return;
  if (rows.length < 2) return;
  // Compare only adjacent rows in the sorted timeline — a same-value
  // collision between neighboring years is the specific signature of a
  // labeling/merge bug; comparing every pair against every other pair
  // would also flag distant, coincidentally-similar years far more often
  // (e.g. a slow-growth company's revenue five years apart).
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.fiscalYear === cur.fiscalYear) continue;
    for (const key of Object.keys(cur) as (keyof T)[]) {
      if (key === "fiscalYear" || key === "dataSource") continue;
      const a = prev[key];
      const b = cur[key];
      if (typeof a !== "number" || typeof b !== "number") continue;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      // Ignore sub-$1M values — many statement fields legitimately sit at
      // (or near) zero across multiple years, e.g. a debt-free company's
      // totalDebt. Only large-magnitude duplicates are statistically
      // implausible enough by chance to be worth flagging.
      if (Math.abs(a) < 1_000_000) continue;
      const relDiff = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
      if (relDiff < 0.001) {
        console.warn(
          `[Stox] ${label}(${symbol}): "${String(key)}" is nearly identical in ` +
            `${prev.fiscalYear} (${a.toLocaleString("en-US")}) and ${cur.fiscalYear} ` +
            `(${b.toLocaleString("en-US")}) — possible fiscal-year label/merge collision ` +
            `rather than a genuine flat year-over-year figure. Verify against a raw ` +
            `provider payload before trusting either row.`
        );
      }
    }
  }
}

/**
 * Dev-only diagnostic added after two independent, unverified-live bug
 * reports that share the same signature — a plausible real annual figure
 * followed by an implausible trailing (TTM/MRQ) one:
 *   - GOOGL: Total Assets $595B (last annual) -> $922B (MRQ), a 55%
 *     one-quarter jump.
 *   - AT&T: Total Debt $143.7B (last annual) -> $9.32B (MRQ), an ~93%
 *     one-quarter drop (almost exactly matching just the current portion
 *     of long-term debt, suggesting the quarterly LongTermDebtNoncurrent
 *     tag came back empty for that specific period while the smaller
 *     current-portion tag didn't).
 *
 * Neither could be root-caused without live SEC EDGAR/Yahoo access in
 * this sandbox (see this file's module doc comment on that limitation),
 * and — unlike the exactly-0 case backfillZeroFields handles — there's no
 * structurally safe automatic fix here: both fields CAN legitimately move
 * a lot in one quarter for a real reason (a major acquisition, a large
 * new bond issuance), so silently overriding either figure risks
 * suppressing a genuinely correct number. This only logs, so the data
 * shown is unchanged; it exists purely so an implausible trailing figure
 * is visible in server logs (with both values named) instead of silently
 * feeding wrong ratios (P/FCF, Debt-to-Equity, etc.) with no trace of why.
 */
export function warnIfTrailingRowImplausible<T extends YearRow>(
  label: string,
  symbol: string,
  historical: T[],
  trailing: T | null | undefined,
  anchorField: keyof T & string,
  /** How large a one-period move counts as "implausible" — defaults to 40%, loose enough that normal quarter-to-quarter movement never trips it. */
  threshold = 0.4
): void {
  if (process.env.NODE_ENV === "production") return;
  if (!trailing || historical.length === 0) return;
  const last = historical[historical.length - 1];
  const lastVal = Number(last[anchorField]);
  const trailingVal = Number(trailing[anchorField]);
  if (!Number.isFinite(lastVal) || !Number.isFinite(trailingVal)) return;
  if (Math.abs(lastVal) < 1_000_000) return; // same noise floor as warnIfDuplicateValuesAcrossYears
  const relDiff = Math.abs(trailingVal - lastVal) / Math.max(Math.abs(lastVal), Math.abs(trailingVal));
  if (relDiff > threshold) {
    console.warn(
      `[Stox] ${label}(${symbol}): "${anchorField}" moved from ${lastVal.toLocaleString("en-US")} ` +
        `(${last.fiscalYear}) to ${trailingVal.toLocaleString("en-US")} (${trailing.fiscalYear}) — a ` +
        `${(relDiff * 100).toFixed(0)}% change in one period. Could be real (acquisition, major debt ` +
        `issuance) or a tag-mapping/dimensional-data artifact — verify against a raw SEC EDGAR/Yahoo ` +
        `payload before trusting either figure.`
    );
  }
}

/**
 * Defensive backstop for the class of bug applyKnownSplitAdjustmentToNonSecRows
 * (sec-edgar.ts) and the filed-date fix inside toSecIncomeRows both target —
 * an adjacent-fiscal-year diluted-share-count ratio outside a plausible
 * organic range (buybacks/issuance/secondary offerings don't move share
 * count 5x in a year; only a stock split, a mis-scaled unit, or a
 * still-undetected split boundary does). "Flag, don't guess" — same
 * philosophy as this file's dataDiscrepancy tagging above: this only warns
 * in development, it never drops, zeroes, or silently "corrects" a row,
 * since a false positive here (a genuine, if unusual, large secondary
 * offering) would be worse than a missed true positive. Run AFTER any
 * split-adjustment step, so a correctly-adjusted series should almost never
 * trip this — if it still does, that's a real signal something's still
 * off (an unknown split, a bad tag, a genuine unit-scale bug) worth
 * checking against the raw payload.
 */
export function warnIfShareCountDiscontinuity<T extends YearRow & { sharesOutstandingDiluted: number }>(
  label: string,
  symbol: string,
  rows: T[],
  /** Ratio bounds outside which an adjacent-year jump is flagged — 5x up or 0.2x down by default, matching the range an organic buyback/issuance program never crosses in a single fiscal year. */
  maxRatio = 5
): void {
  if (process.env.NODE_ENV === "production") return;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].sharesOutstandingDiluted;
    const cur = rows[i].sharesOutstandingDiluted;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    const ratio = cur / prev;
    if (ratio > maxRatio || ratio < 1 / maxRatio) {
      console.warn(
        `[Stox] ${label}(${symbol}): sharesOutstandingDiluted moved from ` +
          `${prev.toLocaleString("en-US")} (${rows[i - 1].fiscalYear}) to ${cur.toLocaleString("en-US")} ` +
          `(${rows[i].fiscalYear}) — a ${ratio.toFixed(1)}x change in one period, outside the range an ` +
          `organic buyback/issuance program ever produces. Likely an undetected/mistimed stock split or a ` +
          `unit-scale tag mismatch — verify against the raw SEC EDGAR/Yahoo payload for these two years.`
      );
    }
  }
}

/**
 * Backfills `totalRevenue` onto each cash-flow row by matching its
 * `fiscalYear` label against the already-merged income array covering the
 * same periods — see CashFlowYear.totalRevenue's doc comment in types.ts
 * for why this is a one-time post-merge join in getFundamentals() (yahoo.ts)
 * rather than sourced per-provider the way `netIncome` is: none of the
 * three cash-flow sources (Yahoo's fundamentalsTimeSeries cash-flow module,
 * SEC EDGAR XBRL cash-flow facts, FMP's cash-flow endpoint) consistently
 * carry a revenue figure, but every source's INCOME statement always does,
 * and by the time this runs both `cashFlow`/`cashFlowQuarterly` and
 * `income`/`incomeQuarterly` are already fully merged (including their
 * TTM/MRQ-equivalent trailing row), so a single label match covers real
 * fiscal years and the trailing row alike. A cash-flow period with no
 * income-side match for its label (an isolated one-sided gap) is left with
 * `totalRevenue: undefined` rather than a fabricated 0 — toPctOfRevenue
 * (chart-transform.ts) already treats a missing/non-finite denominator as
 * "no % to show".
 */
export function backfillCashFlowRevenue(cashFlow: CashFlowYear[], income: IncomeStatementYear[]): CashFlowYear[] {
  const revenueByYear = new Map(income.map((row) => [row.fiscalYear, row.totalRevenue]));
  return cashFlow.map((row) => {
    const totalRevenue = revenueByYear.get(row.fiscalYear);
    return totalRevenue != null ? { ...row, totalRevenue } : row;
  });
}

/**
 * Ticker-recycling / ghost-data fix (live bug report: newly-IPOed stocks
 * showing financial reports "from 3+ years ago" that belong to a different,
 * unrelated company). Yahoo — and, just as often, SEC EDGAR, priority-1 in
 * mergeYearsBySource precisely because it goes "10+ years deep for any
 * SEC-registered filer" (see this file's top doc comment) — key their
 * historical data purely by ticker SYMBOL, not by company identity: when a
 * symbol is recycled after an older company is delisted/defunct, a
 * brand-new IPO under that same symbol can inherit the OLD company's
 * financial history wholesale. `quote.firstTradeDateEpochMs` (see its doc
 * comment in types.ts) is the one signal anchored to the CURRENT listing
 * rather than the symbol string, so getFundamentals() (yahoo.ts) uses it
 * here as a cutoff on the already-merged annual/quarterly arrays — applied
 * post-merge (not per-source pre-merge) so it catches ghost data regardless
 * of which of the three providers happened to contribute it for a given
 * period.
 *
 * REGRESSION FIX (live bug report: SPCX — Space Exploration Technologies
 * Corp / SpaceX, a real operating company that IPO'd 2026-06-12 — showed
 * completely blank Income/Balance Sheet/Cash Flow tabs). The original
 * version of this function used a hard `year >= listingYear` cutoff, which
 * seemed safe (see the superseded doc comment this replaces) but actually
 * discarded EVERY fiscal year before the IPO — including the 2-3 years of
 * audited pre-IPO financials an S-1/F-1 is required to disclose (SEC Reg
 * S-K Item 8 generally requires 2-3 years of audited statements in a
 * registration statement, which is exactly why SEC EDGAR / Yahoo have that
 * history at all for a company that just went public). For a company that
 * IPOs mid-year with no complete fiscal year of its own filed yet (SPCX's
 * case — IPO'd in June, and no full FY2026 10-K exists as of this fix),
 * that hard cutoff left the annual arrays empty entirely: not "ghost data
 * removed," but "every real row removed too."
 *
 * Fixed by widening the cutoff to a PRE_IPO_LOOKBACK_YEARS-year lookback
 * window instead of the bare listing year — grounded in the original bug
 * report's own framing ("financial reports from 3+ years ago" was the
 * shape of the ghost-data problem, i.e. the recycled data was AT LEAST
 * that old relative to the new listing), and in the SEC's own 2-3 year
 * disclosure requirement for legitimate pre-IPO history. A row is now
 * discarded only when its entire labeled fiscal year is more than
 * PRE_IPO_LOOKBACK_YEARS years before the listing year — old enough that
 * it can no longer plausibly be the current company's own required S-1
 * disclosure, which is exactly the shape of genuine ticker-recycling ghost
 * data (a wholly separate company's multi-year history, not a nearby
 * pre-IPO year).
 *
 * Deliberately YEAR-granularity, not exact-date, for the same reason as
 * before: fiscalYear labels ("2023", "2023-Q2") carry no day-level
 * precision, so year-level slack is the right unit to reason about here.
 *
 * `listingDateMs` of null (Yahoo doesn't report firstTradeDateMilliseconds
 * for every symbol) is a no-op — with no anchor to compare against, keeping
 * every row a provider returned is strictly safer than guessing. Synthetic
 * labels that aren't a bare year or "YYYY-Qn" — currently just "TTM" and
 * "MRQ" (see toTrailingIncomeRow/toTrailingCashFlowRow and the MRQ balance
 * appendix in yahoo.ts), both always-current-as-of-fetch by construction —
 * parse to NaN and are never filtered out.
 *
 * Guards against `Number("")` — a JS quirk that resolves to `0`, not NaN —
 * with an explicit leading-4-digit regex check before parsing, so a blank
 * or otherwise malformed label safely falls into the same "always keep,
 * never guess" bucket as "TTM"/"MRQ" rather than being misread as year 0
 * and silently dropped.
 */
const PRE_IPO_LOOKBACK_YEARS = 3;

export function filterRowsBeforeListing<T extends { fiscalYear: string }>(
  rows: T[],
  listingDateMs: number | null
): T[] {
  if (listingDateMs == null) return rows;
  const listingYear = new Date(listingDateMs).getUTCFullYear();
  const cutoffYear = listingYear - PRE_IPO_LOOKBACK_YEARS;
  return rows.filter((row) => {
    if (!/^\d{4}/.test(row.fiscalYear)) return true; // "TTM", "MRQ", blank, or any other non-year label
    const year = Number(row.fiscalYear.slice(0, 4));
    return year >= cutoffYear;
  });
}

/**
 * Same ticker-recycling / ghost-data fix as filterRowsBeforeListing above,
 * applied to the daily price-bar series instead of merged statement rows.
 * Unlike fiscalYear labels, PricePoint.date carries real day-level
 * precision ("YYYY-MM-DD", ISO — see toPricePoints in yahoo.ts), and this
 * cutoff is exact-date rather than year-granularity: Yahoo's chart endpoint
 * returns whatever OHLC history exists under the symbol regardless of
 * company identity, so a recycled ticker's price series can extend years
 * further back than the current company's actual first trade date. ISO
 * date strings sort correctly with a plain lexicographic `>=` comparison,
 * so no Date parsing is needed per point. `listingDateMs` of null is a
 * no-op, same rationale as filterRowsBeforeListing.
 */
export function filterPricePointsBeforeListing(
  points: PricePoint[],
  listingDateMs: number | null
): PricePoint[] {
  if (listingDateMs == null) return points;
  const listingDateStr = new Date(listingDateMs).toISOString().slice(0, 10);
  return points.filter((p) => p.date >= listingDateStr);
}
