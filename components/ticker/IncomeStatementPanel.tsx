"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CashFlowYear, IncomeStatementYear } from "@/lib/finance/types";
import { CHART_COLORS, CHART_TOOLTIP_WRAPPER_STYLE, compactAxis } from "@/lib/format/chart";
import { computeAverage, priorPeriodLabel, splitTrailingRow, toPctOfRevenue, type ChartView } from "@/lib/finance/chart-transform";
import { useChartControls } from "@/lib/finance/useChartControls";
import { ChartTooltip } from "./ChartTooltip";
import { SourceAttributionBadge } from "./SourceAttributionBadge";
import { ChartCard } from "./ChartCard";
import { ChartControls } from "./ChartControls";

interface IncomeStatementPanelProps {
  income: IncomeStatementYear[];
  cashFlow: CashFlowYear[];
  /** Quarterly counterparts (SEC 10-Q / Yahoo / FMP) — see FundamentalsBundle
   *  in lib/finance/types.ts. Empty/omitted means Chart Type: Quarterly is
   *  disabled for this symbol (see ChartControls' quarterlyAvailable prop). */
  incomeQuarterly?: IncomeStatementYear[];
  cashFlowQuarterly?: CashFlowYear[];
  currency: string;
}

const { success: SUCCESS, amber: AMBER, slate: SLATE, destructive: DESTRUCTIVE, sky: SKY, contrast: CONTRAST } = CHART_COLORS;

interface SingleMetricTooltipProps {
  active?: boolean;
  label?: string;
  payload?: { value: number }[];
  data: { fiscalYear: string }[];
  dataKey: string;
  entryLabel: string;
  color: string;
  formatValue: (value: number) => string;
}

/**
 * Passed as a JSX element (not a function) to `content` — same convention
 * as CashFlowPanel's CashFlowTooltip, whose doc comment explains why:
 * recharts clones this element at runtime, injecting active/label/payload,
 * and typing it against recharts' own strict TooltipContentProps function
 * signature (rather than this element-clone path) produces unresolvable
 * ContentType assignability errors for no behavioral benefit.
 */
function SingleMetricTooltip({ active, label, payload, data, dataKey, entryLabel, color, formatValue }: SingleMetricTooltipProps) {
  return (
    <ChartTooltip
      active={active}
      label={label}
      data={data}
      entries={
        payload && payload.length > 0
          ? [{ key: dataKey, label: entryLabel, value: formatValue(Number(payload[0].value)), color }]
          : []
      }
    />
  );
}

interface RuleOf40TooltipProps {
  active?: boolean;
  label?: string;
  payload?: { value: number; payload?: { usedFcf?: boolean } }[];
  data: { fiscalYear: string }[];
}

function RuleOf40Tooltip({ active, label, payload, data }: RuleOf40TooltipProps) {
  return (
    <ChartTooltip
      active={active}
      label={label}
      data={data}
      entries={
        payload && payload.length > 0
          ? [
              {
                key: "ruleOf40",
                label: "Rule of 40",
                value: `${Number(payload[0].value).toFixed(1)}%${payload[0].payload?.usedFcf ? "" : " (op. margin proxy)"}`,
              },
            ]
          : []
      }
    />
  );
}

/** Single-series bar chart used for every card in this 8-chart grid — the
 * reference dashboard shows one metric per card rather than grouped pairs
 * (Phase 5 explicitly split what used to be two combined "Gross Profit &
 * Operating Income" / "Net Income & EPS" charts into standalone cards). */
