import YahooFinance from "yahoo-finance2";
import type { QuoteSummaryResult } from "yahoo-finance2/modules/quoteSummary-iface";
import type { ChartResultArray } from "yahoo-finance2/modules/chart";
import type {
  FundamentalsTimeSeriesBalanceSheetResult,
  FundamentalsTimeSeriesCashFlowResult,
  FundamentalsTimeSeriesFinancialsResult,
} from "yahoo-finance2/modules/fundamentalsTimeSeries";
import { TtlCache } from "./cache";
import {
  mergeYearsBySource,
  warnIfTrailingRowImplausible,
  warnIfShareCountDiscontinuity,
  backfillCashFlowRevenue,
  filterRowsBeforeListing,
  filterPricePointsBeforeListing,
  normalizeCapex,
  normalizeStockBasedComp,
  computeFreeCashFlow,
  fiscalYearForPeriodEnd,
} from "./aggregate";
import { computeTrailingTwelveMonths } from "./ttm";
import { guessCurrencyForSearchResult, toExchangeBadge } from "./exchange";
import { getMockFundamentals } from "./mock-data";
import {
  fetchFmpBalanceSheets,
  fetchFmpBalanceSheetsQuarterly,
  fetchFmpCashFlowStatements,
  fetchFmpCashFlowStatementsQuarterly,
  fetchFmpIncomeStatements,
  fetchFmpIncomeStatementsQuarterly,
  type FmpBalanceSheetStatement,
  type FmpCashFlowStatement,
  type FmpIncomeStatement,
} from "./providers/fmp";
import { fetchSecFinancials, applyKnownSplitAdjustmentToNonSecRows } from "./providers/sec-edgar";
import { BIG_SEVEN_SYMBOLS, MARKET_SUMMARY_SYMBOLS, TASE_SEED_SYMBOLS, US_FALLBACK_SYMBOLS } from "./symbols";
import {
  MarketDataError,
  type AnalystPriceTargets,
  type BalanceSheetYear,
  type CashFlowYear,
  type EstimateRow,
  type EstimatesBundle,
  type FundamentalsBundle,
  type IncomeStatementYear,
  type MarketQuote,
  type MarketState,
  type PricePoint,
  type SearchResultItem,
} from "./types";

// Server-only module: never import this file from a "use client" component.
// (yahoo-finance2 needs Node APIs and has no business shipping to the browser.)

const CACHE_TTL_MS = Number(process.env.MARKET_DATA_CACHE_TTL_MS ?? 20_000);

const yahooFinance = new YahooFinance();

const quoteCache = new TtlCache<MarketQuote[]>(CACHE_TTL_MS);
const searchCache = new TtlCache<SearchResultItem[]>(CACHE_TTL_MS);
const mostActiveCache = new TtlCache<MarketQuote[]>(CACHE_TTL_MS);
// Fundamentals change slowly and historical bars are heavier to fetch —
// cache them longer than live quotes. The live `quote` embedded in a
// cached bundle is NOT left to go stale for the full 5 minutes, though —
// see the getQuotes() re-fetch at the end of getFundamentals(), which
// decouples the price specifically onto quoteCache's faster 20s cadence.
const fundamentalsCache = new TtlCache<FundamentalsBundle>(CACHE_TTL_MS * 15);
// Earnings-aware cache bypass support (see getEarningsFreshnessEpoch and
// getFundamentals below): a short-lived cache for the lightweight
// calendarEvents freshness probe itself (so bursts of requests for the
// same symbol don't each trigger their own probe fetch), plus a map
// remembering which `fundamentalsCache` key was last used per symbol so
// the now-superseded entry can be explicitly evicted the moment a symbol
// crosses into a new earnings-freshness epoch, instead of leaking forever.
const earningsFreshnessProbeCache = new TtlCache<string>(60_000);
const lastFundamentalsCacheKeyBySymbol = new Map<string, string>();

const KNOWN_MARKET_STATES: MarketState[] = [
  "PRE",
  "REGULAR",
  "POST",
  "POSTPOST",
  "PREPRE",
  "CLOSED",
];

function toMarketState(state: unknown): MarketState | null {
  return typeof state === "string" && (KNOWN_MARKET_STATES as string[]).includes(state)
    ? (state as MarketState)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Converts a yahoo-finance2 timestamp field (a `Date`, or epoch seconds as a raw number) into epoch ms — shared by asOf/preMarketTime/postMarketTime below, all of which come back in this same either-shape. */
function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value * 1000;
  return null;
}

/** Adapts a raw yahoo-finance2 quote (any of its discriminated variants) into MarketQuote. */
function toMarketQuote(q: Record<string, unknown>): MarketQuote {
  const asOf = toEpochMs(q.regularMarketTime);

  return {
    symbol: String(q.symbol ?? ""),
    name: String(q.shortName || q.longName || q.symbol || ""),
    exchange: String(q.fullExchangeName || q.exchange || "—"),
    currency: String(q.currency || "USD"),
    quoteType: typeof q.quoteType === "string" ? q.quoteType : null,
    price: num(q.regularMarketPrice),
    change: num(q.regularMarketChange),
    changePercent: num(q.regularMarketChangePercent),
    marketCap: num(q.marketCap),
    marketState: toMarketState(q.marketState),
    asOf,
    timezone:
      typeof q.exchangeTimezoneName === "string" ? q.exchangeTimezoneName : null,
    preMarketPrice: num(q.preMarketPrice),
    preMarketChange: num(q.preMarketChange),
    preMarketChangePercent: num(q.preMarketChangePercent),
    preMarketTime: toEpochMs(q.preMarketTime),
    postMarketPrice: num(q.postMarketPrice),
    postMarketChange: num(q.postMarketChange),
    postMarketChangePercent: num(q.postMarketChangePercent),
    postMarketTime: toEpochMs(q.postMarketTime),
    dayOpen: num(q.regularMarketOpen),
    dayHigh: num(q.regularMarketDayHigh),
    dayLow: num(q.regularMarketDayLow),
    previousClose: num(q.regularMarketPreviousClose),
    weekHigh52: num(q.fiftyTwoWeekHigh),
    weekLow52: num(q.fiftyTwoWeekLow),
    // Ticker-recycling / ghost-data fix — see MarketQuote.firstTradeDateEpochMs's
    // doc comment (types.ts). toEpochMs already handles both shapes this
    // field has been observed in (a `Date` per the library's own DateInMs
    // type, or a raw epoch-seconds number), same as preMarketTime/
    // postMarketTime above.
    firstTradeDateEpochMs: toEpochMs(q.firstTradeDateMilliseconds),
  };
}

/** Fetch live quotes for a list of symbols, cached for CACHE_TTL_MS. */
export async function getQuotes(symbols: string[]): Promise<MarketQuote[]> {
  const unique = Array.from(new Set(symbols.filter(Boolean)));
  if (unique.length === 0) return [];

  const key = [...unique].sort().join(",");
  return quoteCache.getOrSet(key, async () => {
    try {
      const results = await yahooFinance.quote(unique, { return: "array" });
      return (results as unknown as Record<string, unknown>[]).map(toMarketQuote);
    } catch (err) {
      throw new MarketDataError(
        `Failed to fetch quotes for ${unique.join(", ")}`,
        err
      );
    }
  });
}

/**
 * Lightweight daily-bars fetch for one symbol — deliberately a standalone,
 * single-purpose call rather than reusing getFundamentals()'s much heavier
 * multi-module bundle (quoteSummary, fundamentalsTimeSeries x6, SEC EDGAR,
 * FMP, ...), since the only current caller (lib/finance/indicators.ts, via
 * the Strategy Builder's technical-indicator filters — RSI/SMA) needs
 * nothing but a plain close-price series and may need to call this for
 * many symbols in one screener run. Cached separately from quoteCache at a
 * longer TTL: daily bars only gain a new data point once a day (today's
 * still-forming bar aside), so there's no reason to refetch as often as a
 * live price.
 */
const priceHistoryCache = new TtlCache<PricePoint[]>(CACHE_TTL_MS * 15);

export async function getPriceHistory(symbol: string, days = 120): Promise<PricePoint[]> {
  return priceHistoryCache.getOrSet(`history:${symbol}:${days}`, async () => {
    const period1 = new Date();
    period1.setDate(period1.getDate() - days);
    try {
      // yahoo-finance2's chart() has no built-in request-timeout option
      // (unlike this app's own fetch calls, e.g. sec-edgar.ts's
      // AbortSignal.timeout usage) — manually racing it against a timer is
      // what stops one hung symbol from stalling an entire Strategy
      // Builder run, which can call this for dozens of symbols in
      // parallel (see lib/strategy/execute.ts).
      const chart = await Promise.race([
        yahooFinance.chart(symbol, { period1, interval: "1d" }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("getPriceHistory timed out")), 10_000)
        ),
      ]);
      return toPricePoints(chart);
    } catch (err) {
      // Best-effort, like every optional-enrichment fetch in this
      // codebase — a technical-indicator filter simply can't evaluate this
      // one symbol rather than failing the whole screener run over it.
      console.warn(
        `[Stox] getPriceHistory failed for ${symbol}:`,
        err instanceof Error ? err.message : err
      );
      return [];
    }
  });
}

export interface StrategyQuote {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  marketCap: number | null;
  peRatio: number | null;
  dividendYieldPercent: number | null;
  volume: number | null;
}

const strategyQuoteCache = new TtlCache<StrategyQuote[]>(CACHE_TTL_MS);

/**
 * Max symbols sent to Yahoo's unofficial batched quote endpoint per HTTP
 * request. It's a GET with every symbol joined into one query string, so
 * an unbounded batch risks tripping a URL-length limit or just being a
 * much bigger single point of failure than it needs to be — especially
 * once STRATEGY_UNIVERSE_SYMBOLS (lib/finance/symbols.ts) grew from ~180
 * to 400+ names. 150 is a conservative chunk size other yahoo-finance2
 * users have reported working reliably; nothing here depends on it being
 * exactly that number.
 */
const STRATEGY_QUOTE_CHUNK_SIZE = 150;

/**
 * Richer quote batch for the Natural Language Strategy Builder
 * (lib/strategy/execute.ts, lib/strategy/universe-refresh.ts) — a separate
 * function/cache from getQuotes() rather than widening MarketQuote itself,
 * so this new, still-evolving feature can't regress the shared MarketQuote
 * shape every other page (Analysis, Portfolio, Watchlist, Topbar ticker,
 * ...) already depends on. Pulls fields Yahoo's batched quote endpoint
 * already returns but toMarketQuote() doesn't extract: trailingPE,
 * trailingAnnualDividendYield (already a percentage per yahoo-finance2's
 * own field doc, e.g. 2.5 for 2.5% — not a 0-1 fraction), and
 * regularMarketVolume.
 *
 * Chunks large symbol lists into STRATEGY_QUOTE_CHUNK_SIZE-sized batches
 * (see that constant's doc comment) and, unlike a single all-or-nothing
 * call, tolerates one chunk failing without discarding every other chunk's
 * results — this is called with the FULL ~400+ symbol universe both by the
 * refresh cron (universe-refresh.ts) and, on a cold DB before that cron has
 * ever run, by execute.ts directly inside a live user request, so a
 * transient failure on one chunk shouldn't turn into a total screening
 * failure. Only throws if every chunk fails.
 */
