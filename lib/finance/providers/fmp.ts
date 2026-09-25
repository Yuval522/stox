/**
 * Financial Modeling Prep (FMP) — secondary data provider.
 *
 * Stox' primary source is Yahoo Finance (lib/finance/yahoo.ts). This file
 * is a fault-tolerant *enrichment* layer used only to backfill fields Yahoo's
 * free tier tends to omit or gut — this codebase has already hit that twice
 * (see the doc comments on toIncomeYears / toBalanceYears in yahoo.ts, both
 * of which had to route around dead/null fields on Yahoo's legacy
 * quoteSummary sub-modules). It is entirely opt-in: set `FMP_API_KEY` in
 * `.env.local` and these functions activate; leave it unset and every
 * export here is a no-op that resolves to `null`, so the app behaves
 * identically to a Yahoo-only build without a key.
 *
 * IMPORTANT — unverified live in this environment: outbound network access
 * to financialmodelingprep.com is blocked by this sandbox's egress proxy
 * (the same restriction documented for Yahoo Finance in the project's build
 * notes — confirmed via curl during earlier phases), so these calls could
 * not be exercised end-to-end here. The request shapes below follow FMP's
 * publicly documented stable v3 REST API. Spot-check against a live key on
 * your own machine before relying on it, the same way you would for any
 * third-party integration built without the ability to hit the real
 * endpoint during development.
 */

const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3";

function getApiKey(): string | null {
  return process.env.FMP_API_KEY?.trim() || null;
}

/** Whether an FMP key is configured — callers should skip enrichment entirely when false. */
export function isFmpConfigured(): boolean {
  return getApiKey() !== null;
}

