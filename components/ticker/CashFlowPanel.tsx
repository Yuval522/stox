"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CashFlowYear } from "@/lib/finance/types";
import { CHART_COLORS, CHART_TOOLTIP_WRAPPER_STYLE, compactAxis, shouldFlipTooltip } from "@/lib/format/chart";
import { splitTrailingRow, toPctOfRevenue, type ChartView } from "@/lib/finance/chart-transform";
import { useChartControls } from "@/lib/finance/useChartControls";
import { ChartCard } from "./ChartCard";
import { ChartControls } from "./ChartControls";
import { MetricFilterControl, type MetricFilterOption } from "./MetricFilterControl";
import { SourceAttributionBadge } from "./SourceAttributionBadge";

interface CashFlowPanelProps {
  cashFlow: CashFlowYear[];
  /** Quarterly counterpart (SEC 10-Q / Yahoo / FMP) — see FundamentalsBundle
   *  in lib/finance/types.ts. Empty/omitted disables Chart Type: Quarterly. */
  cashFlowQuarterly?: CashFlowYear[];
  currency: string;
}

const { success: SUCCESS, primary: PRIMARY, amber: AMBER, destructive: DESTRUCTIVE, sky: SKY } = CHART_COLORS;

interface CashFlowTooltipPayloadEntry {
  dataKey: string;
  name: string;
  value: number;
  color: string;
}

interface CashFlowTooltipProps {
  active?: boolean;
  label?: string;
  payload?: CashFlowTooltipPayloadEntry[];
  currency: string;
  view: ChartView;
  /** Chart's own fiscalYear-keyed rows — used only to compute whether the
   *  hovered bar is near the end of the series (see shouldFlipTooltip). */
  data: { fiscalYear: string }[];
}

/**
 * Rich floating glass-card tooltip (Phase 5 spec) — shows the exact dollar
 * figure for every series at the hovered fiscal year, not just the
 * compact-axis rounded value shown on the bars themselves. Typed against a
 * minimal local shape rather than recharts' own TooltipProps generic,
 * which doesn't consistently expose `payload`/`label` on the props object
 * recharts actually clones onto a custom `content` element at runtime.
 *
 * QA fix (mobile screenshot: tooltip clipped off the right edge on a
 * rightmost bar) — flips to grow left of the cursor via shouldFlipTooltip()
 * once the hovered bar is near the end of the series; see that helper in
 * lib/format/chart.ts for the full root-cause writeup.
 *
 * The Stock-Based Comp row gets an explicit "(shown as a cost impact)"
 * note in Absolute view — see negateSbcForDisplay's doc comment above —
 * so a negative-looking dollar figure here is never mistaken for a claim
 * that SBC is a literal cash outflow; it isn't, and nowhere else in this
 * app's data model treats it as one.
 */