export async function getStrategyQuotes(symbols: string[]): Promise<StrategyQuote[]> {
  const unique = Array.from(new Set(symbols.filter(Boolean)));
  if (unique.length === 0) return [];

  const key = [...unique].sort().join(",");
  return strategyQuoteCache.getOrSet(key, async () => {
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += STRATEGY_QUOTE_CHUNK_SIZE) {
      chunks.push(unique.slice(i, i + STRATEGY_QUOTE_CHUNK_SIZE));
    }

    const settled = await Promise.allSettled(chunks.map((chunk) => fetchStrategyQuoteChunk(chunk)));

    const out: StrategyQuote[] = [];
    let failedChunks = 0;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        out.push(...result.value);
      } else {
        failedChunks++;
        console.warn("[Stox] getStrategyQuotes — one chunk failed, continuing with the rest:", result.reason);
      }
    }

    if (failedChunks > 0 && out.length === 0) {
      throw new MarketDataError(`Failed to fetch strategy quotes for ${unique.length} symbols (all chunks failed)`);
    }
    return out;
  });
}

async function fetchStrategyQuoteChunk(chunk: string[]): Promise<StrategyQuote[]> {
  try {
    const results = (await yahooFinance.quote(chunk, { return: "array" })) as unknown as Record<string, unknown>[];
    return results.map((q) => ({
      symbol: String(q.symbol ?? ""),
      name: String(q.shortName || q.longName || q.symbol || ""),
      price: num(q.regularMarketPrice),
      changePercent: num(q.regularMarketChangePercent),
      marketCap: num(q.marketCap),
      peRatio: num(q.trailingPE),
      dividendYieldPercent: num(q.trailingAnnualDividendYield),
      volume: num(q.regularMarketVolume),
    }));
  } catch (err) {
    throw new MarketDataError(`Failed to fetch strategy quotes for ${chunk.join(", ")}`, err);
  }
}

/** Smart typeahead search across US, TASE, and other listed instruments. */
export async function searchSymbols(query: string): Promise<SearchResultItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  return searchCache.getOrSet(`search:${trimmed.toLowerCase()}`, async () => {
    try {
      const result = await yahooFinance.search(trimmed, {
        quotesCount: 8,
        newsCount: 0,
      });
      return (result.quotes as unknown as Record<string, unknown>[])
        .filter((q) => q.isYahooFinance === true && typeof q.symbol === "string")
        .map((q): SearchResultItem => {
          // Bug fix (QA Phase 4, re-confirmed still broken live in the
          // Final Polish pass): currency was guessed purely from Yahoo's
          // raw exchange code on the search result. That code is unverified
          // live in this sandbox (network blocked) and evidently isn't a
          // reliable "TLV"/"TASE" match for every TASE hit even when the
          // exchange *badge* renders correctly. guessCurrencyForSearchResult
          // checks the ".TA" symbol suffix first — exact and
          // provider-independent — before falling back to the exchange-code
          // guess, so this can't silently regress to USD again for TASE
          // symbols regardless of exactly what Yahoo's raw code turns out
          // to be.
          const symbol = String(q.symbol);
          const rawExchangeCode = String(q.exchange || q.exchDisp || "");
          const exchange = toExchangeBadge(String(q.exchDisp || q.exchange || ""));
          return {
            symbol,
            name: String(q.longname || q.shortname || q.symbol),
            exchange,
            // Search doesn't return currency (only `quote` does) — best-effort
            // badge from exchange/symbol, confirmed/corrected once a quote loads.
            currency: guessCurrencyForSearchResult(symbol, rawExchangeCode),
            type: String(q.quoteType || "EQUITY"),
          };
        });
    } catch (err) {
      throw new MarketDataError(`Search failed for "${trimmed}"`, err);
    }
  });
}

/** Market Summary: fixed set of major US + TASE indices and Bitcoin. */
export async function getMarketSummary(): Promise<MarketQuote[]> {
  const symbols = MARKET_SUMMARY_SYMBOLS.map((s) => s.symbol);
  const quotes = await getQuotes(symbols);
  const labelBySymbol = new Map(MARKET_SUMMARY_SYMBOLS.map((s) => [s.symbol, s.label]));
  // Preserve the configured order regardless of what the provider returns.
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  return symbols
    .map((symbol) => bySymbol.get(symbol))
    .filter((q): q is MarketQuote => Boolean(q))
    .map((q) => ({ ...q, name: labelBySymbol.get(q.symbol) ?? q.name }));
}

/** Big 7 / "Magnificent Seven": fixed set of mega-cap tech quotes, Home page section. */
export async function getBigSeven(): Promise<MarketQuote[]> {
  const quotes = await getQuotes(BIG_SEVEN_SYMBOLS);
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  // Preserve the configured order regardless of what the provider returns —
  // same rationale as getMarketSummary() above.
  return BIG_SEVEN_SYMBOLS.map((s) => bySymbol.get(s)).filter((q): q is MarketQuote => Boolean(q));
}

/** Most Active: live US "most actives" screener blended with a curated TASE seed list. */
export async function getMostActive(): Promise<MarketQuote[]> {
  return mostActiveCache.getOrSet("most-active", async () => {
    let usSymbols: string[];
    try {
      const screened = await yahooFinance.screener({
        scrIds: "most_actives",
        count: 6,
      });
      usSymbols = screened.quotes.map((q) => q.symbol);
    } catch {
      usSymbols = US_FALLBACK_SYMBOLS;
    }
    return getQuotes([...usSymbols, ...TASE_SEED_SYMBOLS]);
  });
}

// ---------------------------------------------------------------------------
// Fundamentals (company profile, valuation metrics, income statement,
// historical price series) for the ticker analysis page.
// ---------------------------------------------------------------------------

function findCeo(assetProfile: QuoteSummaryResult["assetProfile"]): string | null {
  const officers = assetProfile?.companyOfficers ?? [];
  const ceo = officers.find((o) => /chief executive officer|\bceo\b/i.test(o.title ?? ""));
  return ceo?.name ?? null;
}

/**
 * Global fix (live bug report): the top summary cards and this metrics
 * object were reading Total Cash / Total Debt / operating & free cash flow
 * (and therefore FCF Yield, Cash Flow Yield, P/CF, P/FCF, and every margin)
 * straight off quoteSummary's raw `financialData` module — a completely
 * separate, uncorrected Yahoo-only path that bypasses every fix this
 * pipeline applies to the actual statement arrays (aggregate.ts's
 * cross-source backfill for zero'd grossProfit/totalLiabilities, SEC
 * EDGAR's YTD-cumulative quarterly cash-flow reconstruction, the MRQ
 * total-debt component-sum fix above). A ticker could have a perfectly
 * corrected `balance`/`cashFlow` array feeding every chart correctly while
 * its summary card still showed the old, wrong number, because the card
 * was never actually reading that array.
 *
 * Fixed by repointing every one of those fields at the SAME normalized,
 * multi-source-merged TTM income/cash-flow row and MRQ balance-sheet row
 * every other panel on this page renders from — passed in directly from
 * getFundamentals() below, where they're already computed. `financialData`
 * fields are now only a last-resort fallback for the rare case a symbol
 * has no usable TTM/MRQ row from any of the three providers, so cards
 * still render *something* rather than going blank; whenever a corrected
 * row exists, it always wins. This applies uniformly to every ticker (no
 * per-symbol branching) since incomeTrailing/cashFlowTrailing/balanceMRQ
 * are computed identically for all of them upstream.
 *
 * Note: Yahoo's dividendYield/payoutRatio fields are assumed to be
 * fractions (0.045 = 4.5%) based on this library's historical behavior —
 * unverified live in this environment (network blocked here), so
 * spot-check against a real quote before trusting the exact scale.
 */
function toMetrics(
  summary: QuoteSummaryResult,
  incomeTrailing: IncomeStatementYear | null | undefined,
  cashFlowTrailing: CashFlowYear | null | undefined,
  balanceMRQ: BalanceSheetYear | null | undefined
) {
  const summaryDetail = summary.summaryDetail;
  const keyStats = summary.defaultKeyStatistics;
  const fin = summary.financialData;

  const marketCap = summaryDetail?.marketCap ?? null;
  const trailingPE = summaryDetail?.trailingPE ?? null;

  // Last-resort fallback to Yahoo's own `financialData` summary module
  // (fin?.operatingCashflow / fin?.freeCashflow) only fires when
  // cashFlowTrailing (built via mapCashFlowRow -> computeFreeCashFlow, see
  // aggregate.ts) is entirely unavailable for this symbol. financialData
  // exposes a single pre-netted freeCashflow figure with no separate CapEx
  // field, so there's nothing to sign-normalize or recompute here — it's
  // read as-is, intentionally, and only ever stands in alone rather than
  // mixing with unified-formula rows in the same series.
  const operatingCashflow = cashFlowTrailing?.operatingCashFlow ?? fin?.operatingCashflow ?? null;
  const freeCashflow = cashFlowTrailing?.freeCashFlow ?? fin?.freeCashflow ?? null;
  const totalCash = balanceMRQ?.totalCash ?? fin?.totalCash ?? null;
  const totalDebt = balanceMRQ?.totalDebt ?? fin?.totalDebt ?? null;
  const revenueTTM = incomeTrailing?.totalRevenue ?? null;
  const grossProfitTTM = incomeTrailing?.grossProfit ?? null;
  const operatingIncomeTTM = incomeTrailing?.operatingIncome ?? null;
  const netIncomeTTM = incomeTrailing?.netIncome ?? null;

  return {
    financials: {
      marketCap,
      peRatio: trailingPE,
      forwardPE: summaryDetail?.forwardPE ?? keyStats?.forwardPE ?? null,
      forwardPeg: keyStats?.pegRatio ?? null,
      priceToCashFlow:
        marketCap && operatingCashflow
          ? Number((marketCap / operatingCashflow).toFixed(2))
          : null,
      priceToFreeCashFlow:
        marketCap && freeCashflow ? Number((marketCap / freeCashflow).toFixed(2)) : null,
    },
    yields: {
      earningsYield: trailingPE ? Number((100 / trailingPE).toFixed(2)) : null,
      cashFlowYield:
        marketCap && operatingCashflow
          ? Number(((operatingCashflow / marketCap) * 100).toFixed(2))
          : null,
      freeCashFlowYield:
        marketCap && freeCashflow
          ? Number(((freeCashflow / marketCap) * 100).toFixed(2))
          : null,
      dividendYield:
        summaryDetail?.dividendYield != null
          ? Number((summaryDetail.dividendYield * 100).toFixed(2))
          : 0,
      payoutRatio:
        summaryDetail?.payoutRatio != null
          ? Number((summaryDetail.payoutRatio * 100).toFixed(2))
          : 0,
    },
    balances: {
      totalCash,
      totalDebt,
      netCashPosition:
        totalCash != null && totalDebt != null ? totalCash - totalDebt : null,
    },
    margins: {
      grossMargin:
        revenueTTM && grossProfitTTM != null
          ? Number(((grossProfitTTM / revenueTTM) * 100).toFixed(2))
          : fin?.grossMargins != null
            ? Number((fin.grossMargins * 100).toFixed(2))
            : null,
      operatingMargin:
        revenueTTM && operatingIncomeTTM != null
          ? Number(((operatingIncomeTTM / revenueTTM) * 100).toFixed(2))
          : fin?.operatingMargins != null
            ? Number((fin.operatingMargins * 100).toFixed(2))
            : null,
      netIncomeMargin:
        revenueTTM && netIncomeTTM != null
          ? Number(((netIncomeTTM / revenueTTM) * 100).toFixed(2))
          : fin?.profitMargins != null
            ? Number((fin.profitMargins * 100).toFixed(2))
            : null,
    },
  };
}

