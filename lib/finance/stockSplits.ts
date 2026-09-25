/**
 * Retroactive stock-split adjustment for historical EPS / diluted shares /
 * dividends-per-share.
 *
 * Historically reported per-share figures for a fiscal period are
 * denominated in whatever share count was outstanding AT THE TIME that
 * period was originally filed. A stock split changes the share count going
 * forward, but the data this app's provider (Yahoo Finance) returns for
 * older fiscal years is not guaranteed to already be split-adjusted — so
 * without correction, a chart spanning a split date shows an artificial
 * cliff (e.g. AMZN's June 2022 20-for-1 split: diluted shares correctly
 * jump ~504M -> ~10.2B, but EPS drops ~11x with no adjustment, instead of
 * both series reading as a smooth continuation of the same underlying
 * business performance).
 *
 * This table and the two functions below were originally part of
 * lib/finance/providers/sec-edgar.ts (SEC EDGAR provided a precise,
 * per-fact "which filing was this value FILED in" signal that let a more
 * exact filed-date-based adjustment run on SEC-sourced rows specifically).
 * Now that SEC EDGAR has been removed from this app entirely (see
 * CLAUDE.md's Data layer section), there is only one data source's rows to
 * adjust, so the calendar-date-based approach below — applied uniformly to
 * every row regardless of source — is the only adjustment this app performs
 * (it's also exactly the mechanism the old sec-edgar.ts file already used,
 * unmodified here, for whichever years a non-SEC source won the merge).
 */

export interface StockSplitEvent {
  /** ISO date the split became effective. */
  date: string;
  /** Shares-per-old-share multiplier — 20 for AMZN's June 2022 20-for-1 split, 0.1 for a 1-for-10 reverse split. */
  ratio: number;
}

/**
 * Well-documented, public splits for large-cap tickers likely to come up in
 * this app, sourced from each company's own investor-relations stock-split
 * announcements (a rare, low-frequency corporate action — a handful of
 * entries covers the tickers this app has actually been audited against so
 * far). Not exhaustive — add an entry here for any other ticker a future
 * audit flags a split-cliff distortion on, rather than trying to enumerate
 * every split ever.
 */
const KNOWN_STOCK_SPLITS: Record<string, StockSplitEvent[]> = {
  AAPL: [{ date: "2020-08-31", ratio: 4 }],
  AMZN: [{ date: "2022-06-06", ratio: 20 }],
  GOOGL: [{ date: "2022-07-18", ratio: 20 }],
  GOOG: [{ date: "2022-07-18", ratio: 20 }],
  NVDA: [
    { date: "2021-07-20", ratio: 4 },
    { date: "2024-06-10", ratio: 10 },
  ],
  TSLA: [
    { date: "2020-08-31", ratio: 5 },
    { date: "2022-08-25", ratio: 3 },
  ],
};

/** Strips exchange suffixes (".TA", ".L", etc.) to match KNOWN_STOCK_SPLITS' bare-ticker keys. */
function bareSymbol(symbol: string): string {
  return symbol.split(".")[0].toUpperCase();
}

/** The known splits (if any) for a given symbol, newest-agnostic (unsorted input order preserved from the table above, which is already chronological). */
export function splitsForSymbol(symbol: string): StockSplitEvent[] {
  return KNOWN_STOCK_SPLITS[bareSymbol(symbol)] ?? [];
}

/**
 * Approximates a fiscal-period label ("2022" or "2022-Q3") as its calendar
 * period-end date, purely for ordering against a split's exact date — "did
 * this reporting period end before or after the split."
 */
function fiscalLabelToDate(fiscalYear: string): Date {
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(fiscalYear);
  if (quarterMatch) {
    const year = Number(quarterMatch[1]);
    const quarter = Number(quarterMatch[2]);
    return new Date(year, quarter * 3, 0);
  }
  const year = Number(fiscalYear);
  return Number.isFinite(year) ? new Date(year, 11, 31) : new Date(0);
}

/**
 * Adjusts EPS / diluted shares / dividends-per-share for every known split
 * whose effective date falls AFTER a row's fiscal-period end — multiplying
 * shares (and dividing per-share figures) by that split's ratio, compounding
 * across multiple splits when a period predates more than one. A row with no
 * applicable split is returned unchanged (same object reference skipped via
 * the `ratio === 1` short-circuit, so callers can freely map over every row
 * without worrying about unnecessary allocation).
 */
export function applyKnownSplitAdjustment<
  T extends { fiscalYear: string; eps: number; sharesOutstandingDiluted: number; dividendsPerShare: number }
>(rows: T[], splits: StockSplitEvent[]): T[] {
  if (splits.length === 0) return rows;
  return rows.map((row) => {
    const periodEnd = fiscalLabelToDate(row.fiscalYear);
    let ratio = 1;
    for (const split of splits) {
      if (new Date(split.date).getTime() > periodEnd.getTime()) ratio *= split.ratio;
    }
    if (ratio === 1) return row;
    return {
      ...row,
      eps: row.eps / ratio,
      sharesOutstandingDiluted: row.sharesOutstandingDiluted * ratio,
      dividendsPerShare: row.dividendsPerShare / ratio,
    };
  });
}
