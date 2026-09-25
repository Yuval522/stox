/**
 * Domain types for Stox market data. Deliberately independent of the
 * yahoo-finance2 response shapes — lib/finance/yahoo.ts is the only file
 * that should import from "yahoo-finance2" and adapt into these types, so
 * swapping/adding a data provider later doesn't ripple through the UI.
 */

export type MarketState = "PRE" | "REGULAR" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED";

export interface MarketQuote {
  symbol: string;
  /** Display name, e.g. "Apple Inc." or "S&P 500" */
  name: string;
  /** Exchange code, e.g. "NASDAQ", "NYSE", "TLV" */
  exchange: string;
  /**
   * Yahoo's instrument classification, e.g. "EQUITY", "INDEX", "ETF",
   * "CRYPTOCURRENCY". Optional (mock quotes omit it — they're all EQUITY)
   * and only really used to gate the fundamentals tab strip for indices,
   * which have no income statement/balance sheet/etc. to show. See
   * isIndexQuote() in lib/finance/exchange.ts.
   */
  quoteType?: string | null;
  /** ISO-ish currency code as returned by the provider, e.g. USD, ILA, EUR */
  currency: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  marketCap: number | null;
  marketState: MarketState | null;
  /** Epoch ms of the quote timestamp, if known */
  asOf: number | null;
  /** IANA timezone of the exchange, e.g. "America/New_York", "Asia/Jerusalem" */
  timezone: string | null;
  preMarketPrice: number | null;
  preMarketChange: number | null;
  preMarketChangePercent: number | null;
  /**
   * Epoch ms the pre-market price was last updated — DELIBERATELY separate
   * from `asOf` (which is the REGULAR session's last-trade time). Pre-market
   * timestamp bug fix: PriceHeaderBlock's pre-market row used to show
   * `asOf` next to the pre-market price/change, which while the market
   * hasn't opened yet for the day is still the PRIOR regular session's
   * close time (typically 4:00pm ET) — a real, but wrong-for-this-row,
   * timestamp that made every pre-market quote look like it was frozen at
   * yesterday's close instead of reflecting this morning's actual
   * pre-market activity. Null when Yahoo doesn't report one (e.g. outside
   * pre-market hours, or a symbol/exchange with no pre-market session).
   */
  preMarketTime: number | null;
  postMarketPrice: number | null;
  postMarketChange: number | null;
  postMarketChangePercent: number | null;
  /** Epoch ms the post-market price was last updated — see preMarketTime's doc comment for why this is kept separate from `asOf` too. */
  postMarketTime: number | null;
  /**
   * Today's session OHLC + prior close, for the Live Trading Feed's Day
   * Range strip (PriceHeaderBlock) — sourced from Yahoo's
   * regularMarketOpen/DayHigh/DayLow/PreviousClose fields (see
   * toMarketQuote() in yahoo.ts). Optional/nullable since mock data and
   * some thin instruments (indices without a conventional day range) may
   * not have all four.
   */
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  /**
   * 52-week high/low (Yahoo's fiftyTwoWeekHigh/fiftyTwoWeekLow, see
   * toMarketQuote() in yahoo.ts) — used by the Analysis page's index/ETF/
   * crypto "Market Data" stats block (CompanyProfileHeader) to fill the
   * space that would otherwise show sector/industry/CEO for a normal
   * equity. Null for providers that don't return it (Finnhub's /quote,
   * Polygon's prev-day aggregate, Alpha Vantage's GLOBAL_QUOTE — none of
   * these free-tier endpoints carry a 52-week range).
   */
  weekHigh52: number | null;
  weekLow52: number | null;
  /**
   * Epoch ms of the CURRENT company's first trade date under this symbol
   * (Yahoo's `firstTradeDateMilliseconds`), null when Yahoo doesn't report
   * one. Ticker-recycling / ghost-data fix: Yahoo keys
   * historical data by ticker SYMBOL, not by company identity, so a symbol
   * recycled from a delisted/defunct company can otherwise surface that OLD
   * company's financial statements and price bars under a brand-new IPO.
   * This is the one signal anchored to the actual listing rather than the
   * symbol string, so getFundamentals() (yahoo.ts) uses it as a hard cutoff
   * — see filterRowsBeforeListing/filterPricePointsBeforeListing in
   * aggregate.ts — to discard anything dated before it.
   */
  firstTradeDateEpochMs: number | null;
  /**
   * Which provider this specific quote came from — omitted (undefined) for
   * the normal case (Yahoo Finance, via getQuotes() in yahoo.ts), same
   * "absent means the default/primary source" convention as
   * IncomeStatementYear.dataSource. Only ever set when app/api/quotes'
   * route falls back to a signed-in user's own configured Finnhub/
   * Polygon/Alpha Vantage key for a symbol Yahoo's batch didn't return —
   * see lib/finance/providers/{finnhub,polygon,alphaVantage}.ts.
   */
  source?: "finnhub" | "polygon" | "alphaVantage";
}

