"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import type { PricePoint } from "@/lib/finance/types";
import { computeBollingerBands, computeEmaSeries, computeMacd, computeRsiSeries } from "@/lib/finance/chartIndicators";
import { cn } from "@/lib/utils";

export type ChartMode = "area" | "candlestick";

/**
 * Chart drawing tools (toolbar "Edit"/Tools drawer, see ChartPanel.tsx).
 * "horizontal" completes on a single click; "trendline" waits for a second
 * click before drawing anything, see the click handler below. "eraser" is
 * click-to-delete: clicking any single drawn shape removes ONLY that shape
 * (state + localStorage) and leaves the tool armed so multiple shapes can
 * be erased in a row — see the eraser branch in handleClick and
 * findDrawingIdAtPoint below.
 *
 * Fibonacci was removed entirely (live report round 6: "remove Fibonacci
 * completely — it clutters and fails") rather than kept as a fourth,
 * higher-complexity shape (7 price lines + 6 shaded band series per
 * drawing) alongside the two simple ones here.
 */
export type DrawTool = "trendline" | "horizontal" | "eraser";

interface PriceChartProps {
  /**
   * The ticker this chart is showing — used ONLY as the localStorage key for
   * persisted drawings (`chart_drawings_<symbol>`; see the persistence
   * section below), not for fetching or formatting. Required so drawings
   * always save/load against the right instrument.
   */
  symbol: string;
  /** Already converted to display units (e.g. agorot -> shekels) and sliced to the selected range. */
  data: PricePoint[];
  /**
   * The FULL converted (but NOT range-sliced) history — same display-unit
   * conversion as `data`, just not cut down to the selected timeframe.
   * Indicators (SMA/EMA/Bollinger/RSI/MACD) are computed against this
   * instead of `data` and then filtered down to `data`'s date range before
   * being plotted — see the indicator effects below for why: a moving
   * average computed only from the visible slice has no "before the
   * window" bars to warm up from, so e.g. EMA-200 on a 1-month view used
   * to only start plotting ~200 bars into a ~22-bar slice (i.e. never),
   * or would only appear near the right edge on slightly longer ranges —
   * a stub, not a real line. Computing from the full history first gives
   * every indicator as much real lookback as actually exists, so it can
   * render smoothly across the ENTIRE visible window like a real charting
   * platform, not just whatever happens to fit inside the current slice.
   * Falls back to `data` if omitted, for callers that don't have a longer
   * history available.
   */
  fullHistory?: PricePoint[];
  mode: ChartMode;
  showSma?: boolean;
  smaPeriod?: number;
  /** Which EMA periods to overlay (e.g. [50, 200]) — same pane as the main series. Empty/omitted shows none. */
  emaPeriods?: number[];
  /** Bollinger Bands (20, 2σ) overlay, same pane as the main series. */
  showBollinger?: boolean;
  /** RSI-14 in its own sub-pane below the main chart. */
  showRsi?: boolean;
  /** MACD (12, 26, 9) — line + signal + histogram — in its own sub-pane. */
  showMacd?: boolean;
  /** Currently-armed drawing tool, or null when the chart should behave normally (pan/zoom, no click-to-draw). Reset to null by the parent via onDrawComplete after one shape is placed. */
  drawTool?: DrawTool | null;
  /** Fires once a drawing tool has placed its shape (or been cancelled by Escape) — the parent uses this to un-arm the tool button. */
  onDrawComplete?: () => void;
  /** Bump this (e.g. a counter) to wipe every user-drawn trendline/horizontal-line from the chart. */
  clearDrawingsToken?: number;
  /** Drives area-chart gradient/line color — true = period gained, false = lost. Ignored when overrideColor is set. */
  positive: boolean;
  /**
   * Intl locale for axis date labels. QA hotfix (Phase 4): this used to be
   * left unset, so lightweight-charts fell back to the browser's own
   * locale (e.g. a Hebrew OS/browser setting rendered Hebrew month labels
   * for every ticker, not just TASE ones). Callers should pass "he-IL"
   * only for .TA/TLV symbols and "en-US" for everything else.
   */
  locale?: string;
  /** Show/hide background grid lines. Defaults to visible. */
  showGrid?: boolean;
  /**
   * When set, overrides the default green-gain/red-loss color with a single
   * flat accent color (area line/fill, or candle up+down+wick colors) —
   * powers the chart's color-preset picker. `null`/`undefined` keeps the
   * default trend-based coloring.
   */
  overrideColor?: string | null;
  /** Fullscreen expand mode (ChartPanel.tsx) — swaps the fixed 320/400px height for a flex `h-full` that fills whatever taller container the fullscreen card provides. */
  fullHeight?: boolean;
}

const SUCCESS = "#10B981";
const DESTRUCTIVE = "#EF4444";
// Root-cause fix (live report round 6, screenshot evidence: SMA 20 and
// EMA 150 both rendered as the same indistinguishable orange). The old
// palette picked colors independently per indicator (SMA_COLOR #F59E0B
// amber, EMA 150 #FB923C orange) without checking them against each other
// — two different hues that happen to read as "the same orange" at a thin
// 2px line width. Replaced with one deliberately spread-out, high-contrast
// palette (cyan / magenta / purple / orange / yellow) chosen so every
// SMA/EMA combination that can be active simultaneously is unambiguous at
// a glance, and cross-checked against SUCCESS/DESTRUCTIVE (candle colors)
// and DRAW_COLOR (trendline) below so nothing on this chart can collide.
const SMA_COLOR = "#22D3EE"; // cyan
/** One distinct, high-contrast color per selectable EMA period — see the palette note above. */
const EMA_COLORS: Record<number, string> = {
  50: "#EC4899", // pink / magenta
  100: "#A855F7", // purple
  150: "#FB923C", // orange
  200: "#FACC15", // bright yellow
};
const BOLLINGER_COLOR = "#818CF8"; // indigo — kept distinct from EMA 100's purple above
const RSI_COLOR = "#38BDF8";
const MACD_COLOR = "#38BDF8";
const MACD_SIGNAL_COLOR = "#F59E0B";
const DRAW_COLOR = "#F59E0B";

/** Converts a "#RRGGBB" hex color to an "rgba(r, g, b, alpha)" string for area-chart fills. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Resolves a Time for an x pixel coordinate even when lightweight-charts'
 * own `param.time` comes back undefined — which it reliably does for any
 * click landing in the reserved empty margin to the right of the last bar
 * (or left of the first). That's a well-known library gap: `param.time` is
 * only populated when the crosshair lines up with an actual data point, but
 * a real user very often draws a trendline/fibonacci TOWARD the most recent
 * price action, which means the second (or even first) click frequently
 * lands slightly past the last candle — previously that silently no-opped
 * the whole draw, which is exactly what read as "trendline/fibonacci fails
 * to finalize." Falling back to `coordinateToLogical` + rounding + clamping
 * to the data's actual index range snaps that click to the nearest real
 * bar (almost always the last one) instead of doing nothing.
 */
