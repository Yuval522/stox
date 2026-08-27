"use client";

import { useMemo, useState } from "react";
import {
  filterByRange,
  splitTrailingRow,
  toYoY,
  type ChartRange,
  type ChartType,
  type ChartView,
} from "./chart-transform";

export interface ChartControlsState<T extends { fiscalYear: string }> {
  chartType: ChartType;
  setChartType: (type: ChartType) => void;
  /** Whether real quarterly data exists for this series — feeds ChartControls' quarterlyAvailable prop. */
  quarterlyAvailable: boolean;
  range: ChartRange;
  setRange: (range: ChartRange) => void;
  view: ChartView;
  setView: (view: ChartView) => void;
  /** The active (annual or quarterly, per `chartType`) dataset with any TTM/MRQ trailing row removed, unfiltered by range — feeds totalYears and SourceAttributionBadge. */
  historical: T[];
  /**
   * `historical` sliced by the current Select Range, with the trailing
   * TTM/MRQ row (if present) always re-appended — this is what the chart
   * should render for Absolute or % of Revenue view. Do NOT feed this
   * directly into toYoY for the YoY view — it's already range-restricted,
   * so the earliest visible period(s) would lose their prior-year
   * comparator purely because that comparator fell outside this slice. Use
   * yoy() below instead.
   */
  ranged: T[];
  /** Total real fiscal periods (in years) available for the active chart type — feeds ChartControls' getAvailableRanges. */
  totalYears: number;
  /**
   * Applies THIS card's own chartType/range selection to a different
   * same-shaped dataset. Exists for cards that combine two statements into
   * one view (e.g. Rule of 40 needs both Income and Cash Flow filtered
   * identically) without pulling in a second independent control set —
   * the two series move together because one card's state drives both,
   * not because state is shared across cards.
   */
  rangeOther<U extends { fiscalYear: string }>(otherAnnual: U[], otherQuarterly?: U[]): U[];
  /**
   * The correct way to get YoY data for this card's active dataset: runs
   * toYoY() over the FULL historical series (+ trailing row) — never just
   * `ranged` — so every period has a genuine shot at finding its
   * prior-year comparator, then applies this hook's own current Select
   * Range to the RESULT. See toYoY's doc comment (chart-transform.ts) for
   * why computing YoY before range-restricting, rather than after, is the
   * part that actually matters — the earliest bars in any restricted
   * range would otherwise be dropped or wrong. Same pattern RuleOf40Card
   * (IncomeStatementPanel.tsx) already used by hand before this existed as
   * a shared method.
   */
  yoy(keys: (keyof T)[]): T[];
  /**
   * Resets chartType/range/view back to this hook's own initial defaults
   * (Annually / the same "5 years, or All if fewer" rule the initial
   * range picks / Absolute) — see the module-level doc comment below for
   * why every ChartCard consumer calls this specifically when its
   * fullscreen modal CLOSES, not on every render or on open.
   */
  reset(): void;
}

// QA fix (live report: preview cards on the stock page "still render bars
// that are way too thin and sparse" even after widening barSize/reducing
// barCategoryGap): defaulting to "All" here means a ticker with deep SEC
// EDGAR history (e.g. a filer going back ~19 fiscal years) crams every
// single year into a ~500px-wide, non-fullscreen preview card by default —
// no barSize/maxBarSize value can make 19 bars look "wide and dense" in
// that little space; the category count itself is the real constraint, not
// the per-bar pixel settings. Defaulting to a 5-year window instead
// (falling back to "All" when the ticker genuinely has 5 years or fewer, so
// this never picks a range that would be a silent no-op — same threshold
// getAvailableRanges already uses to hide redundant options) matches how
// professional terminals typically treat a compact widget preview vs. its
// own expanded/fullscreen view: recent-window by default, full history one
// click away via this exact same Select Range control.
//
// Pulled out to a standalone function (rather than inlined in the useState
// lazy-initializer below) so reset() can recompute the exact same default
// instead of drifting from it.
function computeDefaultRange<T extends { fiscalYear: string }>(annualData: T[]): ChartRange {
  const approxYears = splitTrailingRow(annualData).historical.length;
  return approxYears > 5 ? 5 : "All";
}