export interface SearchResultItem {
  symbol: string;
  name: string;
  exchange: string;
  /** Best-effort from exchange (search doesn't return currency); see lib/finance/exchange.ts */
  currency: string;
  /** EQUITY, ETF, INDEX, CRYPTOCURRENCY, MUTUALFUND, CURRENCY, ... */
  type: string;
}

export interface CompanyProfile {
  sector: string | null;
  industry: string | null;
  website: string | null;
  ceo: string | null;
  description: string | null;
}

export interface FinancialsMetrics {
  marketCap: number | null;
  peRatio: number | null;
  forwardPE: number | null;
  forwardPeg: number | null;
  priceToCashFlow: number | null;
  priceToFreeCashFlow: number | null;
}

export interface YieldsMetrics {
  /** Percent, e.g. 3.2 means 3.2% */
  earningsYield: number | null;
  cashFlowYield: number | null;
  freeCashFlowYield: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
}

export interface BalanceMetrics {
  totalCash: number | null;
  totalDebt: number | null;
  netCashPosition: number | null;
}

export interface MarginMetrics {
  /** Percent, e.g. 45.2 means 45.2% */
  grossMargin: number | null;
  operatingMargin: number | null;
  netIncomeMargin: number | null;
}

export interface TickerMetrics {
  financials: FinancialsMetrics;
  yields: YieldsMetrics;
  balances: BalanceMetrics;
  margins: MarginMetrics;
}

/**
 * Multi-source aggregation (see lib/finance/aggregate.ts): each historical
 * financial-statement year is fetched from whichever provider has it,
 * prioritized deepest/most-authoritative first. "yahoo" (lib/finance/yahoo.ts)
 * is the primary source; "fmp" (opt-in via FMP_API_KEY) is a secondary
 * fallback for whatever isolated gap remains; "eodhd" (opt-in, paid, via
 * EODHD_API_KEY — see providers/eodhd.ts) is a third, lowest-priority layer
 * used specifically to extend history into years older than Yahoo/FMP cover
 * — both of those are capped at roughly 4-5 fiscal years on their free
 * tiers with no code-side workaround (SEC EDGAR previously filled the
 * deep-history role; it has been removed — see CLAUDE.md's Data layer
 * section). Optional and omitted on mock/demo data (see mock-data.ts) — a
 * missing `dataSource` should be read as "mock" whenever
 * `FundamentalsBundle.source === "mock"`.
 */
export type FinancialDataSource = "yahoo" | "fmp" | "eodhd";

/**
 * Set by mergeYearsBySource (aggregate.ts) when 2+ independently-fetched
 * sources report this same fiscal period but disagree on the statement's
 * `anchorField` (e.g. totalRevenue for income) beyond the normal
 * provider-to-provider noise tolerance — a real, visible "these providers
 * don't agree yet" signal (e.g. one provider has already indexed a
 * just-released quarter and another hasn't), surfaced by
 * SourceAttributionBadge rather than only logged to the server console.
 * Omitted (undefined) — not `false` — for every row where either only one
 * source had data, or the sources that did agreed within tolerance, so a
 * missing field always means "nothing to flag" without needing a
 * three-way boolean.
 */