/**
 * QA investigation (chart bug report — "missing 2022", bars bunched left):
 * couldn't reproduce this against real Yahoo data in this environment
 * (network egress to Yahoo is blocked in this sandbox, same restriction
 * documented on lib/finance/providers/fmp.ts) — the illustrative mock
 * fixtures (mock-data.ts) have no such gap by construction, and every
 * chart's XAxis already defaults to (and now explicitly sets) Recharts'
 * category scale, which spaces bars evenly regardless of a numeric gap in
 * the underlying fiscalYear values — so a missing year wouldn't visually
 * "bunch" the remaining bars, it would just render one fewer bar. If
 * Yahoo's fundamentalsTimeSeries genuinely skips a fiscal year for some
 * ticker (plausible — it has for other fields per this file's other doc
 * comments), the honest fix is *not* to fabricate a $0 bar for that year
 * (that would misrepresent a real company as having zero revenue/assets/
 * cash flow that year, which is worse than a gap) — it's to surface the
 * gap somewhere visible for debugging instead of silently losing it.
 */
function warnIfFiscalYearGaps(label: string, symbol: string, fiscalYears: string[]): void {
  if (process.env.NODE_ENV === "production") return;
  const numericYears = fiscalYears.map(Number).filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
  for (let i = 1; i < numericYears.length; i++) {
    if (numericYears[i] - numericYears[i - 1] > 1) {
      console.warn(
        `[Stox] ${label}(${symbol}): fiscal year gap detected — ${numericYears[i - 1]} to ${numericYears[i]} ` +
          `(missing ${numericYears[i] - numericYears[i - 1] - 1} year(s)). This reflects what Yahoo returned; ` +
          `no data was fabricated to fill it.`
      );
    }
  }
}

/**
 * QA fix (Compare tab report: adding AMD left Revenue (TTM)/Revenue Growth/
 * EPS Growth blank while margins and P/E populated fine). Root cause: this
 * used to read `summary.incomeStatementHistory`, a legacy quoteSummary
 * module — the exact same vintage as `balanceSheetHistory`, which this
 * codebase's own toBalanceYears() doc comment already documents as having
 * been stripped by Yahoo to just `{maxAge, endDate}` since Nov 2024. Yahoo
 * applied the same deprecation to incomeStatementHistory, so it silently
 * returns rows with every financial field undefined for many symbols —
 * `income` would then default every field to 0 via `?? 0`, which is
 * indistinguishable from "no data" in downstream consumers (Compare tab,
 * Estimates tab's actualRevenue lookup) and just as easily ends up as an
 * empty array. Migrated to the same reliable `fundamentalsTimeSeries`
 * method (module: "financials", the income-statement equivalent) already
 * used for the quarterly revenue backfill and proven live for balance
 * sheet / cash flow.
 */
/** "2023" for annual rows, "2023-Q2" for quarterly — see makeFiscalQuarterLabelFn(). String-sortable either way (see aggregate.ts). */
type PeriodLabelFn = (date: Date) => string;
const annualLabel: PeriodLabelFn = (date) => String(date.getFullYear());

/**
 * Root-cause fix (live bug report: NVDA/AAPL/MSFT quarterly Income/Balance/
 * Cash Flow data showed two adjacent quarter labels — e.g. "2025-Q3" and
 * "2025-Q4" — carrying byte-for-byte identical dollar figures, while GOOGL
 * and TSLA's quarterly data was clean). Root cause: this file used to
 * compute a pure CALENDAR quarter from a row's raw date
 * (`Math.floor(date.getMonth() / 3) + 1`), while SEC EDGAR's
 * quarterlySeries (providers/sec-edgar.ts) labels the SAME real periods by
 * each company's own reported FISCAL quarter (`entry.fp`, straight from
 * their XBRL filing). For a calendar-fiscal-year filer (GOOGL, TSLA — FY
 * ends December), calendar quarter and fiscal quarter are the same number,
 * so the old code coincidentally produced correct-looking labels. For any
 * filer whose fiscal year does NOT end in December — NVDA (~January),
 * MSFT (~June), AAPL (~September) among them — the two schemes disagree
 * for 3 of every 4 quarters. mergeYearsBySource (aggregate.ts) merges SEC
 * EDGAR and Yahoo quarterly rows into one timeline keyed by this exact
 * label string; when the two sources label the SAME real reporting period
 * differently (SEC's correct fiscal "2025-Q3" vs. Yahoo's miscomputed
 * calendar "2025-Q4" for what is actually the same Oct-ending quarter),
 * neither wins outright — both survive as separate entries, so the same
 * real dollar figures appear to repeat under two adjacent, seemingly
 * distinct fiscal periods. This wasn't visible in annual charts because
 * annualLabel (`date.getFullYear()`) needs no quarter-number math at all —
 * a fiscal year's own end date already carries the correct fiscal year
 * number by construction, for every filer regardless of fiscal calendar.
 *
 * Fix: derive each Yahoo quarterly row's FISCAL quarter number (not
 * calendar quarter) relative to the company's own fiscal year-end month,
 * inferred from its most recent annual row's period-end date (see
 * inferFiscalYearEndMonth below) — the same date already used, unmodified,
 * for annualLabel. A December fiscal year-end reduces this exactly to the
 * old calendar-quarter formula, so calendar-fiscal filers are unaffected;
 * every other filer now gets fiscal-aware quarter numbers that agree with
 * SEC EDGAR's `entry.fp` labels for the same real periods, so
 * mergeYearsBySource's exact-string-key dedup can actually recognize them
 * as the same period instead of silently double-counting it.
 */
function inferFiscalYearEndMonth(...annualRowSets: { date: unknown }[][]): number {
  for (const rows of annualRowSets) {
    const dated = rows.filter((r): r is { date: Date } => r.date instanceof Date);
    if (dated.length === 0) continue;
    const mostRecent = dated.reduce((a, b) => (a.date > b.date ? a : b));
    return mostRecent.date.getMonth();
  }
  // No dated annual row from any source — default to December (month 11),
  // i.e. the old behavior, which is also correct for the common
  // calendar-fiscal-year case.
  return 11;
}

/**
 * Fiscal quarter label ("2023-Q2") for a period-END date, given the
 * company's fiscal year-end month (0-11 — e.g. 0 for NVDA's ~January, 5
 * for MSFT's ~June, 8 for AAPL's ~September, 11 for a calendar-fiscal
 * filer). See this pair's shared doc comment above for the bug this fixes.
 * Worked examples (all confirmed against each company's real reporting
 * convention): NVDA (M=0) — a quarter ending in January is 0 months past
 * the fiscal year-end -> Q4 of the fiscal year sharing that January's
 * calendar year; one ending in April is 3 months past -> Q1 of the FOLLOWING
 * fiscal year (NVDA's real FY2026 Q1 ended ~April 2025). MSFT (M=5) — a
 * quarter ending in September is 3 months past June -> Q1 of the fiscal
 * year ending the FOLLOWING June (MSFT's real FY2026 Q1 ended Sept 2025).
 * AAPL (M=8) — a quarter ending in December is 3 months past September ->
 * Q1 of the next fiscal year (Apple's real FY2026 Q1 ended Dec 2025).
 */
function makeFiscalQuarterLabelFn(fiscalYearEndMonth: number): PeriodLabelFn {
  return (date) => {
    const monthsSinceFyEnd = (date.getMonth() - fiscalYearEndMonth + 12) % 12;
    // 0 months past FY-end month = that's Q4 itself; otherwise ceil to the
    // nearest quarter (tolerates a quarter-end date landing a few weeks
    // into the adjacent month, e.g. a 52/53-week fiscal calendar).
    const quarter = Math.ceil(monthsSinceFyEnd / 3) || 4;
    // See fiscalYearForPeriodEnd's doc comment (aggregate.ts) — extracted
    // to a shared primitive so sec-edgar.ts's quarterlySeries can compute
    // the identical fiscal-year rollover for SEC EDGAR's own quarterly
    // rows, rather than each source carrying its own copy of this formula.
    const fiscalYear = fiscalYearForPeriodEnd(date, fiscalYearEndMonth);
    return `${fiscalYear}-Q${quarter}`;
  };
}

/**
 * Maps a single fundamentalsTimeSeries "financials" row into our
 * IncomeStatementYear shape (minus the fiscalYear label, which differs
 * between the annual/quarterly array mapper below and the single-row TTM
 * mapper — see toTrailingIncomeRow). Pulled out into its own function so
 * both call sites share identical field-extraction/fallback logic instead
 * of drifting apart over time.
 */
function mapIncomeRow(
  row: FundamentalsTimeSeriesFinancialsResult,
  summary: QuoteSummaryResult
): Omit<IncomeStatementYear, "fiscalYear"> {
  const sharesOutstandingFallback = summary.defaultKeyStatistics?.sharesOutstanding ?? 0;
  const dividendsPerShareFallback = summary.summaryDetail?.dividendRate ?? 0;
  const grossMarginFallback = summary.financialData?.grossMargins ?? null;
  const operatingMarginFallback = summary.financialData?.operatingMargins ?? null;

  const netIncome = row.netIncome ?? 0;
  const totalRevenue = row.totalRevenue ?? 0;
  const grossProfit =
    row.grossProfit || (grossMarginFallback != null ? Math.round(totalRevenue * grossMarginFallback) : 0);
  const operatingIncome =
    row.operatingIncome ||
    row.EBIT ||
    (operatingMarginFallback != null ? Math.round(totalRevenue * operatingMarginFallback) : 0);
  const sharesOutstanding = row.dilutedAverageShares || sharesOutstandingFallback;
  return {
    totalRevenue,
    grossProfit,
    operatingIncome,
    netIncome,
    eps: row.dilutedEPS ?? (sharesOutstanding > 0 ? Number((netIncome / sharesOutstanding).toFixed(2)) : 0),
    sharesOutstandingDiluted: sharesOutstanding,
    dividendsPerShare: row.dividendPerShare ?? dividendsPerShareFallback,
    dataSource: "yahoo" as const,
  };
}