/**
 * Self-contained Select Range / View / Chart Type state for a single chart
 * card. Each call to this hook creates its own independent useState —
 * mounting it once per ChartCard (rather than once per panel, shared
 * across every card) is what makes changing one chart's controls leave
 * every other chart's controls untouched. See splitTrailingRow/
 * filterByRange in chart-transform.ts for what this builds on.
 *
 * QA fix (live report: setting a fullscreen modal's Select Range to "20
 * Years" — or changing its View/Chart Type — silently carried over to that
 * same card's own compact preview after closing the modal, and was still
 * sitting there the next time the modal was reopened): this hook was
 * always correctly ISOLATED per card (see the bug fix note on
 * ChartControlsState.rangeOther and every ChartCard consumer's own doc
 * comment) — the preview and the fullscreen modal were never each other's
 * problem. The actual bug is that both views render from this SAME
 * useState triple, on the SAME mounted component instance, whether
 * fullscreen or not — ChartCard's `fullscreen` prop only changes layout/
 * portal rendering (see ChartCard.tsx), it doesn't remount anything, so
 * whatever the user last set while the modal was open simply stays set
 * once it's closed, because nothing ever told it to go back. `reset()`
 * exists so every ChartCard consumer can explicitly return to a known,
 * predictable default the moment its modal closes (see each panel's
 * onToggleFullscreen wiring) — the compact preview goes back to showing
 * its own default window, and reopening the modal starts from that same
 * default every time, instead of wherever the user left it.
 */
export function useChartControls<T extends { fiscalYear: string }>(
  annualData: T[],
  quarterlyData: T[] = []
): ChartControlsState<T> {
  const [chartType, setChartType] = useState<ChartType>("annually");
  const quarterlyAvailable = quarterlyData.length > 0;
  const activeData = chartType === "quarterly" ? quarterlyData : annualData;
  const periodsPerYear = chartType === "quarterly" ? 4 : 1;

  const [range, setRange] = useState<ChartRange>(() => computeDefaultRange(annualData));
  const [view, setView] = useState<ChartView>("absolute");

  function reset() {
    setChartType("annually");
    setRange(computeDefaultRange(annualData));
    setView("absolute");
  }

  const { historical, trailing } = useMemo(() => splitTrailingRow(activeData), [activeData]);
  const ranged = useMemo(() => {
    const base = filterByRange(historical, range, periodsPerYear);
    return trailing ? [...base, trailing] : base;
  }, [historical, trailing, range, periodsPerYear]);

  function rangeOther<U extends { fiscalYear: string }>(otherAnnual: U[], otherQuarterly: U[] = []): U[] {
    const otherActive = chartType === "quarterly" ? otherQuarterly : otherAnnual;
    const { historical: otherHistorical, trailing: otherTrailing } = splitTrailingRow(otherActive);
    const base = filterByRange(otherHistorical, range, periodsPerYear);
    return otherTrailing ? [...base, otherTrailing] : base;
  }

  function yoy(keys: (keyof T)[]): T[] {
    const full = trailing ? [...historical, trailing] : historical;
    const { historical: yoyHistorical, trailing: yoyTrailing } = splitTrailingRow(toYoY(full, keys));
    const base = filterByRange(yoyHistorical, range, periodsPerYear);
    return yoyTrailing ? [...base, yoyTrailing] : base;
  }

  const totalYears = chartType === "quarterly" ? Math.floor(historical.length / 4) : historical.length;

  return {
    chartType,
    setChartType,
    quarterlyAvailable,
    range,
    setRange,
    view,
    setView,
    historical,
    ranged,
    totalYears,
    rangeOther,
    yoy,
    reset,
  };
}
