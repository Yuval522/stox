// Deleted: the SEC EDGAR integration has been fully removed from this app
// per explicit request (see CLAUDE.md's Data layer section) — no code path
// makes requests to SEC EDGAR anymore. The app now relies exclusively on
// Yahoo Finance (lib/finance/yahoo.ts) as its primary source, with FMP
// (lib/finance/providers/fmp.ts, opt-in) as the only secondary backfill.
//
// What used to live here:
//   - fetchRecentFilings() / FilingsResult / FilingRecord — powered the
//     "Reports" tab (components/ticker/ReportsPanel.tsx) and its API route
//     (app/api/reports/[symbol]/route.ts), both removed outright since
//     there is no non-SEC substitute for SEC filing data.
//   - The XBRL companyfacts fetch/parse pipeline (toSecIncomeRows,
//     toSecBalanceRows, toSecCashFlowRows, fetchSecFinancials) that used to
//     be the primary deep-history layer in the multi-source merge
//     (lib/finance/aggregate.ts) — removed along with the merge priority
//     entries that referenced it in lib/finance/yahoo.ts.
//   - KNOWN_STOCK_SPLITS / StockSplitEvent / applyKnownSplitAdjustment /
//     applyKnownSplitAdjustmentToNonSecRows — the retroactive stock-split
//     adjustment logic. This part was still needed (Yahoo-sourced rows
//     require the same adjustment) and was MOVED, not deleted — see
//     lib/finance/stockSplits.ts, now wired into lib/finance/yahoo.ts
//     unconditionally on every merged row.
//
// This file could not be unlinked from disk in this sandbox (the mounted
// filesystem intermittently refuses rm/unlink on some tracked files — see
// CLAUDE.md's "Known constraints" section) and is stubbed out here instead.
// Nothing in the codebase imports from this path anymore.
export {};
