import { useMemo } from "react";
import { AlertTriangle, Database } from "lucide-react";
import { formatSourceSummary, summarizeYearSources, type YearRow } from "@/lib/finance/aggregate";

interface SourceAttributionBadgeProps<T extends YearRow> {
  years: T[];
}

/**
 * Small transparency caption for the multi-source aggregation pipeline
 * (see lib/finance/aggregate.ts): shows exactly which provider each fiscal
 * year's figures came from, e.g. "2020-2023: Yahoo Finance · 2024-2026:
 * Financial Modeling Prep". Renders nothing for mock/demo data (rows have no `dataSource`
 * tag — see FinancialDataSource's doc comment in lib/finance/types.ts) or
 * once merged data happens to come entirely from a single source with
 * nothing else worth calling out... actually always renders when there's
 * at least one tagged row, single-source included, so it's never
 * ambiguous whether a given chart is showing real attributed data.
 *
 * Also surfaces mergeYearsBySource's `dataDiscrepancy` flag (see that
 * function's doc comment): when 2+ sources disagreed beyond tolerance for
 * one or more periods — most commonly a just-released quarter one
 * provider has indexed and another hasn't yet — a second line names which
 * period(s), instead of that signal only ever reaching a dev console log.
 */
export function SourceAttributionBadge<T extends YearRow>({ years }: SourceAttributionBadgeProps<T>) {
  const summary = useMemo(() => formatSourceSummary(summarizeYearSources(years)), [years]);
  const disagreeingPeriods = useMemo(
    () => years.filter((y) => y.dataDiscrepancy).map((y) => y.fiscalYear),
    [years]
  );
  if (!summary) return null;
  return (
    <div className="space-y-1 px-1">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Database className="h-3 w-3 shrink-0" />
        <span>
          <span className="font-medium text-muted-foreground/80">Sources:</span> {summary}
        </span>
      </p>
      {disagreeingPeriods.length > 0 && (
        <p
          className="flex items-center gap-1.5 text-[11px] text-amber-500"
          title="Two or more independent data sources reported different figures for this period beyond the normal provider-to-provider tolerance — often a just-released quarter one provider has indexed and another hasn't caught up to yet. Verify before relying on it."
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>
            <span className="font-medium">Sources disagree:</span> {disagreeingPeriods.join(", ")} — verify before relying on it
          </span>
        </p>
      )}
    </div>
  );
}
