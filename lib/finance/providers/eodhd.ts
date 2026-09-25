/**
 * EOD Historical Data (EODHD) — optional, opt-in, third-tier fundamentals
 * backfill source. Same "optional integration, documented fallback"
 * pattern as providers/fmp.ts: set `EODHD_API_KEY` in `.env.local` and this
 * activates; leave it unset and every export here is a no-op that resolves
 * to `null`, so the app behaves identically to a Yahoo(+FMP)-only build
 * without a key.
 *
 * WHY THIS EXISTS (see docs/data-pipeline-architecture.md §2 and §4 for the
 * full research): now that SEC EDGAR has been removed from this app
 * entirely, Yahoo (primary) and FMP (opt-in secondary) are both capped at
 * roughly 4-5 fiscal years on their free tiers — a hard ceiling with no
 * code-side workaround, since it's the providers' own data depth, not a
 * request-parameter or pagination limitation on our end (confirmed: this
 * app's period1 lookback windows already request up to 10-11 years back;
 * Yahoo and FMP simply don't have more to return on their free tiers).
 * EODHD is the one researched, ToS-compliant provider with *demonstrated*
 * multi-decade depth for major tickers (confirmed into the 1980s for names
 * like AAPL), sourced via licensed/digitized historical filing data rather
 * than SEC's structured XBRL API — so it is not simply "SEC EDGAR by
 * another name" the way Polygon/Intrinio effectively are (both source from
 * SEC filings and share the same ~2009 depth wall SEC EDGAR itself has).
 * It is a PAID service (no usable free tier for this purpose — EODHD's
 * free tier caps at 1 year of fundamentals depth, which adds nothing over
 * what Yahoo already provides) — see .env.local.example for current
 * pricing as researched.
 *
 * Lowest priority in the merge chain (Yahoo > FMP > EODHD): Yahoo and FMP's
 * data is fresher/more frequently updated for RECENT years, so EODHD is
 * deliberately used to fill in years strictly OLDER than whatever Yahoo/FMP
 * already cover well, not to compete with them for recent periods (same
 * design already sketched in docs/data-pipeline-architecture.md §4 before
 * this was implemented).
 *
 * IMPORTANT — unverified live in this environment: outbound network access
 * to eodhd.com is blocked by this sandbox's egress proxy (same restriction
 * documented in providers/fmp.ts and providers/alphaVantage.ts), so this
 * could not be exercised end-to-end here. The request/response shape below
 * follows EODHD's publicly documented `/api/fundamentals/{SYMBOL}` endpoint
 * (a single call returns General + all three statements, annual AND
 * quarterly, together — unlike FMP's six separate endpoints). Some
 * per-period fields (diluted EPS, diluted share count on the income
 * statement specifically) are not consistently present in this endpoint's
 * documented shape and are left undefined/0 rather than guessed — same
 * "declared optional, falls back rather than failing" convention FMP's
 * balance-sheet debt-component fields already use. Spot-check the actual
 * field names against a live key on your own machine before relying on
 * this for real periods; this is a ready-to-verify scaffold, not
 * independently confirmed against a live response the way the rest of
 * this codebase's shipped code has been.
 */

const EODHD_BASE_URL = "https://eodhd.com/api";

function getApiKey(): string | null {
  return process.env.EODHD_API_KEY?.trim() || null;
}

/** Whether an EODHD key is configured — callers should skip this layer entirely when false. */
export function isEodhdConfigured(): boolean {
  return getApiKey() !== null;
}

interface EodhdPeriodRow {
  date?: string;
  totalRevenue?: string | number | null;
  grossProfit?: string | number | null;
  operatingIncome?: string | number | null;
  netIncome?: string | number | null;
  epsDiluted?: string | number | null;
  commonStockSharesOutstanding?: string | number | null;
  // Balance sheet fields
  cashAndShortTermInvestments?: string | number | null;
  totalCurrentAssets?: string | number | null;
  totalCurrentLiabilities?: string | number | null;
  totalAssets?: string | number | null;
  totalLiab?: string | number | null;
  totalStockholderEquity?: string | number | null;
  cash?: string | number | null;
  shortTermDebt?: string | number | null;
  longTermDebt?: string | number | null;
  // Cash flow fields
  totalCashFromOperatingActivities?: string | number | null;
  freeCashFlow?: string | number | null;
  stockBasedCompensation?: string | number | null;
  capitalExpenditures?: string | number | null;
}

