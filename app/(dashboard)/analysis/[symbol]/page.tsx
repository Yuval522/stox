import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";
import { getFundamentals, getQuotes } from "@/lib/finance/yahoo";
import { MarketDataError } from "@/lib/finance/types";
import { isNonFundamentalQuote } from "@/lib/finance/exchange";
import { CompanyProfileHeader } from "@/components/ticker/CompanyProfileHeader";
import { CompanyMetricsAccordions } from "@/components/ticker/CompanyMetricsAccordions";
import { MobileTickerHeader } from "@/components/ticker/MobileTickerHeader";
import { TickerPriceAndChart } from "@/components/ticker/TickerPriceAndChart";
import { DataExplorerTabs } from "@/components/ticker/DataExplorerTabs";

// Live upstream data — never let Next statically cache this route.
export const dynamic = "force-dynamic";

/**
 * SEO audit finding (seo-audit-finlens-2026-08-14.md): this was the single
 * highest-value on-page gap — every route shared one static title/
 * description from the root layout, so an Apple page and a Tesla page
 * reported identical metadata to search engines. This is Stox's best
 * source of long-tail search traffic once public (hundreds of "[ticker]
 * stock analysis" queries), so each symbol gets its own title/description
 * built from a real live quote.
 *
 * Deliberately uses the lightweight getQuotes() (a single quote-cache
 * lookup) rather than the page component's own getFundamentals() call —
 * that's a much heavier multi-module bundle (quoteSummary,
 * fundamentalsTimeSeries x6, FMP, ...) that generateMetadata
 * doesn't need just to build a title. Falls back to a generic-but-still-
 * unique title (rather than throwing, or falling through to the root
 * layout's fully generic one) if the quote lookup fails for any reason —
 * metadata generation failing should never take down the page itself.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol: rawSymbol } = await params;
  const symbol = decodeURIComponent(rawSymbol);

  try {
    const [quote] = await getQuotes([symbol]);
    if (!quote) throw new Error("no quote returned");

    const priceText =
      quote.price != null
        ? `${quote.price.toFixed(2)} ${quote.currency}${
            quote.changePercent != null
              ? ` (${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%)`
              : ""
          }`
        : null;

    const title = `${quote.name} (${quote.symbol}) Stock Price, Chart & Analysis | Stox`;
    const description = priceText
      ? `${quote.name} (${quote.symbol}) — ${priceText} on ${quote.exchange}. Live price, RSI, moving averages, and financials on Stox.`
      : `${quote.name} (${quote.symbol}) stock analysis on ${quote.exchange} — live price, technical indicators, and financials on Stox.`;

    return {
      title,
      description,
      openGraph: { title, description },
      twitter: { card: "summary", title, description },
    };
  } catch {
    const title = `${symbol} Stock Analysis | Stox`;
    return { title, openGraph: { title }, twitter: { card: "summary", title } };
  }
}

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol: rawSymbol } = await params;
  const symbol = decodeURIComponent(rawSymbol);

  let bundle = null;
  let error: string | null = null;
  try {
    bundle = await getFundamentals(symbol);
  } catch (err) {
    error =
      err instanceof MarketDataError
        ? err.message
        : "Unable to load this symbol right now";
  }

  if (error || !bundle) {
    return (
      <div className="hig-card flex flex-col items-center justify-center gap-3 !border-dashed py-24 text-center">
        <AlertTriangle className="h-8 w-8 text-muted-foreground" />
        <h1 className="font-display text-lg font-semibold">{symbol}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {error ?? "No data found for this symbol."}
        </p>
      </div>
    );
  }

  const {
    quote,
    profile,
    metrics,
    income,
    balance,
    cashFlow,
    incomeQuarterly,
    balanceQuarterly,
    cashFlowQuarterly,
    estimates,
    priceTargets,
    history,
    reportingCurrency,
  } = bundle;

  // Indices (^GSPC, ^TA125.TA, ^IXIC, ...) — and, more broadly, ETFs,
  // mutual funds, commodities, currency/forex pairs, and crypto — have no
  // income statement, balance sheet, cash flow, analyst estimates, or
  // valuation to show; Yahoo simply doesn't carry fundamentals data for any
  // of these asset classes. Rather than render a tab strip full of empty/
  // broken panels, hide the fundamentals-shaped UI (tabs + the
  // P/E-and-margins metrics accordions, equally meaningless here) and show
  // only the header card and price chart.
  //
  // QA fix (live report): this used to render an explicit
  // NonFundamentalNotice card below the chart explaining the absence of
  // financials. Feedback was that the card added nothing actionable and
  // just took up space — removed outright rather than replaced. The left
  // profile panel's CompanyMetricsAccordions is skipped the same way it
  // always was; CompanyProfileHeader now gets `isNonFundamental` instead,
  // so it can show a Market Data stats block (previous close/open/day's
  // range/52-week range) in the space that would otherwise sit empty for
  // this category (no sector/industry/CEO/website to show either).
  const isNonFundamental = isNonFundamentalQuote(quote.symbol, quote.quoteType);

  return (
    // QA fix (regression found via live comparison against the reference
    // terminal): the previous pass gave both grid columns `items-start` so
    // their tops would align pixel-for-pixel — but that also meant the left
    // column's own box no longer stretched to the row's full height, only
    // to its own (much shorter) content height. `position: sticky` can only
    // stay pinned while *its own containing block* still intersects the
    // viewport — once you scrolled past that short box, the whole profile
    // card scrolled away with it instead of staying pinned, i.e. it just
    // vanished. Fix: drop `items-start` (the default cross-axis `stretch`
    // makes both columns' boxes span the full (taller) row height — tops
    // still align exactly, since that's just where the row starts) and move
    // `sticky` onto an *inner* wrapper, which now has a tall parent to
    // stick within for as long as the right column keeps scrolling.
    //
    // QA fix (audit finding, layered on top of the above): this was CSS
    // Grid with a fixed `22rem 1fr` column template. At common desktop
    // widths that left the right (chart/tab) column meaningfully narrower
    // than the reference terminal's — every downstream chart grid inside it
    // was sized off that narrow column. Switched to `flex` with an explicit
    // `w-[22rem] shrink-0` left column instead of a grid track: identical
    // visual result (fixed-width left, fluid right) but the right column
    // now gets `flex-1` — flexbox's default `align-items: stretch` gives it
    // the exact same full-row-height box the sticky fix above depends on,
    // so nothing about that fix needed to change.
    // Apple-HIG concept redesign: same .hig-bg radial wash + shell-padding
    // cancel-out trick as the Home page (see that page's own doc comment).
    // Swapping the outer Fragment for a real div here is purely cosmetic —
    // it does not touch the .analysis-grid flex/order/sticky structure
    // documented below, which must stay exactly as-is.
    <div className="hig-bg -m-4 p-4 md:-m-6 md:p-6">
      <MobileTickerHeader quote={quote} />
      <div className="analysis-grid flex flex-col gap-6 lg:flex-row">
        <div className="order-2 w-full lg:order-1 lg:w-[22rem] lg:shrink-0">
          <div className="area-profile space-y-4 lg:sticky lg:top-6">
            <CompanyProfileHeader quote={quote} profile={profile} isNonFundamental={isNonFundamental} />
            {!isNonFundamental && (
              <CompanyMetricsAccordions metrics={metrics} reportingCurrency={reportingCurrency} />
            )}
          </div>
        </div>

        <div className="order-1 min-w-0 flex-1 space-y-6 lg:order-2">
          <TickerPriceAndChart initialQuote={quote} history={history} exchange={quote.exchange} />

          {!isNonFundamental && (
            <DataExplorerTabs
              income={income}
              balance={balance}
              cashFlow={cashFlow}
              incomeQuarterly={incomeQuarterly}
              balanceQuarterly={balanceQuarterly}
              cashFlowQuarterly={cashFlowQuarterly}
              estimates={estimates}
              priceTargets={priceTargets}
              reportingCurrency={reportingCurrency}
              quote={quote}
              metrics={metrics}
              history={history}
            />
          )}
        </div>
      </div>
    </div>
  );
}