function SingleMetricChart<T extends { fiscalYear: string }>({
  data,
  dataKey,
  color,
  valueLabel,
  formatValue,
  colorByValue,
  view = "absolute",
  emptyStateMessage,
  showAverage,
}: {
  data: T[];
  dataKey: keyof T & string;
  color: string;
  valueLabel: string;
  formatValue: (value: number) => string;
  /** When set, bars render green/red by sign instead of a flat color. */
  colorByValue?: boolean;
  /** QA feature (fullscreen chart controls): in YoY mode the underlying
   *  `data` has already been converted to % change by the caller — this
   *  only controls display (percent formatting + always color-by-sign,
   *  since a "how much did this grow" chart reads better colored by
   *  growth direction regardless of what the caller normally does). */
  view?: ChartView;
  /**
   * QA fix (live report: "Dividends Per Share" rendered a broken-looking
   * 0-4 axis with every bar invisible for a stock that's never paid a
   * dividend — every fiscal year's real value is a genuine 0, not missing
   * data, so the chart had something to plot, it just had nothing to SHOW:
   * a bar chart where every bar is exactly 0 tall reads as an empty/broken
   * chart, not as "this company doesn't pay dividends"). When every value
   * for `dataKey` across `data` is exactly 0, this replaces the chart with
   * a plain-language message instead. Optional — only metrics where a
   * flat-0 series is a normal, expected outcome (dividends today; kept
   * generic rather than hardcoded to just that one card, in case a future
   * metric has the same shape) should pass this; omitting it preserves the
   * original always-render-the-chart behavior for every other card.
   */
  emptyStateMessage?: string;
  /**
   * Reusable "dynamic average" dashed ReferenceLine, opt-in per card (see
   * IncomeStatementPanel's Operating Income MetricCard usage). Computed via
   * computeAverage() (chart-transform.ts) over exactly `data` — i.e. the
   * array actually being rendered as bars — so it automatically reflects
   * the current Select Range, View (Absolute/YoY/% of Revenue), and Chart
   * Type (Annually/Quarterly) selections without this component needing to
   * know about any of them: change any control, `data` changes, the
   * average recomputes. Formatted through the same `effectiveFormat` the
   * tooltip already uses, so a % view shows a %-formatted average and an
   * Absolute view shows a currency-formatted one automatically. Same
   * pattern RuleOf40Card (below) uses for its own average line, just
   * applied here so any other single-metric card can flip it on later.
   * MetricCard is responsible for only passing `true` while its own
   * fullscreen modal is open (see MetricCard's `isFullscreen` — QA fix:
   * the line/label used to show on the compact home/dashboard preview card
   * too, cluttering a card meant to be a quick-glance summary) — this
   * component itself has no opinion on fullscreen-ness, it just renders
   * whatever it's told.
   */
  showAverage?: boolean;
}) {
  const isPercentView = view === "yoy" || view === "pctOfRevenue";
  const effectiveFormat = isPercentView ? (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : formatValue;
  const effectiveLabel =
    view === "yoy" ? `${valueLabel} (YoY)` : view === "pctOfRevenue" ? `${valueLabel} (% of Revenue)` : valueLabel;
  const effectiveColorByValue = view === "yoy" ? true : colorByValue;
  const average = showAverage ? computeAverage(data, dataKey) : null;

  if (emptyStateMessage && data.length > 0 && data.every((row) => Number(row[dataKey]) === 0)) {
    return (
      <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
        {emptyStateMessage}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* QA fix (reference-terminal density audit): bars read as "thin and
          sparse" next to the reference screenshots even where every year had
          real data — barCategoryGap 12% -> 8% shrinks the gap between
          category bands, and the barSize/maxBarSize bump below raises the
          bar's own upper-bound width, together letting a single-bar-per-
          category chart like this one fill noticeably more of its band. */}
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap="8%">
        <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
        {/* QA fix: explicit type="category" — this was already Recharts'
            default for XAxis, but the reported "bars bunched left with
            dead space" symptom matches what happens under a *numeric*
            scale (which this never was), so making it explicit removes
            any doubt and any risk from a future Recharts default change. */}
        <XAxis dataKey="fiscalYear" type="category" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} />
        <YAxis
          stroke="#64748b"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={isPercentView ? (v: number) => `${v}%` : compactAxis}
        />
        {/* QA fix (mobile screenshot: tooltip clipped off the right edge on
            the "2026" bar) — custom `content` swaps in ChartTooltip, which
            flips the box to grow left of the cursor once the hovered bar is
            near the end of the series. See shouldFlipTooltip() in
            lib/format/chart.ts for the full root-cause writeup. */}
        <Tooltip
          content={
            <SingleMetricTooltip data={data} dataKey={dataKey} entryLabel={effectiveLabel} color={color} formatValue={effectiveFormat} />
          }
          wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
          allowEscapeViewBox={{ x: true, y: true }}
        />
        {/* See SingleMetricChart's showAverage doc comment above — recomputed
            from `data` on every render, so it moves with Select Range/View/
            Chart Type exactly like the bars themselves. */}
        {average != null && (
          <ReferenceLine
            y={average}
            stroke={CONTRAST}
            strokeDasharray="4 4"
            label={{ value: effectiveFormat(average), position: "top", fill: CONTRAST, fontSize: 11, fontWeight: 600 }}
          />
        )}
        {/* Recharts' TypedDataKey inference can't resolve a plain `keyof T`
            string against an abstract, unconstrained generic T inside this
            wrapper (works fine for concrete types, breaks for generics) —
            passing an accessor function sidesteps that branch entirely.
            QA fix (bar-width audit): no barSize cap meant bars scaled up to
            fill the available category band, which balloons to 100px+ when
            few categories are shown (e.g. a 3-year YoY slice) — barSize/
            maxBarSize keeps bars a sane, consistent width regardless of how
            many fiscal years are plotted. Widened further (48/60 -> 64/84,
            paired with barCategoryGap 20% -> 12% above) per a side-by-side
            comparison against the reference terminal's single-metric charts,
            whose bars fill noticeably more of each category band than ours
            did. */}
        <Bar
          dataKey={(row: T) => Number(row[dataKey])}
          radius={[4, 4, 0, 0]}
          animationDuration={600}
          fill={color}
          barSize={72}
          maxBarSize={96}
        >
          {effectiveColorByValue &&
            data.map((row, idx) => (
              <Cell key={idx} fill={Number(row[dataKey]) >= 0 ? SUCCESS : DESTRUCTIVE} />
            ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

interface MetricCardProps {
  id: string;
  title: string;
  subtitle?: string;
  income: IncomeStatementYear[];
  incomeQuarterly: IncomeStatementYear[];
  dataKey: keyof IncomeStatementYear;
  color: string;
  valueLabel: string;
  formatValue: (value: number) => string;
  /** Also offers "As a % of Revenue" as a View option — only meaningful for margin-style metrics (Gross Profit, Operating Income, Net Income). */
  allowPctOfRevenue?: boolean;
  /**
   * Bug fix (live report: "Shares Outstanding Diluted" showed "TTM" as its
   * final bar label, but a diluted share count is a point-in-time snapshot,
   * not a rolling 12-month sum — that label is reserved for genuine flow
   * metrics like Revenue/Net Income). The underlying VALUE was already
   * correct (toTrailingIncomeRow / computeTrailingTwelveMonths's
   * `latestKeys` both use the single latest quarter's actual share count,
   * never a sum across 4 quarters) — only the displayed label was wrong,
   * because it physically lives inside the Income Statement's one shared
   * trailing row (see splitTrailingRow in chart-transform.ts) alongside
   * real flow metrics. Set this for any Income Statement metric that's a
   * snapshot/count rather than a flow, to relabel just that card's own
   * trailing bar to "MRQ" — matching how Balance Sheet's trailing row is
   * already labeled "MRQ" (see the MRQ appendix in getFundamentals(),
   * yahoo.ts), without touching the shared `income` array or any other
   * card reading from it (each MetricCard has its own independent
   * useChartControls copy — see that hook's doc comment).
   */
  pointInTime?: boolean;
  /** See SingleMetricChart's emptyStateMessage doc comment — passed through unchanged. */
  emptyStateMessage?: string;
  /** See SingleMetricChart's showAverage doc comment — passed through unchanged. */
  showAverage?: boolean;
  expanded: string | null;
  onToggle: (id: string) => void;
}

/**
 * Bug fix ("changing a control in one chart modal changes every other
 * chart"): each metric card used to read `range`/`view`/`chartType` off
 * ONE state triple owned by the whole panel, so every ChartCard rendered
 * the exact same slice of data regardless of which card the user was
 * actually looking at. Mounting useChartControls() HERE — once per
 * MetricCard instance, not once per panel — gives every card its own
 * independent useState triple. Two cards showing "Total Revenues" and
 * "Gross Profit" now happen to start out looking similar (same default
 * Select Range/View/Chart Type), not because they share state, but
 * because they were independently initialized to the same defaults.
 */
function MetricCard({
  id,
  title,
  subtitle,
  income,
  incomeQuarterly,
  dataKey,
  color,
  valueLabel,
  formatValue,
  allowPctOfRevenue = false,
  pointInTime = false,
  emptyStateMessage,
  showAverage,
  expanded,
  onToggle,
}: MetricCardProps) {
  const controls = useChartControls(income, incomeQuarterly);
  // QA fix (live report: the dashed average line/label showed on the
  // compact home/dashboard preview card too, not just the expanded modal —
  // cluttering a small card that's meant to be a quick-glance summary).
  // Gated here, at the single point every card's fullscreen-ness is
  // already known (`expanded === id` — the exact same check ChartCard's
  // own `fullscreen` prop below uses), rather than inside SingleMetricChart
  // itself, so any future showAverage-enabled card gets this behavior for
  // free instead of needing to remember to gate it individually.
  const isFullscreen = expanded === id;

  const data =
    controls.view === "yoy"
      ? controls.yoy([dataKey])
      : controls.view === "pctOfRevenue" && allowPctOfRevenue
        ? toPctOfRevenue(controls.ranged, [dataKey], "totalRevenue")
        : controls.ranged;

  // See MetricCardProps.pointInTime's doc comment — every range/view
  // transform above preserves `fiscalYear` on the trailing row untouched,
  // so relabeling here as the final step covers Absolute/YoY/%-of-Revenue
  // and any Select Range alike.
  const displayData = pointInTime
    ? data.map((row) => (row.fiscalYear === "TTM" ? { ...row, fiscalYear: "MRQ" } : row))
    : data;

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      fullscreen={expanded === id}
      // QA fix (global chart state reset): see useChartControls' reset()
      // doc comment. `expanded === id` here still reads as "currently
      // open" (same value ChartCard's own `fullscreen` prop above just
      // used) at the moment this handler fires, since React hasn't
      // re-rendered with the new `expanded` yet — so this only resets when
      // CLOSING (open -> closed), never when opening.
      onToggleFullscreen={() => {
        if (expanded === id) controls.reset();
        onToggle(id);
      }}
      controls={
        <ChartControls
          range={controls.range}
          onRangeChange={controls.setRange}
          view={controls.view}
          onViewChange={controls.setView}
          showPctOfRevenue={allowPctOfRevenue}
          totalYears={controls.totalYears}
          chartType={controls.chartType}
          onChartTypeChange={controls.setChartType}
          quarterlyAvailable={controls.quarterlyAvailable}
        />
      }
    >
      <SingleMetricChart
        data={displayData}
        dataKey={dataKey}
        color={color}
        valueLabel={valueLabel}
        formatValue={formatValue}
        view={controls.view}
        emptyStateMessage={emptyStateMessage}
        showAverage={showAverage && isFullscreen}
      />
    </ChartCard>
  );
}

interface RuleOf40CardProps {
  income: IncomeStatementYear[];
  incomeQuarterly: IncomeStatementYear[];
  cashFlow: CashFlowYear[];
  cashFlowQuarterly: CashFlowYear[];
  expanded: string | null;
  onToggle: (id: string) => void;
}

/**
 * Rule of 40 = YoY Revenue Growth % + FCF Margin % (per the Phase 5 spec).
 *
 * QA fix (live report: quarterly Rule of 40 bars swinging wildly quarter to
 * quarter, e.g. 5%-85% back and forth): this used to compute
 * "revenueGrowthPct" by diffing each row against controls.ranged's
 * PREVIOUS ARRAY ELEMENT — correct for Annual mode, where one array step
 * really is one year, but silently becoming QUARTER-over-quarter growth in
 * Quarterly mode (each element is 3 months apart, not 12), directly
 * contradicting this card's own "YoY Revenue Growth %" spec and producing
 * far noisier, seasonally-distorted numbers than the metric is supposed to
 * show. Fixed by looking up the genuine same-quarter-last-year (or
 * same-year-last-year) row by its fiscal-period LABEL via the shared
 * priorPeriodLabel() (chart-transform.ts — also what toYoY uses now, see
 * its doc comment), from the FULL unfiltered `controls.historical`
 * array rather than the range-windowed `controls.ranged` — which also
 * means a period can now show real YoY growth even when it's the very
 * first bar in the currently-selected Select Range window, as long as the
 * prior year's data was actually fetched (previously ALWAYS true dropped
 * unconditionally, real data or not).
 *
 * Falls back to Operating Margin % when a fiscal year has no matching
 * cash-flow row (e.g. a "TTM" row that fundamentalsTimeSeries doesn't
 * cover) — an EBITDA-margin proxy, since D&A isn't broken out separately
 * in this data model; surfaced in the tooltip ("op. margin proxy") so it's
 * never silently mistaken for a real FCF-based figure. No View toggle
 * (it's already an intrinsically YoY-flavored composite metric).
 *
 * Own independent useChartControls instance (income-driven); cash flow is
 * range-matched to it via rangeOther() so the two series always cover the
 * same fiscal periods for THIS card specifically, without borrowing state
 * from — or leaking state to — any other card in the panel.
 *
 * QA fix (live report: the dashed reference line always showed a static
 * "40%" regardless of the stock): the textbook SaaS "Rule of 40" benchmark
 * is a useful rule of thumb, but rendering it as if it were computed FROM
 * this stock's own data was misleading — it never moved no matter what
 * Select Range or Chart Type was chosen. The line (and its label) now show
 * this stock's own average Rule of 40 score across exactly the bars
 * currently on screen (see ruleOf40Average below, computed via
 * computeAverage() in chart-transform.ts) — the same "dynamic average
 * dashed line" pattern used by Operating Income's card (see
 * SingleMetricChart's showAverage prop), applied here by hand since this
 * card's data shape (`ruleOf40`/`usedFcf`) doesn't fit that shared
 * component. Bar coloring follows the same computed value, not a leftover
 * fixed 40, so the chart stays internally consistent.
 */
function RuleOf40Card({ income, incomeQuarterly, cashFlow, cashFlowQuarterly, expanded, onToggle }: RuleOf40CardProps) {
  const controls = useChartControls(income, incomeQuarterly);
  // QA fix (live report: the dashed average line/label showed on the
  // compact preview card too) — see MetricCard's matching isFullscreen
  // comment. Bar green/red coloring below still uses ruleOf40Average
  // regardless of this flag (only the line/label are gated), so a bar's
  // color never silently changes between the compact and expanded views.
  const isFullscreen = expanded === "ruleof40";
  const rangedCashFlow = controls.rangeOther(cashFlow, cashFlowQuarterly);
  const cashFlowByYear = new Map(rangedCashFlow.map((c) => [c.fiscalYear, c]));
  const historicalByLabel = new Map(controls.historical.map((row) => [row.fiscalYear, row]));

  const ruleOf40Data = controls.ranged
    .map((year, idx) => {
      const priorLabel = priorPeriodLabel(year.fiscalYear);
      // Genuine same-period-last-year comparator when the label maps to
      // one (every real annual/quarterly row) — pulled from the FULL
      // historical array so it's available even for the range window's
      // first displayed bar. The trailing TTM/MRQ row has no such label
      // (see priorPeriodLabel), so it keeps this card's original,
      // more approximate "vs. whatever immediately precedes it in the
      // displayed range" behavior instead — unchanged from before this
      // fix, since that row was never part of the QoQ/YoY bug to begin
      // with.
      const prevRevenue =
        priorLabel != null ? (historicalByLabel.get(priorLabel)?.totalRevenue ?? null) : (controls.ranged[idx - 1]?.totalRevenue ?? null);
      if (prevRevenue == null) return null; // no real comparator — skip rather than fabricate 0% growth
      const revenueGrowthPct = prevRevenue > 0 ? ((year.totalRevenue - prevRevenue) / prevRevenue) * 100 : 0;
      const cf = cashFlowByYear.get(year.fiscalYear);
      const marginPct =
        cf && year.totalRevenue > 0
          ? (cf.freeCashFlow / year.totalRevenue) * 100
          : year.totalRevenue > 0
            ? (year.operatingIncome / year.totalRevenue) * 100
            : 0;
      return {
        fiscalYear: year.fiscalYear,
        ruleOf40: Number((revenueGrowthPct + marginPct).toFixed(1)),
        usedFcf: Boolean(cf),
      };
    })
    .filter((row): row is { fiscalYear: string; ruleOf40: number; usedFcf: boolean } => row !== null);

  // QA fix (live report: the dashed reference line always showed a static,
  // hardcoded "40%" — the textbook SaaS "Rule of 40" benchmark, but not a
  // number this specific stock's own history has anything to do with).
  // Replaced with this stock's own average Rule of 40 score across exactly
  // the bars currently on screen — computeAverage() (chart-transform.ts)
  // over `ruleOf40Data`, so it automatically follows Select Range and Chart
  // Type (Annually/Quarterly) the same way every other card's dynamic
  // average line does (see SingleMetricChart's showAverage doc comment).
  // Bar coloring now follows the same computed threshold instead of the
  // old fixed 40, so a bar reads green/red relative to the line actually
  // drawn on the chart rather than an invisible constant.
  const ruleOf40Average = computeAverage(ruleOf40Data, "ruleOf40");

  return (
    <ChartCard
      title="Rule of 40"
      subtitle="Revenue growth % + FCF margin %"
      fullscreen={expanded === "ruleof40"}
      // QA fix (global chart state reset) — see MetricCard's matching
      // onToggleFullscreen comment above for the exact mechanism.
      onToggleFullscreen={() => {
        if (expanded === "ruleof40") controls.reset();
        onToggle("ruleof40");
      }}
      controls={
        <ChartControls
          range={controls.range}
          onRangeChange={controls.setRange}
          showView={false}
          totalYears={controls.totalYears}
          chartType={controls.chartType}
          onChartTypeChange={controls.setChartType}
          quarterlyAvailable={controls.quarterlyAvailable}
        />
      }
    >
      {ruleOf40Data.length > 0 ? (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={ruleOf40Data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap="8%">
            <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
            <XAxis dataKey="fiscalYear" type="category" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
            {isFullscreen && ruleOf40Average != null && (
              <ReferenceLine
                y={ruleOf40Average}
                stroke={CONTRAST}
                strokeDasharray="4 4"
                label={{
                  value: `Avg ${ruleOf40Average.toFixed(1)}%`,
                  position: "top",
                  fill: CONTRAST,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              />
            )}
            <Tooltip
              content={<RuleOf40Tooltip data={ruleOf40Data} />}
              wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
              allowEscapeViewBox={{ x: true, y: true }}
            />
            <Bar dataKey="ruleOf40" radius={[4, 4, 0, 0]} animationDuration={600} barSize={72} maxBarSize={96}>
              {ruleOf40Data.map((row) => (
                <Cell key={row.fiscalYear} fill={row.ruleOf40 >= (ruleOf40Average ?? 0) ? SUCCESS : DESTRUCTIVE} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Not enough history to compute YoY growth.
        </div>
      )}
    </ChartCard>
  );
}

export function IncomeStatementPanel({
  income,
  cashFlow,
  incomeQuarterly = [],
  cashFlowQuarterly = [],
  currency,
}: IncomeStatementPanelProps) {
  // Only tracks which single card is fullscreen at a time (a UI/layout
  // concern — the reference terminal never shows two modals at once) —
  // NOT chart data state, so it has no bearing on the isolation fix above.
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  const money = (v: number) => `${compactAxis(v)} ${currency}`;
  const perShare = (v: number) => `${v.toFixed(2)} ${currency}`;

  // Panel-level source-attribution caption always reflects the full annual
  // dataset, independent of any individual card's own Chart Type selection
  // (there's no longer a single panel-wide "the" chart type to read it
  // from — see the MetricCard doc comment above).
  const { historical: incomeHistoricalAnnual } = useMemo(() => splitTrailingRow(income), [income]);

  return (
    <div className="space-y-2">
      <SourceAttributionBadge years={incomeHistoricalAnnual} />
      {/* QA fix (root-caused via DOM inspection against the reference
          terminal): this used to be viewport-width breakpoints
          (sm:grid-cols-2 xl:grid-cols-4), sized off the *window's* width. But
          this grid lives in the right-hand column of a `22rem 1fr` split —
          its actual available width is often much narrower than the viewport
          implies, so at common desktop sizes it was stuck at 2 columns of
          ~200px, making every bar chart read as squished/stretched. CSS
          Grid's auto-fit + minmax sizes columns off the *container's* real
          width instead, so it self-adapts correctly regardless of the split
          — no viewport breakpoints, no container-query plugin needed. */}
      <div className="grid min-w-0 gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        <MetricCard
          id="revenue"
          title="Total Revenues"
          income={income}
          incomeQuarterly={incomeQuarterly}
          dataKey="totalRevenue"
          color={DESTRUCTIVE}
          valueLabel="Revenue"
          formatValue={money}
          expanded={expanded}
          onToggle={toggle}
        />

        <MetricCard
          id="grossprofit"
          title="Gross Profit"
          income={income}
          incomeQuarterly={incomeQuarterly}
          dataKey="grossProfit"
          color={SUCCESS}
          valueLabel="Gross Profit"
          formatValue={money}
          allowPctOfRevenue
          expanded={expanded}
          onToggle={toggle}
        />

        <MetricCard
          id="opincome"
          title="Operating Income"
          income={income}
          incomeQuarterly={incomeQuarterly}
          dataKey="operatingIncome"
          color={AMBER}
          valueLabel="Operating Income"
          formatValue={money}
          allowPctOfRevenue
          showAverage
          expanded={expanded}
          onToggle={toggle}
        />

        <MetricCard
          id="netincome"
          title="Net Income"
          income={income}
          incomeQuarterly={incomeQuarterly}
          dataKey="netIncome"
          color={SKY}
          valueLabel="Net Income"
          formatValue={money}
          allowPctOfRevenue
          expanded={expanded}
          onToggle={toggle}
        />

        <MetricCard
          id="eps"
          title="EPS (Diluted)"
          income={income}
          incomeQuarterly={incomeQuarterly}
          dataKey="eps"
          color={SUCCESS}
          valueLabel="EPS"
          formatValue={perShare}
          expanded={expanded}
          onToggle={toggle}
        />

        <MetricCard
          id="shares"
          title="Shares Outstanding (Diluted)"
          income={income}
          incomeQuarterly={incomeQuarterly}
          dataKey="sharesOutstandingDiluted"
          color={SLATE}
          valueLabel="Diluted Shares"
          formatValue={compactAxis}
          pointInTime
          expanded={expanded}
          onToggle={toggle}
        />

        <RuleOf40Card
          income={income}
          incomeQuarterly={incomeQuarterly}
          cashFlow={cashFlow}
          cashFlowQuarterly={cashFlowQuarterly}
          expanded={expanded}
          onToggle={toggle}
        />

        <MetricCard
          id="dividends"
          title="Dividends Per Share"
          income={income}
          incomeQuarterly={incomeQuarterly}
          dataKey="dividendsPerShare"
          color={AMBER}
          valueLabel="Dividends / Share"
          formatValue={perShare}
          emptyStateMessage="This company hasn't paid a dividend in the selected period."
          expanded={expanded}
          onToggle={toggle}
        />
      </div>
    </div>
  );
}