function toIncomeRows(
  rows: FundamentalsTimeSeriesFinancialsResult[],
  summary: QuoteSummaryResult,
  symbol: string,
  labelFn: PeriodLabelFn,
  label: string
): IncomeStatementYear[] {
  const periods = [...rows]
    .filter((row) => row.date instanceof Date)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((row) => ({ fiscalYear: labelFn(row.date), ...mapIncomeRow(row, summary) }))
    // Same "phantom zero-height bar" fix as toBalanceRows/toCashFlowRows —
    // a row with a valid date but every financial field missing shouldn't
    // contribute an empty period to the chart/table.
    .filter((y) => y.totalRevenue !== 0 || y.netIncome !== 0 || y.grossProfit !== 0);

  warnIfFiscalYearGaps(label, symbol, periods.map((y) => y.fiscalYear));
  return periods;
}

/**
 * Rolling-twelve-month row from `fundamentalsTimeSeries({type: "trailing",
 * module: "financials"})` — Yahoo strips the "trailing" prefix the same way
 * it strips "annual"/"quarterly" (confirmed against the installed
 * yahoo-finance2 package's own processResponse() transform), so the row
 * shape is identical to an annual row. Appended as a synthetic "TTM" row
 * onto the end of the merged annual `income` array (see getFundamentals()),
 * matching the reference terminal's behavior of always showing a trailing
 * bar after the fiscal-year history regardless of which Select Range is
 * active — see splitTrailingRow() in chart-transform.ts for how panels pull
 * it back out before range-filtering so it never gets sliced away as one of
 * the "N years".
 */
function toTrailingIncomeRow(
  rows: FundamentalsTimeSeriesFinancialsResult[],
  summary: QuoteSummaryResult
): IncomeStatementYear | null {
  const latest = [...rows]
    .filter((row) => row.date instanceof Date)
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  if (!latest) return null;
  const mapped = mapIncomeRow(latest, summary);
  if (mapped.totalRevenue === 0 && mapped.netIncome === 0 && mapped.grossProfit === 0) return null;
  return { fiscalYear: "TTM", ...mapped };
}

/**
 * Maps annual balance-sheet rows from the `fundamentalsTimeSeries` method.
 *
 * Deliberately NOT using quoteSummary's `balanceSheetHistory` module —
 * confirmed via yahoo-finance2's own source comments and runtime AJV
 * schema (`additionalProperties: false`) that Yahoo has stripped that
 * legacy endpoint down to just `{ maxAge, endDate }` since Nov 2024; every
 * financial field would silently come back as `undefined`. The library's
 * own recommendation is `fundamentalsTimeSeries` instead, whose result
 * rows come back with the "annual"/"quarterly" prefix already stripped
 * (e.g. `totalAssets`, not `annualTotalAssets` — verified against the
 * module's transform code, not just its stale doc-comment examples).
 */
/**
 * Global MRQ/Total Debt fix (live bug report: AT&T's MRQ totalDebt read
 * implausibly smaller than its own prior annual totalDebt — flagged by
 * warnIfTrailingRowImplausible). Root cause: this used to read Yahoo's own
 * single pre-aggregated `totalDebt` field verbatim — a field Yahoo has
 * been observed to populate inconsistently quarter-to-quarter, sometimes
 * reflecting only ONE debt component (e.g. just long-term debt, missing
 * the current/short-term portion entirely) rather than the company's full
 * obligation. Since this narrows the figure rather than zeroing it out,
 * the cross-source `backfillZeroFields` mechanism (aggregate.ts) can't
 * catch it — that only fires on an exact 0, by design (see its doc
 * comment on why totalDebt is deliberately excluded from that list: a
 * genuine drop to a smaller-but-real number must never be auto-"fixed").
 * The right fix is at the source: never trust the single aggregate field
 * when the granular components are available. Computes Total Debt the
 * same way toSecBalanceRows() (sec-edgar.ts) always has — short-term debt
 * + current portion of long-term debt + long-term debt — preferring each
 * side's "AndCapitalLeaseObligation" rollup (includes lease obligations)
 * over the bare debt-only field when Yahoo reports both. Yahoo's own
 * `totalDebt` is now only a last-resort fallback for a row where NONE of
 * the granular component fields are populated at all — universal across
 * every ticker and every period (annual, quarterly, MRQ alike), not a
 * one-off patch for AT&T specifically.
 */
function componentSummedTotalDebt(row: FundamentalsTimeSeriesBalanceSheetResult): number {
  const shortTermDebt = row.currentDebtAndCapitalLeaseObligation ?? row.currentDebt ?? 0;
  const longTermDebtComponent = row.longTermDebtAndCapitalLeaseObligation ?? row.longTermDebt ?? 0;
  const componentDebt = shortTermDebt + longTermDebtComponent;
  return componentDebt > 0 ? componentDebt : (row.totalDebt ?? 0);
}

/** Per-row field extraction shared by toBalanceRows and the MRQ derivation in getFundamentals(). */
function mapBalanceRow(row: FundamentalsTimeSeriesBalanceSheetResult): Omit<BalanceSheetYear, "fiscalYear"> {
  return {
    cashAndShortTermInvestments: row.cashCashEquivalentsAndShortTermInvestments ?? row.cashAndCashEquivalents ?? 0,
    totalCurrentAssets: row.currentAssets ?? 0,
    totalCurrentLiabilities: row.currentLiabilities ?? 0,
    totalAssets: row.totalAssets ?? 0,
    totalLiabilities: row.totalLiabilitiesNetMinorityInterest ?? 0,
    totalStockholdersEquity: row.stockholdersEquity ?? row.totalEquityGrossMinorityInterest ?? 0,
    totalCash: row.cashAndCashEquivalents ?? 0,
    totalDebt: componentSummedTotalDebt(row),
    dataSource: "yahoo" as const,
  };
}

function toBalanceRows(
  rows: FundamentalsTimeSeriesBalanceSheetResult[],
  symbol: string,
  labelFn: PeriodLabelFn,
  label: string
): BalanceSheetYear[] {
  const periods = [...rows]
    .filter((row) => row.date instanceof Date)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((row) => ({ fiscalYear: labelFn(row.date), ...mapBalanceRow(row) }))
    // QA fix (live report: a "2021" axis label rendered with no visible bar
    // on Balance/Cash Flow charts, while every other year rendered fine).
    // Root cause: `row.date instanceof Date` only confirms Yahoo tagged a
    // fiscal year for that row — it says nothing about whether that row
    // actually carries data. For the oldest period in a fundamentalsTimeSeries
    // response, Yahoo not infrequently returns a row with a real date but
    // every financial field genuinely absent (predates a schema field being
    // reported, or the filing just isn't fully indexed) — every `?? 0`
    // fallback above then kicks in, producing a row that's structurally
    // valid but numerically all-zero. That row still contributes its
    // fiscalYear to the array, so Recharts' category axis draws a tick for
    // it — but a bar whose value is 0 renders at zero height, i.e.
    // invisible, which is exactly "a label with no bar." Dropping rows
    // where every meaningful field is 0 removes the phantom tick instead of
    // just hiding the (already-invisible) bar.
    .filter(
      (y) =>
        y.totalAssets !== 0 ||
        y.totalLiabilities !== 0 ||
        y.totalCurrentAssets !== 0 ||
        y.totalCurrentLiabilities !== 0 ||
        y.cashAndShortTermInvestments !== 0
    );
  warnIfFiscalYearGaps(label, symbol, periods.map((y) => y.fiscalYear));
  return periods;
}

/**
 * Maps annual cash-flow rows from `fundamentalsTimeSeries({module: 'cash-flow'})`.
 * Same rationale as toBalanceYears() — the legacy quoteSummary
 * cashflowStatementHistory module is on Yahoo's own "gutted since Nov
 * 2024" list, so this uses the recommended replacement instead. Field
 * names verified directly against fundamentalsTimeSeries.d.ts (all typed
 * `?: number`, none hardcoded-null): operatingCashFlow, freeCashFlow,
 * stockBasedCompensation, capitalExpenditure.
 *
 * Root-cause fix (live request: "standardize sign convention + a unified,
 * foolproof FCF formula globally, preventing sign inversions/field-mapping
 * errors/discrepancies against official reports"): this used to trust
 * Yahoo's raw `capitalExpenditure` sign as-is on the ASSUMPTION it always
 * comes back negative, and trusted Yahoo's own `freeCashFlow` field
 * verbatim — but Yahoo's own FCF figure is computed by Yahoo's own
 * (undocumented, and not necessarily identical to SEC EDGAR's or FMP's)
 * definition. In a whole-row-per-fiscal-year multi-source merge
 * (aggregate.ts), trusting each provider's own FCF field means the exact
 * SAME company's FCF trend can show a discontinuity or even a sign flip
 * purely because the winning source for one year differs from the
 * winning source for the adjacent year — with no underlying business
 * reason. Now uses the same two shared primitives every other provider's
 * mapping function uses (see aggregate.ts's doc comment for the full
 * rationale): normalizeCapex() forces capex to always be negative
 * regardless of the raw sign, and computeFreeCashFlow() is the ONE
 * formula (Operating Cash Flow + CapEx) used everywhere in this codebase
 * to derive FCF — Yahoo's own `row.freeCashFlow` field is intentionally
 * never read.
 *
 * Note: the cash-flow module has no plain `netIncome` field (unlike the
 * balance-sheet/financials modules) — its closest equivalent is
 * `netIncomeFromContinuingOperations`, confirmed against the same .d.ts.
 */
/** Per-row field extraction shared by toCashFlowRows and toTrailingCashFlowRow below. */
function mapCashFlowRow(row: FundamentalsTimeSeriesCashFlowResult): Omit<CashFlowYear, "fiscalYear"> {
  const operatingCashFlow = row.operatingCashFlow ?? 0;
  const capitalExpenditures = normalizeCapex(row.capitalExpenditure ?? 0);
  return {
    operatingCashFlow,
    freeCashFlow: computeFreeCashFlow(operatingCashFlow, capitalExpenditures),
    stockBasedCompensation: normalizeStockBasedComp(row.stockBasedCompensation ?? 0),
    capitalExpenditures,
    netIncome: row.netIncomeFromContinuingOperations ?? 0,
    dataSource: "yahoo" as const,
  };
}

function toCashFlowRows(
  rows: FundamentalsTimeSeriesCashFlowResult[],
  symbol: string,
  labelFn: PeriodLabelFn,
  label: string
): CashFlowYear[] {
  const periods = [...rows]
    .filter((row) => row.date instanceof Date)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((row) => ({ fiscalYear: labelFn(row.date), ...mapCashFlowRow(row) }))
    // QA fix — same root cause as toBalanceYears' matching filter above:
    // a dated-but-otherwise-empty row for the oldest period renders as an
    // axis label with an invisible zero-height bar. Drop it instead.
    .filter((y) => y.operatingCashFlow !== 0 || y.freeCashFlow !== 0 || y.netIncome !== 0);
  warnIfFiscalYearGaps(label, symbol, periods.map((y) => y.fiscalYear));
  return periods;
}

/**
 * Rolling-twelve-month row from `fundamentalsTimeSeries({type: "trailing",
 * module: "cash-flow"})` — same rationale/appending strategy as
 * toTrailingIncomeRow above, labeled "TTM" since cash flow (like income) is
 * a flow statement over a period, not a point-in-time snapshot.
 */
