"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AreaChart,
  CandlestickChart,
  ChevronDown,
  Eraser,
  Grid3x3,
  Maximize2,
  Minimize2,
  Minus,
  Palette,
  PenLine,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  Waypoints,
} from "lucide-react";
import { PriceChart, type ChartMode, type DrawTool } from "./PriceChart";
import { TIME_RANGES, type TimeRange } from "./TimeRangeSelector";
import { currencySymbol, formatPercent, formatPrice, toDisplayUnit } from "@/lib/format/currency";
import { isTaseListing } from "@/lib/finance/exchange";
import { cn } from "@/lib/utils";
import type { PricePoint } from "@/lib/finance/types";

/** Chart color picker presets — a flat accent color overrides the default green-gain/red-loss coloring. */
const COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: "Classic Blue", hex: "#3B82F6" },
  { name: "Emerald Green", hex: "#10B981" },
  { name: "Electric Purple", hex: "#A855F7" },
  { name: "Amber Gold", hex: "#F59E0B" },
];

/** Selectable EMA overlay periods, in display order — see PriceChart.tsx's EMA_COLORS for each period's line color. */
const EMA_PERIODS = [50, 100, 150, 200];

interface ChartPanelProps {
  history: PricePoint[];
  currency: string | null;
  /** Used to pick the chart's date-axis locale — he-IL only for TASE listings. */
  symbol: string;
  exchange: string | null;
  /** Raw (un-divided) live quote price — same convention as PriceHeaderBlock's
   *  formatPrice(quote.price, quote.currency) call, for the top-left ticker
   *  + price label. `null` while the live quote hasn't loaded yet. */
  currentPrice?: number | null;
}

function sliceByRange(history: PricePoint[], range: TimeRange): PricePoint[] {
  if (history.length === 0) return history;

  if (range === "Max") return history;

  if (range === "YTD") {
    const currentYear = new Date(history[history.length - 1].date).getUTCFullYear();
    const sliced = history.filter(
      (point) => new Date(point.date).getUTCFullYear() === currentYear
    );
    return sliced.length > 1 ? sliced : history.slice(-30);
  }

  const tradingDaysByRange: Record<Exclude<TimeRange, "Max" | "YTD">, number> = {
    "1D": 2,
    "5D": 5,
    "1M": 22,
    "6M": 126,
    "1Y": 252,
    "3Y": 756,
    "5Y": 1260,
    "10Y": 2520,
  };

  const days = tradingDaysByRange[range as Exclude<TimeRange, "Max" | "YTD">];
  return history.slice(-days);
}

/**
 * Apple-style pill toggle — shared by the range buttons inside the
 * Timeframe popover, the indicator toggles (SMA/EMA/Bollinger/RSI/MACD)
 * inside the Indicators popover, and the drawing-tool chips
 * (trendline/fibonacci/h-line) inside the Edit popover.
 * Solid glowing primary-color fill when active/armed, translucent glass
 * otherwise — same active-state language (bg-primary + soft primary
 * shadow) already used for the sidebar's active nav item, so this reads as
 * one consistent "on" state across the whole app rather than a one-off
 * style.
 */
