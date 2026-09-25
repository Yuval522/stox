import { splitTrailingRow } from "./chart-transform";
import { toDisplayUnit } from "../format/currency";
import type { IncomeStatementYear, PricePoint } from "./types";

/**
 * GuruFocus-style "fair value band" — a growth-adjusted, historical-
 * multiple-based intrinsic value estimate for the Score tab's Multi-Factor
 * Rating (Valuation pillar). Same disclaimer as score-gurufocus.ts (which
 * deliberately left this exact calculation out, reporting relative
 * cheapness instead — see that file's Valuation pillar doc comment): this
 * is Stox's own, independently-derived approximation of the *shape* of
 * GuruFocus's published GF Value indicator (a historical-multiple-based
 * fair value line with over/undervalued bands), not a reproduction of
 * their proprietary regression, which additionally weighs analyst
 * estimates and a fuller historical-return model this app doesn't have
 * access to. Not affiliated with, endorsed by, or sourced from GuruFocus
 * LLC. Not investment advice.
 *
 * Methodology (fully disclosed, not proprietary):
 *  1. For each of the trailing up-to-10 real fiscal years, find the
 *     closing price nearest that year's approximate fiscal year-end
 *     (Dec 31 of the label year — a simple approximation, since
 *     IncomeStatementYear only carries a bare year label, not an exact
 *     period-end date) and derive that
 *     year's implied P/E (price / EPS) and P/S (price / revenue-per-share)
 *     — only when EPS/revenue were genuinely positive that year.
 *  2. Take the MEDIAN of each multiple across however many years produced
 *     a usable sample (median, not mean, so one anomalous year — a
 *     post-split price spike, a one-off loss — can't dominate the
 *     estimate). Each individual multiple is first capped at
 *     MAX_PE_MULTIPLE/MAX_PS_MULTIPLE (see those constants' doc comment) —
 *     QA fix for a live audit that found this Fair Value estimate running
 *     ~3x above GuruFocus's own GF Value for a historically thin-margin
 *     high-growth name (AMZN): a year where EPS is near zero produces a
 *     mathematically-real but economically-meaningless P/E (hundreds or
 *     thousands of x), and a single outlier year can't skew a MEDIAN, but a
 *     ticker whose margins were thin across MOST of its trailing window
 *     (exactly the class of stock — high-growth, historically low-margin —
 *     this estimate is least reliable for) can end up with the median
 *     position itself landing on one of these inflated values. Capping
 *     (never excluding) keeps every year in the sample — preserving
 *     `yearsUsed` and this estimate's coverage for tickers with only a thin
 *     historical window — while preventing a near-zero-earnings year from
 *     smuggling an extreme, non-economic value into the middle of the
 *     sorted list.
 *  2b. The per-year-capped median itself is then blended with a SECOND
 *     median computed from just the most recent RECENT_SAMPLE_COUNT
 *     samples, tilted toward that recent subset (see
 *     recencyWeightedMedian's doc comment) — QA fix for a live audit
 *     finding that per-year capping alone didn't fully address: a flat,
 *     unweighted median across up to a decade implicitly assumes a
 *     company's "deserved" multiple hasn't structurally changed, which
 *     systematically overstates fair value for a maturing former-hyper-
 *     growth name whose multiple has genuinely compressed over that
 *     decade (AMZN was the reported case). Tickers with a short or stable
 *     multiple history (RECENT_SAMPLE_COUNT samples or fewer) are
 *     unaffected — there's no "recent vs. distant" distinction to draw.
 *  3. Growth-adjust both (recency-weighted) medians by a bounded multiplier
 *     derived from the trailing EPS CAGR over the same window: every 10
 *     points of EPS CAGR shifts the "deserved" multiple by 5%, clamped to
 *     +-40% so a single extreme growth/decline year can't blow up the
 *     estimate.
 *  4. Apply the growth-adjusted multiples to a SMOOTHED current EPS and
 *     revenue-per-share — the average of whichever of {TTM, latest fiscal
 *     year, second-latest fiscal year} are genuinely positive (see
 *     normalizedCurrentValue's doc comment), not a single period — QA fix
 *     for the opposite-direction sibling of the recency-weighting fix
 *     above: applying an otherwise-fair historical multiple to a single
 *     temporarily-depressed current period (e.g. mid-way through a
 *     deliberate margin-compressing pricing cycle) can swing the estimate
 *     hard even when the multiple itself is reasonable. Blend the two
 *     resulting per-share estimates (simple average of whichever are
 *     available), and band it +-20% for the Undervalued/Overvalued zones
 *     the caller asked for.
 *
 * Currency handling follows the exact precedent already established by
 * ValuationCalculator (DataExplorerTabs.tsx's Valuation tab): historical
 * price closes are in `quoteCurrency`'s raw subunit convention (agorot,
 * pence, etc. — see toDisplayUnit), while EPS/revenue/shares from `income`
 * are already reporting-currency display units with no subunit scaling.
 * When `quoteCurrency !== reportingCurrency` (e.g. TEVA.TA — ILA-quoted,
 * USD-reporting), the multiples/fair value are computed the same way but
 * flagged via `currencyDiffers` so the UI can show the same "not
 * FX-adjusted" caveat ValuationCalculator already shows, rather than
 * silently producing a technically-mismatched-currency number that looks
 * precise.
 */