function toTrailingCashFlowRow(rows: FundamentalsTimeSeriesCashFlowResult[]): CashFlowYear | null {
  const latest = [...rows]
    .filter((row) => row.date instanceof Date)
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  if (!latest) return null;
  const mapped = mapCashFlowRow(latest);
  if (mapped.operatingCashFlow === 0 && mapped.freeCashFlow === 0 && mapped.netIncome === 0) return null;
  return { fiscalYear: "TTM", ...mapped };
}

/**
 * Maps FMP's annual statement endpoints into this app's Year shapes, tagged
 * `dataSource: "fmp"`. Used only as the third-tier layer in the
 * multi-source merge (see aggregate.ts) — superseded the old field-by-field
 * "backfill zeros" enrichment, which only ever patched gaps *within*
 * Yahoo's own ~5-year window. A whole-row merge is both simpler (one merge
 * strategy for all three statements, all three sources) and more capable
 * (FMP rows can now also fill entire fiscal years Yahoo doesn't have, not
 * just individual fields within years it does).
 */
/** "2023" for annual FMP rows, "2023-Q2" for quarterly ones (FMP's `period` field is present only on quarterly responses) — matches the same convention Yahoo/SEC EDGAR quarterly rows use, so all three sources merge cleanly. */
function fmpPeriodKey(r: { calendarYear: string; period?: string }): string {
  return r.period ? `${r.calendarYear}-${r.period}` : r.calendarYear;
}

function fmpIncomeToYears(rows: FmpIncomeStatement[] | null): IncomeStatementYear[] {
  if (!rows) return [];
  return rows
    .filter((r) => r.calendarYear)
    .map((r) => ({
      fiscalYear: fmpPeriodKey(r),
      totalRevenue: r.revenue ?? 0,
      grossProfit: r.grossProfit ?? 0,
      operatingIncome: r.operatingIncome ?? 0,
      netIncome: r.netIncome ?? 0,
      eps: r.epsdiluted ?? 0,
      sharesOutstandingDiluted: r.weightedAverageShsOutDil ?? 0,
      // FMP's income-statement endpoint doesn't include dividends/share.
      dividendsPerShare: 0,
      dataSource: "fmp" as const,
    }));
}

function fmpBalanceToYears(rows: FmpBalanceSheetStatement[] | null): BalanceSheetYear[] {
  if (!rows) return [];
  return rows
    .filter((r) => r.calendarYear)
    .map((r) => {
      // Same global MRQ/Total Debt fix as componentSummedTotalDebt (yahoo.ts)
      // and toSecBalanceRows (sec-edgar.ts) — sum short-term + long-term
      // debt components when FMP's response includes them, only falling
      // back to FMP's own pre-aggregated totalDebt when neither component
      // is present, so this third-tier provider can't reintroduce the same
      // narrow-subcomponent bug the other two sources are now guarded
      // against.
      const componentDebt = (r.shortTermDebt ?? 0) + (r.longTermDebt ?? 0);
      return {
        fiscalYear: fmpPeriodKey(r),
        cashAndShortTermInvestments: r.cashAndShortTermInvestments ?? 0,
        totalCurrentAssets: r.totalCurrentAssets ?? 0,
        totalCurrentLiabilities: r.totalCurrentLiabilities ?? 0,
        totalAssets: r.totalAssets ?? 0,
        totalLiabilities: r.totalLiabilities ?? 0,
        totalStockholdersEquity: r.totalStockholdersEquity ?? 0,
        totalCash: r.cashAndCashEquivalents ?? 0,
        totalDebt: componentDebt > 0 ? componentDebt : (r.totalDebt ?? 0),
        dataSource: "fmp" as const,
      };
    });
}

/**
 * Same root-cause fix as mapCashFlowRow above, applied to FMP's cash-flow
 * endpoint (the third-tier/last-resort layer — see this file's module doc
 * comment): FMP's `capitalExpenditure` sign was never actually verified
 * live (network access to financialmodelingprep.com is blocked in this
 * sandbox — see providers/fmp.ts's module doc comment), so trusting its
 * raw sign was an unconfirmed assumption, not a fact. normalizeCapex()
 * makes that assumption irrelevant — capex is forced negative regardless
 * of what FMP actually sends — and FMP's own `freeCashFlow` field is
 * never read; computeFreeCashFlow() derives it the same way every other
 * source does.
 */
function fmpCashFlowToYears(rows: FmpCashFlowStatement[] | null): CashFlowYear[] {
  if (!rows) return [];
  return rows
    .filter((r) => r.calendarYear)
    .map((r) => {
      const operatingCashFlow = r.operatingCashFlow ?? 0;
      const capitalExpenditures = normalizeCapex(r.capitalExpenditure ?? 0);
      return {
        fiscalYear: fmpPeriodKey(r),
        operatingCashFlow,
        freeCashFlow: computeFreeCashFlow(operatingCashFlow, capitalExpenditures),
        stockBasedCompensation: normalizeStockBasedComp(r.stockBasedCompensation ?? 0),
        capitalExpenditures,
        netIncome: r.netIncome ?? 0,
        dataSource: "fmp" as const,
      };
    });
}

/**
 * Finds the actual revenue for the quarter nearest a given end date, from
 * quarterly `fundamentalsTimeSeries({module:'financials', type:'quarterly'})`
 * rows. Yahoo's fiscal quarter-end dates don't always land on the exact
 * same day across modules (earningsHistory vs. fundamentalsTimeSeries), so
 * this matches within a 10-day tolerance rather than requiring an exact
 * date match.
 */
function findNearestQuarterlyRevenue(
  rows: FundamentalsTimeSeriesFinancialsResult[],
  targetDate: Date
): number | null {
  const TOLERANCE_MS = 10 * 24 * 60 * 60 * 1000;
  let best: { revenue: number; diff: number } | null = null;
  for (const row of rows) {
    if (!(row.date instanceof Date) || row.totalRevenue == null) continue;
    const diff = Math.abs(row.date.getTime() - targetDate.getTime());
    if (diff > TOLERANCE_MS) continue;
    if (!best || diff < best.diff) best = { revenue: row.totalRevenue, diff };
  }
  return best?.revenue ?? null;
}

/**
 * Maps Yahoo's `earningsTrend` module (forward analyst consensus) into our
 * EstimateRow shape, split into quarterly vs. annual buckets by the
 * `period` label's suffix ("0q"/"+1q" vs "0y"/"+1y"/"+5y"/"-5y"), then
 * enriches the quarterly bucket with genuinely real historical data from
 * `earningsHistory` (trailing ~4 quarters of EPS actual/estimate).
 *
 * Data availability caveat worth flagging clearly: Yahoo's free
 * earningsTrend module typically only carries a handful of near-term
 * periods (current + next quarter, current + next year, a 5y growth
 * estimate) — no historical rows. It does NOT expose point-in-time
 * historical *revenue* consensus at all, at any tier we have access to.
 * Rather than fabricate a revenue-based historical comparison, historical
 * quarterly rows are built from `earningsHistory` (real trailing EPS
 * actual/estimate/surprise — confirmed non-deprecated, no hardcoded-null
 * fields) cross-referenced with real actual quarterly revenue from
 * `fundamentalsTimeSeries`, and honestly labeled `beatBasis: "eps"` since
 * that's what they actually compare. The mock data path (AAPL/NVDA/
 * TEVA.TA) still shows the fuller illustrative revenue-based table for
 * demo purposes, labeled `beatBasis: "revenue"`.
 */
function toEstimates(
  summary: QuoteSummaryResult,
  income: IncomeStatementYear[],
  quarterlyRevenueRows: FundamentalsTimeSeriesFinancialsResult[]
): EstimatesBundle {
  const trend = summary.earningsTrend?.trend ?? [];
  const today = new Date();
  const actualRevenueByYear = new Map(income.map((y) => [y.fiscalYear, y.totalRevenue]));

  const quarterly: EstimateRow[] = [];
  const annual: EstimateRow[] = [];

  for (const t of trend) {
    if (!t.endDate) continue;
    const isQuarterly = t.period.endsWith("q");
    const isHistorical = t.endDate.getTime() < today.getTime();
    const fiscalYearKey = String(t.endDate.getFullYear());
    const actualRevenue = isHistorical ? (actualRevenueByYear.get(fiscalYearKey) ?? null) : null;
    const revenueEstimate = t.revenueEstimate?.avg ?? null;
    const beat =
      isHistorical && actualRevenue != null && revenueEstimate != null
        ? actualRevenue >= revenueEstimate
        : null;

    const row: EstimateRow = {
      // "Mon YYYY" for both quarterly and annual rows (e.g. "Sep 2024") —
      // matches the reference dashboard's fiscal-period labeling, which
      // shows the fiscal year-end month even for annual rows rather than
      // a bare year number.
      fiscalPeriodLabel: t.endDate.toLocaleDateString("en-US", { year: "numeric", month: "short" }),
      periodEndDate: t.endDate.toISOString().slice(0, 10),
      revenueEstimate,
      revenueYoyGrowthPct:
        t.revenueEstimate?.growth != null ? Number((t.revenueEstimate.growth * 100).toFixed(2)) : null,
      revenueAvg: t.revenueEstimate?.avg ?? null,
      revenueLow: t.revenueEstimate?.low ?? null,
      revenueHigh: t.revenueEstimate?.high ?? null,
      numberOfAnalysts: t.revenueEstimate?.numberOfAnalysts ?? null,
      isHistorical,
      beat,
      actualRevenue,
      epsActual: null,
      epsEstimate: null,
      beatBasis: beat != null ? "revenue" : null,
    };

    (isQuarterly ? quarterly : annual).push(row);
  }

  // Enrich with real trailing EPS actual/estimate history — the one
  // genuinely historical, non-fabricated data source Yahoo's free tier
  // exposes for "did the company beat" style questions.
  const existingQuarterlyDates = new Set(quarterly.map((r) => r.periodEndDate));
  for (const h of summary.earningsHistory?.history ?? []) {
    if (!h.quarter) continue;
    const periodEndDate = h.quarter.toISOString().slice(0, 10);
    if (existingQuarterlyDates.has(periodEndDate)) continue; // don't duplicate an earningsTrend row

    const beat = h.epsActual != null && h.epsEstimate != null ? h.epsActual >= h.epsEstimate : null;
    const actualRevenue = findNearestQuarterlyRevenue(quarterlyRevenueRows, h.quarter);
    // QA fix (bug report Issue #4 — "Estimates tab: historical quarters
    // have null consensus fields"): Yahoo's free tier has no point-in-time
    // historical revenue *consensus* to show here (see this function's doc
    // comment), so revenueEstimate/Avg/Low/High/numberOfAnalysts stay
    // honestly null — there's no real forecast data to backfill them with.
    // revenueYoyGrowthPct is different: it's not a consensus figure, it's
    // a straightforward comparison of two *actuals* (this quarter vs. the
    // same calendar quarter a year prior), and we already have the real
    // revenue history via quarterlyRevenueRows — so compute it instead of
    // leaving it null.
    const priorYearQuarter = new Date(h.quarter);
    priorYearQuarter.setFullYear(priorYearQuarter.getFullYear() - 1);
    const priorYearRevenue = findNearestQuarterlyRevenue(quarterlyRevenueRows, priorYearQuarter);
    const revenueYoyGrowthPct =
      actualRevenue != null && priorYearRevenue != null && priorYearRevenue !== 0
        ? Number((((actualRevenue - priorYearRevenue) / Math.abs(priorYearRevenue)) * 100).toFixed(2))
        : null;
    quarterly.push({
      fiscalPeriodLabel: h.quarter.toLocaleDateString("en-US", { year: "numeric", month: "short" }),
      periodEndDate,
      revenueEstimate: null,
      revenueYoyGrowthPct,
      revenueAvg: null,
      revenueLow: null,
      revenueHigh: null,
      numberOfAnalysts: null,
      isHistorical: true,
      beat,
      actualRevenue,
      epsActual: h.epsActual,
      epsEstimate: h.epsEstimate,
      beatBasis: beat != null ? "eps" : null,
    });
  }

  const byDate = (a: EstimateRow, b: EstimateRow) => a.periodEndDate.localeCompare(b.periodEndDate);
  return { quarterly: quarterly.sort(byDate), annual: annual.sort(byDate) };
}