async function fmpGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const url = new URL(`${FMP_BASE_URL}${path}`);
  url.searchParams.set("apikey", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  try {
    // Revalidate hourly — fundamentals move slowly, no need to hit FMP's
    // rate-limited free tier on every request. AbortSignal.timeout: this is
    // awaited inside a Promise.all in getFundamentals() (yahoo.ts), so a hung FMP request
    // would otherwise block the entire fundamentals fetch, not just this
    // opt-in enrichment layer.
    const res = await fetch(url.toString(), { next: { revalidate: 3600 }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      // Only worth logging once a key IS configured — an unset key already
      // short-circuits above and that's expected, silent behavior. A
      // configured key that's failing (bad key, exhausted free-tier quota,
      // rate limit) is a real, previously-invisible reason this fallback
      // layer contributes nothing — worth logging for the "range
      // selector doesn't show more history" class of report.
      console.warn(`[Stox] FMP request failed: ${path} — HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    // Network failure, timeout, malformed response, etc. — enrichment is
    // best-effort by design, so any failure here degrades to "no extra
    // data" rather than breaking the primary Yahoo-sourced bundle, but
    // still worth a log line for the same reason as the res.ok branch
    // above.
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[Stox] FMP request timed out: ${path}`);
    } else {
      console.warn(`[Stox] FMP request threw: ${path} —`, err instanceof Error ? err.message : err);
    }
    return null;
  }
}

export interface FmpCashFlowStatement {
  date: string;
  calendarYear: string;
  /** Present on quarterly responses only, e.g. "Q1". Absent (undefined) on annual rows. */
  period?: string;
  operatingCashFlow: number;
  freeCashFlow: number;
  stockBasedCompensation: number;
  capitalExpenditure: number;
  netIncome: number;
}

/**
 * Annual cash flow statements — used to backfill stock-based compensation
 * and capex for fiscal years where Yahoo's fundamentalsTimeSeries module
 * comes back thin or missing those specific fields.
 *
 * QA fix: this used to default to `limit = 6`, while the sibling income/
 * balance-sheet fetchers below default to 10 — an unintentional asymmetry
 * that made cash flow the shallowest of the three FMP layers for no real
 * reason (FMP's free tier already caps history around ~5 years regardless,
 * so there was no benefit to asking for even less). Aligned to 10 to match.
 */
export async function fetchFmpCashFlowStatements(
  symbol: string,
  limit = 10
): Promise<FmpCashFlowStatement[] | null> {
  return fmpGet<FmpCashFlowStatement[]>(`/cash-flow-statement/${encodeURIComponent(symbol)}`, {
    period: "annual",
    limit: String(limit),
  });
}

/** Quarterly cash flow statements — third-tier fallback for the Chart Type: Quarterly view. */
export async function fetchFmpCashFlowStatementsQuarterly(
  symbol: string,
  limit = 16
): Promise<FmpCashFlowStatement[] | null> {
  return fmpGet<FmpCashFlowStatement[]>(`/cash-flow-statement/${encodeURIComponent(symbol)}`, {
    period: "quarter",
    limit: String(limit),
  });
}

export interface FmpKeyMetricsTTM {
  stockBasedCompensationToRevenueTTM?: number;
  freeCashFlowYieldTTM?: number;
  netDebtToEBITDATTM?: number;
}

/** TTM ratio snapshot — used as a last-resort fallback for valuation ratios Yahoo omits. */
export async function fetchFmpKeyMetricsTTM(symbol: string): Promise<FmpKeyMetricsTTM | null> {
  const rows = await fmpGet<FmpKeyMetricsTTM[]>(`/key-metrics-ttm/${encodeURIComponent(symbol)}`);
  return rows?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Multi-source aggregation (lib/finance/aggregate.ts) — secondary fallback
// for whichever fiscal years Yahoo (the primary source) didn't come back
// with. Note: FMP's free tier caps historical annual statements at roughly
// 5 years as of their current pricing, so this mainly helps fill isolated
// gaps rather than provide depth on its own — this app has no source deep
// enough to back a genuine 10-year+ range (see CLAUDE.md's Data layer
// section).
// ---------------------------------------------------------------------------

export interface FmpIncomeStatement {
  date: string;
  calendarYear: string;
  /** Present on quarterly responses only, e.g. "Q1". Absent (undefined) on annual rows. */
  period?: string;
  revenue: number;
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
  epsdiluted: number;
  weightedAverageShsOutDil: number;
}

/** Annual income statements — see the module doc comment above for this fallback's role/limits. */
export async function fetchFmpIncomeStatements(symbol: string, limit = 10): Promise<FmpIncomeStatement[] | null> {
  return fmpGet<FmpIncomeStatement[]>(`/income-statement/${encodeURIComponent(symbol)}`, {
    period: "annual",
    limit: String(limit),
  });
}

/** Quarterly income statements — third-tier fallback for the Chart Type: Quarterly view. */
export async function fetchFmpIncomeStatementsQuarterly(
  symbol: string,
  limit = 16
): Promise<FmpIncomeStatement[] | null> {
  return fmpGet<FmpIncomeStatement[]>(`/income-statement/${encodeURIComponent(symbol)}`, {
    period: "quarter",
    limit: String(limit),
  });
}

export interface FmpBalanceSheetStatement {
  date: string;
  calendarYear: string;
  /** Present on quarterly responses only, e.g. "Q1". Absent (undefined) on annual rows. */
  period?: string;
  cashAndShortTermInvestments: number;
  totalCurrentAssets: number;
  totalCurrentLiabilities: number;
  totalAssets: number;
  totalLiabilities: number;
  totalStockholdersEquity: number;
  cashAndCashEquivalents: number;
  totalDebt: number;
  /**
   * Global MRQ/Total Debt fix companion (see componentSummedTotalDebt in
   * yahoo.ts for the full rationale): FMP's public balance-sheet-statement
   * endpoint documents these two component fields alongside its own
   * pre-aggregated `totalDebt` — declared optional here since this
   * provider is unverified live in this sandbox (network egress blocked),
   * so a response that omits either simply falls back to `totalDebt`
   * as-is rather than failing.
   */
  shortTermDebt?: number;
  longTermDebt?: number;
}

/** Annual balance sheets — see the module doc comment above for this fallback's role/limits. */
export async function fetchFmpBalanceSheets(
  symbol: string,
  limit = 10
): Promise<FmpBalanceSheetStatement[] | null> {
  return fmpGet<FmpBalanceSheetStatement[]>(`/balance-sheet-statement/${encodeURIComponent(symbol)}`, {
    period: "annual",
    limit: String(limit),
  });
}

/** Quarterly balance sheets — third-tier fallback for the Chart Type: Quarterly view. */
export async function fetchFmpBalanceSheetsQuarterly(
  symbol: string,
  limit = 16
): Promise<FmpBalanceSheetStatement[] | null> {
  return fmpGet<FmpBalanceSheetStatement[]>(`/balance-sheet-statement/${encodeURIComponent(symbol)}`, {
    period: "quarter",
    limit: String(limit),
  });
}
