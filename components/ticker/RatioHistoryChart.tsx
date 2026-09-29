"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  averageRatioValue,
  computeAvailableRatioHistoryRanges,
  filterRatioHistoryByRange,
  type PriceToEarningsHistoryResult,
  type RatioHistoryRange,
} from "@/lib/finance/ratioHistory";
import { CHART_COLORS, CHART_TOOLTIP_STYLE, CHART_TOOLTIP_WRAPPER_STYLE } from "@/lib/format/chart";
import { ChartCard } from "./ChartCard";

const { sky: SKY, contrast: CONTRAST } = CHART_COLORS;

const SELECT_CLASS =
  "rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none";

function formatAxisDate(date: string): string {
  // "DD/MM/YY" — matches the reference terminal's X-axis date format for this chart.
  return new Date(date).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** Same index-based boundary-flip idiom as FairValueHistoryChart's local
 *  shouldFlipHistoryTooltip / lib/format/chart.ts's shouldFlipTooltip, just
 *  matched on `date` instead of `fiscalYear` — small local variant rather
 *  than a shared cross-file dependency, same duplication convention already
 *  established by those two. */
function shouldFlipTooltip(label: string | undefined, data: { date: string }[]): boolean {
  if (!label || data.length <= 1) return false;
  const index = data.findIndex((row) => row.date === label);
  return index >= 0 && index / (data.length - 1) > 0.6;
}

interface RatioHistoryTooltipProps {
  active?: boolean;
  label?: string;
  payload?: { value: number }[];
  data: { date: string }[];
  metricLabel: string;
  formatValue: (value: number) => string;
}

/** Passed as a JSX element (not a function) to `content` — same convention every other custom Recharts tooltip in this codebase uses (see ChartTooltip.tsx's doc comment). */
function RatioHistoryTooltip({ active, label, payload, data, metricLabel, formatValue }: RatioHistoryTooltipProps) {
  if (!active || !label || !payload || payload.length === 0) return null;
  const flip = shouldFlipTooltip(label, data);
  return (
    <div style={{ ...CHART_TOOLTIP_STYLE, transform: flip ? "translateX(-100%)" : undefined }}>
      <p className="mb-1.5 font-semibold text-foreground">{new Date(label).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</p>
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: SKY }} />
          {metricLabel}
        </span>
        <span className="font-medium text-foreground">{formatValue(Number(payload[0].value))}</span>
      </div>
    </div>
  );
}

/** "5 Years" when available, else the broadest range this series actually has — same "recent-window by default, full history one click away" default useChartControls.ts's computeDefaultRange picks for the fiscal-period charts, applied here to a calendar-date-based range instead. */
function computeDefaultRange(available: RatioHistoryRange[]): RatioHistoryRange {
  return available.includes("5Y") ? "5Y" : (available[available.length - 1] ?? "All");
}

export interface RatioHistoryChartProps {
  title: string;
  subtitle?: string;
  data: PriceToEarningsHistoryResult;
  /** Defaults to a plain "x" multiple, e.g. "24.37x" — override for a differently-scaled ratio (a future P/S or P/B chart could reuse this component with its own formatter). */
  formatValue?: (value: number) => string;
}

/**
 * Continuous historical valuation-multiple line chart — Ratios tab's
 * "Valuation Ratios" section (see lib/finance/ratioHistory.ts for the
 * underlying daily P/E-over-time computation). Matches the reference
 * professional-terminal style requested: a smooth interactive line (not
 * discrete per-year bars), a Select Range control (1/3/5/10 Years or All
 * Available — only offering ranges this ticker's own price history actually
 * spans, same "don't offer a redundant option" principle as
 * chart-transform.ts's getAvailableRanges), a hover tooltip with the exact
 * date and value, and a dashed historical-average benchmark line that
 * recomputes over whichever window is currently selected.
 */
export function RatioHistoryChart({ title, subtitle, data, formatValue = (v) => `${v.toFixed(2)}x` }: RatioHistoryChartProps) {
  const availableRanges = useMemo(() => computeAvailableRatioHistoryRanges(data.points), [data.points]);
  const [range, setRange] = useState<RatioHistoryRange>(() => computeDefaultRange(availableRanges));
  const [expanded, setExpanded] = useState(false);

  const ranged = useMemo(() => filterRatioHistoryByRange(data.points, range), [data.points, range]);
  const average = useMemo(() => averageRatioValue(ranged), [ranged]);

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      fullscreen={expanded}
      height="h-72"
      // Same "reset the control back to its default when the modal CLOSES"
      // pattern as useChartControls.ts's reset() — see that hook's doc
      // comment for why this only fires open -> closed, never on open.
      onToggleFullscreen={() => {
        if (expanded) setRange(computeDefaultRange(availableRanges));
        setExpanded((e) => !e);
      }}
      controls={
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-muted-foreground">Select Range</label>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as RatioHistoryRange)}
              className={SELECT_CLASS}
            >
              {availableRanges.map((r) => (
                <option key={r} value={r}>
                  {r === "All" ? "All Available" : r === "1Y" ? "1 Year" : `${r[0]} Years`}
                </option>
              ))}
            </select>
          </div>
        </div>
      }
    >
      {/* Own flex-col wrapper so the optional footnote text (fullscreen
          only, below) never steals height from ResponsiveContainer's
          `height="100%"` — ResponsiveContainer measures against its
          immediate parent, so that parent needs to be exactly the chart
          area (flex-1 min-h-0), with any sibling notes shrink-0 below it,
          rather than both living directly in ChartCard's own fixed-height
          children slot. */}
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          {ranged.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={ranged} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
                <XAxis
                  dataKey="date"
                  type="category"
                  tickFormatter={formatAxisDate}
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={48}
                />
                <YAxis
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  domain={["auto", "auto"]}
                  width={56}
                  tickFormatter={(v: number) => formatValue(v)}
                />
                <Tooltip
                  content={<RatioHistoryTooltip data={ranged} metricLabel={title} formatValue={formatValue} />}
                  wrapperStyle={CHART_TOOLTIP_WRAPPER_STYLE}
                  allowEscapeViewBox={{ x: true, y: true }}
                />
                {average != null && (
                  <ReferenceLine
                    y={average}
                    stroke={CONTRAST}
                    strokeDasharray="4 4"
                    label={{ value: `Avg ${formatValue(average)}`, position: "top", fill: CONTRAST, fontSize: 11, fontWeight: 600 }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={SKY}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
              Not enough historical earnings/price data to chart {title}.
            </div>
          )}
        </div>
        {/* Footnotes only in the expanded modal — same "don't clutter the
            compact preview card" principle as showAverage's isFullscreen
            gate in IncomeStatementPanel.tsx. */}
        {expanded && data.currencyDiffers && (
          <p className="mt-2 shrink-0 text-[10px] leading-relaxed text-muted-foreground">
            Note: computed from {data.reportingCurrency}-reporting earnings against a {data.quoteCurrency}-quoted
            price — not FX-adjusted.
          </p>
        )}
        {expanded && !data.quarterlyBased && (
          <p className="mt-1 shrink-0 text-[10px] leading-relaxed text-muted-foreground">
            Based on annual earnings (insufficient quarterly history for this symbol) — steps once per fiscal year
            rather than every quarter.
          </p>
        )}
      </div>
    </ChartCard>
  );
}