export interface FairValueBandResult {
  /** Blended per-share fair value estimate, in reporting-currency display units. */
  fairValue: number;
  lowerBand: number;
  upperBand: number;
  /** Current share price in quote-currency display units — null if the live quote has no price. */
  currentPrice: number | null;
  /** (currentPrice - fairValue) / fairValue * 100 — positive = trading above fair value. Null when currentPrice is null. */
  premiumDiscountPct: number | null;
  /** True when quoteCurrency and reportingCurrency diverge — premiumDiscountPct is NOT FX-adjusted in that case. */
  currencyDiffers: boolean;
  reportingCurrency: string;
  quoteCurrency: string;
  medianHistoricalPE: number | null;
  medianHistoricalPS: number | null;
  /** Bounded multiplier applied to both historical medians (1 = no adjustment). */
  growthAdjustmentFactor: number;
  epsCagrPct: number | null;
  /** How many distinct fiscal years actually contributed a price+multiple sample. */
  yearsUsed: number;
  label: string;
}

const BAND_WIDTH = 0.2; // +-20%, per spec
/** A "closest" price match beyond this window isn't a real fiscal-year-end price — likely a thin/gappy history — so that year is skipped rather than matched to a misleadingly-distant price. */
const PRICE_MATCH_TOLERANCE_DAYS = 45;
/** Ceilings a single fiscal year's implied P/E or P/S is capped at before entering the median sample — see this file's module doc comment, step 2, for why. Generous on purpose: even the priciest real mega-cap growth names rarely sustain a P/E above 100x or a P/S above 40x for long, so these only ever bite on a genuinely near-zero-earnings/revenue-per-share outlier year, never on a normal (if expensive) real valuation. */
const MAX_PE_MULTIPLE = 100;
const MAX_PS_MULTIPLE = 40;
/** How many of the most recent samples form the "recent" subset in recencyWeightedMedian, and how heavily that subset is weighted against the full-window median — see that function's doc comment. */
const RECENT_SAMPLE_COUNT = 5;
const RECENT_WEIGHT = 0.65;

function fiscalYearEndDate(fiscalYear: string): Date | null {
  const year = Number(fiscalYear);
  return Number.isFinite(year) ? new Date(year, 11, 31) : null;
}

/** Linear scan for the closest date match — same "running best-by-diff" idiom as yahoo.ts's findNearestQuarterlyRevenue, just against PricePoint[] instead of FundamentalsTimeSeriesFinancialsResult[]. history is oldest-first but this doesn't rely on that ordering. */
function findClosestPricePoint(history: PricePoint[], target: Date, toleranceDays: number): PricePoint | null {
  const toleranceMs = toleranceDays * 24 * 60 * 60 * 1000;
  const targetMs = target.getTime();
  let best: { point: PricePoint; diff: number } | null = null;
  for (const point of history) {
    const diff = Math.abs(new Date(point.date).getTime() - targetMs);
    if (diff > toleranceMs) continue;
    if (!best || diff < best.diff) best = { point, diff };
  }
  return best?.point ?? null;
}