interface EodhdFundamentalsResponse {
  Financials?: {
    Income_Statement?: { yearly?: Record<string, EodhdPeriodRow>; quarterly?: Record<string, EodhdPeriodRow> };
    Balance_Sheet?: { yearly?: Record<string, EodhdPeriodRow>; quarterly?: Record<string, EodhdPeriodRow> };
    Cash_Flow?: { yearly?: Record<string, EodhdPeriodRow>; quarterly?: Record<string, EodhdPeriodRow> };
  };
}

export interface EodhdFundamentals {
  incomeAnnual: EodhdPeriodRow[];
  incomeQuarterly: EodhdPeriodRow[];
  balanceAnnual: EodhdPeriodRow[];
  balanceQuarterly: EodhdPeriodRow[];
  cashFlowAnnual: EodhdPeriodRow[];
  cashFlowQuarterly: EodhdPeriodRow[];
}

function toRows(byDate: Record<string, EodhdPeriodRow> | undefined): EodhdPeriodRow[] {
  if (!byDate) return [];
  // EODHD keys each period by its end-date string ("2023-12-31") — the map
  // key and the row's own `date` field are redundant, so callers use
  // `row.date` (defensively falling back to the map key) rather than
  // depending on object key ordering, which is not a data contract.
  return Object.entries(byDate).map(([date, row]) => ({ date: row.date ?? date, ...row }));
}

/**
 * Single combined fetch for a symbol's full fundamentals history — EODHD's
 * `/fundamentals/{SYMBOL}` endpoint returns General info plus every
 * statement (Income/Balance/Cash Flow), both annual and quarterly, in one
 * response, unlike FMP's six separate per-statement endpoints. Exchange
 * suffix: EODHD requires a `.US`/`.TA`/etc. exchange code, not a bare
 * ticker — `bareSymbol`-stripped US tickers (the overwhelming majority of
 * what this app's Yahoo-sourced symbol strings look like) are assumed
 * `.US`; a symbol that already carries a recognized suffix is passed
 * through as-is. This mapping is a best-effort default, not exhaustively
 * verified against EODHD's exact supported exchange-code list for every
 * market this app covers (see module doc comment's "unverified live" note).
 */
