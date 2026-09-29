import { useMemo } from "react";
import { computeRatios } from "@/lib/finance/ratios";
import { computePriceToEarningsHistory } from "@/lib/finance/ratioHistory";
import type { BalanceSheetYear, IncomeStatementYear, PricePoint, TickerMetrics } from "@/lib/finance/types";
import { RatioHistoryChart } from "./RatioHistoryChart";

interface RatiosPanelProps {
  income: IncomeStatementYear[];
  balance: BalanceSheetYear[];
  metrics: TickerMetrics;
  /** Quarterly income counterpart — see FundamentalsBundle.incomeQuarterly in
   *  lib/finance/types.ts. Preferred basis for the Valuation Ratios' P/E
   *  history (a genuine rolling TTM walk); the historical chart falls back
   *  to annual `income` when this is empty/too thin — see
   *  lib/finance/ratioHistory.ts. */
  incomeQuarterly?: IncomeStatementYear[];
  /** Daily closes — see FundamentalsBundle.history. Required to plot P/E
   *  over time at all; the Valuation Ratios section is simply omitted when
   *  empty (e.g. mock/demo data with no price history attached). */
  history?: PricePoint[];
  quoteCurrency?: string;
  reportingCurrency?: string;
}

function formatValue(value: number | null, format: "ratio" | "percent"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return format === "percent" ? `${value.toFixed(1)}%` : `${value.toFixed(2)}x`;
}

export function RatiosPanel({
  income,
  balance,
  metrics,
  incomeQuarterly = [],
  history = [],
  quoteCurrency,
  reportingCurrency,
}: RatiosPanelProps) {
  const categories = computeRatios({ income, balance, metrics });

  // Only meaningful once we have both a real price to divide and reporting
  // currencies for both sides of that division — mock/demo data or a symbol
  // with no attached price history simply omits this section rather than
  // rendering an empty/broken chart (same principle as every other panel's
  // emptyStateMessage/quarterlyAvailable gating in this codebase).
  const peHistory = useMemo(() => {
    if (history.length === 0 || !quoteCurrency || !reportingCurrency) return null;
    return computePriceToEarningsHistory({
      history,
      incomeQuarterly,
      incomeAnnual: income,
      quoteCurrency,
      reportingCurrency,
    });
  }, [history, incomeQuarterly, income, quoteCurrency, reportingCurrency]);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      {peHistory && (
        <div className="sm:col-span-2">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Valuation Ratios</h3>
          <RatioHistoryChart title="Price to Earnings (P/E)" subtitle="Trailing twelve months, daily" data={peHistory} />
        </div>
      )}
      {categories.map((category) => (
        <div key={category.title} className="glass-card min-w-0 rounded-xl p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">{category.title}</h3>
          <dl className="space-y-2.5">
            {category.items.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-1 text-xs text-muted-foreground" title={item.note}>
                  {item.label}
                  {item.note && (
                    <span className="text-[10px] text-muted-foreground/70" aria-hidden="true">
                      *
                    </span>
                  )}
                </dt>
                <dd className="font-mono text-sm font-medium text-foreground">
                  {formatValue(item.value, item.format)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}

      <p className="sm:col-span-2 text-[10px] text-muted-foreground">
        * Quick Ratio is approximated as Cash &amp; ST Investments ÷ Current Liabilities — inventory and
        receivables aren&apos;t broken out separately in this data model.
      </p>
    </div>
  );
}