function median(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v) && v > 0);
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Blends a MEDIAN of just the most recent RECENT_SAMPLE_COUNT samples with
 * the MEDIAN of the full sample set, tilted RECENT_WEIGHT toward the recent
 * subset — see this file's module doc comment, step 2b, for the live-audit
 * finding this addresses. `samplesChronological` must already be in
 * oldest-to-newest order (peSamples/psSamples below are built that way, by
 * iterating `window` — itself chronologically ordered — without
 * reordering), so `.slice(-RECENT_SAMPLE_COUNT)` genuinely captures the
 * most recent years, not an arbitrary subset. Still a median within each
 * subset, so still resistant to any single remaining outlier year.
 */
function recencyWeightedMedian(samplesChronological: number[]): number | null {
  const full = median(samplesChronological);
  if (full == null || samplesChronological.length <= RECENT_SAMPLE_COUNT) return full;
  const recent = median(samplesChronological.slice(-RECENT_SAMPLE_COUNT));
  if (recent == null) return full;
  return RECENT_WEIGHT * recent + (1 - RECENT_WEIGHT) * full;
}

/**
 * Averages whichever of the given rows have a genuinely positive value for
 * `selector` — the smoothed "current" per-share base described in this
 * file's module doc comment, step 4. A ticker with only one usable period
 * among the rows passed in behaves exactly as before (no averaging to
 * dilute a genuinely single-data-point case); `rows` may contain nulls
 * (e.g. no TTM row available) or rows whose `selector` value isn't
 * meaningful for a given field (e.g. zero shares outstanding for revenue-
 * per-share) — both are filtered out before averaging.
 *
 * Exported (QA fix: a live audit found the Fair Value Estimate card and the
 * Fair Value History chart showing two DIFFERENT numbers for the same
 * ticker at the same time — this function was added here, private, without
 * updating valuation-history.ts's own "current" anchor to match, breaking
 * the exact guarantee that file's module doc comment describes). Every
 * caller computing a "current" fair-value point MUST use this shared
 * function rather than a locally-duplicated normalization, so the two
 * widgets can't drift apart again the same way.
 */
