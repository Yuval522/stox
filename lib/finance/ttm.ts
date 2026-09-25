/**
 * Source-agnostic Trailing-Twelve-Months (TTM) calculation engine.
 *
 * Before this file existed, TTM (Income/Cash Flow) came exclusively from
 * Yahoo's own `fundamentalsTimeSeries({type: "trailing"})` endpoint (see
 * toTrailingIncomeRow/toTrailingCashFlowRow in yahoo.ts) — a real, live
 * figure when it's available, but a SINGLE-SOURCE dependency: if that one
 * Yahoo endpoint fails, rate-limits, or simply doesn't cover a given
 * symbol, the "TTM" column silently disappeared from every Income/Cash
 * Flow chart, even when this app's own multi-source quarterly pipeline
 * (Yahoo + FMP, merged in aggregate.ts) has all four of
 * the most recent quarters sitting right there in `incomeQuarterly`/
 * `cashFlowQuarterly`.
 *
 * This is the standard institutional convention for TTM anyway — "sum the
 * four most recently reported quarters" for every flow metric (revenue,
 * net income, operating cash flow, ...), independent of which fiscal-year
 * boundary those quarters happen to straddle — so computing it directly
 * from the quarterly arrays this app already assembles, REGARDLESS of
 * which upstream source(s) contributed those quarters, makes TTM
 * genuinely universal instead of implicitly Yahoo-only. See getFundamentals()
 * in yahoo.ts for how this is wired in as a fallback behind Yahoo's own
 * (real, slightly fresher when available) trailing endpoint.
 */

interface QuarterRow {
  /** "YYYY-Qn" — see makeFiscalQuarterLabelFn() in yahoo.ts. Anything not in that exact shape (annual "YYYY" rows, "TTM"/"MRQ" appendix rows) is ignored by quarterIndex() below. */
  fiscalYear: string;
}

/**
 * Parses a "YYYY-Qn" quarterly label into a linear, diffable index
 * (year*4 + (quarter-1)) so consecutive quarters are always exactly 1
 * apart regardless of whether they cross a calendar-year boundary (e.g.
 * "2025-Q4" -> "2026-Q1" is still a diff of 1). Returns null for any label
 * that isn't that exact shape, so callers can safely run this over a
 * mixed array without pre-filtering.
 */
function quarterIndex(fiscalYear: string): number | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(fiscalYear);
  if (!m) return null;
  return Number(m[1]) * 4 + (Number(m[2]) - 1);
}

export interface TtmFieldConfig<T> {
  /** Flow fields summed across the 4 trailing quarters — revenue, net income, operating cash flow, EPS, dividends/share, etc. */
  sumKeys: (keyof T & string)[];
  /** Point-in-time fields taken from the single most recent quarter instead of summed — e.g. diluted shares outstanding, which isn't a "flow" and would be meaningless summed 4x. */
  latestKeys?: (keyof T & string)[];
}

/**
 * Computes a synthetic "TTM" row from the 4 most recent CONSECUTIVE
 * quarters in `quarterlyRows`. Returns null — rather than a partial or
 * silently-wrong TTM — when fewer than 4 quarters exist, or when the 4
 * most recent aren't actually consecutive (a genuine gap, e.g. one
 * quarter a source failed to report): summing across a gap would
 * understate TTM without any indication anything was wrong, which is
 * worse than showing no TTM bar at all. Every row in `quarterlyRows` is
 * expected to already be real, deduped, fiscal-quarter-labeled data (see
 * this file's module doc comment) — this function only does the
 * selection + arithmetic, no source-specific parsing.
 */
export function computeTrailingTwelveMonths<T extends QuarterRow>(
  quarterlyRows: T[],
  config: TtmFieldConfig<T>
): T | null {
  const withIndex = quarterlyRows
    .map((row) => ({ row, index: quarterIndex(row.fiscalYear) }))
    .filter((r): r is { row: T; index: number } => r.index != null)
    .sort((a, b) => b.index - a.index); // newest first

  if (withIndex.length < 4) return null;
  const last4 = withIndex.slice(0, 4);
  for (let i = 1; i < last4.length; i++) {
    if (last4[i - 1].index - last4[i].index !== 1) return null; // gap — don't fabricate a TTM across missing data
  }

  const rows = last4.map((r) => r.row);
  const latest = rows[0];
  const out = { ...latest, fiscalYear: "TTM" } as T;
  for (const key of config.sumKeys) {
    const sum = rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    (out as Record<string, unknown>)[key] = sum;
  }
  for (const key of config.latestKeys ?? []) {
    (out as Record<string, unknown>)[key] = latest[key];
  }
  return out;
}
