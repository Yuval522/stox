"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TrendingUp,
  Landmark,
  Wallet,
  Percent,
  Target,
  GitCompare,
  Calculator,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import { IncomeStatementPanel } from "./IncomeStatementPanel";
import { BalanceSheetPanel } from "./BalanceSheetPanel";
import { CashFlowPanel } from "./CashFlowPanel";
import { EstimatesPanel } from "./EstimatesPanel";
import { ComparePanel } from "./ComparePanel";
import { ValuationCalculator } from "./ValuationCalculator";
import { AIInsightsPanel } from "./AIInsightsPanel";
import { RatiosPanel } from "./RatiosPanel";
import { ScorePanel } from "./ScorePanel";
import { toDisplayUnit } from "@/lib/format/currency";
import type {
  AnalystPriceTargets,
  BalanceSheetYear,
  CashFlowYear,
  EstimatesBundle,
  IncomeStatementYear,
  MarketQuote,
  PricePoint,
  TickerMetrics,
} from "@/lib/finance/types";

const TABS = [
  "Income",
  "Balance",
  "Cash Flow",
  "Ratios",
  "Estimates",
  "Compare",
  "Score",
  "Valuation",
  "AI Insights",
] as const;

type Tab = (typeof TABS)[number];

// Design-audit fix: the reference terminal pairs every tab with an icon.
// Kept as a lookup (rather than inlining icons in the TABS array) so TABS
// stays a plain readonly string tuple for the Tab union type above.
const TAB_ICONS: Record<Tab, LucideIcon> = {
  Income: TrendingUp,
  Balance: Landmark,
  "Cash Flow": Wallet,
  Ratios: Percent,
  Estimates: Target,
  Compare: GitCompare,
  Score: Star,
  Valuation: Calculator,
  "AI Insights": Sparkles,
};

const FADE_PX = "20px";

/**
 * Builds an edge-fade mask that only fades the side(s) that actually have
 * more content to scroll to. QA hotfix: this used to be a single constant
 * gradient applied at both edges unconditionally, which faded the leftmost
 * tab ("Income") even at scrollLeft=0 when there was nothing hidden to its
 * left — at a glance that reads as a tab being clipped/missing, not as a
 * scroll hint, which is exactly what an audit at ~1400px desktop width
 * flagged. Fading only the edge(s) with real overflow makes the hint
 * unambiguous and stops misrepresenting fully-visible tabs as cut off.
 */
function buildEdgeFadeMask(canScrollLeft: boolean, canScrollRight: boolean): string | undefined {
  if (!canScrollLeft && !canScrollRight) return undefined;
  const left = canScrollLeft ? `transparent, black ${FADE_PX}` : "black 0";
  const right = canScrollRight ? `black calc(100% - ${FADE_PX}), transparent` : "black 100%";
  return `linear-gradient(to right, ${left}, ${right})`;
}

interface DataExplorerTabsProps {
  income: IncomeStatementYear[];
  balance: BalanceSheetYear[];
  cashFlow: CashFlowYear[];
  /** Quarterly counterparts (SEC 10-Q / Yahoo / FMP) — see FundamentalsBundle
   *  in lib/finance/types.ts. Empty/omitted disables Chart Type: Quarterly
   *  in the corresponding panel. */
  incomeQuarterly?: IncomeStatementYear[];
  balanceQuarterly?: BalanceSheetYear[];
  cashFlowQuarterly?: CashFlowYear[];
  estimates: EstimatesBundle;
  /** Null when the provider has no analyst coverage for this symbol. */
  priceTargets: AnalystPriceTargets | null;
  reportingCurrency: string;
  quote: MarketQuote;
  metrics: TickerMetrics;
  /** Daily closes, oldest first — see FundamentalsBundle.history in
   *  lib/finance/types.ts. Threaded down only for the Score tab's
   *  Multi-Factor Rating fair-value band (lib/finance/fair-value.ts),
   *  which needs historical prices to derive historical P/E and P/S
   *  multiples; every other tab already gets its own price context
   *  elsewhere (ChartPanel, rendered as a sibling of this component in
   *  page.tsx, not through here). */
  history: PricePoint[];
}