export interface IncomeStatementYear {
  fiscalYear: string;
  totalRevenue: number;
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
  eps: number;
  sharesOutstandingDiluted: number;
  dividendsPerShare: number;
  dataSource?: FinancialDataSource;
  dataDiscrepancy?: boolean;
}

export interface BalanceSheetYear {
  fiscalYear: string;
  /** Cash & cash equivalents plus short-term marketable securities. */
  cashAndShortTermInvestments: number;
  totalCurrentAssets: number;
  totalCurrentLiabilities: number;
  totalAssets: number;
  totalLiabilities: number;
  totalStockholdersEquity: number;
  /** Cash & cash equivalents only (subset of cashAndShortTermInvestments). */
  totalCash: number;
  totalDebt: number;
  dataSource?: FinancialDataSource;
  dataDiscrepancy?: boolean;
}

export interface CashFlowYear {
  fiscalYear: string;
  operatingCashFlow: number;
  freeCashFlow: number;
  /** Non-cash addback, reported as a positive figure (provider convention). */
  stockBasedCompensation: number;
  /** Investing outflow, reported as a negative figure (provider convention). */
  capitalExpenditures: number;
  /** Snapshot of net income for this fiscal year, for the OCF-vs-Net-Income
   *  earnings-quality comparison — duplicated here rather than joined
   *  against `income[]` at render time since the two arrays aren't
   *  guaranteed to cover identical fiscal years. */
  netIncome: number;
  /**
   * Snapshot of that same fiscal period's total revenue, for the Cash Flow
   * panel's "As a % of Revenue" View option (Free Cash Flow margin, CapEx
   * as % of revenue, etc — see toPctOfRevenue in chart-transform.ts).
   * Optional and backfilled via a post-merge join against the `income`/
   * `incomeQuarterly` arrays in getFundamentals() (see
   * backfillCashFlowRevenue in aggregate.ts), NOT sourced per-provider like
   * `netIncome` above — Yahoo's cash-flow fundamentalsTimeSeries module has
   * no revenue field at all, and FMP's cash-flow endpoint doesn't
   * consistently carry one either, but every source's income statement
   * always does. A period with no income-side match for the same
   * fiscalYear label (or any construction site that doesn't go through the
   * getFundamentals() join, e.g. mock-data.ts's hand-authored fixtures)
   * simply leaves this undefined — toPctOfRevenue already treats a
   * missing/non-finite revenue denominator as "no % to show" (0%) rather
   * than throwing or dividing by zero.
   */
  totalRevenue?: number;
  dataSource?: FinancialDataSource;
  dataDiscrepancy?: boolean;
}

export interface EstimateRow {
  /** Display label, e.g. "Sep 2025" (annual) or "2025 Q2" (quarterly). */
  fiscalPeriodLabel: string;
  /** ISO date of the fiscal period end, for sorting. */
  periodEndDate: string;
  revenueEstimate: number | null;
  revenueYoyGrowthPct: number | null;
  revenueAvg: number | null;
  revenueLow: number | null;
  revenueHigh: number | null;
  numberOfAnalysts: number | null;
  /** True once the fiscal period has actually closed. */
  isHistorical: boolean;
  /** Only meaningful when isHistorical — actual reported revenue met/beat consensus. */
  beat: boolean | null;
  /** Only populated when isHistorical and known. */
  actualRevenue: number | null;
  /**
   * Trailing EPS actual/estimate (Yahoo's `earningsHistory` module, up to
   * ~4 quarters back) — populated for historical quarterly rows that don't
   * have a revenue consensus to compare against (see beatBasis).
   */
  epsActual: number | null;
  epsEstimate: number | null;
  /**
   * Which figure `beat` is based on. Yahoo's free tier doesn't expose
   * point-in-time historical *revenue* consensus (only forward-looking
   * earningsTrend and trailing EPS-only earningsHistory), so live
   * historical rows are honestly labeled "eps" rather than fabricating a
   * revenue comparison. Mock/demo data uses "revenue" throughout. Null
   * when there's nothing to compare (forward-looking rows).
   */
  beatBasis: "revenue" | "eps" | null;
}