export function normalizedCurrentValue(
  rows: (IncomeStatementYear | null | undefined)[],
  selector: (r: IncomeStatementYear) => number
): number | null {
  const values = rows
    .filter((r): r is IncomeStatementYear => r != null)
    .map(selector)
    .filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Same convention as score-gurufocus.ts's own cagrPct (duplicated locally rather than imported/exported across files for one three-line pure function) — null unless both endpoints are genuinely positive, since a CAGR spanning a loss year isn't meaningful. */
function cagrPct(current: number, base: number, years: number): number | null {
  if (years <= 0 || base <= 0 || current <= 0) return null;
  return (Math.pow(current / base, 1 / years) - 1) * 100;
}

function blend(a: number | null, b: number | null): number | null {
  const present = [a, b].filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}

function labelFromPremiumDiscount(pct: number | null): string {
  if (pct == null) return "—";
  if (pct <= -20) return "Significantly Undervalued";
  if (pct <= -5) return "Undervalued";
  if (pct < 5) return "Fairly Valued";
  if (pct < 20) return "Overvalued";
  return "Significantly Overvalued";
}

interface ComputeFairValueInput {
  income: IncomeStatementYear[];
  history: PricePoint[];
  /** Raw quote.price (quote-currency subunits) — null when no live quote is available. */
  quotePrice: number | null;
  quoteCurrency: string;
  reportingCurrency: string;
}

export function computeFairValueBand({
  income,
  history,
  quotePrice,
  quoteCurrency,
  reportingCurrency,
}: ComputeFairValueInput): FairValueBandResult | null {
  if (history.length === 0) return null;
  const { historical, trailing } = splitTrailingRow(income);
  if (historical.length === 0) return null;

  // 5-to-10-year window, per spec — whatever's available up to the last 10
  // real fiscal years (older data is dropped, not required; a ticker with
  // only Yahoo/FMP's ~4-5 years of coverage still gets an estimate).
  const window = historical.slice(-10);

  const peSamples: number[] = [];
  const psSamples: number[] = [];
  let yearsUsed = 0;
  for (const row of window) {
    const yearEnd = fiscalYearEndDate(row.fiscalYear);
    if (!yearEnd) continue;
    const pricePoint = findClosestPricePoint(history, yearEnd, PRICE_MATCH_TOLERANCE_DAYS);
    if (!pricePoint) continue;
    const priceDisplay = toDisplayUnit(pricePoint.close, quoteCurrency);
    let usedThisYear = false;
    if (row.eps > 0) {
      peSamples.push(Math.min(priceDisplay / row.eps, MAX_PE_MULTIPLE));
      usedThisYear = true;
    }
    if (row.totalRevenue > 0 && row.sharesOutstandingDiluted > 0) {
      psSamples.push(Math.min(priceDisplay / (row.totalRevenue / row.sharesOutstandingDiluted), MAX_PS_MULTIPLE));
      usedThisYear = true;
    }
    if (usedThisYear) yearsUsed++;
  }

  if (peSamples.length === 0 && psSamples.length === 0) return null;

  const medianHistoricalPE = recencyWeightedMedian(peSamples);
  const medianHistoricalPS = recencyWeightedMedian(psSamples);

  // Growth adjustment — trailing EPS CAGR over the same window (capped at
  // 9 years back so a >10y-deep `window` slice, which can't happen given
  // the slice(-10) above, could never divide by more years than exist).
  const yearsBack = Math.min(window.length - 1, 9);
  const baseRow = yearsBack > 0 ? window[window.length - 1 - yearsBack] : null;
  const latestHistoricalRow = window[window.length - 1];
  const epsCagrPct =
    baseRow && latestHistoricalRow ? cagrPct(latestHistoricalRow.eps, baseRow.eps, yearsBack) : null;
  const growthAdjustmentFactor =
    epsCagrPct == null ? 1 : Math.min(1.4, Math.max(0.6, 1 + (epsCagrPct / 100) * 0.5));

  const adjMedianPE = medianHistoricalPE != null ? medianHistoricalPE * growthAdjustmentFactor : null;
  const adjMedianPS = medianHistoricalPS != null ? medianHistoricalPS * growthAdjustmentFactor : null;

  // Apply the growth-adjusted historical multiples to a SMOOTHED current
  // basis — TTM blended with the latest 1-2 fiscal years (see
  // normalizedCurrentValue's doc comment) — instead of a single period.
  const recentHistoricalRows = window.slice(-2).reverse(); // [latest FY, prior FY], newest first
  const normalizationRows = [trailing, ...recentHistoricalRows];
  const normEps = normalizedCurrentValue(normalizationRows, (r) => r.eps);
  const normRevenuePerShare = normalizedCurrentValue(normalizationRows, (r) =>
    r.totalRevenue > 0 && r.sharesOutstandingDiluted > 0 ? r.totalRevenue / r.sharesOutstandingDiluted : NaN
  );
  if (normEps == null && normRevenuePerShare == null) return null;
  const fairValueFromPE = adjMedianPE != null && normEps != null ? adjMedianPE * normEps : null;
  const fairValueFromPS = adjMedianPS != null && normRevenuePerShare != null ? adjMedianPS * normRevenuePerShare : null;

  const fairValue = blend(fairValueFromPE, fairValueFromPS);
  if (fairValue == null || fairValue <= 0) return null;

  const currentPrice = quotePrice != null ? toDisplayUnit(quotePrice, quoteCurrency) : null;
  const premiumDiscountPct = currentPrice != null ? ((currentPrice - fairValue) / fairValue) * 100 : null;

  return {
    fairValue,
    lowerBand: fairValue * (1 - BAND_WIDTH),
    upperBand: fairValue * (1 + BAND_WIDTH),
    currentPrice,
    premiumDiscountPct,
    currencyDiffers: quoteCurrency !== reportingCurrency,
    reportingCurrency,
    quoteCurrency,
    medianHistoricalPE,
    medianHistoricalPS,
    growthAdjustmentFactor,
    epsCagrPct,
    yearsUsed,
    label: labelFromPremiumDiscount(premiumDiscountPct),
  };
}