function resolveTimeAtX(chart: IChartApi | null, dates: string[], x: number): Time | null {
  if (!chart || dates.length === 0) return null;
  const logical = chart.timeScale().coordinateToLogical(x);
  if (logical == null) return null;
  const idx = Math.max(0, Math.min(dates.length - 1, Math.round(logical)));
  return dates[idx] ?? null;
}

/**
 * Root-cause fix (live report round 4: "trendline/fibonacci completely
 * broken"). `resolveTimeAtX` rounds a pixel x to the nearest whole BAR — on
 * any remotely zoomed-out range (e.g. 1Y over a ~1900px chart is under 8px
 * per bar) two clicks that don't drift more than a few pixels resolve to
 * the exact SAME bar. lightweight-charts requires strictly distinct times
 * on a 2-point line series, so `drawTrendlineShape`/`drawFibonacciShape`
 * silently returned null/no-opped in that case — the tool still disarmed
 * (so it visibly "consumed" the click) but rendered nothing and threw no
 * error, which reads exactly like "the tool doesn't work" even though every
 * underlying coordinate lookup was correct. Used only for the SECOND click
 * of a two-point drawing, and only when it lands on the same bar as the
 * first: snaps to the nearest bar that is NOT `excludeTime`, biased toward
 * whichever side of that bar the raw (unrounded) logical position actually
 * falls on, so the result is still the closest distinct bar to where the
 * user really clicked rather than an arbitrary "always +1".
 */
function resolveDistinctTimeAtX(
  chart: IChartApi | null,
  dates: string[],
  x: number,
  excludeTime: Time
): Time | null {
  if (!chart || dates.length < 2) return null;
  const logical = chart.timeScale().coordinateToLogical(x);
  if (logical == null) return null;
  let idx = Math.max(0, Math.min(dates.length - 1, Math.round(logical)));
  if (dates[idx] !== String(excludeTime)) return dates[idx] ?? null;
  const step = logical - idx >= 0 ? 1 : -1;
  let nudged = idx + step;
  if (nudged < 0 || nudged > dates.length - 1) nudged = idx - step; // ran off the data on that side — try the other
  idx = Math.max(0, Math.min(dates.length - 1, nudged));
  return dates[idx] ?? null;
}

