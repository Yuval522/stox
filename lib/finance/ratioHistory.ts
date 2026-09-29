import { fiscalLabelToDate } from "./stockSplits";
import { toDisplayUnit } from "../format/currency";
import type { IncomeStatementYear, PricePoint } from "./types";

/**
 * Continuous historical valuation-multiple time series (currently: Price to
 * Earnings) for the Ratios tab's "Valuation Ratios" section — matching the
 * professional-terminal pattern of a smooth daily line (not discrete
 * per-fiscal-year bars) with a Select Range control and a dashed historical-
 * average benchmark line.
 *
 * Distinct from lib/finance/fair-value.ts / valuation-history.ts: those
 * compute a *fair value estimate* (price the stock "should" trade at, given
 * its own historical multiples) — this file computes the multiple ITSELF,
 * day by day, exactly as a terminal's "P/E over time" chart does. No
 * fair-value modeling, growth adjustment, or projection here — just
 * `price / trailing EPS` at each daily close.
 *
 * Methodology:
 *  1. Build a "trailing EPS as of date X" timeline. Preferred: walk the
 *     quarterly income statements and sum each set of 4 CONSECUTIVE
 *     quarters into a genuine TTM EPS figure (same consecutive-quarter
 *     requirement as lib/finance/ttm.ts's computeTrailingTwelveMonths — a
 *     gap is skipped rather than summed across, which would silently
 *     understate TTM). Falls back to annual EPS (each fiscal year's `eps`
 *     is already a genuine trailing-twelve-months figure by construction)
 *     when there isn't enough usable quarterly data to build even one TTM
 *     point this way — e.g. thin quarterly coverage for a foreign private
 *     issuer, or mock/demo data.
 *  2. Each TTM/annual EPS figure only becomes "known" a reporting lag AFTER
 *     its period actually ended — approximated as 45 days for a quarter, 75
 *     for a full fiscal year (both comfortably inside the SEC's own 10-Q/
 *     10-K filing deadlines for even the slowest filer category) — so the
 *     resulting P/E series never uses a figure before the market could have
 *     actually known it (no look-ahead bias).
 *  3. Each daily close in `history` is divided by whichever EPS figure was
 *     the most recently "known" one as of that date (walk-forward join, not
 *     interpolation — P/E should visibly step when a new quarter's earnings
 *     are reported, not smoothly ramp toward it). Dates before ANY EPS
 *     figure is known, and dates where the known EPS is zero or negative
 *     (a P/E against non-positive earnings isn't a meaningful multiple), are
 *     both simply omitted from the series — consistent with this codebase's
 *     "don't fabricate a number when there's nothing real to show" principle
 *     (see e.g. ttm.ts's own "missing TTM bar is better than a silently-wrong
 *     one" reasoning).
 *
 * Currency handling mirrors fair-value.ts's own precedent exactly: `history`
 * closes are in quoteCurrency's raw subunit convention (agorot, pence,
 * etc — see toDisplayUnit), while `eps` from the income statements is
 * already reporting-currency DISPLAY units. When quoteCurrency !==
 * reportingCurrency (e.g. TEVA.TA), the ratio is still computed the same
 * way but flagged via `currencyDiffers` so the UI can show the same
 * "not FX-adjusted" caveat every other cross-currency valuation widget in
 * this app already shows, rather than silently presenting a technically
 * mismatched-currency multiple as if it were precise.
 */

export interface RatioHistoryPoint {
  /** ISO date, matches the underlying PricePoint.date this was derived from. */
  date: string;
  value: number;
}

export interface PriceToEarningsHistoryResult {
  points: RatioHistoryPoint[];
  /** True when the series was built from a genuine quarterly TTM walk (denser, more responsive to each earnings report) rather than the coarser annual-EPS fallback — surfaced so the UI can caption which basis is in play. */
  quarterlyBased: boolean;
  currencyDiffers: boolean;
  quoteCurrency: string;
  reportingCurrency: string;
}