export async function fetchEodhdFundamentals(symbol: string): Promise<EodhdFundamentals | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const eodhdSymbol = symbol.includes(".") ? symbol : `${symbol}.US`;
  const url = new URL(`${EODHD_BASE_URL}/fundamentals/${encodeURIComponent(eodhdSymbol)}`);
  url.searchParams.set("api_token", apiKey);
  url.searchParams.set("fmt", "json");

  try {
    // Revalidate daily — this is the deepest, slowest-changing layer
    // (historical/older fiscal years), and a paid-per-call provider is not
    // worth re-hitting on the same cadence as the free Yahoo/FMP layers.
    const res = await fetch(url.toString(), { next: { revalidate: 86_400 }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[Stox] EODHD fundamentals request failed for ${symbol}: HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const data = (await res.json()) as EodhdFundamentalsResponse;
    const financials = data.Financials;
    if (!financials) return null;

    return {
      incomeAnnual: toRows(financials.Income_Statement?.yearly),
      incomeQuarterly: toRows(financials.Income_Statement?.quarterly),
      balanceAnnual: toRows(financials.Balance_Sheet?.yearly),
      balanceQuarterly: toRows(financials.Balance_Sheet?.quarterly),
      cashFlowAnnual: toRows(financials.Cash_Flow?.yearly),
      cashFlowQuarterly: toRows(financials.Cash_Flow?.quarterly),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[Stox] EODHD fundamentals request timed out for ${symbol}`);
    } else {
      console.warn(`[Stox] EODHD fundamentals request threw for ${symbol}:`, err instanceof Error ? err.message : err);
    }
    return null;
  }
}

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** "2023-12-31" -> "2023" (annual) or "2023-Q4" (quarterly, derived from the calendar month). */
function eodhdPeriodKey(row: EodhdPeriodRow, quarterly: boolean): string | null {
  if (!row.date) return null;
  const d = new Date(row.date);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (!quarterly) return String(year);
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

export function eodhdIncomeToYears(
  rows: EodhdPeriodRow[],
  quarterly: boolean
): { fiscalYear: string; totalRevenue: number; grossProfit: number; operatingIncome: number; netIncome: number; eps: number; sharesOutstandingDiluted: number; dividendsPerShare: number; dataSource: "eodhd" }[] {
  return rows
    .map((r) => {
      const fiscalYear = eodhdPeriodKey(r, quarterly);
      if (!fiscalYear) return null;
      return {
        fiscalYear,
        totalRevenue: num(r.totalRevenue),
        grossProfit: num(r.grossProfit),
        operatingIncome: num(r.operatingIncome),
        netIncome: num(r.netIncome),
        eps: num(r.epsDiluted),
        sharesOutstandingDiluted: num(r.commonStockSharesOutstanding),
        // EODHD's Income_Statement rows don't carry dividends/share (same
        // gap FMP's income endpoint has — see fmpIncomeToYears in yahoo.ts).
        dividendsPerShare: 0,
        dataSource: "eodhd" as const,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

export function eodhdBalanceToYears(
  rows: EodhdPeriodRow[],
  quarterly: boolean
): { fiscalYear: string; cashAndShortTermInvestments: number; totalCurrentAssets: number; totalCurrentLiabilities: number; totalAssets: number; totalLiabilities: number; totalStockholdersEquity: number; totalCash: number; totalDebt: number; dataSource: "eodhd" }[] {
  return rows
    .map((r) => {
      const fiscalYear = eodhdPeriodKey(r, quarterly);
      if (!fiscalYear) return null;
      // Same component-summed debt preference as fmpBalanceToYears in
      // yahoo.ts (see componentSummedTotalDebt's doc comment there) —
      // falls back to EODHD's own field name only when the components
      // this app already validates against are absent.
      // EODHD's documented balance-sheet shape has no single pre-aggregated
      // "totalDebt" field the way FMP's does — short-term + long-term debt
      // components are the only source for this, so unlike fmpBalanceToYears
      // there's no better fallback to reach for when both are absent; a
      // symbol/period missing both simply reports 0 debt from this layer
      // (Yahoo/FMP, higher priority in the merge, are the layers actually
      // relied on for recent-year debt figures in practice — see this
      // file's module doc comment on EODHD's lowest-priority role).
      const componentDebt = num(r.shortTermDebt) + num(r.longTermDebt);
      return {
        fiscalYear,
        cashAndShortTermInvestments: num(r.cashAndShortTermInvestments),
        totalCurrentAssets: num(r.totalCurrentAssets),
        totalCurrentLiabilities: num(r.totalCurrentLiabilities),
        totalAssets: num(r.totalAssets),
        totalLiabilities: num(r.totalLiab),
        totalStockholdersEquity: num(r.totalStockholderEquity),
        totalCash: num(r.cash),
        totalDebt: componentDebt,
        dataSource: "eodhd" as const,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

export function eodhdCashFlowToYears(
  rows: EodhdPeriodRow[],
  quarterly: boolean,
  helpers: {
    normalizeCapex: (v: number) => number;
    normalizeStockBasedComp: (v: number) => number;
    computeFreeCashFlow: (ocf: number, capex: number) => number;
  }
): { fiscalYear: string; operatingCashFlow: number; freeCashFlow: number; stockBasedCompensation: number; capitalExpenditures: number; netIncome: number; dataSource: "eodhd" }[] {
  return rows
    .map((r) => {
      const fiscalYear = eodhdPeriodKey(r, quarterly);
      if (!fiscalYear) return null;
      const operatingCashFlow = num(r.totalCashFromOperatingActivities);
      const capitalExpenditures = helpers.normalizeCapex(num(r.capitalExpenditures));
      return {
        fiscalYear,
        operatingCashFlow,
        freeCashFlow: helpers.computeFreeCashFlow(operatingCashFlow, capitalExpenditures),
        stockBasedCompensation: helpers.normalizeStockBasedComp(num(r.stockBasedCompensation)),
        capitalExpenditures,
        netIncome: num(r.netIncome),
        dataSource: "eodhd" as const,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}