function timeToDate(time: Time): Date {
  if (typeof time === "string") return new Date(time);
  if (typeof time === "number") return new Date(time * 1000);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

/** Formats the hovered point's date for the floating crosshair tooltip. */
function formatTooltipTime(time: Time, locale: string): string {
  return timeToDate(time).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Pulls a display price out of whatever shape lightweight-charts'
 * `seriesData.get(series)` hands back — `{ value }` for the area/line
 * series, `{ close }` for candlesticks. Written with `unknown` + `in`
 * narrowing (no `any`) since the exact union type depends on which main
 * series is currently mounted.
 */
function extractTooltipPrice(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  if ("value" in data && typeof (data as { value: unknown }).value === "number") {
    return (data as { value: number }).value;
  }
  if ("close" in data && typeof (data as { close: unknown }).close === "number") {
    return (data as { close: number }).close;
  }
  return null;
}

const TOOLTIP_WIDTH = 132;
const TOOLTIP_HEIGHT = 52;
const TOOLTIP_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

interface ChartTooltipState {
  x: number;
  y: number;
  time: string;
  price: number;
}

/**
 * One SMA/EMA overlay's legend entry (live report round 2: the right-margin
 * axis-tag approach from the previous fix still visually crowded the real
 * price-scale numbers — moved out of the price scale entirely into a
 * dedicated legend row above the chart canvas instead; see the `<div>`
 * rendered just above `containerRef`'s element in the return below).
 * `value` is the series' own final data point, refreshed every time that
 * series is rebuilt (data/period/toggle change) — lightweight-charts
 * doesn't expose a "get the last value" getter, so this is tracked
 * ourselves rather than re-derived from the chart.
 */
interface IndicatorLegendItem {
  id: string;
  label: string;
  color: string;
  value: number;
}

/** Sort key for the legend row: SMA first, then EMAs in ascending period order (a plain string sort of ids like "ema-100"/"ema-50" would wrongly put "100" before "50"). */
function legendSortKey(id: string): number {
  if (id === "sma") return -1;
  const match = /^ema-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 999;
}

/**
 * QA hotfix (Final Polish pass): AAPL's date axis was still rendering
 * Hebrew month labels live, despite `localization.locale` already being
 * set correctly to "en-US" for non-TASE symbols (that logic — isTaseListing
 * gating "he-IL" — is correct; see ChartPanel.tsx). lightweight-charts'
 * *default* tick-mark formatter is documented to take the chart's
 * `localization.locale`, but that resolution is unverified live in this
 * sandbox and evidently isn't reliable in practice. Supplying an explicit
 * `tickMarkFormatter` removes the ambiguity entirely: we format the label
 * ourselves with `Intl.DateTimeFormat(locale, ...)` using the exact same
 * `locale` value already computed by isTaseListing(), so correctness no
 * longer depends on any library-internal default.
 */
function makeTickMarkFormatter(locale: string) {
  return (time: Time, tickMarkType: TickMarkType): string => {
    const date = timeToDate(time);
    switch (tickMarkType) {
      case TickMarkType.Year:
        return date.toLocaleDateString(locale, { year: "numeric" });
      case TickMarkType.Month:
        return date.toLocaleDateString(locale, { month: "short" });
      case TickMarkType.DayOfMonth:
        return date.toLocaleDateString(locale, { day: "numeric" });
      default:
        return date.toLocaleDateString(locale, { hour: "2-digit", minute: "2-digit" });
    }
  };
}

function computeSma(data: PricePoint[], period: number) {
  const result: { time: string; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i].close;
    if (i >= period) sum -= data[i - period].close;
    if (i >= period - 1) {
      result.push({ time: data[i].date, value: Number((sum / period).toFixed(4)) });
    }
  }
  return result;
}

type MainSeriesApi = ISeriesApi<"Area"> | ISeriesApi<"Candlestick">;

/**
 * Persistence layer for user-drawn trendlines/h-lines (live report:
 * "drawings disappear on refresh"). Keyed by ticker in localStorage
 * (`chart_drawings_<symbol>`) — a plain JSON array of serializable shapes,
 * NOT the lightweight-charts series/price-line objects themselves (those
 * can't survive a reload and are re-created fresh from this data every time
 * the main series is (re)built — see `renderStoredDrawing` and its call
 * site in the mode/data effect below). `points[].time` is stored as a plain
 * string: every Time value that ever reaches this file is already a
 * "YYYY-MM-DD" string (see how `data`/`fullHistory` feed every series with
 * `time: d.date`), so this intentionally doesn't need to handle the
 * BusinessDay/number variants of lightweight-charts' Time union.
 *
 * Fibonacci removed (live report round 6). `isValidStoredDrawing` below no
 * longer accepts `type: "fibonacci"`, so any drawing saved by an earlier
 * build simply gets filtered out of `loadDrawings` on next load — a quiet,
 * graceful migration rather than a crash on old localStorage data.
 */
type StoredDrawing =
  | { id: string; type: "horizontal"; price: number }
  | { id: string; type: "trendline"; points: [{ time: string; price: number }, { time: string; price: number }] };

/** Every persisted drawing gets a stable id at creation time (see handleClick) — this is what the eraser tool matches against to delete exactly ONE drawing rather than clearing everything. */
function makeDrawingId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `d_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function drawingsStorageKey(symbol: string): string {
  return `chart_drawings_${symbol}`;
}

/** Narrow runtime check before trusting anything pulled out of localStorage — a hand-edited or stale-schema value should be dropped, not crash the chart. */
function isValidStoredDrawing(value: unknown): value is StoredDrawing {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (v.type === "horizontal") return typeof v.price === "number" && Number.isFinite(v.price);
  if (v.type === "trendline") {
    if (!Array.isArray(v.points) || v.points.length !== 2) return false;
    return v.points.every(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof (p as { time: unknown }).time === "string" &&
        typeof (p as { price: unknown }).price === "number" &&
        Number.isFinite((p as { price: number }).price)
    );
  }
  return false;
}

function loadDrawings(symbol: string): StoredDrawing[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(drawingsStorageKey(symbol));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidStoredDrawing);
  } catch {
    // Corrupted JSON or localStorage unavailable (private browsing, quota,
    // etc.) — fail open to an empty chart rather than crash it.
    return [];
  }
}

function persistDrawings(symbol: string, drawings: StoredDrawing[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(drawingsStorageKey(symbol), JSON.stringify(drawings));
  } catch {
    // Same as above — drawings still work for the rest of this session via
    // savedDrawingsRef, they just won't survive a refresh. Not worth
    // surfacing an error over.
  }
}

function clearPersistedDrawings(symbol: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(drawingsStorageKey(symbol));
  } catch {
    // ignore — see loadDrawings/persistDrawings.
  }
}

/** One on-screen drawing's chart objects, grouped by the same `id` as its StoredDrawing counterpart — see renderedDrawingsRef's doc comment in the component body. */
interface RenderedDrawing {
  id: string;
  series: ISeriesApi<SeriesType>[];
  priceLines: IPriceLine[];
}

/** Pixel-distance tolerance for the eraser's click-to-delete hit test — generous enough to be forgiving on a precise click, tight enough not to grab a neighboring line. */
const ERASER_HIT_TOLERANCE_PX = 6;

/** Shortest distance from point (px, py) to the line SEGMENT (not infinite line) from (x1, y1) to (x2, y2) — standard point-to-segment projection, clamped to the segment's endpoints. Used by the eraser to hit-test trendlines. */
function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Trims an indicator series (computed from the full history) down to just the dates visible in the currently-selected range, so a long-lookback indicator like EMA-200 can use real prior history for its MATH without also being plotted before the chart's actual visible window. */
function visibleSlice<T extends { time: string }>(points: T[], visibleStartDate: string | undefined): T[] {
  if (!visibleStartDate) return points;
  return points.filter((p) => p.time >= visibleStartDate);
}

export function PriceChart({
  symbol,
  data,
  fullHistory,
  mode,
  showSma = false,
  smaPeriod = 20,
  emaPeriods = [],
  showBollinger = false,
  showRsi = false,
  showMacd = false,
  drawTool = null,
  onDrawComplete,
  clearDrawingsToken = 0,
  positive,
  locale = "en-US",
  showGrid = true,
  overrideColor = null,
  fullHeight = false,
}: PriceChartProps) {
  // See fullHistory's doc comment above — indicators compute against this
  // (falls back to `data` if no longer history was supplied) and then get
  // trimmed to `visibleStartDate` before being plotted.
  const indicatorSource = fullHistory ?? data;
  const visibleStartDate = data[0]?.date;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<
    ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null
  >(null);
  const smaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSeriesRef = useRef<Map<number, ISeriesApi<"Line">>>(new Map());
  const bollingerSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSeriesRef = useRef<ISeriesApi<"Line" | "Histogram">[]>([]);
  // Every currently-on-screen drawing, grouped by its persisted `id` (one
  // group per trendline/h-line — a trendline holds 1 line series, an
  // h-line holds 1 price line). Grouped by id (rather than a flat array of
  // series/price-lines) so the eraser tool can remove exactly ONE drawing's
  // on-screen elements without touching any other drawing — see
  // deleteDrawing below. Kept in a ref so the click handler (registered
  // once, in the creation effect) and the "Clear Drawings" effect can both
  // reach it without either needing to be in the other's dependency array.
  const renderedDrawingsRef = useRef<RenderedDrawing[]>([]);
  const drawStartRef = useRef<{ time: Time; price: number } | null>(null);
  // Persistence (live report: "drawings disappear on refresh"): the
  // in-memory source of truth for what's currently saved for THIS symbol,
  // reloaded from localStorage and re-rendered onto the chart every time
  // the main series is (re)built — see the mode/data effect below. Kept
  // separate from renderedDrawingsRef (which is purely "what's currently
  // drawn on screen" and gets wiped/rebuilt on every mode/range switch)
  // since this one must survive those rebuilds.
  const savedDrawingsRef = useRef<StoredDrawing[]>([]);
  // Mirrors the `symbol` prop for the click handler and the "Clear
  // Drawings" effect, both of which need the CURRENT symbol but the click
  // handler is registered once (creation effect depends only on `locale`) —
  // same ref-mirroring pattern as drawToolRef/onDrawCompleteRef below.
  const symbolRef = useRef(symbol);
  // The currently-visible bars' dates, kept in sync for resolveTimeAtX's
  // right/left-margin fallback (see its doc comment) — the click handler is
  // registered once (creation effect depends only on `locale`) and needs
  // the CURRENT data, not whatever was visible when the chart was created.
  const dataDatesRef = useRef<string[]>([]);
  useEffect(() => {
    dataDatesRef.current = data.map((d) => d.date);
  }, [data]);
  // Rubber-band preview: a dashed, ghost-colored 2-point line that tracks
  // the cursor between the first and second click of a trendline drawing,
  // so the user can see what they're about to draw instead of clicking
  // twice blind. Lives entirely in the crosshair-move handler below;
  // removed on finalize, on tool change, and on unmount.
  const previewSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  // Mirrors of the latest drawTool/onDrawComplete props — the click handler
  // is registered once (creation effect depends only on `locale`) but must
  // always see the CURRENT armed tool, not the one active when the chart
  // was first created, hence refs updated by a separate effect below.
  const drawToolRef = useRef<DrawTool | null>(drawTool);
  const onDrawCompleteRef = useRef(onDrawComplete);
  // Tracks the main series' current display color so the floating tooltip's
  // legend swatch always matches the line/candles on screen, including when
  // the color-preset picker (ChartPanel.tsx) overrides it.
  const seriesColorRef = useRef<string>(SUCCESS);
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  // SMA/EMA legend row (live report round 2: a right-margin axis-tag
  // overlay — the previous fix for "EMA labels float over the candles" —
  // still visually crowded the real price-scale numbers up close, so
  // labels are moved out of the price scale entirely into a dedicated
  // legend row rendered above the chart canvas; see the return below).
  // `indicatorLegendInfoRef` is the source of truth (updated by the SMA/EMA
  // effects, each owning only its own id-prefixed entries so they don't
  // clobber each other); `indicatorLegend` is the sorted array actually
  // rendered.
  const indicatorLegendInfoRef = useRef<IndicatorLegendItem[]>([]);
  const [indicatorLegend, setIndicatorLegend] = useState<IndicatorLegendItem[]>([]);

  /** Re-derives the sorted, rendered legend array from indicatorLegendInfoRef — call after any SMA/EMA effect mutates that ref. */
  function refreshIndicatorLegend() {
    setIndicatorLegend([...indicatorLegendInfoRef.current].sort((a, b) => legendSortKey(a.id) - legendSortKey(b.id)));
  }

  useEffect(() => {
    drawToolRef.current = drawTool;
  }, [drawTool]);

  useEffect(() => {
    onDrawCompleteRef.current = onDrawComplete;
  }, [onDrawComplete]);

  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  /** Draws a single horizontal price line. Returns it so the caller can group it under a drawing id (registerRenderedDrawing) for later single-shape erasure. Shared by the live click-handler finalize path and the load-from-storage replay path below. */
  function drawHorizontalLine(main: MainSeriesApi, price: number): IPriceLine {
    return main.createPriceLine({
      price,
      color: DRAW_COLOR,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "H-Line",
    });
  }

  /** Draws a 2-point trendline. Returns null (drawing nothing) if both points land on the same time — lightweight-charts requires strictly ascending time per series and a same-bar trendline has no sensible slope anyway. Shared by the live and storage-replay paths. */
  function drawTrendlineShape(chart: IChartApi, aTime: Time, aPrice: number, bTime: Time, bPrice: number): ISeriesApi<"Line"> | null {
    const points = [
      { time: aTime, value: aPrice },
      { time: bTime, value: bPrice },
    ].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    if (points[0].time === points[1].time) return null;
    const series = chart.addSeries(LineSeries, {
      color: DRAW_COLOR,
      lineWidth: 2,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    series.setData(points);
    return series;
  }

  /** Tracks one drawing's chart objects under its id so a later eraser click can remove exactly this drawing (see deleteDrawing) without touching any other. Called after every successful draw, whether live (handleClick) or replayed from storage (renderStoredDrawing). */
  function registerRenderedDrawing(id: string, series: ISeriesApi<SeriesType>[], priceLines: IPriceLine[]) {
    renderedDrawingsRef.current.push({ id, series, priceLines });
  }

  /** Re-renders one persisted drawing onto the current main series/chart and registers its chart objects under the drawing's id — the storage-replay counterpart to the click-handler's live drawing logic above. */
  function renderStoredDrawing(main: MainSeriesApi, chart: IChartApi, drawing: StoredDrawing) {
    if (drawing.type === "horizontal") {
      const line = drawHorizontalLine(main, drawing.price);
      registerRenderedDrawing(drawing.id, [], [line]);
    } else if (drawing.type === "trendline") {
      const [a, b] = drawing.points;
      const line = drawTrendlineShape(chart, a.time, a.price, b.time, b.price);
      if (line) registerRenderedDrawing(drawing.id, [line], []);
    }
  }

  /** Loads this symbol's saved drawings from localStorage and renders every one onto the freshly-(re)built main series. Called whenever the main series is (re)created (mount, symbol change, range/mode switch) — see the mode/data effect below. */
  function loadAndRenderDrawings(main: MainSeriesApi, chart: IChartApi) {
    const drawings = loadDrawings(symbolRef.current);
    savedDrawingsRef.current = drawings;
    renderedDrawingsRef.current = [];
    for (const drawing of drawings) {
      try {
        renderStoredDrawing(main, chart, drawing);
      } catch {
        // A single corrupted/out-of-range saved drawing shouldn't block the
        // rest of the chart from rendering — skip it and keep going.
      }
    }
  }

  /** Appends one freshly-finalized drawing to the persisted set and saves immediately — called right after a trendline/h-line is placed on the chart (see handleClick below), so a mid-session refresh never loses a drawing. */
  function persistNewDrawing(drawing: StoredDrawing) {
    savedDrawingsRef.current = [...savedDrawingsRef.current, drawing];
    persistDrawings(symbolRef.current, savedDrawingsRef.current);
  }

  /**
   * Eraser tool: removes exactly ONE drawing — its on-screen chart objects
   * (via the matching renderedDrawingsRef group) AND its entry in
   * savedDrawingsRef/localStorage — leaving every other drawing untouched.
   * This is the surgical counterpart to clearAllDrawings/"Clear All", which
   * wipes everything.
   */
  function deleteDrawing(id: string, main: MainSeriesApi, chart: IChartApi) {
    const groupIndex = renderedDrawingsRef.current.findIndex((g) => g.id === id);
    if (groupIndex !== -1) {
      const group = renderedDrawingsRef.current[groupIndex];
      for (const series of group.series) {
        try {
          chart.removeSeries(series);
        } catch {
          // already gone — safe to ignore.
        }
      }
      for (const line of group.priceLines) {
        try {
          main.removePriceLine(line);
        } catch {
          // already gone — safe to ignore.
        }
      }
      renderedDrawingsRef.current.splice(groupIndex, 1);
    }
    savedDrawingsRef.current = savedDrawingsRef.current.filter((d) => d.id !== id);
    persistDrawings(symbolRef.current, savedDrawingsRef.current);
  }

  /**
   * Eraser hit-testing: finds the id of whichever saved drawing is closest
   * under the click, within ERASER_HIT_TOLERANCE_PX pixels — or null if
   * nothing was close enough. Iterates savedDrawingsRef in reverse (most
   * recently drawn first) so overlapping drawings prefer deleting the
   * newest/top-most one, matching how a human would expect "click here" to
   * resolve. All geometry is done in PIXEL space (not price/time units) so
   * the tolerance stays visually consistent regardless of the chart's
   * current zoom level or price scale.
   */
  function findDrawingIdAtPoint(main: MainSeriesApi, chart: IChartApi, x: number, y: number): string | null {
    const timeScale = chart.timeScale();
    for (let i = savedDrawingsRef.current.length - 1; i >= 0; i--) {
      const drawing = savedDrawingsRef.current[i];

      if (drawing.type === "horizontal") {
        const ly = main.priceToCoordinate(drawing.price);
        if (ly != null && Math.abs(ly - y) <= ERASER_HIT_TOLERANCE_PX) return drawing.id;
        continue;
      }

      // Only "trendline" reaches here — "horizontal" already returned above,
      // and fibonacci no longer exists as a drawing type (removed round 6).
      const [a, b] = drawing.points;
      const x1 = timeScale.timeToCoordinate(a.time);
      const x2 = timeScale.timeToCoordinate(b.time);
      const y1 = main.priceToCoordinate(a.price);
      const y2 = main.priceToCoordinate(b.price);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue; // an endpoint is outside the currently-rendered range — can't test
      if (distanceToSegment(x, y, x1, y1, x2, y2) <= ERASER_HIT_TOLERANCE_PX) return drawing.id;
    }
    return null;
  }

  /** Removes the live rubber-band preview line (if one exists) and clears its ref. Safe to call even when there's nothing to remove. */
  function removePreviewSeries() {
    const chart = chartRef.current;
    if (chart && previewSeriesRef.current) {
      try {
        chart.removeSeries(previewSeriesRef.current);
      } catch {
        // already gone (e.g. whole chart torn down first) — safe to ignore.
      }
    }
    previewSeriesRef.current = null;
  }

  // Bug fix: switching or cancelling the armed tool (including via Escape,
  // which only ever touches the `drawTool` PROP up in ChartPanel) used to
  // leave a stale drawStartRef behind — click once to set a trendline's
  // start point, hit Escape, re-arm the tool later, and the next click
  // would silently resume from that old, unrelated first point instead of
  // starting fresh. Resetting whenever the armed tool itself changes (to
  // anything, including null) closes that gap, and also cleans up any
  // in-progress rubber-band preview so it can't outlive the tool it
  // belonged to.
  useEffect(() => {
    drawStartRef.current = null;
    removePreviewSeries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawTool]);

  /** Removes every user-drawn trendline/horizontal-line from the chart (all renderedDrawingsRef groups) and empties the tracking ref. Used by both the "Clear Drawings" toolbar action and internally whenever the underlying data set changes (a drawing anchored to old range's dates/prices stops making sense once the range/mode changes). */
  function clearAllDrawings() {
    removePreviewSeries();
    const chart = chartRef.current;
    const main = mainSeriesRef.current;
    for (const group of renderedDrawingsRef.current) {
      if (chart) {
        for (const series of group.series) {
          try {
            chart.removeSeries(series);
          } catch {
            // series may already be gone if the whole chart was torn down first — safe to ignore.
          }
        }
      }
      if (main) {
        for (const line of group.priceLines) {
          try {
            main.removePriceLine(line);
          } catch {
            // same as above.
          }
        }
      }
    }
    renderedDrawingsRef.current = [];
    drawStartRef.current = null;
  }

  // Create the chart instance once, tear it down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.08)", visible: showGrid },
        horzLines: { color: "rgba(148, 163, 184, 0.08)", visible: showGrid },
      },
      rightPriceScale: { borderColor: "rgba(148, 163, 184, 0.15)" },
      timeScale: {
        borderColor: "rgba(148, 163, 184, 0.15)",
        tickMarkFormatter: makeTickMarkFormatter(locale),
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale },
      width: container.clientWidth,
      height: container.clientHeight || 360,
    });
    chartRef.current = chart;

    /**
     * Design-audit item #5 ("Priority Order for Dev Hand-off"): a floating
     * cursor-tracking tooltip to match iCharts' near-cursor time+price
     * readout, without removing the existing crosshair. Purely additive —
     * doesn't touch the grid-toggle/color-picker options or index-aware
     * logic elsewhere in the app.
     */
    function handleCrosshairMove(param: MouseEventParams<Time>) {
      // TS doesn't carry the outer `if (!container) return;` narrowing into
      // a nested function declaration's body, so re-check here explicitly.
      if (!container) return;
      const series = mainSeriesRef.current;
      if (!series || !param.point || !param.time) {
        setTooltip(null);
        return;
      }
      const price = extractTooltipPrice(param.seriesData.get(series));
      if (price == null) {
        setTooltip(null);
        return;
      }
      const maxX = Math.max(container.clientWidth - TOOLTIP_WIDTH - TOOLTIP_MARGIN, TOOLTIP_MARGIN);
      const maxY = Math.max(container.clientHeight - TOOLTIP_HEIGHT - TOOLTIP_MARGIN, TOOLTIP_MARGIN);
      setTooltip({
        x: clamp(param.point.x + 14, TOOLTIP_MARGIN, maxX),
        y: clamp(param.point.y - 12, TOOLTIP_MARGIN, maxY),
        time: formatTooltipTime(param.time, locale),
        price,
      });
    }
    chart.subscribeCrosshairMove(handleCrosshairMove);

    /**
     * Trendline rubber-band drawing preview (live report round 6:
     * "angle & direction control — as the user moves the mouse, a clear
     * dashed line dynamically rotates and stretches following the
     * cursor"). Once the FIRST click has set drawStartRef, every
     * subsequent mouse move updates (or creates, on the very first move) a
     * dashed 2-point ghost line from that anchor to wherever the cursor
     * currently is — the line's angle and length are entirely a function
     * of the live cursor position, recomputed on every event, so slope and
     * direction are fully under the user's control right up until the
     * second click locks it in. Registered as its own
     * subscribeCrosshairMove handler (rather than folded into
     * handleCrosshairMove above) so the tooltip and the preview line stay
     * independent concerns — one purely reads state to render a floating
     * label, the other mutates a chart series.
     */
    function handlePreviewMove(param: MouseEventParams<Time>) {
      const tool = drawToolRef.current;
      const start = drawStartRef.current;
      const main = mainSeriesRef.current;
      const inProgress = start && tool === "trendline";
      if (!inProgress || !main || !param.point || param.paneIndex !== 0) {
        removePreviewSeries();
        return;
      }
      // See resolveTimeAtX's doc comment: the cursor is very often past the
      // last bar (drawing toward "now"), where lightweight-charts leaves
      // `param.time` undefined — without this fallback the rubber-band
      // preview would simply vanish right as the user approaches the most
      // natural place to finish the drawing.
      const time = param.time ?? resolveTimeAtX(chart, dataDatesRef.current, param.point.x);
      if (time == null) {
        removePreviewSeries();
        return;
      }
      const price = main.coordinateToPrice(param.point.y);
      if (price == null) {
        removePreviewSeries();
        return;
      }
      const points = [
        { time: start.time, value: start.price },
        { time, value: price },
      ].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      if (points[0].time === points[1].time) return; // same bar as the start point — nothing sensible to preview yet

      if (!previewSeriesRef.current) {
        previewSeriesRef.current = chart.addSeries(LineSeries, {
          color: hexToRgba(DRAW_COLOR, 0.65),
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        });
      }
      previewSeriesRef.current.setData(points);
    }
    chart.subscribeCrosshairMove(handlePreviewMove);

    /**
     * Chart Tools drawer, drawing tools (ChartPanel.tsx): click-to-draw for
     * trendline (2 clicks: anchor, then target), horizontal line (1 click),
     * and click-to-delete for the eraser. Reads drawToolRef/
     * onDrawCompleteRef rather than the `drawTool`/`onDrawComplete` props
     * directly since this handler is registered once here (effect depends
     * only on `locale`, matching the crosshair handler above) and must
     * still see whichever tool is CURRENTLY armed, not whichever was armed
     * at chart-creation time.
     */
    function handleClick(param: MouseEventParams<Time>) {
      const tool = drawToolRef.current;
      const main = mainSeriesRef.current;
      if (!tool || !main || !param.point) return;
      // Bug fix (live report/screenshot): drawing tools only make sense on
      // the main price pane (index 0). RSI's pane is a 0-100 scale and
      // MACD's is a small oscillator range — both totally unrelated to the
      // main series' price scale, so a click in either used to still run
      // through `main.coordinateToPrice(param.point.y)` (pane-relative y,
      // interpreted against the WRONG pane's scale) and produced wildly
      // wrong prices, e.g. an "H-Line" landing near the top of the main
      // scale no matter where in the RSI pane was actually clicked. Ignore
      // clicks outside pane 0 entirely rather than try to guess a mapping
      // that doesn't exist.
      if (param.paneIndex !== 0) return;

      // Eraser: click-to-delete for exactly one drawing. Doesn't need
      // `param.time` (a click on a horizontal line's flat price only needs
      // the Y pixel), and deliberately stays armed after each delete — no
      // onDrawCompleteRef call — so multiple drawings can be erased in a
      // row without re-arming the tool each time.
      if (tool === "eraser") {
        const chartInstance = chartRef.current;
        if (!chartInstance) return;
        const hitId = findDrawingIdAtPoint(main, chartInstance, param.point.x, param.point.y);
        if (hitId) deleteDrawing(hitId, main, chartInstance);
        return;
      }

      // See resolveTimeAtX's doc comment: a click landing past the last bar
      // (very common — drawing toward the most recent price action) leaves
      // `param.time` undefined by default; falling back to the nearest real
      // bar via logical-index rounding is what stops that click from being
      // silently swallowed.
      const time = param.time ?? resolveTimeAtX(chartRef.current, dataDatesRef.current, param.point.x);
      if (time == null) return; // every other tool needs a time coordinate

      const price = main.coordinateToPrice(param.point.y);
      if (price == null) return;

      if (tool === "horizontal") {
        // Wrapped in try/finally: if createPriceLine ever throws (malformed
        // price, series mid-teardown, etc.), the tool must still disarm
        // rather than stay silently "stuck" armed with no visible feedback.
        try {
          const id = makeDrawingId();
          const line = drawHorizontalLine(main, price);
          registerRenderedDrawing(id, [], [line]);
          persistNewDrawing({ id, type: "horizontal", price });
        } finally {
          onDrawCompleteRef.current?.();
        }
        return;
      }

      const start = drawStartRef.current;
      if (!start) {
        // First click: set the anchor. The rubber-band preview (a separate
        // subscribeCrosshairMove handler above) picks this up on the very
        // next mouse move — no second click required to see it.
        drawStartRef.current = { time, price };
        return;
      }
      // Second click: finalize immediately — everything below is
      // synchronous and wrapped in try/finally, so there's no intermediate
      // "stuck" state between clearing drawStartRef and the tool disarming,
      // even if the drawing itself fails partway through.
      drawStartRef.current = null;
      removePreviewSeries();

      const chartInstance = chartRef.current;
      if (!chartInstance) return;

      // See resolveDistinctTimeAtX's doc comment: a second click landing on
      // the SAME bar as the first (very easy on a zoomed-out range) used to
      // silently produce nothing at all. Force the two anchors apart before
      // handing off to the shape builders, which both legitimately require
      // (and rely on lightweight-charts requiring) distinct times.
      let finalTime = time;
      if (String(finalTime) === String(start.time)) {
        finalTime = resolveDistinctTimeAtX(chartInstance, dataDatesRef.current, param.point.x, start.time) ?? finalTime;
      }

      // "trendline" is the only tool that reaches this point — "horizontal"
      // already returned above, "eraser" too, and fibonacci no longer
      // exists (removed round 6).
      try {
        const line = drawTrendlineShape(chartInstance, start.time, start.price, finalTime, price);
        if (line) {
          const id = makeDrawingId();
          registerRenderedDrawing(id, [line], []);
          persistNewDrawing({
            id,
            type: "trendline",
            points: [
              { time: String(start.time), price: start.price },
              { time: String(finalTime), price },
            ],
          });
        }
      } finally {
        onDrawCompleteRef.current?.();
      }
    }
    chart.subscribeClick(handleClick);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      chart.resize(Math.max(Math.floor(width), 0), Math.max(Math.floor(height), 200));
    });
    ro.observe(container);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.unsubscribeCrosshairMove(handlePreviewMove);
      chart.unsubscribeClick(handleClick);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      smaSeriesRef.current = null;
      emaSeriesRef.current = new Map();
      bollingerSeriesRef.current = [];
      rsiSeriesRef.current = null;
      macdSeriesRef.current = [];
      renderedDrawingsRef.current = [];
      drawStartRef.current = null;
      savedDrawingsRef.current = [];
      indicatorLegendInfoRef.current = [];
      previewSeriesRef.current = null;
      setTooltip(null);
      setIndicatorLegend([]);
    };
    // showGrid is intentionally read only as this effect's *initial* value —
    // it must stay out of the deps array, since re-running it would tear
    // down and recreate the whole chart (losing zoom/scroll position) just
    // to flip a grid switch. Live toggling is handled by the dedicated
    // applyOptions() effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  // Fix (live report: "second click doesn't reliably finalize / feels
  // stuck"): lightweight-charts' default pan/zoom handling treats even a
  // tiny pointer drift between mousedown and mouseup as a pan gesture
  // rather than a click, which can silently swallow the SECOND click of a
  // trendline draw (or occasionally the first) without
  // `subscribeClick` ever firing — nothing visibly happens, so it reads as
  // the tool being "stuck". Disabling scroll/scale entirely for as long as
  // a draw tool is armed removes that ambiguity: every pointer interaction
  // while drawing is unambiguously a click, not a maybe-pan. Restored the
  // instant the tool is disarmed (finalized shape, Escape, or switching
  // tools), so normal pan/zoom is back for everyday chart browsing.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const drawing = drawTool != null;
    chart.applyOptions({
      handleScroll: !drawing,
      handleScale: !drawing,
    });
  }, [drawTool]);

  // Live grid visibility toggle — applyOptions() rather than baking it into
  // the creation effect above, so flipping the switch doesn't tear down and
  // recreate the whole chart (losing zoom/scroll position).
  useEffect(() => {
    chartRef.current?.applyOptions({
      grid: {
        vertLines: { visible: showGrid },
        horzLines: { visible: showGrid },
      },
    });
  }, [showGrid]);

  // Fix (live report: "fullscreen button fails to resize the chart to the
  // full viewport"): the ResizeObserver above already resizes the chart on
  // every container size change, and normally that's sufficient — but the
  // fullscreen toggle also runs a CSS transition (see ChartPanel.tsx's
  // `transition-all duration-300`), and relying solely on the observer's
  // own callback timing can leave the chart visibly a frame or two behind
  // the container while that transition is mid-flight. This effect forces
  // an immediate, synchronous `chart.resize()` off the container's ACTUAL
  // current bounding box the instant `fullHeight` flips, so the canvas
  // never lags behind the "true full screen" size the container is about
  // to animate to/from.
  useEffect(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    const rect = container.getBoundingClientRect();
    chart.resize(Math.max(Math.floor(rect.width), 0), Math.max(Math.floor(rect.height), 200));
  }, [fullHeight]);

  // Swap the main series whenever mode/data/direction/color changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainSeriesRef.current) {
      chart.removeSeries(mainSeriesRef.current);
      mainSeriesRef.current = null;
    }
    // A previous range/mode's drawings are attached to the OLD main series
    // (price lines) or were just visually stale — clear them here rather
    // than leave orphaned lines pointing at a series that's about to be
    // removed. This is purely a VISUAL clear: the persisted set in
    // localStorage (savedDrawingsRef) is untouched, and gets reloaded and
    // redrawn onto the new main series a few lines down, so switching
    // range/mode/symbol never actually loses a drawing — only "Clear All"
    // (the clearDrawingsToken effect below) touches the persisted set.
    clearAllDrawings();
    // The old series (and any hovered point on it) is gone — clear any
    // stale floating tooltip rather than leaving it pinned to a price
    // that no longer belongs to the chart underneath it.
    setTooltip(null);

    if (data.length === 0) return;

    const upDownColor = overrideColor ?? (positive ? SUCCESS : DESTRUCTIVE);
    seriesColorRef.current = upDownColor;

    if (mode === "area") {
      const series = chart.addSeries(AreaSeries, {
        lineColor: upDownColor,
        topColor: hexToRgba(upDownColor, 0.35),
        bottomColor: hexToRgba(upDownColor, 0.02),
        lineWidth: 2,
      });
      series.setData(data.map((d) => ({ time: d.date, value: d.close })));
      mainSeriesRef.current = series;
    } else {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: overrideColor ?? SUCCESS,
        downColor: overrideColor ?? DESTRUCTIVE,
        borderVisible: false,
        wickUpColor: overrideColor ?? SUCCESS,
        wickDownColor: overrideColor ?? DESTRUCTIVE,
      });
      series.setData(
        data.map((d) => ({
          time: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        }))
      );
      mainSeriesRef.current = series;
    }

    // Persistence (live report: "drawings disappear on refresh"): reload
    // this symbol's saved drawings from localStorage and redraw every one
    // onto the just-(re)built main series. Runs on mount, on every symbol
    // change (new `data`), and on every range/mode switch — localStorage is
    // always the up-to-date source of truth since every finalized drawing
    // is persisted immediately (see persistNewDrawing in the click
    // handler), so reloading here is cheap and keeps drawings visible no
    // matter what triggered this effect.
    if (mainSeriesRef.current) {
      loadAndRenderDrawings(mainSeriesRef.current, chart);
    }

    chart.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, data, positive, overrideColor, symbol]);

  // SMA overlay toggle.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (smaSeriesRef.current) {
      chart.removeSeries(smaSeriesRef.current);
      smaSeriesRef.current = null;
    }
    // Drop any stale SMA entry before possibly re-adding a fresh one below.
    indicatorLegendInfoRef.current = indicatorLegendInfoRef.current.filter((info) => info.id !== "sma");

    if (showSma && indicatorSource.length > smaPeriod) {
      const points = visibleSlice(computeSma(indicatorSource, smaPeriod), visibleStartDate);
      if (points.length > 0) {
        const series = chart.addSeries(LineSeries, {
          color: SMA_COLOR,
          lineWidth: 2,
          crosshairMarkerVisible: false,
          // Live report round 2: a right-margin axis-tag overlay (the
          // previous fix for "EMA labels float over the candles") still
          // visually crowded the real price-scale numbers up close.
          // Suppressed the native/previous badge entirely — the legend row
          // above the chart (rendered in the JSX below) is now the only
          // place SMA/EMA values are shown, fully outside the price scale.
          lastValueVisible: false,
          // Root-cause fix (live report round 5): lastValueVisible only
          // suppresses the axis BADGE — it does nothing to
          // `priceLineVisible`, which defaults to true and independently
          // draws its own full-width dashed line across the whole pane at
          // the series' last value. That stray line was still rendering
          // (unlabeled, since the badge that would have identified it was
          // just turned off), reading exactly like "an indicator with no
          // label" even though the actual text lives in the legend row.
          // Must be turned off explicitly for the legend to be the ONLY
          // on-chart trace of this series' value.
          priceLineVisible: false,
        });
        series.setData(points);
        smaSeriesRef.current = series;
        const lastValue = points[points.length - 1]?.value;
        if (lastValue != null) {
          indicatorLegendInfoRef.current.push({ id: "sma", label: `SMA ${smaPeriod}`, color: SMA_COLOR, value: lastValue });
        }
      }
    }
    refreshIndicatorLegend();
  }, [showSma, smaPeriod, indicatorSource, visibleStartDate]);

  // EMA overlay toggles (50/100/150/200, any subset) — same pane as the
  // main series, alongside SMA. Rebuilt from scratch on every toggle/data
  // change (remove-then-recreate), same pattern as every other overlay in
  // this file, keyed by period in a Map so periods can be added/removed
  // independently without disturbing the others.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const series of emaSeriesRef.current.values()) chart.removeSeries(series);
    emaSeriesRef.current = new Map();
    indicatorLegendInfoRef.current = indicatorLegendInfoRef.current.filter((info) => !info.id.startsWith("ema-"));

    for (const period of emaPeriods) {
      const points = visibleSlice(computeEmaSeries(indicatorSource, period), visibleStartDate);
      if (points.length === 0) continue;
      const color = EMA_COLORS[period] ?? EMA_COLORS[50];
      const series = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        crosshairMarkerVisible: false,
        // Same fix as SMA above — replaced by the legend row instead of a
        // native/price-scale badge.
        lastValueVisible: false,
        // Root-cause fix (live report round 5): see the matching comment on
        // the SMA series above — priceLineVisible is a SEPARATE option from
        // lastValueVisible and defaults to true, so every active EMA was
        // still drawing its own full-width, unlabeled dashed line across
        // the pane even with the axis badge suppressed.
        priceLineVisible: false,
      });
      series.setData(points);
      emaSeriesRef.current.set(period, series);
      const lastValue = points[points.length - 1]?.value;
      if (lastValue != null) {
        indicatorLegendInfoRef.current.push({ id: `ema-${period}`, label: `EMA ${period}`, color, value: lastValue });
      }
    }
    refreshIndicatorLegend();
    // emaPeriods is an array prop that may get a fresh identity each render
    // — depending on its sorted/joined contents (not the array reference)
    // avoids tearing down and rebuilding every EMA series on every
    // unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emaPeriods.slice().sort().join(","), indicatorSource, visibleStartDate]);

  // Bollinger Bands overlay toggle — three lines (upper/middle/lower), same pane as the main series.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const series of bollingerSeriesRef.current) chart.removeSeries(series);
    bollingerSeriesRef.current = [];

    if (showBollinger) {
      const bands = visibleSlice(computeBollingerBands(indicatorSource, 20, 2), visibleStartDate);
      if (bands.length > 0) {
        const upper = chart.addSeries(LineSeries, {
          color: BOLLINGER_COLOR,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
        });
        upper.setData(bands.map((b) => ({ time: b.time, value: b.upper })));
        const middle = chart.addSeries(LineSeries, {
          color: BOLLINGER_COLOR,
          lineWidth: 1,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
        });
        middle.setData(bands.map((b) => ({ time: b.time, value: b.middle })));
        const lower = chart.addSeries(LineSeries, {
          color: BOLLINGER_COLOR,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
        });
        lower.setData(bands.map((b) => ({ time: b.time, value: b.lower })));
        bollingerSeriesRef.current = [upper, middle, lower];
      }
    }
  }, [showBollinger, indicatorSource, visibleStartDate]);

  // RSI + MACD sub-panes, managed together so pane indices stay consistent
  // (RSI gets pane 1 if active; MACD gets whichever of pane 1/2 is free —
  // i.e. pane 1 if RSI is off, pane 2 if RSI is also on). lightweight-charts
  // v5's chart.addSeries(definition, options, paneIndex) auto-creates a
  // pane at that index the first time it's used.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (rsiSeriesRef.current) {
      chart.removeSeries(rsiSeriesRef.current);
      rsiSeriesRef.current = null;
    }
    for (const series of macdSeriesRef.current) chart.removeSeries(series);
    macdSeriesRef.current = [];

    let nextPane = 1;

    if (showRsi) {
      const points = visibleSlice(computeRsiSeries(indicatorSource, 14), visibleStartDate);
      if (points.length > 0) {
        const rsiPane = nextPane++;
        const series = chart.addSeries(
          LineSeries,
          { color: RSI_COLOR, lineWidth: 2, crosshairMarkerVisible: false, title: "RSI 14" },
          rsiPane
        );
        series.setData(points);
        series.createPriceLine({ price: 70, color: "rgba(239, 68, 68, 0.5)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
        series.createPriceLine({ price: 30, color: "rgba(16, 185, 129, 0.5)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
        chart.panes()[rsiPane]?.setStretchFactor(0.4);
        rsiSeriesRef.current = series;
      }
    }

    if (showMacd) {
      const macdResult = computeMacd(indicatorSource, 12, 26, 9);
      const macd = visibleSlice(macdResult.macd, visibleStartDate);
      const signal = visibleSlice(macdResult.signal, visibleStartDate);
      const histogram = visibleSlice(macdResult.histogram, visibleStartDate);
      if (macd.length > 0) {
        const macdPane = nextPane++;
        const histSeries = chart.addSeries(
          HistogramSeries,
          { priceFormat: { type: "price", precision: 3, minMove: 0.001 } },
          macdPane
        );
        histSeries.setData(histogram);
        const macdSeries = chart.addSeries(
          LineSeries,
          { color: MACD_COLOR, lineWidth: 2, crosshairMarkerVisible: false, lastValueVisible: false },
          macdPane
        );
        macdSeries.setData(macd);
        const signalSeries = chart.addSeries(
          LineSeries,
          { color: MACD_SIGNAL_COLOR, lineWidth: 1, crosshairMarkerVisible: false, lastValueVisible: false },
          macdPane
        );
        signalSeries.setData(signal);
        chart.panes()[macdPane]?.setStretchFactor(0.4);
        macdSeriesRef.current = [histSeries, macdSeries, signalSeries];
      }
    }
  }, [showRsi, showMacd, indicatorSource, visibleStartDate]);

  // "Clear Drawings" toolbar action — bump clearDrawingsToken to trigger.
  // Unlike the mode/data effect's clearAllDrawings() call above (a purely
  // visual clear, immediately followed by reloading + redrawing from
  // localStorage), THIS is the one place that actually deletes the
  // persisted set for the current symbol — wiping both the in-memory
  // savedDrawingsRef and the localStorage entry itself, per the live
  // report's "Clear All ... also clears localStorage for that ticker".
  useEffect(() => {
    if (clearDrawingsToken > 0) {
      clearAllDrawings();
      savedDrawingsRef.current = [];
      clearPersistedDrawings(symbolRef.current);
    }
    // clearAllDrawings intentionally excluded from deps: it's a stable
    // function of refs only (no props/state it needs to stay fresh
    // against), redeclaring it every render would just churn the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDrawingsToken]);

  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-2",
        // The chart container below now handles its own height (fixed in
        // normal mode, flex-1 in fullscreen) — this outer wrapper just
        // needs to participate in the fullscreen flex column so the legend
        // row sits above the chart without stealing its height.
        fullHeight && "h-full min-h-0"
      )}
    >
      {/* Live report (round 3): SMA/EMA badges positioned inside the
          right-margin price-scale gutter (previous fix) still visually
          crowded the real axis tick numbers up close. Moved indicator
          values out of the price scale entirely into this plain legend
          row above the chart — no coordinate math, so it can never
          overlap chart content or axis labels again. */}
      {indicatorLegend.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
          {indicatorLegend.map((item) => (
            <span
              key={item.id}
              className="flex items-center gap-1.5 font-mono text-xs font-medium text-muted-foreground"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              {item.label}: <span className="text-foreground">{item.value.toFixed(2)}</span>
            </span>
          ))}
        </div>
      )}
      <div
        ref={containerRef}
        className={cn(
          "relative w-full min-w-0 overflow-hidden",
          fullHeight ? "min-h-0 flex-1" : "h-[320px] sm:h-[400px]",
          // QA fix (live report: "Eraser cursor doesn't change"): a plain
          // inline `style.cursor` here used to lose to lightweight-charts'
          // own inline cursor styling on its internal canvas elements — see
          // the `.chart-eraser-active`/`.chart-draw-active` !important rules
          // in globals.css for why a stylesheet class, not inline style, is
          // what actually wins this fight.
          drawTool === "eraser" && "chart-eraser-active",
          drawTool && drawTool !== "eraser" && "chart-draw-active"
        )}
        // QA fix (diagnostic: "stale hover tooltip persists after cursor
        // moves away"): lightweight-charts fires subscribeCrosshairMove with
        // an empty param (clearing the tooltip) when it detects the pointer
        // leaving its own canvas via mousemove tracking — but a fast pointer
        // exit, or the pointer leaving via a click on an element elsewhere on
        // the page (e.g. a different DataExplorerTabs tab) rather than a
        // continuous mousemove trail out through the container's edge, can
        // land outside the chart without that internal handler ever firing.
        // A plain onMouseLeave on the container is a guaranteed, library-
        // independent safety net: the browser always fires it when the
        // pointer's bounding-box exit happens, regardless of how it got
        // there, so the tooltip can never outlive the cursor being over it.
        onMouseLeave={() => setTooltip(null)}
      >
        {tooltip && (
          <div
            className="pointer-events-none absolute z-10 flex flex-col gap-1 rounded-md border border-white/10 bg-slate-900/95 px-3 py-2 shadow-lg backdrop-blur-sm"
            style={{ left: tooltip.x, top: tooltip.y, width: TOOLTIP_WIDTH }}
          >
            <span className="text-[10px] text-muted-foreground">{tooltip.time}</span>
            <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-foreground">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: seriesColorRef.current }}
              />
              {tooltip.price.toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