export type RatioHistoryRange = "1Y" | "3Y" | "5Y" | "10Y" | "All";

const QUARTERLY_REPORTING_LAG_DAYS = 45;
const ANNUAL_REPORTING_LAG_DAYS = 75;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface TrailingEpsEntry {
  /** The date this EPS figure first becomes "known" to the market (period end + reporting lag). */
  effectiveDate: Date;
  eps: number;
}

/** Same "YYYY-Qn" -> linear-index parsing as lib/finance/ttm.ts's own quarterIndex — duplicated locally (that one isn't exported) rather than reworking ttm.ts's public surface for a single shared helper. */
function quarterIndex(fiscalYear: string): number | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(fiscalYear);
  if (!m) return null;
  return Number(m[1]) * 4 + (Number(m[2]) - 1);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * Builds the "known TTM EPS as of date X" timeline from quarterly income
 * statements — one entry per set of 4 consecutive reported quarters, oldest
 * first. Returns an empty array (rather than a partial/gappy series) when
 * there's no run of 4+ consecutive quarters anywhere in the data, so the
 * caller can cleanly fall back to annual EPS instead of half-succeeding.
 */
function buildQuarterlyTtmEpsTimeline(quarterly: IncomeStatementYear[]): TrailingEpsEntry[] {
  const withIndex = quarterly
    .map((row) => ({ row, index: quarterIndex(row.fiscalYear) }))
    .filter((r): r is { row: IncomeStatementYear; index: number } => r.index != null)
    .sort((a, b) => a.index - b.index); // oldest first

  const entries: TrailingEpsEntry[] = [];
  for (let i = 3; i < withIndex.length; i++) {
    const window = withIndex.slice(i - 3, i + 1);
    let consecutive = true;
    for (let j = 1; j < window.length; j++) {
      if (window[j].index - window[j - 1].index !== 1) {
        consecutive = false;
        break;
      }
    }
    if (!consecutive) continue; // a genuine reporting gap — don't fabricate a TTM across it
    const ttmEps = window.reduce((sum, w) => sum + w.row.eps, 0);
    const periodEnd = fiscalLabelToDate(window[3].row.fiscalYear);
    entries.push({ effectiveDate: addDays(periodEnd, QUARTERLY_REPORTING_LAG_DAYS), eps: ttmEps });
  }
  return entries;
}

/** Annual fallback — each fiscal year's `eps` is already a real trailing-twelve-months figure by construction, so no summing is needed, just a reporting-lag-adjusted effective date. Excludes any non-plain-year label (the "TTM" trailing-appendix row) since that row would double-count the latest annual figure. */
function buildAnnualEpsTimeline(annual: IncomeStatementYear[]): TrailingEpsEntry[] {
  return annual
    .filter((row) => /^\d{4}$/.test(row.fiscalYear))
    .map((row) => ({
      effectiveDate: addDays(fiscalLabelToDate(row.fiscalYear), ANNUAL_REPORTING_LAG_DAYS),
      eps: row.eps,
    }))
    .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
}

/**
 * Walk-forward join of daily prices against a "known as of" EPS timeline —
 * O(n) single pass since both `prices` (oldest-first, per PricePoint's own
 * contract) and `timeline` (sorted here defensively) are chronological.
 */
function joinPriceWithTrailingEps(prices: PricePoint[], timeline: TrailingEpsEntry[]): RatioHistoryPoint[] {
  if (prices.length === 0 || timeline.length === 0) return [];
  const sorted = [...timeline].sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
  const points: RatioHistoryPoint[] = [];
  let idx = -1;
  for (const p of prices) {
    const priceTime = new Date(p.date).getTime();
    while (idx + 1 < sorted.length && sorted[idx + 1].effectiveDate.getTime() <= priceTime) idx++;
    if (idx < 0) continue; // no EPS figure known yet as of this date
    const eps = sorted[idx].eps;
    if (!(eps > 0)) continue; // non-positive trailing EPS -> P/E isn't a meaningful multiple; skip rather than show a fabricated/negative "P/E"
    points.push({ date: p.date, value: p.close / eps });
  }
  return points;
}