function CashFlowTooltip({ active, payload, label, currency, view, data }: CashFlowTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const flip = shouldFlipTooltip(label, data);
  return (
    <div
      className="glass-card min-w-[220px] rounded-lg border !border-solid p-3 shadow-xl"
      style={{ transform: flip ? "translateX(-100%)" : undefined }}
    >
      <p className="mb-2 font-mono text-xs font-semibold text-foreground">{label}</p>
      <div className="space-y-1.5">
        {payload.map((entry) => (
          <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
              {entry.name}
              {entry.dataKey === "stockBasedCompensation" && view === "absolute" ? " (shown as a cost impact)" : ""}
            </span>
            <span className="font-mono font-medium text-foreground">
              {view === "yoy"
                ? `${entry.value >= 0 ? "+" : ""}${entry.value.toFixed(1)}%`
                : view === "pctOfRevenue"
                  ? `${entry.value.toFixed(1)}%`
                  : `${typeof entry.value === "number" ? entry.value.toLocaleString("en-US") : entry.value} ${currency}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface MultiMetricCardProps {
  id: string;
  title: string;
  subtitle: string;
  className?: string;
  cashFlow: CashFlowYear[];
  cashFlowQuarterly: CashFlowYear[];
  options: MetricFilterOption[];
  currency: string;
  barSize?: number;
  maxBarSize?: number;
  /** Offers "As a % of Revenue" as a third View option — see
   *  ChartControls' showPctOfRevenue doc comment. Only meaningful when
   *  every series here is naturally a portion of revenue; requires
   *  CashFlowYear.totalRevenue (backfilled post-merge — see
   *  backfillCashFlowRevenue in aggregate.ts) to actually be present for
   *  this symbol's periods, same graceful "0%" degradation as any other
   *  toPctOfRevenue consumer when it isn't. */
  showPctOfRevenue?: boolean;
  expanded: string | null;
  onToggle: (id: string) => void;
}

/**
 * Display-only sign flip for Stock-Based Comp in this ONE chart's Absolute
 * (dollar) view, so its bar renders downward next to CapEx instead of
 * upward — a user-requested visual grouping, NOT an accounting claim.
 *
 * IMPORTANT: Stock-Based Compensation is not a real cash outflow — it's a
 * non-cash expense added BACK to Operating Cash Flow precisely because no
 * cash actually leaves the company for it, which is why
 * CashFlowYear.stockBasedCompensation is documented and normalized as a
 * positive figure everywhere else in this app (normalizeStockBasedComp in
 * aggregate.ts; the FCF formula; SBC-as-%-of-revenue in insights.ts and
 * this same panel's own "% of Revenue" view, which deliberately does NOT
 * go through this function — see the call site below). Negating it in the
 * shared CashFlowYear data model would silently corrupt every one of
 * those. This function only ever runs on a throwaway COPY of the data
 * built just for this Bar chart's render, immediately after
 * useChartControls' `ranged` — the canonical `cashFlow`/`cashFlowQuarterly`
 * arrays this component receives as props are never touched.
 *
 * CashFlowTooltip below shows an explicit "(shown as a cost impact)" note
 * on this row specifically, so hovering never reads as "SBC was actually
 * negative in the cash flow statement."
 */
function negateSbcForDisplay(data: CashFlowYear[]): CashFlowYear[] {
  return data.map((row) =>
    row.stockBasedCompensation === 0 ? row : { ...row, stockBasedCompensation: -row.stockBasedCompensation }
  );
}

/**
 * Bug fix ("changing a control in one chart modal changes every other
 * chart"): the two Cash Flow charts used to share one panel-level
 * `range`/`view`/`chartType` triple, so touching any control on either card
 * moved both at once. useChartControls() — plus this card's own Filter
 * Metrics `visible` state — is mounted HERE, once per card instance,
 * giving each chart fully independent state. Same fix pattern as
 * IncomeStatementPanel's MetricCard / BalanceSheetPanel's MultiMetricCard.
 */
function MultiMetricCard({
  id,
  title,
  subtitle,
  className,
  cashFlow,
  cashFlowQuarterly,
  options,
  currency,
  // QA fix (reference-terminal density audit — see IncomeStatementPanel.tsx's
  // matching comment): widened from 28/38. Multi-series cards (2-4 bars per
  // category here) can't go as wide as the single-metric Income charts
  // without bars touching, so the bump is proportionally smaller.
  barSize = 36,
  maxBarSize = 48,
  showPctOfRevenue = false,
  expanded,
  onToggle,
}: MultiMetricCardProps) {
  const controls = useChartControls(cashFlow, cashFlowQuarterly);
  const [visible, setVisible] = useState<Set<string>>(() => new Set(options.map((o) => o.key)));
  const toggleVisible = (key: string) =>
    setVisible((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const keys = options.map((o) => o.key) as (keyof CashFlowYear)[];
  const data =
    controls.view === "yoy"
      ? controls.yoy(keys)
      : controls.view === "pctOfRevenue" && showPctOfRevenue
        ? toPctOfRevenue(controls.ranged, keys, "totalRevenue")
        // Display-only sign flip for Stock-Based Comp in the Absolute
        // (dollar) view — see negateSbcForDisplay's doc comment just below
        // this component for why this happens HERE, at render time, rather
        // than in the underlying CashFlowYear data.
        : negateSbcForDisplay(controls.ranged);
  const axisFormatter = controls.view === "yoy" || controls.view === "pctOfRevenue" ? (v: number) => `${v}%` : compactAxis;

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      className={className}
      fullscreen={expanded === id}
      // QA fix (global chart state reset): see useChartControls' reset()
      // doc comment — resets range/view/chartType back to defaults only
      // when this modal is CLOSING (expanded === id still reads "currently
      // open" at the moment this fires), never when opening.
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
          showPctOfRevenue={showPctOfRevenue}
          totalYears={controls.totalYears}
          chartType={controls.chartType}
          onChartTypeChange={controls.setChartType}
          quarterlyAvailable={controls.quarterlyAvailable}
          filterMetrics={<MetricFilterControl options={options} visible={visible} onToggle={toggleVisible} />}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap="10%">
          <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
          {/* QA fix: explicit type="category" — see IncomeStatementPanel.tsx's matching comment. */}
          <XAxis dataKey="fiscalYear" type="category" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} tickFormatter={axisFormatter} />
          <Tooltip
            content={<CashFlowTooltip currency={currency} view={controls.view} data={data} />}
            wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
            cursor={{ fill: "rgba(148,163,184,0.06)" }}
            allowEscapeViewBox={{ x: true, y: true }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {options.map(
            (opt) =>
              visible.has(opt.key) && (
                <Bar
                  key={opt.key}
                  dataKey={opt.key}
                  name={opt.label}
                  fill={opt.color}
                  radius={[4, 4, 0, 0]}
                  animationDuration={600}
                  barSize={barSize}
                  maxBarSize={maxBarSize}
                />
              )
          )}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

const BREAKDOWN_OPTIONS: MetricFilterOption[] = [
  { key: "operatingCashFlow", label: "Operating Cash Flow", color: PRIMARY },
  { key: "freeCashFlow", label: "Free Cash Flow", color: SUCCESS },
  { key: "stockBasedCompensation", label: "Stock-Based Comp", color: AMBER },
  { key: "capitalExpenditures", label: "CapEx", color: DESTRUCTIVE },
];

const QUALITY_OPTIONS: MetricFilterOption[] = [
  { key: "operatingCashFlow", label: "Operating Cash Flow", color: SKY },
  { key: "netIncome", label: "Net Income", color: PRIMARY },
];

export function CashFlowPanel({ cashFlow, cashFlowQuarterly = [], currency }: CashFlowPanelProps) {
  // Only tracks which single card is fullscreen at a time — a UI/layout
  // concern, not chart data state (see MultiMetricCard's doc comment).
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  // Panel-level source-attribution caption always reflects the full annual
  // dataset, independent of any individual card's own Chart Type selection.
  const { historical: cashFlowHistoricalAnnual } = useMemo(() => splitTrailingRow(cashFlow), [cashFlow]);

  return (
    <div className="space-y-2">
      <SourceAttributionBadge years={cashFlowHistoricalAnnual} />
      {/* QA fix: auto-fit/minmax instead of a viewport breakpoint — see the
          matching comment in IncomeStatementPanel.tsx for the root cause. */}
      <div className="grid min-w-0 gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        <MultiMetricCard
          id="breakdown"
          title="Cash Flow Breakdown"
          subtitle="Operating CF, Free CF, Stock-Based Comp, CapEx"
          className="xl:col-span-2"
          cashFlow={cashFlow}
          cashFlowQuarterly={cashFlowQuarterly}
          options={BREAKDOWN_OPTIONS}
          currency={currency}
          showPctOfRevenue
          expanded={expanded}
          onToggle={toggle}
        />

        <MultiMetricCard
          id="quality"
          title="Earnings Quality"
          subtitle="Operating Cash Flow vs Net Income"
          cashFlow={cashFlow}
          cashFlowQuarterly={cashFlowQuarterly}
          options={QUALITY_OPTIONS}
          currency={currency}
          barSize={52}
          maxBarSize={68}
          expanded={expanded}
          onToggle={toggle}
        />
      </div>
    </div>
  );
}
