import { Skeleton } from "@/components/shared/Skeleton";

/**
 * Mobile UX audit fix: this route previously had no loading.tsx at all, so
 * Next.js showed nothing but a blank content area for however long
 * getFundamentals() (yahoo.ts) took — Yahoo + FMP fetched in
 * parallel, plus daily price history, is comfortably a
 * multi-second round trip on a slow mobile connection. Fast scrolling
 * straight into that gap (navigating from Watchlist/Portfolio/search
 * results into a ticker page) read as a broken/frozen page rather than
 * "still loading."
 *
 * Mirrors the real page's structure (app/(dashboard)/analysis/[symbol]/page.tsx)
 * closely enough that layout doesn't visibly jump once real content
 * replaces it: same flex-col/lg:flex-row grid, same fixed-width left
 * column, same glass-card chart + tab-strip shapes on the right. Uses the
 * shared Skeleton primitive (components/shared/Skeleton.tsx) already
 * established for the Home dashboard's IndexCard loading state, so the
 * shimmer/pulse treatment is consistent across the app rather than a
 * one-off for this route.
 */
export default function AnalysisLoading() {
  return (
    <div className="animate-in fade-in duration-300">
      {/* Mobile header bar (logo/back button) equivalent — see MobileTickerHeader */}
      <div className="mb-4 flex items-center gap-3 lg:hidden">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-4 w-24" />
      </div>

      <div className="analysis-grid flex flex-col gap-6 lg:flex-row">
        {/* Left column: company profile card + metrics accordions */}
        <div className="order-2 w-full space-y-4 lg:order-1 lg:w-[22rem] lg:shrink-0">
          <div className="glass-card rounded-2xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <div className="mt-4 space-y-2.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </div>
          </div>
          <div className="glass-card space-y-3 rounded-2xl p-4 sm:p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-lg" />
            ))}
          </div>
        </div>

        {/* Right column: live price header + chart + tab explorer */}
        <div className="order-1 min-w-0 flex-1 space-y-6 lg:order-2">
          <div className="glass-card flex items-center justify-between rounded-2xl p-4 sm:p-5">
            <div className="space-y-2">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3.5 w-20" />
            </div>
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>

          <div className="glass-card rounded-2xl p-4 sm:p-5">
            <div className="mb-3 flex items-center gap-2">
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-5 w-16" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-9 w-64 rounded-lg" />
              <Skeleton className="h-5 w-28" />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Skeleton className="h-11 w-24 rounded-lg" />
              <Skeleton className="h-11 w-11 rounded-lg" />
              <Skeleton className="h-11 w-11 rounded-lg" />
              <Skeleton className="h-11 w-20 rounded-lg" />
            </div>
            <Skeleton className="mt-4 h-72 w-full rounded-xl sm:h-96" />
          </div>

          <div className="glass-card rounded-2xl p-4 sm:p-5">
            <div className="flex gap-1 border-b border-slate-800/80 pb-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11 min-w-[68px] flex-1 rounded-lg" />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-48 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
