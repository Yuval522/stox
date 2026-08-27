"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BalanceSheetYear } from "@/lib/finance/types";
import { CHART_COLORS, CHART_TOOLTIP_WRAPPER_STYLE, compactAxis } from "@/lib/format/chart";
import { splitTrailingRow } from "@/lib/finance/chart-transform";
import { useChartControls } from "@/lib/finance/useChartControls";
import { ChartCard } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { ChartControls } from "./ChartControls";
import { MetricFilterControl, type MetricFilterOption } from "./MetricFilterControl";
import { SourceAttributionBadge } from "./SourceAttributionBadge";

interface BalanceSheetPanelProps {
  balance: BalanceSheetYear[];
  /** Quarterly counterpart (SEC 10-Q / Yahoo / FMP) — see FundamentalsBundle
   *  in lib/finance/types.ts. Empty/omitted disables Chart Type: Quarterly. */
  balanceQuarterly?: BalanceSheetYear[];
  currency: string;
}

const { success: SUCCESS, primary: PRIMARY, destructive: DESTRUCTIVE, sky: SKY } = CHART_COLORS;

interface BalanceSheetTooltipProps {
  active?: boolean;
  label?: string;
  payload?: { dataKey?: string; name?: string; value: number; color?: string }[];
  data: { fiscalYear: string }[];
  formatValue: (value: unknown) => string;
}

/** Passed as a JSX element to `content` — see SingleMetricTooltip's doc
 *  comment in IncomeStatementPanel.tsx for why (same convention throughout
 *  this codebase's chart tooltips). */
function BalanceSheetTooltip({ active, label, payload, data, formatValue }: BalanceSheetTooltipProps) {
  return (
    <ChartTooltip
      active={active}
      label={label}
      data={data}
      entries={
        payload?.map((entry) => ({
          key: entry.dataKey ?? entry.name ?? "",
          label: entry.name ?? "",
          value: formatValue(entry.value),
          color: entry.color,
        })) ?? []
      }
    />
  );
}

interface MultiMetricCardProps {
  id: string;
  title: string;
  subtitle: string;
  balance: BalanceSheetYear[];
  balanceQuarterly: BalanceSheetYear[];
  options: MetricFilterOption[];
  currency: string;
  barSize?: number;
  maxBarSize?: number;
  expanded: string | null;
  onToggle: (id: string) => void;
}

/**
 * Bug fix ("changing a control in one chart modal changes every other
 * chart"): the three Balance Sheet charts used to share one panel-level
 * `range`/`view`/`chartType` triple, so touching any control on any card
 * moved all three at once. useChartControls() — plus this card's own
 * Filter Metrics `visible` state — is mounted HERE, once per card
 * instance, giving each of the three charts fully independent state.
 * Same fix pattern as IncomeStatementPanel's MetricCard.
 */
function MultiMetricCard({
  id,
  title,
  subtitle,
  balance,
  balanceQuarterly,
  options,
  currency,
  // QA fix (reference-terminal density audit — see IncomeStatementPanel.tsx's
  // matching comment): widened from 34/44. Multi-series cards (2-3 bars per
  // category here) can't go as wide as the single-metric Income charts
  // without bars touching, so the bump is proportionally smaller.
  barSize = 40,
  maxBarSize = 54,
  expanded,
  onToggle,
}: MultiMetricCardProps) {
  const controls = useChartControls(balance, balanceQuarterly);
  const [visible, setVisible] = useState<Set<string>>(() => new Set(options.map((o) => o.key)));
  const toggleVisible = (key: string) =>
    setVisible((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const keys = options.map((o) => o.key) as (keyof BalanceSheetYear)[];
  const data = controls.view === "yoy" ? controls.yoy(keys) : controls.ranged;
  const axisFormatter = controls.view === "yoy" ? (v: number) => `${v}%` : compactAxis;
  const tooltipFormatter = (value: unknown) =>
    controls.view === "yoy"
      ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(1)}%`
      : `${compactAxis(Number(value))} ${currency}`;

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
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
          {/* QA fix (mobile screenshot: tooltip clipped off the right edge on
              a rightmost bar) — custom `content` swaps in the shared
              ChartTooltip, which flips the box to grow left of the cursor
              near the end of the series. See shouldFlipTooltip() in
              lib/format/chart.ts. */}
          <Tooltip
            content={<BalanceSheetTooltip data={data} formatValue={tooltipFormatter} />}
            wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
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

const SHORT_TERM_OPTIONS: MetricFilterOption[] = [
  { key: "cashAndShortTermInvestments", label: "Cash & ST Investments", color: SUCCESS },
  { key: "totalCurrentAssets", label: "Total Current Assets", color: SKY },
  { key: "totalCurrentLiabilities", label: "Total Current Liabilities", color: DESTRUCTIVE },
];

const STRUCTURE_OPTIONS: MetricFilterOption[] = [
  { key: "totalAssets", label: "Total Assets", color: SKY },
  { key: "totalLiabilities", label: "Total Liabilities", color: DESTRUCTIVE },
  { key: "totalStockholdersEquity", label: "Stockholders' Equity", color: PRIMARY },
];

const DEBT_LIQUIDITY_OPTIONS: MetricFilterOption[] = [
  { key: "totalDebt", label: "Total Debt", color: DESTRUCTIVE },
  { key: "cashAndShortTermInvestments", label: "Cash & ST Investments", color: SUCCESS },
];

export function BalanceSheetPanel({ balance, balanceQuarterly = [], currency }: BalanceSheetPanelProps) {
  // Only tracks which single card is fullscreen at a time — a UI/layout
  // concern, not chart data state (see MultiMetricCard's doc comment).
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  // Panel-level source-attribution caption always reflects the full annual
  // dataset, independent of any individual card's own Chart Type selection.
  const { historical: balanceHistoricalAnnual } = useMemo(() => splitTrailingRow(balance), [balance]);

  return (
    <div className="space-y-2">
      <SourceAttributionBadge years={balanceHistoricalAnnual} />
      {/* Phase 5: 3-column breakdown (Short-Term Position / Total Structure /
          Debt vs Liquidity), replacing the earlier 2-chart layout.
          QA fix: auto-fit/minmax instead of a viewport breakpoint — see the
          matching comment in IncomeStatementPanel.tsx for the root cause
          (this grid's real available width is the right-hand analysis column,
          not the full viewport). */}
      <div className="grid min-w-0 gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        <MultiMetricCard
          id="short-term"
          title="Short-Term Position"
          subtitle="Cash & ST Investments vs Current Assets vs Current Liabilities"
          balance={balance}
          balanceQuarterly={balanceQuarterly}
          options={SHORT_TERM_OPTIONS}
          currency={currency}
          expanded={expanded}
          onToggle={toggle}
        />

        <MultiMetricCard
          id="structure"
          title="Total Structure"
          subtitle="Assets vs Liabilities vs Equity"
          balance={balance}
          balanceQuarterly={balanceQuarterly}
          options={STRUCTURE_OPTIONS}
          currency={currency}
          expanded={expanded}
          onToggle={toggle}
        />

        <MultiMetricCard
          id="debt-liquidity"
          title="Debt vs Liquidity"
          subtitle="Total Debt vs Cash & ST Investments"
          balance={balance}
          balanceQuarterly={balanceQuarterly}
          options={DEBT_LIQUIDITY_OPTIONS}
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