export function DataExplorerTabs({
  income,
  balance,
  cashFlow,
  incomeQuarterly,
  balanceQuarterly,
  cashFlowQuarterly,
  estimates,
  priceTargets,
  reportingCurrency,
  quote,
  metrics,
  history,
}: DataExplorerTabsProps) {
  const [tab, setTab] = useState<Tab>("Income");
  const latestIncome = income[income.length - 1];

  // Bug fix (reported: chart Range/View/Filter settings "reset" when
  // switching tabs and back): every panel below used to be gated purely by
  // `tab === "X" && <Panel/>`, which *unmounts* the non-active panel
  // entirely rather than just hiding it. Each panel's chart controls live
  // in per-card `useState` (see useChartControls.ts) scoped to that
  // component instance — unmounting destroys that state outright, so
  // navigating Income -> Balance -> Income silently reset Income's cards
  // back to their defaults. This looked like "another action overrode my
  // setting" but was actually a mount/unmount lifecycle issue, not state
  // leaking between cards.
  //
  // Fix: track which tabs have ever been opened and, once a tab has been
  // visited, keep its panel mounted for the rest of this page's lifetime —
  // only its visibility (via the `hidden` utility class, not conditional
  // rendering) toggles when switching away. A panel still only mounts the
  // *first* time its tab is opened, so tabs the user never visits (e.g. AI
  // Insights) still incur zero cost until then, and nothing
  // renders into a hidden container on its very first paint (avoids the
  // classic "chart measures 0-width because it first rendered while
  // display:none" failure mode some chart libraries have).
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set<Tab>(["Income"]));
  function selectTab(t: Tab) {
    setTab(t);
    setVisitedTabs((prev) => (prev.has(t) ? prev : new Set(prev).add(t)));
  }

  const tabStripRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollAffordance = useCallback(() => {
    const el = tabStripRef.current;
    if (!el) return;
    // Small tolerance so sub-pixel scroll rounding doesn't leave a
    // permanently-stuck fade at either end.
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);

  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    updateScrollAffordance();
    el.addEventListener("scroll", updateScrollAffordance, { passive: true });
    // Re-check on resize/content changes — this is the actual reported bug:
    // at ~1400px desktop width the strip is scrollable, at wider widths it
    // may not be, and the fade needs to reflect whichever is true right now.
    const ro = new ResizeObserver(updateScrollAffordance);
    ro.observe(el);
    window.addEventListener("resize", updateScrollAffordance);
    return () => {
      el.removeEventListener("scroll", updateScrollAffordance);
      ro.disconnect();
      window.removeEventListener("resize", updateScrollAffordance);
    };
  }, [updateScrollAffordance]);

  const edgeFadeMask = buildEdgeFadeMask(canScrollLeft, canScrollRight);

  return (
    <div className="hig-card p-4 sm:p-5">
      {/*
        QA hotfix (UI/UX audit pass): the tab strip overflowed at normal
        desktop widths (~1400px), not just mobile, and the previous
        always-on edge fade actually made it *worse* — it dimmed the
        leftmost tab even when nothing was scrolled past it, which reads as
        "clipped" rather than "scroll for more". Now scroll-position-aware:
        the mask only fades an edge when there's genuinely more content past
        it (see buildEdgeFadeMask), tracked via scroll/resize/content-size
        listeners. Each tab still scrolls itself into view on click, so
        selecting a currently-hidden tab always brings it fully into frame.
      */}
      {/*
        QA fix (root-caused via live DOM inspection): buttons used to be
        `shrink-0` — fixed to their own content width — inside a flex row
        that was narrower than their combined width at ordinary desktop
        sizes (~656px of tabs in a ~412px container), so most of the strip
        silently overflowed behind the fade/scroll mask instead of ever
        being visibly "misaligned". The reference terminal instead divides
        the full strip width evenly across every tab. `flex-1` (no
        shrink-0) does the same: all tabs fill the row and compress
        together as one, so nothing overflows at normal widths. A
        `min-w` floor plus the existing tab-scroll/fade mechanism still
        kicks in as a fallback once the strip genuinely can't fit even at
        the floor (very narrow mobile), so nothing here was removed —
        just no longer the *first* thing that engages.
      */}
      <div
        ref={tabStripRef}
        className="tab-scroll flex gap-1 border-b border-foreground/8 pb-2"
        style={{
          maskImage: edgeFadeMask,
          WebkitMaskImage: edgeFadeMask,
        }}
        role="tablist"
      >
        {TABS.map((t) => {
          const active = t === tab;
          const Icon = TAB_ICONS[t];
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={(e) => {
                selectTab(t);
                e.currentTarget.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
              }}
              // Design-audit fix: a saturated primary-blue fill on the active
              // tab read as "generic web app" rather than "institutional
              // terminal" next to the reference's restrained neutral-chip
              // treatment. Softened to an elevated neutral surface (white-
              // tinted background + a hairline ring + a soft shadow — a
              // "pressed button" look) instead of a bright color fill,
              // while keeping every existing behavior (scroll-into-view,
              // fade mask, index-aware tab logic) completely untouched.
              className={`flex min-w-[68px] flex-1 flex-col items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-white/10 text-foreground shadow-sm ring-1 ring-white/10"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="truncate">{t}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {visitedTabs.has("Income") && (
          <div className={tab === "Income" ? undefined : "hidden"}>
            <IncomeStatementPanel
              income={income}
              cashFlow={cashFlow}
              incomeQuarterly={incomeQuarterly}
              cashFlowQuarterly={cashFlowQuarterly}
              currency={reportingCurrency}
            />
          </div>
        )}
        {visitedTabs.has("Balance") && (
          <div className={tab === "Balance" ? undefined : "hidden"}>
            <BalanceSheetPanel balance={balance} balanceQuarterly={balanceQuarterly} currency={reportingCurrency} />
          </div>
        )}
        {visitedTabs.has("Cash Flow") && (
          <div className={tab === "Cash Flow" ? undefined : "hidden"}>
            <CashFlowPanel cashFlow={cashFlow} cashFlowQuarterly={cashFlowQuarterly} currency={reportingCurrency} />
          </div>
        )}
        {visitedTabs.has("Estimates") && (
          <div className={tab === "Estimates" ? undefined : "hidden"}>
            <EstimatesPanel estimates={estimates} currency={reportingCurrency} quote={quote} priceTargets={priceTargets} />
          </div>
        )}
        {visitedTabs.has("Compare") && (
          <div className={tab === "Compare" ? undefined : "hidden"}>
            <ComparePanel initialSymbol={quote.symbol} />
          </div>
        )}
        {visitedTabs.has("Score") && (
          <div className={tab === "Score" ? undefined : "hidden"}>
            <ScorePanel
              income={income}
              balance={balance}
              cashFlow={cashFlow}
              metrics={metrics}
              currency={reportingCurrency}
              history={history}
              quotePrice={quote.price}
              quoteCurrency={quote.currency}
            />
          </div>
        )}
        {visitedTabs.has("Valuation") && latestIncome && (
          <div className={tab === "Valuation" ? undefined : "hidden"}>
            <ValuationCalculator
              baseRevenue={latestIncome.totalRevenue}
              sharesOutstanding={latestIncome.sharesOutstandingDiluted}
              currentNetMargin={metrics.margins.netIncomeMargin}
              currentPE={metrics.financials.peRatio}
              currentPrice={quote.price != null ? toDisplayUnit(quote.price, quote.currency) : null}
              marketCap={quote.marketCap != null ? toDisplayUnit(quote.marketCap, quote.currency) : null}
              reportingCurrency={reportingCurrency}
              quoteCurrency={quote.currency}
            />
          </div>
        )}
        {visitedTabs.has("AI Insights") && (
          <div className={tab === "AI Insights" ? undefined : "hidden"}>
            <AIInsightsPanel
              income={income}
              balance={balance}
              cashFlow={cashFlow}
              estimates={estimates}
              metrics={metrics}
              currency={reportingCurrency}
            />
          </div>
        )}
        {visitedTabs.has("Ratios") && (
          <div className={tab === "Ratios" ? undefined : "hidden"}>
            <RatiosPanel income={income} balance={balance} metrics={metrics} />
          </div>
        )}
      </div>
    </div>
  );
}