export interface EstimatesBundle {
  quarterly: EstimateRow[];
  annual: EstimateRow[];
}

/** Analyst rating counts for the most recent period Yahoo reports (its `recommendationTrend` module's first row, conventionally labeled "0m" — this month). */
export interface AnalystRecommendationDistribution {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

/**
 * Analyst price-target consensus (Estimates tab). Sourced from Yahoo's
 * `financialData`/`recommendationTrend` quoteSummary modules — see
 * toPriceTargets() in yahoo.ts. Target prices are assumed to share the same
 * raw-unit convention as `quote.price` for that symbol (e.g. agorot for
 * ILA-quoted TASE names) — same unverified-in-this-sandbox caveat already
 * documented on toMetrics()/formatPrice(), so they're always rendered
 * through the same currency-aware formatter as the header price rather than
 * assumed to already be in display units.
 */
export interface AnalystPriceTargets {
  meanTarget: number | null;
  medianTarget: number | null;
  highTarget: number | null;
  lowTarget: number | null;
  numberOfAnalysts: number | null;
  /** Yahoo's 1 (Strong Buy) - 5 (Strong Sell) consensus scale. */
  recommendationMean: number | null;
  /** Yahoo's raw key, e.g. "buy", "strong_buy", "hold" — title-cased for display. */
  recommendationKey: string | null;
  distribution: AnalystRecommendationDistribution | null;
}

export interface PricePoint {
  /** ISO date, e.g. "2024-03-15" */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface FundamentalsBundle {
  quote: MarketQuote;
  profile: CompanyProfile;
  metrics: TickerMetrics;
  /**
   * Annual, oldest first — depth is capped by Yahoo's free-tier
   * fundamentalsTimeSeries limit of ~4 annual periods (see aggregate.ts and
   * FinancialDataSource's doc comment); there is no source in this app deep
   * enough to go beyond that. May end with one trailing-appendix row:
   * `fiscalYear: "TTM"` (trailing twelve months) on
   * `income`/`cashFlow`, or `fiscalYear: "MRQ"` (most recent quarter) on
   * `balance` — see splitTrailingRow() in chart-transform.ts, which panels
   * use to pull it out before Select Range filtering and always re-append
   * it afterward, so it's never sliced away as one of the "N years".
   */
  income: IncomeStatementYear[];
  balance: BalanceSheetYear[];
  cashFlow: CashFlowYear[];
  /**
   * Quarterly counterparts, `fiscalYear` holds a "YYYY-Qn" label (e.g.
   * "2025-Q2") instead of a bare year — see makeFiscalQuarterLabelFn()
   * in yahoo.ts. Powers the Chart Type: Quarterly
   * toggle (ChartControls.tsx); may be empty (e.g. mock/demo data, or a
   * foreign private issuer with thin Yahoo/FMP
   * quarterly coverage) — panels should treat an empty array as "Quarterly
   * unavailable for this symbol" rather than rendering an empty chart.
   */
  incomeQuarterly?: IncomeStatementYear[];
  balanceQuarterly?: BalanceSheetYear[];
  cashFlowQuarterly?: CashFlowYear[];
  estimates: EstimatesBundle;
  /** Null when the provider has no analyst coverage for this symbol (thin/illiquid names) or on mock data that doesn't define it. */
  priceTargets: AnalystPriceTargets | null;
  /** Daily closes, oldest first — sliced client-side per selected time range */
  history: PricePoint[];
  /**
   * Currency for `metrics`/`income` figures. Usually equals quote.currency,
   * but diverges for dual-listed names like TEVA.TA, which trades in ILA
   * on the TASE but reports financial statements in USD.
   */
  reportingCurrency: string;
  source: "live" | "mock";
}

export class MarketDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MarketDataError";
  }
}