/**
 * Analyst price-target consensus + Buy/Hold/Sell distribution (Estimates
 * tab). `financialData` was already being fetched for the existing metrics
 * (margins, P/E, cash/debt) — its targetMeanPrice/targetHighPrice/
 * targetLowPrice/targetMedianPrice/recommendationMean/recommendationKey/
 * numberOfAnalystOpinions fields cover the price-target half for free.
 * `recommendationTrend` is a separate module (added to the modules list
 * below) for the Buy/Hold/Sell counts, keyed by trailing period — Yahoo's
 * convention is trend[0] = "0m" (this month), the current consensus.
 *
 * Returns null when Yahoo has no analyst coverage at all for this symbol
 * (thin/illiquid names, some foreign listings) rather than a struct of all
 * nulls, so the UI can render an honest "No analyst coverage" empty state
 * instead of a price-target card full of dashes.
 */
function toPriceTargets(summary: QuoteSummaryResult): AnalystPriceTargets | null {
  const fin = summary.financialData;
  if (!fin) return null;

  const hasAnyTarget = fin.targetMeanPrice != null || fin.targetHighPrice != null || fin.targetLowPrice != null;
  const trendRow = summary.recommendationTrend?.trend?.[0] ?? null;
  const distribution =
    trendRow &&
    (trendRow.strongBuy > 0 || trendRow.buy > 0 || trendRow.hold > 0 || trendRow.sell > 0 || trendRow.strongSell > 0)
      ? {
          strongBuy: trendRow.strongBuy,
          buy: trendRow.buy,
          hold: trendRow.hold,
          sell: trendRow.sell,
          strongSell: trendRow.strongSell,
        }
      : null;

  if (!hasAnyTarget && !distribution && fin.recommendationKey == null) return null;

  return {
    meanTarget: fin.targetMeanPrice ?? null,
    medianTarget: fin.targetMedianPrice ?? null,
    highTarget: fin.targetHighPrice ?? null,
    lowTarget: fin.targetLowPrice ?? null,
    numberOfAnalysts: fin.numberOfAnalystOpinions ?? null,
    recommendationMean: fin.recommendationMean ?? null,
    recommendationKey: fin.recommendationKey ?? null,
    distribution,
  };
}

function toPricePoints(chart: ChartResultArray): PricePoint[] {
  const points: PricePoint[] = [];
  for (const q of chart.quotes) {
    if (typeof q.close !== "number") continue;
    points.push({
      date: q.date.toISOString().slice(0, 10),
      open: typeof q.open === "number" ? q.open : q.close,
      high: typeof q.high === "number" ? q.high : q.close,
      low: typeof q.low === "number" ? q.low : q.close,
      close: q.close,
    });
  }
  return points;
}

/**
 * Earnings-aware cache bypass: a cheap probe (one small quoteSummary
 * module, not the full multi-source fundamentals fetch below) used to
 * derive a "freshness epoch" string that becomes PART of the fundamentals
 * cache key. As long as a symbol hasn't crossed a new earnings-call date,
 * this returns the same epoch every time, so caching behaves exactly as
 * before (normal TTL). The moment a NEW earnings date is crossed — e.g.
 * Microsoft reporting on 2026-07-30 — the epoch string changes, which
 * means the *next* request for that symbol naturally misses the cache
 * (the old key is also explicitly evicted, see getFundamentals below) and
 * triggers a real, fresh, cross-source-validated multi-source fetch
 * instead of serving a bundle built before the report existed.
 *
 * Honest limitation: this guarantees Stox ASKS its upstream providers
 * again as soon as the calendar date arrives — it can't guarantee Yahoo/
 * SEC EDGAR/FMP have already indexed the brand-new quarter at that exact
 * moment (that indexing lag lives entirely on their end, not something a
 * client-side cache policy can close). What it fixes is Stox's *own*
 * up-to-15-cache-cycle (~5 minute in current config) delay on top of
 * whatever the providers already have — the actual bug behind "we're
 * still showing last quarter's numbers days after earnings dropped."
 *
 * Wrapped in its own short-lived (60s) cache so a burst of requests for
 * the same symbol (multiple components/tabs on one page load) triggers
 * only one probe fetch, not one per request. Fails open to "unknown" —
 * a fixed, stable epoch — on any error or when calendarEvents has no past
 * earnings date to report (thinly-covered tickers, indices, ETFs), so a
 * flaky probe degrades to ordinary TTL-based caching rather than either
 * erroring the whole request or forcing a full refetch on every call.
 */
async function getEarningsFreshnessEpoch(symbol: string): Promise<string> {
  return earningsFreshnessProbeCache.getOrSet(symbol.toUpperCase(), async () => {
    try {
      const probe = await yahooFinance.quoteSummary(symbol, { modules: ["calendarEvents"] });
      const dates = probe.calendarEvents?.earnings?.earningsDate ?? [];
      const now = Date.now();
      const pastDates = dates
        .filter((d): d is Date => d instanceof Date && d.getTime() <= now)
        .map((d) => d.getTime());
      if (pastDates.length === 0) return "unknown";
      return new Date(Math.max(...pastDates)).toISOString().slice(0, 10); // "YYYY-MM-DD"
    } catch {
      return "unknown";
    }
  });
}

/**
 * Full ticker analysis bundle: quote, company profile, valuation metrics,
 * income statement history, and ~10y of daily price bars. Falls back to
 * curated mock data (AAPL, NVDA, TEVA.TA only) if the live provider is
 * unreachable or the symbol isn't covered — see lib/finance/mock-data.ts.
 */