function PillToggle({
  label,
  icon,
  active,
  onClick,
  title,
}: {
  label: string;
  icon?: ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title ?? label}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-all duration-200",
        active
          ? "bg-primary text-primary-foreground shadow-[0_0_14px_-3px] shadow-primary/70"
          : "bg-white/[0.04] text-muted-foreground hover:bg-white/10 hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Thin vertical separator between logical control groups in the toolbar. */
function ToolbarDivider() {
  return <div className="mx-0.5 h-6 w-px shrink-0 bg-white/10" aria-hidden="true" />;
}

export function ChartPanel({ history, currency, symbol, exchange, currentPrice = null }: ChartPanelProps) {
  const [range, setRange] = useState<TimeRange>("1Y");
  const [mode, setMode] = useState<ChartMode>("area");
  const [showSma, setShowSma] = useState(false);
  const [emaPeriods, setEmaPeriods] = useState<number[]>([]);
  const [showBollinger, setShowBollinger] = useState(false);
  const [showRsi, setShowRsi] = useState(false);
  const [showMacd, setShowMacd] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [chartColor, setChartColor] = useState<string | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const [drawTool, setDrawTool] = useState<DrawTool | null>(null);
  const [clearDrawingsToken, setClearDrawingsToken] = useState(0);

  // Ultra-clean toolbar redesign (live report): the timeframe selector,
  // every indicator toggle, and every drawing tool used to sit directly on
  // the toolbar (first as a two-row drawer, then as one long scrolling
  // row) — both crowded the chart. Now three dedicated dropdown triggers
  // live on the toolbar itself — Timeframe, Indicators, Edit — each opening
  // its own small popover underneath. (Timeframe and Indicators used to be
  // bundled into one combined "Strategy" popover; a live report found that
  // confusing and also uncovered a real clickability bug — see the z-index
  // fix on the popover panels below — so they're now split into two
  // separate, single-purpose triggers.) `*MenuOpen` + refs all follow the
  // exact same click-outside pattern the color picker already established
  // below.
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const [timeframeMenuOpen, setTimeframeMenuOpen] = useState(false);
  const [indicatorsMenuOpen, setIndicatorsMenuOpen] = useState(false);
  const editMenuRef = useRef<HTMLDivElement>(null);
  const timeframeMenuRef = useRef<HTMLDivElement>(null);
  const indicatorsMenuRef = useRef<HTMLDivElement>(null);

  /** Opens one popover and closes the other three — only one floating menu should ever be open at a time. */
  function openOnly(which: "edit" | "timeframe" | "indicators" | "color") {
    setEditMenuOpen(which === "edit" ? (v) => !v : false);
    setTimeframeMenuOpen(which === "timeframe" ? (v) => !v : false);
    setIndicatorsMenuOpen(which === "indicators" ? (v) => !v : false);
    setColorPickerOpen(which === "color" ? (v) => !v : false);
  }

  function toggleEma(period: number) {
    setEmaPeriods((prev) => (prev.includes(period) ? prev.filter((p) => p !== period) : [...prev, period]));
  }

  // Fullscreen expand: toggles the SAME card between its normal inline
  // position and a `fixed inset-*` overlay, rather than portaling/
  // remounting a second copy — the chart element itself never unmounts, so
  // zoom/pan position, drawn trendlines, and every toggle above survive the
  // transition in both directions with zero extra state-syncing code.
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // Escape cancels whichever "modal-ish" state is active, most-transient
  // first: an open popover, then an armed drawing tool (so a stray Escape
  // while sketching a trendline doesn't also blow away fullscreen),
  // otherwise fullscreen itself.
  useEffect(() => {
    const anyMenuOpen = editMenuOpen || timeframeMenuOpen || indicatorsMenuOpen || colorPickerOpen;
    if (!anyMenuOpen && !drawTool && !fullscreen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (anyMenuOpen) {
        setEditMenuOpen(false);
        setTimeframeMenuOpen(false);
        setIndicatorsMenuOpen(false);
        setColorPickerOpen(false);
      } else if (drawTool) setDrawTool(null);
      else if (fullscreen) setFullscreen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editMenuOpen, timeframeMenuOpen, indicatorsMenuOpen, colorPickerOpen, drawTool, fullscreen]);

  // Mobile UX audit fix: the color picker used to be a permanently-open
  // row of five 14px swatch buttons crammed next to the SMA/grid toggles
  // and mode buttons — both a touch-target problem (14px is well under
  // the ~44px minimum recommended tap size) and a row-crowding problem on
  // narrow phone widths. Collapsed into a single 44px trigger that opens a
  // small popover with 44px swatch buttons instead — same click-outside
  // pattern already used by the search comboboxes (SymbolSearchInput,
  // ComparePanel's inline search) elsewhere in this codebase.
  useEffect(() => {
    if (!colorPickerOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(event.target as Node)) {
        setColorPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [colorPickerOpen]);

  // Same click-outside pattern as the color picker above, for the three
  // other dropdown popovers.
  useEffect(() => {
    if (!editMenuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (editMenuRef.current && !editMenuRef.current.contains(event.target as Node)) {
        setEditMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [editMenuOpen]);

  useEffect(() => {
    if (!timeframeMenuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (timeframeMenuRef.current && !timeframeMenuRef.current.contains(event.target as Node)) {
        setTimeframeMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [timeframeMenuOpen]);

  useEffect(() => {
    if (!indicatorsMenuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (indicatorsMenuRef.current && !indicatorsMenuRef.current.contains(event.target as Node)) {
        setIndicatorsMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [indicatorsMenuOpen]);

  // QA hotfix (Phase 4): date-axis locale is market-aware now — Hebrew only
  // for TASE listings, English everywhere else (was previously left unset,
  // so it silently inherited the browser's own locale for every symbol).
  const locale = isTaseListing(symbol, exchange) ? "he-IL" : "en-US";

  // periodChange: absolute + percent move from the FIRST to the LAST point
  // of whatever's currently sliced into view — i.e. exactly the return over
  // the selected timeframe (1D/5D/.../Max), recomputed automatically every
  // time `range` changes since it's derived in the same useMemo as
  // `slicedData`. `first`/`last` are already display-unit-converted here
  // (toDisplayUnit applied below), so periodChange.abs must NOT be run
  // through toDisplayUnit again when rendering — see the render section.
  //
  // `convertedHistory` (the FULL history, display-unit-converted but NOT
  // range-sliced) is passed to PriceChart as `fullHistory` — see that
  // prop's doc comment for why indicators need it: a moving average
  // computed only from `slicedData` has no bars before the visible window
  // to warm up from, so e.g. EMA-200 on a short range used to render as a
  // truncated stub instead of a real, fully-correlated line across the
  // whole selected timeframe.
  const { convertedHistory, slicedData, positive, periodChange } = useMemo(() => {
    const converted: PricePoint[] = history.map((point) => ({
      date: point.date,
      open: toDisplayUnit(point.open, currency),
      high: toDisplayUnit(point.high, currency),
      low: toDisplayUnit(point.low, currency),
      close: toDisplayUnit(point.close, currency),
    }));
    const sliced = sliceByRange(converted, range);
    const first = sliced[0]?.close ?? 0;
    const last = sliced[sliced.length - 1]?.close ?? 0;
    const change =
      sliced.length >= 2 && Number.isFinite(first) && first !== 0
        ? { abs: last - first, pct: ((last - first) / Math.abs(first)) * 100 }
        : null;
    return { convertedHistory: converted, slicedData: sliced, positive: last >= first, periodChange: change };
  }, [history, range, currency]);

  const activeIndicatorCount = (showSma ? 1 : 0) + emaPeriods.length + (showBollinger ? 1 : 0) + (showRsi ? 1 : 0) + (showMacd ? 1 : 0);

  return (
    <>
      {/*
        Fullscreen (live report: "maximize button is failing to scale the
        chart to true full screen"). Previously this toggled between
        `relative` and a `fixed inset-3/6/10` card — a translucent,
        rounded, backdrop-blurred "window" with margins on every side, PLUS
        a separate dimmed backdrop layer behind it. That read as a floating
        panel, not a true fullscreen surface. Now it's a single opaque,
        edge-to-edge `fixed inset-0` layer at z-[9999] (above every other
        z-indexed layer in this component, including the z-[999] toolbar
        popovers) — no separate backdrop needed since this IS the backdrop.
        `hig-card`'s rounded/blurred/translucent treatment is intentionally
        dropped in fullscreen (kept for the normal inline card) since none
        of that reads as "immersive full-viewport" once there's nothing
        visible behind it to blur.
      */}
      <div
        className={cn(
          "p-4 transition-all duration-300 ease-out",
          fullscreen
            ? "fixed inset-0 z-[9999] flex flex-col overflow-y-auto bg-background"
            : "hig-card relative sm:p-5"
        )}
      >
        {/* Top-left ticker + live price header, matching institutional
            terminal charts (e.g. "T 400.04"). Also carries the selected
            timeframe's performance readout and the fullscreen toggle on the
            right — this row is unrelated to the toolbar's own controls, so
            it stays separate from the minimal toolbar below. currentPrice
            is the raw (un-divided) live quote price, same convention
            PriceHeaderBlock already uses, so formatPrice's own currency
            divisor applies once here rather than double-converting. */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-sm font-bold uppercase tracking-wide text-foreground">{symbol}</span>
            {currentPrice != null && (
              <span className="font-mono text-lg font-bold text-foreground">{formatPrice(currentPrice, currency)}</span>
            )}
            {periodChange && (
              <span
                className={cn(
                  "shrink-0 font-mono text-sm font-semibold",
                  periodChange.abs >= 0 ? "text-success" : "text-destructive"
                )}
              >
                {/* periodChange.abs is already display-unit-converted (see the
                    useMemo above) — currencySymbol() only, no formatPrice/
                    toDisplayUnit here, or the divisor would apply twice. */}
                ({periodChange.abs >= 0 ? "+" : "-"}
                {currencySymbol(currency)}
                {Math.abs(periodChange.abs).toFixed(2)} {formatPercent(periodChange.pct)})
              </span>
            )}
          </div>
          {/* Fullscreen expand/collapse — top-right, same corner every OS/
              photo-viewer convention puts it in. */}
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            aria-pressed={fullscreen}
            title={fullscreen ? "Exit fullscreen" : "Expand chart to fullscreen"}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.04] text-muted-foreground transition-all duration-200 hover:bg-white/10 hover:text-foreground"
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>

        {/*
          Ultra-clean minimalist toolbar (live report): only the core
          always-visible controls (Grid, color, view mode) plus three
          single-purpose dropdown triggers — "Timeframe", "Indicators", and
          "Edit" (drawing tools) — stay on the toolbar itself. Everything
          else lives in a floating popover underneath its own trigger,
          closed by default, so the bar directly above the chart canvas
          stays short and the canvas gets the vertical space.
        */}
        {/* `relative z-20` here matters, not just cosmetically: `backdrop-blur-md`
            below creates its own CSS stacking context, and this bar sits
            earlier in the DOM than the chart canvas div right under it. Without
            an explicit z-index on THIS element, that whole stacking context
            (popovers and all, regardless of their own z-index) paints behind
            the later chart sibling once both overlap — which is exactly what
            made every popover button unclickable (a live report/screenshot
            showed the chart's own crosshair tooltip rendering on top of an
            open popover, swallowing clicks meant for it). Bumping this
            wrapper above the chart's stacking level is what actually fixes
            it; z-[999] on the popover panels alone would not have, since a
            child's z-index can never escape a parent stacking context that
            itself paints behind a sibling. */}
        <div className="relative z-20 mt-3 flex items-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-md">
          <PillToggle
            label="Grid"
            icon={<Grid3x3 className="h-3.5 w-3.5" />}
            active={showGrid}
            onClick={() => setShowGrid((v) => !v)}
            title="הצג/הסתר רשת — toggle chart grid lines"
          />

          {/* Color picker: a single trigger that opens a small popover with
              44px swatch buttons (touch-target size fix from an earlier
              mobile-UX audit — kept as-is here). */}
          <div ref={colorPickerRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => openOnly("color")}
              aria-expanded={colorPickerOpen}
              aria-haspopup="true"
              aria-label="Chart color"
              title="Chart color"
              className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-white/[0.04] px-3 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-full"
                style={
                  chartColor
                    ? { backgroundColor: chartColor }
                    : { background: "linear-gradient(135deg, #10B981 50%, #EF4444 50%)" }
                }
              />
              <Palette className="h-3.5 w-3.5" />
            </button>
            {colorPickerOpen && (
              <div
                role="group"
                aria-label="Chart color options"
                className="search-dropdown-panel pointer-events-auto absolute left-0 top-[calc(100%+8px)] z-[999] flex items-center gap-1 rounded-lg border border-border p-1 shadow-xl"
              >
                <button
                  type="button"
                  onClick={() => {
                    setChartColor(null);
                    setColorPickerOpen(false);
                  }}
                  aria-pressed={chartColor === null}
                  title="Auto (trend color)"
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors ${
                    chartColor === null ? "bg-accent ring-2 ring-primary" : "hover:bg-accent"
                  }`}
                >
                  <span
                    className="h-3.5 w-3.5 rounded-full"
                    style={{ background: "linear-gradient(135deg, #10B981 50%, #EF4444 50%)" }}
                  />
                </button>
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.hex}
                    type="button"
                    onClick={() => {
                      setChartColor(preset.hex);
                      setColorPickerOpen(false);
                    }}
                    aria-pressed={chartColor === preset.hex}
                    title={preset.name}
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors ${
                      chartColor === preset.hex ? "bg-accent ring-2 ring-primary" : "hover:bg-accent"
                    }`}
                  >
                    <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: preset.hex }} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center rounded-full border border-foreground/10 p-0.5">
            <button
              type="button"
              aria-pressed={mode === "area"}
              onClick={() => setMode("area")}
              title="Area mode"
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                mode === "area"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <AreaChart className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-pressed={mode === "candlestick"}
              onClick={() => setMode("candlestick")}
              title="Candlestick mode"
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                mode === "candlestick"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <CandlestickChart className="h-4 w-4" />
            </button>
          </div>

          <ToolbarDivider />

          {/* "Timeframe" dropdown — its own dedicated trigger/popover, split
              out from the old combined "Strategy" menu per live report (that
              menu bundled range + every indicator together, which read as
              cluttered). Trigger always shows the current range so it's
              legible at a glance even with the popover closed. */}
          <div ref={timeframeMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => openOnly("timeframe")}
              aria-expanded={timeframeMenuOpen}
              aria-haspopup="true"
              title="Timeframe"
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-all duration-200",
                timeframeMenuOpen
                  ? "bg-primary text-primary-foreground shadow-[0_0_14px_-3px] shadow-primary/70"
                  : "bg-white/[0.04] text-muted-foreground hover:bg-white/10 hover:text-foreground"
              )}
            >
              Timeframe · {range}
              <ChevronDown className={cn("h-3 w-3 transition-transform", timeframeMenuOpen && "rotate-180")} />
            </button>
            {timeframeMenuOpen && (
              <div
                role="menu"
                aria-label="Timeframe"
                className="search-dropdown-panel pointer-events-auto absolute left-0 top-[calc(100%+8px)] z-[999] w-[15rem] rounded-2xl border border-border p-3 shadow-xl"
              >
                <div className="flex flex-wrap gap-1.5">
                  {TIME_RANGES.map((r) => (
                    <PillToggle
                      key={r}
                      label={r}
                      active={range === r}
                      onClick={() => {
                        setRange(r);
                        setTimeframeMenuOpen(false);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* "Indicators" dropdown — its own dedicated trigger/popover, the
              other half of the old combined "Strategy" menu. Left open
              across multiple clicks inside it (unlike Timeframe/Edit above),
              since toggling on RSI, MACD, and a couple of EMAs together in
              one visit is a normal workflow here — only closes via outside
              click, Escape, or clicking the trigger again. Trigger shows a
              small count badge whenever any indicators are active. */}
          <div ref={indicatorsMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => openOnly("indicators")}
              aria-expanded={indicatorsMenuOpen}
              aria-haspopup="true"
              title="Indicators"
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-all duration-200",
                indicatorsMenuOpen || activeIndicatorCount > 0
                  ? "bg-primary text-primary-foreground shadow-[0_0_14px_-3px] shadow-primary/70"
                  : "bg-white/[0.04] text-muted-foreground hover:bg-white/10 hover:text-foreground"
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Indicators
              {activeIndicatorCount > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-black/20 px-1 text-[10px] font-semibold">
                  {activeIndicatorCount}
                </span>
              )}
              <ChevronDown className={cn("h-3 w-3 transition-transform", indicatorsMenuOpen && "rotate-180")} />
            </button>
            {indicatorsMenuOpen && (
              <div
                role="menu"
                aria-label="Indicators"
                className="search-dropdown-panel pointer-events-auto absolute left-0 top-[calc(100%+8px)] z-[999] w-[19rem] rounded-2xl border border-border p-3 shadow-xl"
              >
                <div className="flex flex-wrap gap-1.5">
                  <PillToggle label="SMA 20" active={showSma} onClick={() => setShowSma((v) => !v)} />
                  {EMA_PERIODS.map((period) => (
                    <PillToggle
                      key={period}
                      label={`EMA ${period}`}
                      active={emaPeriods.includes(period)}
                      onClick={() => toggleEma(period)}
                    />
                  ))}
                  <PillToggle
                    label="Bollinger Bands"
                    active={showBollinger}
                    onClick={() => setShowBollinger((v) => !v)}
                  />
                  <PillToggle label="RSI" active={showRsi} onClick={() => setShowRsi((v) => !v)} />
                  <PillToggle label="MACD" active={showMacd} onClick={() => setShowMacd((v) => !v)} />
                </div>
              </div>
            )}
          </div>

          {/* "Edit" dropdown — draw tools popover (Trendline/Fibonacci/
              H-Line/Eraser/Clear All). Selecting Trendline, Fibonacci, or
              H-Line arms it AND closes the menu (the user's next move is on
              the canvas, not this popover); Eraser arms but deliberately
              leaves the menu open (see its own comment below); "Clear All"
              closes the menu after wiping every drawing. The trigger itself
              goes solid/glowing whenever any tool is currently armed
              (including the eraser), so it stays visibly "active" even with
              the popover closed while the user is off drawing/erasing on
              the chart. */}
          <div ref={editMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => openOnly("edit")}
              aria-expanded={editMenuOpen}
              aria-haspopup="true"
              title="Drawing tools"
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-all duration-200",
                drawTool
                  ? "bg-primary text-primary-foreground shadow-[0_0_14px_-3px] shadow-primary/70"
                  : "bg-white/[0.04] text-muted-foreground hover:bg-white/10 hover:text-foreground"
              )}
            >
              <PenLine className="h-3.5 w-3.5" />
              Edit
              <ChevronDown className={cn("h-3 w-3 transition-transform", editMenuOpen && "rotate-180")} />
            </button>
            {editMenuOpen && (
              <div
                role="menu"
                aria-label="Drawing tools"
                className="search-dropdown-panel pointer-events-auto absolute left-0 top-[calc(100%+8px)] z-[999] flex flex-col gap-1 rounded-2xl border border-border p-2 shadow-xl"
              >
                <PillToggle
                  label="Trendline"
                  icon={<TrendingUp className="h-3.5 w-3.5" />}
                  active={drawTool === "trendline"}
                  onClick={() => {
                    setDrawTool((t) => (t === "trendline" ? null : "trendline"));
                    setEditMenuOpen(false);
                  }}
                  title="Click a start point, then an end point, to draw a trendline"
                />
                <PillToggle
                  label="Fibonacci"
                  icon={<Waypoints className="h-3.5 w-3.5" />}
                  active={drawTool === "fibonacci"}
                  onClick={() => {
                    setDrawTool((t) => (t === "fibonacci" ? null : "fibonacci"));
                    setEditMenuOpen(false);
                  }}
                  title="Click a swing high and a swing low (either order) to draw a Fibonacci retracement"
                />
                <PillToggle
                  label="H-Line"
                  icon={<Minus className="h-3.5 w-3.5" />}
                  active={drawTool === "horizontal"}
                  onClick={() => {
                    setDrawTool((t) => (t === "horizontal" ? null : "horizontal"));
                    setEditMenuOpen(false);
                  }}
                  title="Click once to place a horizontal price line"
                />
                {/* Eraser (live report: "instead of a blunt Clear All ...
                    add an Eraser tool") — click-to-delete for exactly one
                    drawing, leaving every other trendline/fibonacci/h-line
                    intact. Unlike the other tools this one does NOT close
                    the menu on click, and stays armed after each delete
                    (see PriceChart.tsx's eraser branch) so several drawings
                    can be erased in a row; it's disarmed the same way as
                    any other tool — clicking it again, Escape, or arming a
                    different tool. */}
                <PillToggle
                  label="Eraser"
                  icon={<Eraser className="h-3.5 w-3.5" />}
                  active={drawTool === "eraser"}
                  onClick={() => setDrawTool((t) => (t === "eraser" ? null : "eraser"))}
                  title="Click any single drawing to delete just that one"
                />
                <button
                  type="button"
                  onClick={() => {
                    setClearDrawingsToken((t) => t + 1);
                    setEditMenuOpen(false);
                  }}
                  title="Clear all drawings"
                  className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white/[0.04] px-3 text-xs font-medium text-muted-foreground transition-all duration-200 hover:bg-destructive/15 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear All
                </button>
              </div>
            )}
          </div>

        </div>

        <div className={cn("mt-4", fullscreen && "min-h-0 flex-1")}>
          <PriceChart
            symbol={symbol}
            data={slicedData}
            fullHistory={convertedHistory}
            mode={mode}
            showSma={showSma}
            emaPeriods={emaPeriods}
            showBollinger={showBollinger}
            showRsi={showRsi}
            showMacd={showMacd}
            drawTool={drawTool}
            onDrawComplete={() => setDrawTool(null)}
            clearDrawingsToken={clearDrawingsToken}
            positive={positive}
            locale={locale}
            showGrid={showGrid}
            overrideColor={chartColor}
            fullHeight={fullscreen}
          />
        </div>
      </div>
    </>
  );
}