interface ComputePriceToEarningsHistoryInput {
  history: PricePoint[];
  incomeQuarterly: IncomeStatementYear[];
  incomeAnnual: IncomeStatementYear[];
  quoteCurrency: string;
  reportingCurrency: string;
}

export function computePriceToEarningsHistory({
  history,
  incomeQuarterly,
  incomeAnnual,
  quoteCurrency,
  reportingCurrency,
}: ComputePriceToEarningsHistoryInput): PriceToEarningsHistoryResult | null {
  if (history.length === 0) return null;

  const quarterlyTimeline = buildQuarterlyTtmEpsTimeline(incomeQuarterly);
  const quarterlyBased = quarterlyTimeline.length > 0;
  const timeline = quarterlyBased ? quarterlyTimeline : buildAnnualEpsTimeline(incomeAnnual);
  if (timeline.length === 0) return null;

  // Price closes are in quoteCurrency's raw subunit convention; EPS is
  // already a reporting-currency DISPLAY figure — same convention fair-
  // value.ts's own median-multiple loop follows (see its doc comment).
  const displayPrices: PricePoint[] = history.map((p) => ({ ...p, close: toDisplayUnit(p.close, quoteCurrency) }));

  const points = joinPriceWithTrailingEps(displayPrices, timeline);
  if (points.length === 0) return null;

  return {
    points,
    quarterlyBased,
    currencyDiffers: quoteCurrency !== reportingCurrency,
    quoteCurrency,
    reportingCurrency,
  };
}

/** Calendar-date-based range filter — deliberately separate from lib/finance/chart-transform.ts's `filterByRange`, which slices by fiscal-PERIOD COUNT (annual/quarterly array length), not by calendar date. This series is a continuous daily line with no fiscal-period boundaries to count, so "5 Years" here means "the last 5 calendar years of the series," anchored to the series' own last point (not `Date.now()`) so a symbol whose price history itself stops short of today still gets a sensible window instead of an empty one. */
export function filterRatioHistoryByRange(points: RatioHistoryPoint[], range: RatioHistoryRange): RatioHistoryPoint[] {
  if (range === "All" || points.length === 0) return points;
  const years = range === "1Y" ? 1 : range === "3Y" ? 3 : range === "5Y" ? 5 : 10;
  const lastDate = new Date(points[points.length - 1].date);
  const cutoff = new Date(lastDate);
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return points.filter((p) => new Date(p.date).getTime() >= cutoff.getTime());
}

/** Which Select Range options are non-redundant for this series' actual span — same "don't offer a range indistinguishable from a broader one" principle as chart-transform.ts's getAvailableRanges, just span-based (calendar days) rather than period-count-based. */
export function computeAvailableRatioHistoryRanges(points: RatioHistoryPoint[]): RatioHistoryRange[] {
  if (points.length === 0) return ["All"];
  const spanYears =
    (new Date(points[points.length - 1].date).getTime() - new Date(points[0].date).getTime()) /
    (365.25 * MS_PER_DAY);
  const options: RatioHistoryRange[] = [];
  for (const [range, years] of [
    ["1Y", 1],
    ["3Y", 3],
    ["5Y", 5],
    ["10Y", 10],
  ] as const) {
    if (spanYears > years) options.push(range);
  }
  options.push("All");
  return options;
}

/** Plain arithmetic mean of whatever's currently on screen — recomputed by the caller on every Select Range change, same "dynamic average that follows the current view" pattern as computeAverage() in chart-transform.ts, just for a flat point array instead of fiscal-year rows. */
export function averageRatioValue(points: RatioHistoryPoint[]): number | null {
  if (points.length === 0) return null;
  const sum = points.reduce((acc, p) => acc + p.value, 0);
  return sum / points.length;
}