export async function getFundamentals(symbolRaw: string): Promise<FundamentalsBundle> {
  const symbol = symbolRaw.trim();
  if (!symbol) throw new MarketDataError("No symbol provided");
  const upperSymbol = symbol.toUpperCase();

  // See getEarningsFreshnessEpoch's doc comment above for the full
  // mechanism. Evicting the previous epoch's key explicitly (rather than
  // leaving it to its own TTL, which may never be re-checked once nothing
  // requests that exact key again) keeps the cache's footprint bounded to
  // "currently relevant keys" across a long-running server process that
  // lives through many earnings cycles for many symbols.
  const freshnessEpoch = await getEarningsFreshnessEpoch(symbol);
  const cacheKey = `fundamentals:${upperSymbol}:${freshnessEpoch}`;
  const previousKey = lastFundamentalsCacheKeyBySymbol.get(upperSymbol);
  if (previousKey && previousKey !== cacheKey) {
    fundamentalsCache.delete(previousKey);
  }
  lastFundamentalsCacheKeyBySymbol.set(upperSymbol, cacheKey);

  const bundle = await fundamentalsCache.getOrSet(cacheKey, async () => {
    try {
      const period1 = new Date();
      period1.setFullYear(period1.getFullYear() - 10);

      // QA fix ("Select Range does nothing" report): this used to be -6,
      // which meant the Select Range dropdown's "10 Years" option could
      // *never* actually show 10 years of data even when Yahoo has it —
      // the fetch itself was already capping the window below that. Bumped
      // to comfortably clear the broadest range the UI offers (see
      // ChartControls' CHART_RANGES), so "10 Years"/"All Available" can
      // genuinely differ from "5 Years" whenever the ticker's real history
      // goes back that far.
      //
      // IMPORTANT caveat (root-caused in a later pass, see the USER_AGENT
      // doc comment in providers/sec-edgar.ts): this period1 window only
      // matters for how far back *Yahoo* is willing to look — it does NOT
      // mean Yahoo will actually return that much. Yahoo's
      // fundamentalsTimeSeries endpoint has a hard backend cap of roughly 4
      // annual periods / 5 quarters regardless of period1 (confirmed
      // against yfinance's own scraper source and multiple independent
      // reports), so real 5/10-year depth depends entirely on SEC EDGAR
      // (providers/sec-edgar.ts) actually succeeding — which itself
      // requires SEC_EDGAR_CONTACT to be set (see .env.local.example) or
      // SEC returns 403 and this whole layer silently contributes nothing.
      const balancePeriod1 = new Date();
      balancePeriod1.setFullYear(balancePeriod1.getFullYear() - 11);

      // Trailing ~2 years is enough to cover earningsHistory's ~4 quarters
      // with room to spare for the nearest-date matching in
      // findNearestQuarterlyRevenue().
      const quarterlyPeriod1 = new Date();
      quarterlyPeriod1.setFullYear(quarterlyPeriod1.getFullYear() - 2);

      const [
        quotes,
        summary,
        chartResult,
        balanceRows,
        cashFlowRows,
        incomeRows,
        quarterlyRevenueRows,
        balanceRowsQuarterly,
        cashFlowRowsQuarterly,
        trailingIncomeRows,
        trailingCashFlowRows,
        secFinancials,
        fmpIncomeRows,
        fmpBalanceRows,
        fmpCashFlowRows,
        fmpIncomeRowsQuarterly,
        fmpBalanceRowsQuarterly,
        fmpCashFlowRowsQuarterly,
      ] = await Promise.all([
        getQuotes([symbol]),
        // QA fix (live report: ETFs like SPCX threw a generic "Unable to
        // load fundamentals" error instead of loading at all): several of
        // these modules are equity-only — an ETF/fund has no earnings
        // calls, no analyst coverage, and no "financialData" income
        // figures, so Yahoo's response for "earningsTrend"/"earningsHistory"/
        // "recommendationTrend"/"financialData" on a non-equity quoteType
        // fails the yahoo-finance2 library's own response validation and
        // REJECTS THE WHOLE quoteSummary() CALL — unlike every other fetch
        // in this Promise.all (balanceRows, cashFlowRows, incomeRows, ...
        // all already end in their own `.catch(() => [])`), this one had no
        // per-call catch, so that single rejection took down the entire
        // Promise.all and the outer try/catch's generic MarketDataError
        // fired for a symbol that actually has a perfectly good quote and
        // price history to show. Every consumer of `summary` below already
        // reads it defensively (summary.assetProfile, summary.financialData,
        // etc. are all immediately optional-chained one level down — see
        // e.g. toIncomeRows, toEstimates, toPriceTargets, the assetProfile
        // destructure below), so falling back to an empty-but-correctly-
        // typed object here is safe: every module just reads as "not
        // present" instead of crashing, exactly like it already does for a
        // module Yahoo genuinely omits for some other equity ticker.
        yahooFinance
          .quoteSummary(symbol, {
            modules: [
              "assetProfile",
              "summaryDetail",
              "defaultKeyStatistics",
              "financialData",
              // Analyst consensus (Phase 5: Estimates tab). Not on Yahoo's
              // deprecated-module list and has no hardcoded-null fields —
              // see toEstimates() doc comment for the real-world caveat that
              // this typically only returns a handful of near-term periods.
              "earningsTrend",
              // Real trailing EPS actual/estimate/surprise (~4 quarters) —
              // used to give the Estimates tab genuine historical beat/miss
              // rows on the live path. See toEstimates() doc comment.
              "earningsHistory",
              // Buy/Hold/Sell analyst-rating counts (Estimates tab price
              // targets card) — see toPriceTargets() doc comment. The price
              // targets themselves (mean/high/low/median) come from
              // financialData above, already fetched.
              "recommendationTrend",
              // Next/most-recent earnings-call date — powers the
              // earnings-aware cache bypass below (getEarningsFreshnessEpoch).
              // Fetched here too (not just in the lightweight probe) so the
              // full bundle's own `summary` carries it for any future UI use.
              "calendarEvents",
            ],
          })
          .catch(() => ({}) as QuoteSummaryResult),
        yahooFinance.chart(symbol, { period1, interval: "1d" }),
        // Balance sheet data comes from a separate top-level method, not a
        // quoteSummary module (see toBalanceYears() doc comment). Caught
        // independently so a balance-sheet-only hiccup doesn't fall the
        // entire bundle back to mock data when the rest loaded fine.
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: balancePeriod1,
            type: "annual",
            module: "balance-sheet",
          })
          .catch(() => [] as FundamentalsTimeSeriesBalanceSheetResult[]),
        // Same rationale as balanceRows — see toCashFlowYears() doc comment.
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: balancePeriod1,
            type: "annual",
            module: "cash-flow",
          })
          .catch(() => [] as FundamentalsTimeSeriesCashFlowResult[]),
        // Annual income-statement data — see toIncomeYears() doc comment
        // for why this replaced quoteSummary's deprecated
        // `incomeStatementHistory` module (dropped from the modules list
        // above entirely now that nothing reads it).
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: balancePeriod1,
            type: "annual",
            module: "financials",
          })
          .catch(() => [] as FundamentalsTimeSeriesFinancialsResult[]),
        // Real quarterly actual revenue, used both to backfill the
        // "Actual" figure next to earningsHistory's historical EPS rows
        // (see findNearestQuarterlyRevenue()) AND as the quarterly Income
        // Statement source for the Chart Type: Quarterly view below — same
        // module, no need for a second fetch.
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: quarterlyPeriod1,
            type: "quarterly",
            module: "financials",
          })
          .catch(() => [] as FundamentalsTimeSeriesFinancialsResult[]),
        // Quarterly balance sheet / cash flow — Chart Type: Quarterly view.
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: quarterlyPeriod1,
            type: "quarterly",
            module: "balance-sheet",
          })
          .catch(() => [] as FundamentalsTimeSeriesBalanceSheetResult[]),
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: quarterlyPeriod1,
            type: "quarterly",
            module: "cash-flow",
          })
          .catch(() => [] as FundamentalsTimeSeriesCashFlowResult[]),
        // Trailing-twelve-month (TTM) rows — appended as a synthetic "TTM"
        // row after the real fiscal-year history (see toTrailingIncomeRow/
        // toTrailingCashFlowRow above and splitTrailingRow() in
        // chart-transform.ts). Same period1 window as the quarterly fetches
        // above is plenty since Yahoo only ever returns the single latest
        // trailing period regardless of how far back period1 goes.
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: quarterlyPeriod1,
            type: "trailing",
            module: "financials",
          })
          .catch(() => [] as FundamentalsTimeSeriesFinancialsResult[]),
        yahooFinance
          .fundamentalsTimeSeries(symbol, {
            period1: quarterlyPeriod1,
            type: "trailing",
            module: "cash-flow",
          })
          .catch(() => [] as FundamentalsTimeSeriesCashFlowResult[]),
        // Multi-source aggregation, primary deep-history layer (see
        // aggregate.ts / providers/sec-edgar.ts doc comments) — audited
        // XBRL data straight from 10-K/20-F filings, the only source that
        // can genuinely back a "10 Years"/"All Available" range selection
        // for an established filer. fetchSecFinancials() never throws (its
        // own try/catch resolves a well-formed { status: "unavailable" }
        // result), caught here too only for defense-in-depth consistency
        // with the other independently-caught fetches above.
        fetchSecFinancials(symbol).catch(
          () => ({
            status: "unavailable" as const,
            income: [],
            balance: [],
            cashFlow: [],
            incomeQuarterly: [],
            balanceQuarterly: [],
            cashFlowQuarterly: [],
            splits: [],
          })
        ),
        // Multi-source aggregation, third-tier layer — no-op (resolves
        // null almost instantly) unless FMP_API_KEY is configured; see
        // providers/fmp.ts.
        fetchFmpIncomeStatements(symbol).catch(() => null),
        fetchFmpBalanceSheets(symbol).catch(() => null),
        fetchFmpCashFlowStatements(symbol).catch(() => null),
        fetchFmpIncomeStatementsQuarterly(symbol).catch(() => null),
        fetchFmpBalanceSheetsQuarterly(symbol).catch(() => null),
        fetchFmpCashFlowStatementsQuarterly(symbol).catch(() => null),
      ]);

      const quote = quotes[0];
      if (!quote || quote.price == null) {
        throw new MarketDataError(`No live quote for ${symbol}`);
      }

      // Ticker-recycling / ghost-data cutoff — see
      // filterRowsBeforeListing/filterPricePointsBeforeListing's doc
      // comments (aggregate.ts) for the full mechanism and rationale.
      // Computed once, up front, so every merged statement array and the
      // price-history series below can be filtered against the same
      // anchor.
      const listingDateMs = quote.firstTradeDateEpochMs;

      const assetProfile = summary.assetProfile;

      // Root-cause fix for the "duplicate quarter" bug — see
      // makeFiscalQuarterLabelFn's doc comment above. Computed once per
      // request, before any quarterly row gets labeled, from whichever
      // annual dataset actually has a dated row (income first, falling
      // back to balance/cash-flow for the rare case income's fetch came
      // back empty but another statement's didn't).
      const fiscalYearEndMonth = inferFiscalYearEndMonth(
        incomeRows as FundamentalsTimeSeriesFinancialsResult[],
        balanceRows as FundamentalsTimeSeriesBalanceSheetResult[],
        cashFlowRows as FundamentalsTimeSeriesCashFlowResult[]
      );
      const quarterLabel = makeFiscalQuarterLabelFn(fiscalYearEndMonth);

      const yahooIncome = toIncomeRows(incomeRows as FundamentalsTimeSeriesFinancialsResult[], summary, symbol, annualLabel, "toIncomeRows");
      const yahooBalance = toBalanceRows(balanceRows as FundamentalsTimeSeriesBalanceSheetResult[], symbol, annualLabel, "toBalanceRows");
      const yahooCashFlow = toCashFlowRows(cashFlowRows as FundamentalsTimeSeriesCashFlowResult[], symbol, annualLabel, "toCashFlowRows");

      // Multi-source aggregation (see aggregate.ts): for each fiscal year,
      // SEC EDGAR's audited deep history wins when it has that year, Yahoo
      // fills recent years and any ticker SEC doesn't register, FMP fills
      // whatever isolated gap remains. Every row keeps a `dataSource` tag
      // for the UI attribution badge (see Income/Balance/CashFlow panels).
      // anchorField opts each statement into cross-source triangulation —
      // see mergeYearsBySource's doc comment in aggregate.ts. Each anchor
      // is that statement's single most load-bearing, universally-reported
      // figure, chosen specifically because every provider defines it the
      // same way (unlike, say, "operating income", which varies by
      // one-time-charge treatment across sources).
      //
      // backfillZeroFields (live bug reports: AT&T's Gross Profit was $0
      // for every annual year, and separately its Total Liabilities was $0
      // for every period, despite Total Assets/Revenue populating fine —
      // root-caused to SEC EDGAR's per-filer XBRL tag coverage gaps, not a
      // company that genuinely has $0 liabilities/gross profit — see
      // mergeYearsBySource's doc comment for the exact mechanism) patches
      // just that one field from a lower-priority source's real value when
      // the winning row's own value is a suspicious, structurally-implausible
      // exact 0, without touching any other field on the row.
      // QA fix (live audit: NVDA's earliest 2 fiscal years — the only ones
      // outside SEC EDGAR's XBRL coverage, so Yahoo/FMP win them instead —
      // showed diluted shares wildly out of line with every later,
      // SEC-sourced, correctly split-adjusted year). See
      // applyKnownSplitAdjustment's doc comment in sec-edgar.ts: SEC-sourced
      // rows already get the precise, per-fact filed-date adjustment inside
      // toSecIncomeRows, but a non-SEC row that wins the merge for a year
      // SEC has no data for was never adjusted at all anywhere in this
      // codebase. Applied AFTER the merge, filtered to non-sec-edgar rows
      // only, so SEC rows are never touched twice.
      const incomeMerged = mergeYearsBySource(
        "income",
        symbol,
        [
          { source: "sec-edgar", years: secFinancials.income },
          { source: "yahoo", years: yahooIncome },
          { source: "fmp", years: fmpIncomeToYears(fmpIncomeRows) },
        ],
        { anchorField: "totalRevenue", backfillZeroFields: ["grossProfit", "operatingIncome"] }
      );
      // Ticker-recycling / ghost-data fix (see filterRowsBeforeListing's doc
      // comment in aggregate.ts) — applied AFTER the multi-source merge so
      // it catches ghost data regardless of which of the three providers
      // contributed a given period, and BEFORE the TTM/MRQ appendix below
      // so those always-current synthetic rows are never at risk of it.
      const income = filterRowsBeforeListing(
        applyKnownSplitAdjustmentToNonSecRows(incomeMerged, secFinancials.splits),
        listingDateMs
      );
      // Cheap safety net for both this fix and the filed-date fix upstream —
      // see warnIfShareCountDiscontinuity's doc comment in aggregate.ts.
      warnIfShareCountDiscontinuity("income", symbol, income);
      const balance = filterRowsBeforeListing(
        mergeYearsBySource(
          "balance",
          symbol,
          [
            { source: "sec-edgar", years: secFinancials.balance },
            { source: "yahoo", years: yahooBalance },
            { source: "fmp", years: fmpBalanceToYears(fmpBalanceRows) },
          ],
          { anchorField: "totalAssets", backfillZeroFields: ["totalLiabilities"] }
        ),
        listingDateMs
      );
      const cashFlow = filterRowsBeforeListing(
        mergeYearsBySource(
          "cashFlow",
          symbol,
          [
            { source: "sec-edgar", years: secFinancials.cashFlow },
            { source: "yahoo", years: yahooCashFlow },
            { source: "fmp", years: fmpCashFlowToYears(fmpCashFlowRows) },
          ],
          { anchorField: "operatingCashFlow" }
        ),
        listingDateMs
      );

      // Quarterly counterparts — Chart Type: Quarterly view. Same merge
      // priority (SEC EDGAR 10-Qs > Yahoo > FMP), keyed "fiscalYear-Qn"
      // instead of a bare year (see quarterLabel()/quarterlySeries()).
      // Foreign private issuers (20-F filers) generally don't file 10-Qs,
      // so `secFinancials.*Quarterly` is often empty for them — Yahoo/FMP
      // still cover that case. Computed BEFORE the trailing/TTM appendix
      // below so the merged, multi-source quarterly arrays are available as
      // a universal TTM fallback (see computeTrailingTwelveMonths in ttm.ts).
      const yahooIncomeQuarterly = toIncomeRows(
        quarterlyRevenueRows as FundamentalsTimeSeriesFinancialsResult[],
        summary,
        symbol,
        quarterLabel,
        "toIncomeRows(quarterly)"
      );
      const yahooBalanceQuarterly = toBalanceRows(
        balanceRowsQuarterly as FundamentalsTimeSeriesBalanceSheetResult[],
        symbol,
        quarterLabel,
        "toBalanceRows(quarterly)"
      );
      const yahooCashFlowQuarterly = toCashFlowRows(
        cashFlowRowsQuarterly as FundamentalsTimeSeriesCashFlowResult[],
        symbol,
        quarterLabel,
        "toCashFlowRows(quarterly)"
      );
      const incomeQuarterlyMerged = mergeYearsBySource(
        "incomeQuarterly",
        symbol,
        [
          { source: "sec-edgar", years: secFinancials.incomeQuarterly },
          { source: "yahoo", years: yahooIncomeQuarterly },
          { source: "fmp", years: fmpIncomeToYears(fmpIncomeRowsQuarterly) },
        ],
        { anchorField: "totalRevenue", backfillZeroFields: ["grossProfit", "operatingIncome"] }
      );
      // Same non-SEC split-adjustment gap as the annual series above, just
      // for the quarterly one — see applyKnownSplitAdjustmentToNonSecRows'
      // doc comment in sec-edgar.ts. Ghost-data cutoff applied here too —
      // same rationale as the annual arrays above.
      const incomeQuarterly = filterRowsBeforeListing(
        applyKnownSplitAdjustmentToNonSecRows(incomeQuarterlyMerged, secFinancials.splits),
        listingDateMs
      );
      const balanceQuarterly = filterRowsBeforeListing(
        mergeYearsBySource(
          "balanceQuarterly",
          symbol,
          [
            { source: "sec-edgar", years: secFinancials.balanceQuarterly },
            { source: "yahoo", years: yahooBalanceQuarterly },
            { source: "fmp", years: fmpBalanceToYears(fmpBalanceRowsQuarterly) },
          ],
          { anchorField: "totalAssets", backfillZeroFields: ["totalLiabilities"] }
        ),
        listingDateMs
      );
      const cashFlowQuarterly = filterRowsBeforeListing(
        mergeYearsBySource(
          "cashFlowQuarterly",
          symbol,
          [
            { source: "sec-edgar", years: secFinancials.cashFlowQuarterly },
            { source: "yahoo", years: yahooCashFlowQuarterly },
            { source: "fmp", years: fmpCashFlowToYears(fmpCashFlowRowsQuarterly) },
          ],
          { anchorField: "operatingCashFlow" }
        ),
        listingDateMs
      );

      // Trailing-twelve-month appendix — appended directly onto the merged
      // annual arrays as a final "TTM" row (same convention mock-data.ts
      // already uses for its illustrative fixtures), NOT merged through
      // mergeYearsBySource since TTM isn't a fiscal year any source "has"
      // or "is missing". Panels split it back out before Select Range
      // filtering (see splitTrailingRow() in chart-transform.ts) so it's
      // always shown regardless of range, matching the reference
      // terminal's behavior.
      //
      // Prefers Yahoo's own dedicated trailing-type fetch when it succeeds
      // (a real, live figure, occasionally fresher than the latest filed
      // quarter). Falls back to computeTrailingTwelveMonths() — summing the
      // 4 most recent CONSECUTIVE quarters out of the merged, multi-source
      // `incomeQuarterly`/`cashFlowQuarterly` above — whenever Yahoo's
      // trailing endpoint fails, rate-limits, or doesn't cover this symbol.
      // This makes "TTM" genuinely universal/source-agnostic instead of a
      // silent Yahoo-only dependency: any symbol with 4 consecutive merged
      // quarters (from SEC EDGAR 10-Qs, Yahoo, or FMP, in any combination)
      // now gets a TTM bar. SEC EDGAR itself has no TTM concept (audited
      // annual/quarterly filings only) — it contributes via the quarterly
      // merge above, not directly.
      const incomeTrailing =
        toTrailingIncomeRow(trailingIncomeRows as FundamentalsTimeSeriesFinancialsResult[], summary) ??
        computeTrailingTwelveMonths(incomeQuarterly, {
          sumKeys: ["totalRevenue", "grossProfit", "operatingIncome", "netIncome", "eps", "dividendsPerShare"],
          latestKeys: ["sharesOutstandingDiluted"],
        });
      if (incomeTrailing) income.push(incomeTrailing);
      const cashFlowTrailing =
        toTrailingCashFlowRow(trailingCashFlowRows as FundamentalsTimeSeriesCashFlowResult[]) ??
        computeTrailingTwelveMonths(cashFlowQuarterly, {
          sumKeys: ["operatingCashFlow", "freeCashFlow", "stockBasedCompensation", "capitalExpenditures", "netIncome"],
        });
      if (cashFlowTrailing) cashFlow.push(cashFlowTrailing);

      // Most Recent Quarter (MRQ) appendix for the Balance Sheet panel —
      // unlike income/cash flow (flow statements, where "trailing twelve
      // months" is the natural rolling figure), a balance sheet is a
      // point-in-time snapshot, so its trailing appendix is simply the
      // latest quarter already fetched above, relabeled "MRQ" rather than
      // re-fetched. `balanceQuarterly` is lexicographically sorted by
      // "fiscalYear-Qn" (see mergeYearsBySource), so the last entry is the
      // most recent quarter. Appended the same way as income/cashFlow's TTM
      // row — see splitTrailingRow() in chart-transform.ts.
      const latestQuarter = balanceQuarterly[balanceQuarterly.length - 1];
      if (latestQuarter) {
        // Dev-only sanity check (live bug reports: GOOGL's Total Assets
        // jumped $595B annual -> $922B MRQ; AT&T's Total Debt dropped
        // $143.7B annual -> $9.32B MRQ) — see warnIfTrailingRowImplausible's
        // doc comment for why this only logs rather than "fixing" either
        // figure. `balance` here is still the pre-MRQ-append annual array.
        warnIfTrailingRowImplausible("balance", symbol, balance, latestQuarter, "totalAssets");
        warnIfTrailingRowImplausible("balance", symbol, balance, latestQuarter, "totalDebt");
        balance.push({ ...latestQuarter, fiscalYear: "MRQ" });
      }

      // Post-merge revenue join for the Cash Flow panel's "As a % of
      // Revenue" View — see backfillCashFlowRevenue's doc comment
      // (aggregate.ts) for why this runs here rather than per-provider.
      // Both `income`/`incomeQuarterly` already carry their TTM row by this
      // point (pushed above), so this also covers `cashFlow`'s/
      // `cashFlowQuarterly`'s own "TTM" row via the same label match.
      const cashFlowWithRevenue = backfillCashFlowRevenue(cashFlow, income);
      const cashFlowQuarterlyWithRevenue = backfillCashFlowRevenue(cashFlowQuarterly, incomeQuarterly);

      const bundle: FundamentalsBundle = {
        source: "live",
        reportingCurrency: summary.financialData?.financialCurrency || quote.currency,
        quote,
        profile: {
          sector: assetProfile?.sector ?? null,
          industry: assetProfile?.industry ?? null,
          website: assetProfile?.website ?? null,
          ceo: findCeo(assetProfile),
          description: assetProfile?.longBusinessSummary ?? null,
        },
        metrics: toMetrics(summary, incomeTrailing, cashFlowTrailing, latestQuarter),
        income,
        balance,
        cashFlow: cashFlowWithRevenue,
        incomeQuarterly,
        balanceQuarterly,
        cashFlowQuarterly: cashFlowQuarterlyWithRevenue,
        estimates: toEstimates(summary, income, quarterlyRevenueRows as FundamentalsTimeSeriesFinancialsResult[]),
        priceTargets: toPriceTargets(summary),
        // Ghost-data cutoff for the price series too (see
        // filterPricePointsBeforeListing's doc comment, aggregate.ts) —
        // Yahoo's chart endpoint returns whatever OHLC history exists under
        // the symbol regardless of company identity, so a recycled ticker's
        // price bars can extend years further back than this company's own
        // first trade date.
        history: filterPricePointsBeforeListing(toPricePoints(chartResult), listingDateMs),
      };
      return bundle;
    } catch (err) {
      const mock = getMockFundamentals(symbol);
      if (mock) return mock;
      throw err instanceof MarketDataError
        ? err
        : new MarketDataError(`Unable to load fundamentals for ${symbol}`, err);
    }
  });

  // Perf/freshness fix ("ticker page price can be up to 5 minutes stale"):
  // the quote embedded in `bundle` above was fetched (and then frozen) at
  // whatever moment the *whole* fundamentals bundle was last computed —
  // income statements, balance sheets, 10 years of price history, and all
  // — which is deliberately cached for CACHE_TTL_MS * 15 (5 minutes; see
  // fundamentalsCache above) since that heavier data genuinely doesn't
  // need to be any fresher. But that meant the live price rode along on
  // the same 5-minute cache, even though getQuotes() (used by the
  // dashboard/watchlist) already has its own, much faster 20-second cache
  // (quoteCache). Two requests for the same symbol a minute apart could
  // legitimately show two different prices depending on whether they hit
  // the home dashboard or the ticker page.
  //
  // Re-fetching here, *outside* fundamentalsCache.getOrSet, decouples the
  // two: this call goes through getQuotes()'s own 20s cache, so the price
  // shown on /analysis/[symbol] now refreshes on the same cadence as
  // everywhere else in the app, independent of whether the heavier
  // fundamentals bundle happens to still be cache-fresh. Only applied to
  // live bundles — overlaying a real-time quote onto mock/demo data would
  // produce a confusing hybrid (mock fundamentals, live price) for a
  // symbol whose real fundamentals genuinely couldn't be fetched.
  if (bundle.source !== "live") return bundle;
  try {
    const [freshQuote] = await getQuotes([symbol]);
    if (freshQuote && freshQuote.price != null) {
      return { ...bundle, quote: freshQuote };
    }
  } catch {
    // Best-effort: getQuotes() failing here shouldn't take down the whole
    // fundamentals bundle when everything else loaded fine — fall through
    // to whatever quote is already embedded in `bundle` (fresh as of that
    // bundle's own fetch, just not guaranteed 20s-fresh).
  }
  return bundle;
}
