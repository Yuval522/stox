/**
 * SEC EDGAR — real, free, keyless public filing data used by the Reports
 * tab. Unlike FMP (lib/finance/providers/fmp.ts), this needs no API key at
 * all: EDGAR's JSON endpoints are open to anyone who sends a proper,
 * identifying User-Agent header (SEC's fair-access policy — requests
 * without one get blocked). We default to a generic app-identifying
 * string but let it be overridden via SEC_EDGAR_CONTACT env var so a real
 * deployment can put a real contact email in it, which is what SEC
 * actually asks for and reduces the odds of the shared default getting
 * rate-limited if many people run this app unmodified.
 *
 * CONFIRMED against SEC's official Developer FAQ
 * (sec.gov/about/webmaster-frequently-asked-questions#developers, "Last
 * Reviewed or Updated: Aug. 23, 2024" — fetched directly during this
 * session, not assumed): a declared User-Agent is genuinely required, not
 * a best-practice suggestion. The FAQ states verbatim: "Please declare
 * your user agent in request headers," gives the sample shape "Sample
 * Company Name AdminContact@<sample company domain>.com", and documents
 * the exact failure mode this file guards against — requests without one
 * (or with one that doesn't look like that shape) get an "Undeclared
 * Automated Tool" error/403. There is no SEC-sanctioned shared or
 * anonymous-access default; every application is expected to declare its
 * own. Separately, SEC also enforces a flat 10-requests/second-per-IP rate
 * limit across www.sec.gov / data.sec.gov / efts.sec.gov (unrelated to the
 * UA requirement — no header satisfies it, it's purely a request-rate
 * cap), not a concern for this app's per-page-load request volume.
 *
 * Since there's no way to *not* require a UA and stay within SEC's policy,
 * "robust" here means: (1) ship a default that's shaped exactly like SEC's
 * own sample so it passes the same check a real one would, so the app
 * never hard-fails for lack of local .env setup, while (2) making very
 * clear via the startup warning below that a real SEC_EDGAR_CONTACT is
 * still what SEC is actually asking for, and (3) every fetch in this file
 * has a request timeout (see FETCH_TIMEOUT_MS) and resolves a well-formed
 * "unavailable" status rather than throwing or hanging, so a slow/blocked
 * SEC response degrades to the Yahoo/FMP fallback layers (aggregate.ts)
 * instead of ever blocking the whole fundamentals request.
 *
 * IMPORTANT — unverified live in this environment: outbound network access
 * to data.sec.gov / www.sec.gov is blocked by this sandbox's egress proxy
 * (the same restriction already documented for Yahoo Finance and FMP), so
 * these calls could not be exercised end-to-end here. The request shapes
 * below follow SEC's publicly documented EDGAR APIs. Spot-check against a
 * real deployment before relying on it, the same way you would for any
 * third-party integration built without the ability to hit the real
 * endpoint during development.
 */

import type { BalanceSheetYear, CashFlowYear, IncomeStatementYear } from "../types";
import { normalizeCapex, normalizeStockBasedComp, computeFreeCashFlow, fiscalYearForPeriodEnd } from "../aggregate";

/**
 * QA fix (bug report: "5Y/10Y range still only shows ~3-4 years despite the
 * multi-source pipeline"): root-caused via SEC's own Developer FAQ
 * (sec.gov/os/webmaster-faq#developers) — EDGAR doesn't just want a
 * non-empty User-Agent string, it specifically checks for a *declared*
 * contact in the form "Company Name AdminContact@domain.com" and returns
 * 403 ("Undeclared Automated Tool") for anything that doesn't look like
 * that, including the previous default here
 * ("FinLens/1.0 (contact: set SEC_EDGAR_CONTACT env var)" — no @ sign, no
 * real domain). Every request silently failed with `status: "unavailable"`
 * as a result (fetchSecFinancials never throws — see below), so the app
 * fell all the way through to Yahoo for every single ticker, and Yahoo's
 * fundamentalsTimeSeries endpoint has an undocumented-by-Yahoo but
 * extensively-reported hard backend cap of ~4 annual periods / ~5 quarters
 * *regardless of period1* (confirmed against yfinance's own scraper source
 * and multiple independent reports — this isn't something any period1/
 * lookback-window tuning on our side can work around). That combination —
 * SEC EDGAR silently 403ing + Yahoo's hard 4-year cap — is exactly the "3-4
 * years no matter what I select" symptom, and it was invisible in server
 * logs because neither failure path logged anything.
 *
 * Two changes address this: a properly SEC-shaped default User-Agent
 * (still a placeholder — there is no substitute for setting
 * SEC_EDGAR_CONTACT to a real contact per SEC's request, see
 * .env.local.example) and, in every fetch function below, an actual
 * console.warn on non-ok responses/thrown errors including the status
 * code, so a 403 here shows up in server logs instead of silently
 * degrading to "no SEC data for any ticker" with zero trace.
 */
// Shaped to match SEC's own sample header exactly ("Sample Company Name
// AdminContact@<sample company domain>.com") — a plain name + space +
// email, ordinary-looking TLD (not a reserved/obviously-fake one like
// .invalid, which no longer looks like the sample and is one more way an
// automated check could reasonably flag it). Still a placeholder, not a
// real monitored inbox — see the module doc comment above for why this
// exists (a working built-in default) versus what SEC actually wants (a
// real SEC_EDGAR_CONTACT).
const DEFAULT_USER_AGENT = "Stox contact@finlens.app";
const USER_AGENT = process.env.SEC_EDGAR_CONTACT || DEFAULT_USER_AGENT;

if (!process.env.SEC_EDGAR_CONTACT) {
  console.warn(
    "[Stox] SEC_EDGAR_CONTACT is not set — SEC EDGAR requests are using a built-in " +
      `placeholder User-Agent ("${DEFAULT_USER_AGENT}"), shaped like the sample SEC's ` +
      "Developer FAQ documents (\"Company Name AdminContact@domain.com\") so requests " +
      "shouldn't be rejected outright, but it is not a real, monitored contact — which is " +
      "what SEC's policy actually asks every application to declare (see " +
      "sec.gov/about/webmaster-frequently-asked-questions#developers). If SEC EDGAR " +
      "requests still fail (403 \"Undeclared Automated Tool\", or any non-2xx logged below), " +
      "financial history silently falls back to Yahoo Finance, which caps annual data at " +
      "~4 fiscal years no matter what range is selected. Set SEC_EDGAR_CONTACT in .env.local " +
      "to a real 'Your App Name you@yourdomain.com' string to fix this properly."
  );
}

/**
 * Every fetch in this file uses this as an AbortSignal.timeout — without
 * it, a hung or very slow response from SEC (rate-limiting, an outage, a
 * network blip) would leave the underlying fetch() pending indefinitely
 * (Node's fetch has no default timeout), and since this file's exports are
 * awaited inside a Promise.all alongside Yahoo/FMP in getFundamentals()
 * (yahoo.ts), that would block the *entire* fundamentals request — not
 * just degrade SEC's contribution to it. 10s is generous for a JSON API
 * response but still well short of what a user would tolerate waiting on.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** True for both DOMException("AbortError") (browser-shaped) and Node's
 *  undici abort error — used to log a clearer "timed out" message instead
 *  of a generic thrown-error one. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

let tickerMapPromise: Promise<Map<string, { cik: number; name: string }> | null> | null = null;

/**
 * SEC's full ticker->CIK map (~800KB, all US-listed/SEC-registered
 * filers). Fetched once per server lifetime and cached in-memory — this
 * list changes rarely enough that a TTL isn't worth the added complexity.
 */
async function getTickerMap(): Promise<Map<string, { cik: number; name: string }> | null> {
  if (!tickerMapPromise) {
    tickerMapPromise = (async () => {
      try {
        const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
          headers: { "User-Agent": USER_AGENT },
          next: { revalidate: 86400 }, // filers list changes rarely — daily is plenty
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.warn(
            `[Stox] SEC EDGAR ticker map fetch failed: HTTP ${res.status} ${res.statusText}. ` +
              (res.status === 403
                ? "This is almost always a rejected/undeclared User-Agent — see SEC_EDGAR_CONTACT in .env.local.example."
                : "Every symbol will fall back to Yahoo-only history until this resolves.")
          );
          return null;
        }
        const raw = (await res.json()) as Record<
          string,
          { cik_str: number; ticker: string; title: string }
        >;
        const map = new Map<string, { cik: number; name: string }>();
        for (const entry of Object.values(raw)) {
          map.set(entry.ticker.toUpperCase(), { cik: entry.cik_str, name: entry.title });
        }
        return map;
      } catch (err) {
        if (isAbortError(err)) {
          console.warn(
            `[Stox] SEC EDGAR ticker map fetch timed out after ${FETCH_TIMEOUT_MS}ms — falling back to Yahoo-only history for every symbol this request.`
          );
        } else {
          console.warn("[Stox] SEC EDGAR ticker map fetch threw:", err instanceof Error ? err.message : err);
        }
        return null;
      }
    })();
  }
  return tickerMapPromise;
}

/**
 * Strips exchange suffixes (".TA", ".L", etc.) to get the bare ticker SEC's
 * map is keyed by — SEC only covers US-listed / SEC-registered filers, so
 * this is a best-effort match (e.g. "TEVA.TA" -> "TEVA", which *does*
 * resolve, since Teva files 20-F/6-K with the SEC as a foreign private
 * issuer under its US ADR ticker).
 */
function bareSymbol(symbol: string): string {
  return symbol.split(".")[0].toUpperCase();
}

export interface FilingRecord {
  form: string;
  filingDate: string;
  reportDate: string | null;
  description: string | null;
  accessionNumber: string;
  /** Direct link to the primary filing document on SEC EDGAR. */
  url: string;
}

const REPORT_FORM_TYPES = new Set(["10-K", "10-Q", "20-F", "6-K", "10-K/A", "10-Q/A"]);

/**
 * QA fix (live report: Reports tab confidently told a user INTC — a major
 * US-listed, SEC-registered company — has no SEC filings, "as expected for
 * symbols that aren't US-listed or SEC-registered"). That's not possible
 * for INTC to be true, which means the *real* failure was something else
 * entirely — most likely the ticker-map or submissions fetch failing
 * (network hiccup, SEC rate-limiting, a bad User-Agent) — but the old
 * `Promise<CompanyFilings | null>` return type collapsed every failure
 * mode into the same `null`, and the API route/UI then confidently
 * reported the ONE specific, mostly-wrong explanation ("not registered")
 * for all of them. This result type keeps them distinct so the UI can
 * finally tell a real "SEC has never heard of this ticker" (true for,
 * say, most non-US small-caps) apart from "we couldn't reach SEC EDGAR
 * just now" (true for network blips, and honestly the more likely
 * explanation for any well-known US ticker showing up empty).
 */
export type FilingsResult =
  | { status: "ok"; cik: number; companyName: string; filings: FilingRecord[] }
  | { status: "not-registered" }
  | { status: "unavailable" };

/**
 * Recent 10-K/10-Q (or 20-F/6-K for foreign private issuers) filings for a
 * symbol, newest first.
 */
export async function fetchRecentFilings(symbol: string, limit = 12): Promise<FilingsResult> {
  const map = await getTickerMap();
  if (!map) return { status: "unavailable" };

  const match = map.get(bareSymbol(symbol));
  if (!match) return { status: "not-registered" };

  const cikPadded = String(match.cik).padStart(10, "0");
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cikPadded}.json`, {
      headers: { "User-Agent": USER_AGENT },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[Stox] SEC EDGAR submissions fetch failed for ${symbol} (CIK ${match.cik}): HTTP ${res.status} ${res.statusText}`);
      return { status: "unavailable" };
    }
    const data = await res.json();

    const recent = data?.filings?.recent;
    if (!recent?.form) return { status: "unavailable" };

    const filings: FilingRecord[] = [];
    for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
      const form = String(recent.form[i]);
      if (!REPORT_FORM_TYPES.has(form)) continue;

      const accessionNumber = String(recent.accessionNumber[i]);
      const primaryDocument = String(recent.primaryDocument[i] ?? "");
      const accessionNoDashes = accessionNumber.replace(/-/g, "");

      filings.push({
        form,
        filingDate: String(recent.filingDate[i]),
        reportDate: recent.reportDate?.[i] ? String(recent.reportDate[i]) : null,
        description: recent.primaryDocDescription?.[i] ? String(recent.primaryDocDescription[i]) : null,
        accessionNumber,
        url: `https://www.sec.gov/Archives/edgar/data/${match.cik}/${accessionNoDashes}/${primaryDocument}`,
      });
    }

    // A real CIK with zero matching report-type filings on record is
    // genuinely rare but not impossible (a brand-new registrant) — "ok"
    // with an empty array is still the honest status here, since we DID
    // successfully identify and query the company; it's not a lookup or
    // network failure.
    return { status: "ok", cik: match.cik, companyName: match.name, filings };
  } catch (err) {
    if (isAbortError(err)) {
      console.warn(`[Stox] SEC EDGAR submissions fetch timed out after ${FETCH_TIMEOUT_MS}ms for ${symbol} (CIK ${match.cik}).`);
    } else {
      console.warn(`[Stox] SEC EDGAR submissions fetch threw for ${symbol}:`, err instanceof Error ? err.message : err);
    }
    return { status: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// XBRL company facts — deep (often 10-20 year) audited historical financial
// statements, straight from each filer's own 10-K/20-F XBRL tagging. This is
// the "multi-source aggregation" architecture's primary — and, in practice,
// *only* — deep-history source (see lib/finance/aggregate.ts): Yahoo
// Finance's fundamentalsTimeSeries has a hard backend cap of roughly 4
// annual periods / 5 quarters *regardless of period1* (confirmed against
// yfinance's own scraper source and multiple independent reports — not
// something any lookback-window tuning on our side can widen), so for any
// SEC-registered filer, real 5/10-year-and-deeper history has to come from
// here instead — this file being unreachable/misconfigured (see the
// USER_AGENT doc comment above) is functionally equivalent to capping every
// range selector above ~4 years at the same ~4 years of data. Genuinely
// free and keyless, same as fetchRecentFilings above.
//
// IMPORTANT — same "unverified live" caveat as the rest of this file: this
// sandbox blocks outbound access to data.sec.gov, so the XBRL tag names
// below (standard `us-gaap` taxonomy concepts) could not be validated
// against a real payload during development. They're the well-documented
// canonical tags for each line item, with fallback aliases for the several
// tags companies commonly switch between (e.g. `SalesRevenueNet` before the
// 2018 revenue-recognition standard update vs.
// `RevenueFromContractWithCustomerExcludingAssessedTax` after) — spot-check
// against a couple of real filers (a `10-K` filer and a `20-F` foreign
// private issuer like TEVA) before trusting this in production.
// ---------------------------------------------------------------------------

interface XbrlFactEntry {
  /** Period start (duration concepts only — income statement, cash flow). Absent for instant concepts (balance sheet). */
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form: string;
  filed: string;
}

interface XbrlConceptFacts {
  units: Record<string, XbrlFactEntry[]>;
}

interface XbrlCompanyFacts {
  facts?: {
    "us-gaap"?: Record<string, XbrlConceptFacts>;
  };
}

/** Annual report forms whose facts we trust as a fiscal year's "as-filed" figure. Includes 20-F for foreign private issuers (e.g. TEVA). */
const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "20-F", "20-F/A"]);
/** Quarterly report forms. Foreign private issuers (20-F filers) generally
 *  don't file 10-Qs, so quarterly history is effectively US-filer-only. */
const QUARTERLY_FORMS = new Set(["10-Q", "10-Q/A"]);

/**
 * Reduces one or more candidate XBRL tags (checked in priority order, since
 * companies occasionally switch which tag they file a concept under across
 * years) down to a single period-key -> value map. `classify` decides which
 * entries count as "this kind of period" and what key to file them under —
 * shared by annualSeries (fiscal year, e.g. "2023") and quarterlySeries
 * (fiscal year + quarter, e.g. "2023-Q2") below, since both need identical
 * priority/restatement-recency handling, just different period filters.
 */
/**
 * Detailed variant of periodSeries — same tag-priority / most-recently-filed
 * selection logic, but keeps the winning entry's `filed` date alongside its
 * value instead of discarding it. Needed for the split-adjustment fix below:
 * knowing WHICH FILING a per-share fact came from (not just its value) is
 * what lets that fix tell an already-split-restated historical figure apart
 * from a genuinely still-pre-split one — see cumulativeSplitRatioForFiling's
 * doc comment. periodSeries() itself is now a thin wrapper over this that
 * strips `filed`, so every other existing caller's behavior is unchanged.
 */
function periodSeriesDetailed(
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  classify: (entry: XbrlFactEntry) => string | null,
  unitKey = "USD"
): Map<string, { value: number; filed: string }> {
  const chosen = new Map<string, { value: number; filed: string; tag: string }>();
  for (const tag of tags) {
    const entries = facts?.[tag]?.units[unitKey];
    if (!entries) continue;
    for (const entry of entries) {
      const key = classify(entry);
      if (key == null) continue;
      const existing = chosen.get(key);
      // Prefer the higher-priority tag for a given period; within the same
      // tag, prefer the most recently filed value (a later /A restatement
      // supersedes the original as-filed figure).
      if (!existing || (existing.tag === tag && entry.filed > existing.filed)) {
        chosen.set(key, { value: entry.val, filed: entry.filed, tag });
      }
    }
  }
  return new Map([...chosen].map(([key, v]) => [key, { value: v.value, filed: v.filed }]));
}

function periodSeries(
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  classify: (entry: XbrlFactEntry) => string | null,
  unitKey = "USD"
): Map<string, number> {
  return new Map(
    [...periodSeriesDetailed(facts, tags, classify, unitKey)].map(([key, v]) => [key, v.value])
  );
}

/** Duration in days between an XBRL fact's start/end — used to sanity-check
 *  that a "duration" concept (income statement, cash flow) actually spans
 *  the period it claims to, since the same tag also carries quarterly and
 *  multi-year-cumulative entries that would otherwise corrupt a series. */
function durationDays(entry: XbrlFactEntry): number | null {
  if (!entry.start) return null;
  return (new Date(entry.end).getTime() - new Date(entry.start).getTime()) / 86_400_000;
}

/**
 * Root-cause fix (user report: NVDA's fullscreen Total Revenues chart showed
 * "2026" = $61B, when NVIDIA's real FY2026 revenue was $215.9B and $61B is
 * NVIDIA's real FY2024 revenue instead — i.e. a real, correct dollar figure
 * surviving under the WRONG, much-later fiscal-year label). Previously these
 * two classify() functions keyed each period by `entry.fy` when present,
 * falling back to `entry.end`'s year only if `fy` was absent.
 *
 * That was backwards, and is the actual bug: `fy` (XBRL's
 * `dei:DocumentFiscalYearFocus`) is FILING-level metadata — "which fiscal
 * year is THIS FILING reporting on" — not period-level metadata. A 10-K's
 * income statement conventionally shows 2-3 years of comparative columns
 * (current year + 1-2 prior years side by side), and SEC's XBRL processor
 * tags EVERY numeric fact in that filing — including the prior-year
 * comparative columns — with that SAME filing-level `fy`, regardless of
 * which column's real period a given fact instance actually describes.
 * Concretely: NVIDIA's FY2026 10-K (filed ~March 2026) shows FY2026/FY2025/
 * FY2024 revenue side by side; ALL THREE of those facts get tagged
 * `fy=2026` in companyfacts, because that's the filing's own fiscal-year
 * focus — even though only one of the three genuinely IS fiscal 2026.
 * Keying on `entry.fy` therefore filed FY2024's real, correct $60.922B
 * figure under "2026" once the FY2026 10-K was filed, exactly matching the
 * reported bug (and independently confirmed as a general, well-documented
 * companyfacts quirk — SEC's API returns every duplicate instance of a
 * fact across every filing that reports it, not just its "home" filing —
 * see thefullstackaccountant.com/blog/intro-to-edgar, "Handling Duplicate
 * Values in Company Concepts").
 *
 * `entry.end` (and `entry.start` for durations) is genuine period-level
 * data — it's the actual reported period boundary, identical across every
 * duplicate instance of the same real fact regardless of which filing
 * reported it. Deriving the year label from `end` instead (matching the
 * convention yahoo.ts's annualLabel/quarterLabel already use) makes every
 * duplicate instance of a given real fiscal year's figure collapse onto the
 * SAME correct key, letting periodSeries' existing "prefer most recently
 * filed" tie-break do its intended job — pick the latest-filed value for a
 * genuine period, instead of accidentally comparing unrelated periods that
 * happened to share a filing's fy.
 */
/** Genuinely annual, as-filed 10-K/20-F entries only, keyed by fiscal year (e.g. "2023"). */
function annualSeries(
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  unitKey = "USD"
): Map<string, number> {
  return periodSeries(
    facts,
    tags,
    (entry) => {
      if (entry.fp !== "FY" || !ANNUAL_FORMS.has(entry.form)) return null;
      const days = durationDays(entry);
      if (days != null && (days < 300 || days > 400)) return null; // not a genuine ~1-year duration
      return String(new Date(entry.end).getFullYear());
    },
    unitKey
  );
}

/**
 * Genuinely quarterly, as-filed 10-Q entries only, keyed "fiscalYear-Qn"
 * (e.g. "2023-Q2"). String-sortable within and across years (see
 * aggregate.ts).
 *
 * Root-cause fix (live report: CRM/Salesforce — fiscal year ends January
 * 31 — showed artificial dips/spikes in quarterly revenue): `entry.fp`
 * ("Q1"-"Q4") is safe to keep as-is — unlike `fy`, it does correctly
 * identify WHICH quarter a comparative column describes (a same-quarter-
 * prior-year comparison is still tagged with that quarter's own fp). But
 * the YEAR component used to be `new Date(entry.end).getFullYear()` — the
 * bare calendar year of the period's own end date. For CRM's FY2024 Q1
 * (ending April 30, 2023) that produced "2023-Q1", while CRM's own FY2024
 * annual period (ending January 31, 2024) is correctly labeled "2024" by
 * annualSeries above — splitting ONE real fiscal year's four quarters
 * across TWO different label-year prefixes (Q1-Q3 landing under "2023",
 * Q4 under "2024"). That broke synthesizeIncomeQ4/synthesizeCashFlowQ4/
 * synthesizeBalanceQ4 below, which look up "${annualLabel}-Q1/Q2/Q3" and
 * silently found nothing for any such company, and scattered a single
 * fiscal year's quarters across Select Range's year-bucketing.
 *
 * Fixed via fiscalYearForPeriodEnd (aggregate.ts) — the same shared
 * fiscal-year-rollover formula yahoo.ts's makeFiscalQuarterLabelFn uses
 * for Yahoo's own quarterly rows, so both sources land on the identical
 * label for the identical real period (required for mergeYearsBySource's
 * exact-string-key cross-source matching to work — see that function's
 * doc comment in aggregate.ts). `fiscalYearEndMonth` (0-11) comes from
 * inferSecFiscalYearEndMonth below, computed once per symbol from this
 * company's own annual filings rather than assumed to be December.
 */
function quarterlySeries(
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  fiscalYearEndMonth: number,
  unitKey = "USD"
): Map<string, number> {
  return periodSeries(
    facts,
    tags,
    (entry) => {
      if (!entry.fp || !/^Q[1-4]$/.test(entry.fp) || !QUARTERLY_FORMS.has(entry.form)) return null;
      const days = durationDays(entry);
      if (days != null && (days < 70 || days > 100)) return null; // not a genuine ~1-quarter duration
      return `${fiscalYearForPeriodEnd(new Date(entry.end), fiscalYearEndMonth)}-${entry.fp}`;
    },
    unitKey
  );
}

type SeriesFn = (facts: Record<string, XbrlConceptFacts> | undefined, tags: string[], unitKey?: string) => Map<string, number>;

/**
 * Detailed siblings of annualSeries/quarterlySeries — identical period
 * classification logic, but return periodSeriesDetailed's `{value, filed}`
 * shape instead of a bare value. Needed anywhere a caller has to know WHICH
 * FILING a period's winning fact came from, not just its value — currently
 * only the retroactive split adjustment in toSecIncomeRows below (see
 * cumulativeSplitRatioForFiling's doc comment for why the filed date
 * matters there). Every other caller keeps using the plain annualSeries/
 * quarterlySeries above unchanged.
 */
function annualSeriesDetailed(
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  unitKey = "USD"
): Map<string, { value: number; filed: string }> {
  return periodSeriesDetailed(
    facts,
    tags,
    (entry) => {
      if (entry.fp !== "FY" || !ANNUAL_FORMS.has(entry.form)) return null;
      const days = durationDays(entry);
      if (days != null && (days < 300 || days > 400)) return null;
      return String(new Date(entry.end).getFullYear());
    },
    unitKey
  );
}

/** Detailed sibling of quarterlySeries above — same fiscal-year-aware period classification (see its doc comment), plus the winning entry's `filed` date. */
function quarterlySeriesDetailed(
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  fiscalYearEndMonth: number,
  unitKey = "USD"
): Map<string, { value: number; filed: string }> {
  return periodSeriesDetailed(
    facts,
    tags,
    (entry) => {
      if (!entry.fp || !/^Q[1-4]$/.test(entry.fp) || !QUARTERLY_FORMS.has(entry.form)) return null;
      const days = durationDays(entry);
      if (days != null && (days < 70 || days > 100)) return null;
      return `${fiscalYearForPeriodEnd(new Date(entry.end), fiscalYearEndMonth)}-${entry.fp}`;
    },
    unitKey
  );
}

type SeriesFnDetailed = (
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  unitKey?: string
) => Map<string, { value: number; filed: string }>;

/**
 * Company-specific fiscal year end month (0-11, Date.getMonth() convention
 * — matches yahoo.ts's own inferFiscalYearEndMonth exactly), fed into
 * quarterlySeries/quarterlySeriesDetailed above via fiscalYearForPeriodEnd
 * so quarters get bucketed into the fiscal year they actually belong to
 * instead of the calendar year their own end date happens to fall in (see
 * quarterlySeries' doc comment for the CRM/Salesforce bug this fixes).
 *
 * Takes the MOST RECENT "FY" (10-K/20-F, fp="FY") entry's period end date
 * found anywhere in this company's companyfacts payload — same "most
 * recent annual row wins" convention yahoo.ts's inferFiscalYearEndMonth
 * uses (see its doc comment), so a company that changed its fiscal
 * year-end at some point in its history is read the same current
 * convention by both sources, not an early outlier. Falls back to 11
 * (December) — the default for the overwhelming majority of US filers,
 * and a mathematical no-op for fiscalYearForPeriodEnd — if no FY entry is
 * found at all (e.g. a filer whose facts payload happens to contain zero
 * ANNUAL_FORMS entries under any tag, which would also mean annualSeries
 * itself has nothing to return).
 */
function inferSecFiscalYearEndMonth(facts: Record<string, XbrlConceptFacts> | undefined): number {
  if (!facts) return 11;
  let mostRecentEnd: Date | null = null;
  for (const concept of Object.values(facts)) {
    const entries = concept.units?.USD;
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.fp !== "FY" || !ANNUAL_FORMS.has(entry.form)) continue;
      const days = durationDays(entry);
      if (days != null && (days < 300 || days > 400)) continue; // not a genuine ~1-year duration
      const end = new Date(entry.end);
      if (!mostRecentEnd || end > mostRecentEnd) mostRecentEnd = end;
    }
  }
  return mostRecentEnd ? mostRecentEnd.getMonth() : 11;
}

// ---------------------------------------------------------------------------
// Retroactive stock-split adjustment
// ---------------------------------------------------------------------------

export interface StockSplitEvent {
  /** ISO date the split became effective. */
  date: string;
  /** Shares-per-old-share multiplier — 20 for AMZN's June 2022 20-for-1 split, 0.1 for a 1-for-10 reverse split. */
  ratio: number;
}

/**
 * QA fix (live comparison against GuruFocus flagged the SAME distortion
 * this function's own doc comment below already anticipated as a risk:
 * "unverified live in this sandbox... confirm the exact tag/unit shape
 * before shipping" — AMZN's Fair Value History chart showed a ~6x spike
 * right at the pre-2022 boundary, and a live audit of AMZN's actual
 * company-facts payload found `sharesOutstandingDiluted` still reading
 * ~504M for FY2019, not the ~10.08B a correct retroactive adjustment
 * would produce (504M x 20). Root cause almost certainly IS what the doc
 * comment below flagged as the open risk: this sandbox has no network
 * access to sec.gov, so `StockholdersEquityNoteStockSplitConversionRatio`
 * detection below was never actually verified against AMZN's/GOOGL's real
 * XBRL — if either files that split disclosure under a different concept,
 * a different unit key, or doesn't tag it as a distinct fact at all for
 * that filing, detection silently returns nothing and no adjustment
 * happens, for exactly the handful of large, heavily-audited tickers most
 * likely to be spot-checked against GuruFocus.
 *
 * Since this sandbox still can't verify the live tag shape, this table is
 * a small, independently-reliable supplement rather than a replacement:
 * well-documented, public splits for large-cap tickers likely to come up
 * in this kind of comparison, sourced from each company's own investor-
 * relations stock-split announcements (a rare, low-frequency corporate
 * action — a handful of entries covers the tickers this app has actually
 * been audited against so far). Merged with whatever XBRL detection DOES
 * find (deduped by date, XBRL's own value winning on a same-date
 * conflict, since a live-detected ratio is more authoritative than this
 * static list whenever both exist) rather than replacing it, so any
 * ticker/split XBRL correctly detects on its own is unaffected, and any
 * future split for a ticker not in this table still gets a shot at
 * XBRL-based detection. Not exhaustive — add an entry here for any other
 * ticker a future audit flags the same distortion on, rather than trying
 * to enumerate every split ever.
 */
const KNOWN_STOCK_SPLITS: Record<string, StockSplitEvent[]> = {
  AAPL: [{ date: "2020-08-31", ratio: 4 }],
  AMZN: [{ date: "2022-06-06", ratio: 20 }],
  GOOGL: [{ date: "2022-07-18", ratio: 20 }],
  GOOG: [{ date: "2022-07-18", ratio: 20 }],
  NVDA: [
    { date: "2021-07-20", ratio: 4 },
    { date: "2024-06-10", ratio: 10 },
  ],
  TSLA: [
    { date: "2020-08-31", ratio: 5 },
    { date: "2022-08-25", ratio: 3 },
  ],
};

/**
 * Bug fix (reported: "Amazon's June 2022 20-for-1 split creates an
 * artificial ~11x cliff in the EPS chart" — diluted shares correctly jump
 * ~504M -> ~10.2B between FY2021 and FY2022, but EPS drops from ~$23 to
 * ~$2 with no adjustment, instead of both series reading as a smooth
 * continuation of the same underlying business performance). Root cause:
 * `eps`/`sharesOutstandingDiluted`/`dividendsPerShare` were taken directly
 * from each fiscal year's *as-filed* XBRL facts with no retroactive
 * adjustment — correct for the post-split period, but every pre-split
 * historical period is still denominated in pre-split share counts, so the
 * two halves of the series aren't on the same scale.
 *
 * Detects splits via XBRL's purpose-built `StockholdersEquityNoteStockSplitConversionRatio`
 * concept — deliberately NOT by inferring one from a large jump in
 * reported shares outstanding between periods. That heuristic is a
 * well-known false-positive trap: a large primary share issuance, a
 * follow-on offering, or an all-stock acquisition can produce a
 * similar-looking jump, and misclassifying one as a split would silently
 * corrupt real historical data — worse than the original bug. Merged with
 * KNOWN_STOCK_SPLITS above (see that table's doc comment for why) — a
 * ticker with neither a detected XBRL fact nor a table entry simply gets
 * no adjustment rather than a guessed, possibly-wrong one.
 */
function detectStockSplits(facts: Record<string, XbrlConceptFacts> | undefined, symbol: string): StockSplitEvent[] {
  const entries = facts?.["StockholdersEquityNoteStockSplitConversionRatio"]?.units?.pure ?? [];
  const byDate = new Map<string, { ratio: number; filed: string }>();
  for (const entry of entries) {
    // A ratio of exactly 1 (or anything non-finite/non-positive) isn't a
    // real split — skip rather than apply a no-op/corrupting adjustment.
    if (typeof entry.val !== "number" || !Number.isFinite(entry.val) || entry.val <= 0 || entry.val === 1) continue;
    const existing = byDate.get(entry.end);
    // Same "most recently filed wins" convention as periodSeries above —
    // if multiple filings disclose the same split event, prefer whichever
    // was filed last.
    if (!existing || entry.filed > existing.filed) {
      byDate.set(entry.end, { ratio: entry.val, filed: entry.filed });
    }
  }
  const detected = [...byDate.entries()].map(([date, v]) => ({ date, ratio: v.ratio }));

  // KNOWN_STOCK_SPLITS fills in only the dates XBRL detection didn't
  // already find for this ticker — live-detected data wins on any exact
  // date collision, since it comes straight from the filer's own
  // disclosure rather than this app's hardcoded table.
  const known = KNOWN_STOCK_SPLITS[bareSymbol(symbol)] ?? [];
  const detectedDates = new Set(detected.map((s) => s.date));
  const merged = [...detected, ...known.filter((s) => !detectedDates.has(s.date))];

  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Root-cause fix for a second-order bug in the retroactive split adjustment
 * above (live audit: AMZN's/GOOGL's diluted shares for FY2020/FY2021 came
 * out ~20x too large — a "double adjustment" stacked on top of already-
 * correct data — while FY2019-and-earlier were correctly restated). Root
 * cause: the function this replaces, `cumulativeSplitRatioAfter(periodEnd,
 * splits)`, computed the ratio purely from a fiscal period's CALENDAR END
 * DATE vs. each split's effective date, with zero awareness of which
 * FILING the period's winning value actually came from.
 *
 * That distinction matters because of periodSeries'/periodSeriesDetailed's
 * "most recently filed wins" tie-break (see their shared doc comment): SEC's
 * companyfacts API returns every instance of a fact across every filing
 * that reports it, and a 10-K's income statement conventionally shows ~2-3
 * years of comparative columns. GAAP requires stock splits to be applied
 * retrospectively, so any LATER filing that includes an earlier period as a
 * comparative column must present that period's per-share figures in
 * POST-split terms — even though the period itself predates the split.
 *
 * Concretely, for AMZN's June 2022 20-for-1 split: FY2019's winning value
 * comes from AMZN's FY2021 10-K (filed ~Feb 2022, BEFORE the split) — still
 * genuinely pre-split, so it needs the x20 adjustment. But FY2020/FY2021's
 * winning values come from AMZN's FY2022 10-K (filed ~Feb 2023, AFTER the
 * split, whose ~3-year comparative window covers FY2022/2021/2020) —
 * already split-restated by SEC's own filing convention, so applying x20
 * again produced the reported ~20x-too-large figures. The old
 * calendar-date-based ratio had no way to tell these two cases apart.
 *
 * Fix: compute the ratio from the winning FACT's own `filed` date instead
 * of the fiscal period's calendar end date. A fact filed BEFORE a split is
 * still pre-split-denominated for that split (multiply); a fact filed AFTER
 * a split already reflects it, regardless of which historical period it
 * describes (don't multiply for that split). This is self-correcting and
 * needs no advance knowledge of "which years are affected" — it falls
 * straight out of filing chronology, which periodSeriesDetailed/
 * annualSeriesDetailed/quarterlySeriesDetailed above now expose. Plain ISO
 * date strings (YYYY-MM-DD) compare correctly with `>`/`<` lexically, so no
 * Date parsing is needed here.
 */
function cumulativeSplitRatioForFiling(filed: string, splits: StockSplitEvent[]): number {
  let ratio = 1;
  for (const split of splits) {
    if (split.date > filed) ratio *= split.ratio;
  }
  return ratio;
}

/**
 * Approximates a fiscal-period label ("2022" or "2022-Q3") as its calendar
 * period-end date, purely for ordering against a split's exact date — "did
 * this reporting period end before or after the split." Deliberately
 * calendar-based, unlike cumulativeSplitRatioForFiling's per-fact filed-date
 * approach above — see applyKnownSplitAdjustment's doc comment for why a
 * calendar-based ratio is actually the RIGHT (and safe) tool for the rows
 * this function adjusts, not a regression back to the bug that function
 * fixed.
 */
function fiscalLabelToDate(fiscalYear: string): Date {
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(fiscalYear);
  if (quarterMatch) {
    const year = Number(quarterMatch[1]);
    const quarter = Number(quarterMatch[2]);
    return new Date(year, quarter * 3, 0);
  }
  const year = Number(fiscalYear);
  return Number.isFinite(year) ? new Date(year, 11, 31) : new Date(0);
}

/**
 * Root-cause fix for a THIRD split-adjustment gap (live audit, checked
 * against a merged/live app rather than this file in isolation): NVDA's
 * earliest two fiscal years (pre-dating SEC's June 2009 structured-XBRL
 * mandate — see the "Historical-depth note" doc comment on
 * fetchSecFinancials below) showed diluted shares far out of line with
 * every later year, even though those later years were correctly
 * split-adjusted by the filed-date fix above.
 *
 * Root cause: the filed-date-based fix in toSecIncomeRows only runs on rows
 * IT builds — i.e. only on years SEC EDGAR's XBRL payload actually covers.
 * mergeYearsBySource (aggregate.ts) merges SEC EDGAR with Yahoo/FMP in
 * priority order per fiscal year; for years outside SEC's XBRL coverage
 * (most commonly the oldest years for a long-tenured filer, before the 2009
 * mandate), Yahoo or FMP's row wins instead — and neither of those
 * providers' historical fundamentals get any split-adjustment treatment
 * anywhere in this codebase, since that logic has only ever lived inside
 * this file's SEC-specific row builder. So a ticker whose SEC coverage
 * starts AFTER a stock split (not the case for most of KNOWN_STOCK_SPLITS'
 * tickers, but the case for NVDA's 2 earliest fiscal years) ends up with a
 * visible seam exactly where the winning source switches from Yahoo/FMP to
 * SEC EDGAR.
 *
 * Fix: apply the SAME known-splits table this file already uses, as a
 * calendar-date-based (not filed-date-based) retroactive adjustment, to
 * whichever rows in the FINAL MERGED series came from a non-SEC source.
 * Calendar-date-based is deliberately fine here — unlike the bug
 * cumulativeSplitRatioForFiling fixed — because mergeYearsBySource's
 * priority order *guarantees* a non-SEC row only wins for a fiscal year SEC
 * EDGAR has no data for at all, which for every ticker in KNOWN_STOCK_SPLITS
 * only happens for years well before that ticker's split (SEC's XBRL
 * coverage reliably starts well before any of these companies' splits) —
 * there's no "already-restated-by-a-later-filing's-comparative-column"
 * ambiguity to worry about the way there was for SEC's own multi-year
 * comparative-column filings, because Yahoo/FMP's historical fundamentals
 * for old fiscal years aren't retroactively restated by newer filings the
 * way XBRL comparative columns are.
 *
 * Exported so yahoo.ts can call this on the post-merge income arrays,
 * filtered to `dataSource !== "sec-edgar"` rows only (SEC rows already got
 * the correct, more precise per-fact treatment and must NOT be adjusted
 * again here).
 */
export function applyKnownSplitAdjustment<
  T extends { fiscalYear: string; eps: number; sharesOutstandingDiluted: number; dividendsPerShare: number }
>(rows: T[], splits: StockSplitEvent[]): T[] {
  if (splits.length === 0) return rows;
  return rows.map((row) => {
    const periodEnd = fiscalLabelToDate(row.fiscalYear);
    let ratio = 1;
    for (const split of splits) {
      if (new Date(split.date).getTime() > periodEnd.getTime()) ratio *= split.ratio;
    }
    if (ratio === 1) return row;
    return {
      ...row,
      eps: row.eps / ratio,
      sharesOutstandingDiluted: row.sharesOutstandingDiluted * ratio,
      dividendsPerShare: row.dividendsPerShare / ratio,
    };
  });
}

/**
 * Convenience wrapper over applyKnownSplitAdjustment for a post-merge
 * (aggregate.ts's mergeYearsBySource) row array that carries a `dataSource`
 * tag — adjusts only the rows NOT sourced from sec-edgar (whose per-share
 * figures already got the more precise, per-fact filed-date treatment
 * inside toSecIncomeRows, and must not be adjusted a second time here),
 * preserving the original row order.
 */
export function applyKnownSplitAdjustmentToNonSecRows<
  T extends {
    fiscalYear: string;
    eps: number;
    sharesOutstandingDiluted: number;
    dividendsPerShare: number;
    dataSource?: string;
  }
>(rows: T[], splits: StockSplitEvent[]): T[] {
  if (splits.length === 0) return rows;
  const secRows = rows.filter((r) => r.dataSource === "sec-edgar");
  const nonSecRows = rows.filter((r) => r.dataSource !== "sec-edgar");
  const adjustedNonSec = applyKnownSplitAdjustment(nonSecRows, splits);
  const adjustedByFiscalYear = new Map(adjustedNonSec.map((r) => [r.fiscalYear, r]));
  const secByFiscalYear = new Map(secRows.map((r) => [r.fiscalYear, r]));
  return rows.map((r) => adjustedByFiscalYear.get(r.fiscalYear) ?? secByFiscalYear.get(r.fiscalYear) ?? r);
}

/**
 * Builds either the annual or quarterly Income Statement series, depending
 * on which `series` function (annualSeries/quarterlySeries) is passed —
 * same tag list and merge logic either way, just a different period filter.
 *
 * Bug fix (reported: "Gross Profit shows as 0/flat for Google/Alphabet
 * while Total Revenues and Operating Income populate correctly"): root
 * cause confirmed by re-reading how XBRL tagging actually works — unlike
 * Revenues/OperatingIncomeLoss/NetIncomeLoss (all real line items on
 * essentially every filer's income statement, so essentially every filer
 * tags them), "Gross Profit" is only tagged by companies whose income
 * statement actually presents a Gross Profit subtotal line. Alphabet's
 * (like many tech/services companies') income statement is single-step —
 * Revenues, then "Costs and expenses" broken into Cost of revenues / R&D /
 * SG&A, then "Income from operations" — with no Gross Profit line at all,
 * so `GrossProfit` is never instance-tagged in their XBRL, ever, for any
 * year. The old code had no fallback for this: `grossProfit.get(fiscalYear)
 * ?? 0` silently turned "this filer doesn't tag this concept" into a
 * permanent, misleading zero on every chart.
 *
 * This is a single-tag problem with an outsized effect, too: because
 * mergeYearsBySource (aggregate.ts) picks one source's *entire* row for a
 * given fiscal year rather than blending fields across sources, a filer
 * like this having Revenue/OperatingIncome/NetIncome tagged (so SEC EDGAR
 * "wins" that year against Yahoo/FMP) means its flat-zero Gross Profit
 * wins right along with it — Yahoo's data for that same year is never
 * consulted to patch just that one field, even if Yahoo happens to have a
 * usable number.
 *
 * Fix: derive Gross Profit = Revenue - Cost of Revenue whenever the direct
 * `GrossProfit` tag is missing for a specific period (checked per-period,
 * not just "does this filer ever tag it," since some filers change their
 * statement presentation across years). Applied the identical fallback
 * pattern one level up for Operating Income (via `CostsAndExpenses`) for
 * the rarer filer that doesn't even tag that subtotal, per the same
 * "comprehensive fallbacks so no core chart silently zeroes out" goal.
 */
/**
 * Root-cause fix (live bug report: an Income Statement panel showed real,
 * populated Operating Income / Net Income / EPS bars for 2021-2023 but
 * completely blank (zero-height) Revenue / Gross Profit bars for the exact
 * same years). Traced to this function's period-inclusion rule further
 * down (`periods = new Set([...revenue.keys(), ...netIncome.keys()])`) — a
 * period only needs revenue OR net income tagged to become a row, but the
 * row unconditionally pushed `totalRevenue: totalRevenue ?? 0`. When a
 * filer's revenue for a given fiscal year wasn't tagged under any of the
 * (previously shorter) list below — an XBRL tag-coverage gap, not "this
 * company had zero revenue" — OperatingIncomeLoss/NetIncomeLoss are
 * near-universal tags that don't depend on Revenue being tagged at all —
 * that period silently got a *fabricated* $0 revenue baked into the row.
 * Because mergeYearsBySource (aggregate.ts) merges WHOLE rows per fiscal
 * year with SEC EDGAR as the top-priority source, that fabricated-$0 row
 * won the entire year, so even a real revenue figure Yahoo/FMP might have
 * had for that year was never consulted.
 *
 * Two changes close this gap without regressing the (correct) Operating
 * Income/Net Income/EPS data those years already had:
 *  1. The revenue tag list below was widened with industry-specific
 *     revenue concepts (banks/financials, regulated utilities, healthcare,
 *     REITs, oil & gas) that weren't previously checked — standard
 *     `us-gaap` taxonomy concepts, same "unverified live in this sandbox"
 *     caveat as the rest of this file's tag lists.
 *  2. `deriveRevenue()` below applies Revenue = Gross Profit + Cost of
 *     Revenue as a last-resort derivation for any period that still has no
 *     direct revenue tag — the same accounting identity this function
 *     already uses in reverse a few lines down (Gross Profit = Revenue -
 *     Cost of Revenue), just solved for the other variable. This is a real
 *     mathematical identity, not a guess, and only fires when a period
 *     genuinely has both GrossProfit and a Cost-of-Revenue tag reported.
 * A period that still has no revenue after both of these keeps its row —
 * dropping the whole row over one missing field would regress Operating
 * Income/Net Income/EPS/Shares, which is worse than a gap in one metric.
 */
function toSecIncomeRows(
  facts: Record<string, XbrlConceptFacts> | undefined,
  series: SeriesFn,
  seriesDetailed: SeriesFnDetailed,
  splits: StockSplitEvent[] = []
): IncomeStatementYear[] {
  const revenueTagged = series(facts, [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "SalesRevenueServicesNet",
    "RevenuesNetOfInterestExpense",
    // Industry-specific revenue tags — see this function's doc comment.
    "InterestAndDividendIncomeOperating",
    "RegulatedAndUnregulatedOperatingRevenue",
    "HealthCareOrganizationRevenue",
    "RealEstateRevenueNet",
    "OilAndGasRevenue",
  ]);
  const grossProfitTagged = series(facts, ["GrossProfit"]);
  // Fallback derivation source for filers that never tag GrossProfit at
  // all (see doc comment above) — checked in priority order, since a
  // filer's chosen "cost" tag can vary by industry (goods vs. services vs.
  // a blended cost-of-revenue line).
  const costOfRevenue = series(facts, [
    "CostOfRevenue",
    "CostOfGoodsAndServicesSold",
    "CostOfGoodsSold",
    "CostOfServices",
    "CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization",
  ]);
  // Revenue = Gross Profit + Cost of Revenue — see this function's doc
  // comment, item 2. Only fills periods revenueTagged genuinely has no
  // entry for; never overrides a directly-tagged figure.
  const revenue = new Map(revenueTagged);
  for (const [fiscalYear, gp] of grossProfitTagged) {
    if (!revenue.has(fiscalYear) && costOfRevenue.has(fiscalYear)) {
      revenue.set(fiscalYear, gp + costOfRevenue.get(fiscalYear)!);
    }
  }
  const operatingIncomeTagged = series(facts, ["OperatingIncomeLoss"]);
  // Fallback derivation source for the rarer filer that doesn't tag an
  // operating-income subtotal either — same rationale as Gross Profit.
  const costsAndExpenses = series(facts, ["CostsAndExpenses"]);
  const netIncome = series(facts, ["NetIncomeLoss", "ProfitLoss"]);
  // Detailed (value + filed date) rather than plain series for the three
  // split-affected per-share concepts — see cumulativeSplitRatioForFiling's
  // doc comment for why the filed date, not the fiscal period's calendar
  // date, is what the split ratio must be computed from.
  const epsDetailed = seriesDetailed(facts, ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"], "USD/shares");
  const sharesDetailed = seriesDetailed(
    facts,
    [
      "WeightedAverageNumberOfDilutedSharesOutstanding",
      "WeightedAverageNumberOfDilutedAndBasicSharesOutstanding",
      "WeightedAverageNumberOfSharesOutstandingBasic",
    ],
    "shares"
  );
  // Dividend TTM bug fix (live report: trailing-twelve-month dividends
  // reading roughly 1.5-2x too high — the equivalent of ~6-8 quarters
  // summed instead of exactly 4). Root cause: unlike every other per-share
  // concept above (EPS/shares, where the fallback tags describe the SAME
  // underlying figure at different presentation granularity), "Declared"
  // and "Cash Paid" dividends are genuinely DIFFERENT timing concepts — a
  // board can declare a quarter's dividend in one fiscal quarter and pay it
  // in the next. seriesDetailed's normal per-TAG-then-per-PERIOD fallback
  // (see periodSeriesDetailed above: tag 1 wins for every period it covers,
  // tag 2 only fills the periods tag 1 is missing) can therefore end up
  // sourcing SOME quarters from "Declared" and OTHER quarters — for the
  // very same company — from "CashPaid". When a dividend declared near a
  // quarter boundary is later summed by computeTrailingTwelveMonths, the
  // same real-world payment can be counted once under each concept in two
  // adjacent quarters, inflating the 4-quarter TTM sum well past the true
  // total. Fix: pick ONE tag for this company's ENTIRE quarterly (or
  // annual) series — whichever has broader coverage — rather than letting
  // the winning tag vary period-by-period, so a TTM sum never mixes the two
  // concepts.
  const dividendsDeclaredDetailed = seriesDetailed(facts, ["CommonStockDividendsPerShareDeclared"], "USD/shares");
  const dividendsPaidDetailed = seriesDetailed(facts, ["CommonStockDividendsPerShareCashPaid"], "USD/shares");
  const dividendsDetailed =
    dividendsDeclaredDetailed.size >= dividendsPaidDetailed.size ? dividendsDeclaredDetailed : dividendsPaidDetailed;

  const periods = new Set([...revenue.keys(), ...netIncome.keys()]);
  const rows: IncomeStatementYear[] = [];
  for (const fiscalYear of periods) {
    const totalRevenue = revenue.get(fiscalYear);
    const netIncomeVal = netIncome.get(fiscalYear);
    // Require at least revenue or net income to exist — a period with
    // neither isn't a real data point, just noise from a stray tag.
    if (totalRevenue == null && netIncomeVal == null) continue;

    const grossProfitVal =
      grossProfitTagged.get(fiscalYear) ??
      (totalRevenue != null && costOfRevenue.has(fiscalYear)
        ? totalRevenue - costOfRevenue.get(fiscalYear)!
        : undefined);
    const operatingIncomeVal =
      operatingIncomeTagged.get(fiscalYear) ??
      (totalRevenue != null && costsAndExpenses.has(fiscalYear)
        ? totalRevenue - costsAndExpenses.get(fiscalYear)!
        : undefined);

    // QA fix (live comparison flagged sharesOutstandingDiluted reading 0
    // for real fiscal years with genuine, non-zero EPS and net income —
    // reported on GOOGL/Alphabet specifically): none of the three tagged
    // weighted-average-shares concepts above are universal — a filer that
    // presents diluted shares under a different concept (or a
    // company-specific extension taxonomy tag this app doesn't check)
    // simply has no entry in `shares`, and the old code turned that
    // straight into a fabricated 0 rather than an actual missing-data
    // signal. Net Income / EPS = diluted shares outstanding, algebraically
    // — not as precise as the real reported figure (EPS is itself rounded
    // to 2 decimals, so this reintroduces a small rounding error), but a
    // disclosed, reasonable approximation is better than a flat 0 for any
    // metric that divides by shares (this app has several: Price/EPS
    // multiples, Piotroski's "no new shares issued" check, book value per
    // share, etc.) — only used when the real tag is genuinely missing,
    // never overriding a directly-tagged figure.
    const epsEntry = epsDetailed.get(fiscalYear);
    const sharesEntry = sharesDetailed.get(fiscalYear);
    const dividendsEntry = dividendsDetailed.get(fiscalYear);
    const epsRaw = epsEntry?.value;
    const sharesRaw =
      sharesEntry?.value ??
      (netIncomeVal != null && epsRaw != null && epsRaw !== 0 ? Math.abs(netIncomeVal / epsRaw) : undefined);
    // Algebraically derived from the EPS fact when the direct shares tag is
    // missing, so it inherits EPS's own filed date as its "vintage" for
    // split-ratio purposes below.
    const sharesFiled = sharesEntry?.filed ?? epsEntry?.filed;

    // Retroactive split adjustment (see cumulativeSplitRatioForFiling's doc
    // comment): computed per-fact from that fact's own filed date, NOT from
    // the fiscal period's calendar date — a fact already picked up from a
    // later, post-split filing's comparative column is already restated
    // and correctly gets ratio 1 here, while a fact still filed pre-split
    // gets the multiplier. Empty `splits` (the common case — most tickers
    // never split) always yields ratio 1 regardless of filed date.
    const epsSplitRatio = epsEntry ? cumulativeSplitRatioForFiling(epsEntry.filed, splits) : 1;
    const sharesSplitRatio = sharesFiled ? cumulativeSplitRatioForFiling(sharesFiled, splits) : 1;
    const dividendsSplitRatio = dividendsEntry ? cumulativeSplitRatioForFiling(dividendsEntry.filed, splits) : 1;

    rows.push({
      fiscalYear,
      totalRevenue: totalRevenue ?? 0,
      grossProfit: grossProfitVal ?? 0,
      operatingIncome: operatingIncomeVal ?? 0,
      netIncome: netIncomeVal ?? 0,
      // Per-share figures scale with shares outstanding — multiply share
      // counts and divide per-share dollar amounts by that fact's own
      // cumulative ratio, so a pre-split fact reads as if the split had
      // always been in effect (matching how every post-split fact is
      // already reported) instead of creating an artificial cliff — or, for
      // a fact a later filing's comparative column already restated,
      // getting adjusted a second time.
      eps: (epsRaw ?? 0) / epsSplitRatio,
      sharesOutstandingDiluted: (sharesRaw ?? 0) * sharesSplitRatio,
      dividendsPerShare: (dividendsEntry?.value ?? 0) / dividendsSplitRatio,
      dataSource: "sec-edgar",
    });
  }
  return backfillMissingSharesFromNeighbors(rows.sort((a, b) => a.fiscalYear.localeCompare(b.fiscalYear)));
}

/**
 * QA fix (live audit: GOOGL's FY2015 row showed eps=0 and
 * sharesOutstandingDiluted=0 despite a real, populated ~$16.3B netIncome —
 * an isolated missing-field year, not the widespread 0-diluted-shares bug
 * the netIncome/epsRaw fallback above already fixed). Root cause is almost
 * certainly a still-unverified XBRL tag-shape gap this sandbox can't
 * confirm live (no sec.gov access — see this file's other "unverified live"
 * caveats): a filer with multiple common-stock classes (Alphabet has traded
 * dual-class since its 2014 Class C issuance) sometimes reports EPS and/or
 * weighted-average-shares under a company-specific EXTENSION taxonomy
 * concept for the fiscal years nearest that kind of restructuring, rather
 * than the standard `us-gaap` tags this file's fixed tag lists check —
 * extension tags are per-filer, so no generic tag-list widening could ever
 * enumerate them all. NetIncomeLoss itself (a single, unified concept
 * regardless of share class) still tags normally in that scenario, which is
 * why netIncome can be populated while eps/shares are both genuinely
 * absent — and why the netIncome/epsRaw derivation above can't help
 * either, since it needs epsRaw to already be present.
 *
 * Last-resort fallback for exactly this shape of gap: carry forward the
 * nearest ADJACENT fiscal year's (already split-adjusted, by this point in
 * the pipeline) diluted share count — averaging both neighbors when both
 * are available, otherwise whichever single side has one — as an
 * approximation, rather than a fabricated 0. A large public company's
 * diluted share count rarely moves more than a few percent year-over-year
 * outside a split (handled separately, upstream of this function), so a
 * neighboring year is a reasonable stand-in — nowhere near as precise as
 * the real reported figure, but a disclosed, sane approximation is better
 * than a flat 0 for any metric that divides by shares. Deliberately
 * narrow: only fires when sharesOutstandingDiluted is still exactly 0 after
 * every tag-based and derived attempt above AND there's real netIncome for
 * that year (a period with no netIncome either isn't a real data point to
 * begin with), and never overrides a directly-tagged or algebraically
 * derived figure.
 */
function backfillMissingSharesFromNeighbors(rows: IncomeStatementYear[]): IncomeStatementYear[] {
  const result = rows.map((r) => ({ ...r }));
  for (let i = 0; i < result.length; i++) {
    if (result[i].sharesOutstandingDiluted !== 0 || result[i].netIncome === 0) continue;
    let before: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (result[j].sharesOutstandingDiluted > 0) {
        before = result[j].sharesOutstandingDiluted;
        break;
      }
    }
    let after: number | null = null;
    for (let j = i + 1; j < result.length; j++) {
      if (result[j].sharesOutstandingDiluted > 0) {
        after = result[j].sharesOutstandingDiluted;
        break;
      }
    }
    const borrowed = before != null && after != null ? (before + after) / 2 : (before ?? after);
    if (borrowed == null) continue;
    result[i].sharesOutstandingDiluted = borrowed;
    // EPS can now be derived from the borrowed share count too, if it was
    // also missing (GOOGL FY2015's actual reported shape).
    if (result[i].eps === 0) {
      result[i].eps = result[i].netIncome / borrowed;
    }
  }
  return result;
}

/**
 * Note on the one gap here that isn't fixable with a tag fallback:
 * `AssetsCurrent`/`LiabilitiesCurrent` (current assets/liabilities) are
 * genuinely absent from the XBRL of filers that don't present a classified
 * balance sheet at all — banks and other financial institutions, by
 * standard industry convention, don't split assets/liabilities into
 * current/noncurrent (a bank's balance sheet is ordered by liquidity
 * instead). There is no alternate us-gaap tag that means the same thing
 * for those filers; the 0 those fields fall back to for such a company
 * reflects a genuine absence in the underlying filing, not a mapping bug.
 * Every other field below has real fallback tag variants.
 */
function toSecBalanceRows(facts: Record<string, XbrlConceptFacts> | undefined, series: SeriesFn): BalanceSheetYear[] {
  const totalAssets = series(facts, ["Assets"]);
  const totalLiabilities = series(facts, ["Liabilities"]);
  const equity = series(facts, [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ]);
  const currentAssets = series(facts, ["AssetsCurrent"]);
  const currentLiabilities = series(facts, ["LiabilitiesCurrent"]);
  const cash = series(facts, [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ]);
  const shortTermInvestments = series(facts, ["ShortTermInvestments", "MarketableSecuritiesCurrent"]);
  const longTermDebt = series(facts, ["LongTermDebtNoncurrent", "LongTermDebt"]);
  const currentDebt = series(facts, ["LongTermDebtCurrent", "DebtCurrent"]);
  const combinedDebt = series(facts, ["DebtLongtermAndShorttermCombinedAmount"]);

  const periods = new Set([...totalAssets.keys(), ...totalLiabilities.keys()]);
  const rows: BalanceSheetYear[] = [];
  for (const fiscalYear of periods) {
    const assets = totalAssets.get(fiscalYear);
    const liabilities = totalLiabilities.get(fiscalYear);
    if (assets == null && liabilities == null) continue;
    const cashVal = cash.get(fiscalYear) ?? 0;
    const totalDebt =
      combinedDebt.get(fiscalYear) ?? (longTermDebt.get(fiscalYear) ?? 0) + (currentDebt.get(fiscalYear) ?? 0);
    rows.push({
      fiscalYear,
      cashAndShortTermInvestments: cashVal + (shortTermInvestments.get(fiscalYear) ?? 0),
      totalCurrentAssets: currentAssets.get(fiscalYear) ?? 0,
      totalCurrentLiabilities: currentLiabilities.get(fiscalYear) ?? 0,
      totalAssets: assets ?? 0,
      totalLiabilities: liabilities ?? 0,
      totalStockholdersEquity: equity.get(fiscalYear) ?? 0,
      totalCash: cashVal,
      totalDebt,
      dataSource: "sec-edgar",
    });
  }
  return rows.sort((a, b) => a.fiscalYear.localeCompare(b.fiscalYear));
}

/**
 * Root-cause fix (live bug report: AT&T's `cashFlowQuarterly` had genuine
 * $0 operating-cash-flow values for 2025-Q2/2025-Q3/2026-Q2 while adjacent
 * quarters had real figures — confirmed systemic across NVDA/AAPL too, and
 * traced downstream to understate TTM free cash flow by roughly half,
 * dragging FCF Yield/P-FCF ratios off by a comparable margin).
 *
 * Cash flow statements are conventionally presented in 10-Q interim
 * filings as YEAR-TO-DATE CUMULATIVE columns only — "six months ended
 * June 30" for Q2, "nine months ended September 30" for Q3 — rather than
 * a discrete-quarter-only column, unlike the income statement (which
 * typically presents both). `quarterlySeries`' duration filter (~70-100
 * days) correctly rejects these longer cumulative entries as "not a
 * genuine single quarter" — right for avoiding a ~181-day H1 figure being
 * mistaken for Q2 alone — but for a filer that reports cash flow this way,
 * that correct rejection means NO entry survives quarterlySeries for the
 * affected tag/quarter at all, and toSecCashFlowRows' `operatingCashFlow:
 * ocf ?? 0` then bakes in a fabricated $0 for a period that only lacks a
 * DISCRETE figure — real underlying data exists, just cumulative.
 *
 * This reconstructs the discrete figure the same way an analyst would:
 * Q2 = (six-months-ended) − Q1, Q3 = (nine-months-ended) − (six-months-ended).
 * Deliberately conservative: only fires when a real Q1 (or H1) anchor is
 * available from the SAME already-discrete series to subtract against, so
 * a bad delta is never computed from a missing anchor. Q4 is NOT
 * reconstructed here (FY − nine-months) — no standalone Q4-only 10-Q ever
 * exists to source a "genuinely quarterly, as-filed" entry for it in the
 * first place (a pre-existing, separate gap from this bug, not something
 * this pass changes — Yahoo/FMP's quarterly data is the fallback for Q4,
 * same as before).
 */
function reconstructDiscreteQuartersFromCumulative(
  facts: Record<string, XbrlConceptFacts> | undefined,
  tags: string[],
  discreteQuarterly: Map<string, number>,
  unitKey = "USD"
): Map<string, number> {
  const h1ByYear = new Map<string, { value: number; filed: string }>();
  const ninemoByYear = new Map<string, { value: number; filed: string }>();
  for (const tag of tags) {
    const entries = facts?.[tag]?.units[unitKey];
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.start || !QUARTERLY_FORMS.has(entry.form)) continue;
      const days = durationDays(entry);
      if (days == null) continue;
      // Generous ~±30-day bands around the nominal 181/273-day cumulative
      // durations — same pragmatic tolerance this file already applies to
      // the ~91-day discrete-quarter window, to absorb non-calendar fiscal
      // years and 52/53-week reporting calendars.
      const bucket = days >= 150 && days <= 210 ? h1ByYear : days >= 240 && days <= 300 ? ninemoByYear : null;
      if (!bucket) continue;
      const year = String(new Date(entry.end).getFullYear());
      const existing = bucket.get(year);
      if (!existing || entry.filed > existing.filed) {
        bucket.set(year, { value: entry.val, filed: entry.filed });
      }
    }
  }

  const reconstructed = new Map<string, number>();
  for (const [year, h1] of h1ByYear) {
    const q1 = discreteQuarterly.get(`${year}-Q1`);
    if (q1 == null) continue; // no real Q1 anchor — don't guess
    reconstructed.set(`${year}-Q2`, h1.value - q1);
  }
  for (const [year, ninemo] of ninemoByYear) {
    const h1 = h1ByYear.get(year);
    if (!h1) continue; // no real H1 anchor — don't guess
    reconstructed.set(`${year}-Q3`, ninemo.value - h1.value);
  }
  return reconstructed;
}

/** Discrete-series values win when present; a reconstructed (cumulative-delta) value only fills a period the discrete series has nothing for. */
function withReconstructedFallback(discrete: Map<string, number>, reconstructed: Map<string, number>): Map<string, number> {
  const out = new Map(discrete);
  for (const [key, value] of reconstructed) {
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function toSecCashFlowRows(
  facts: Record<string, XbrlConceptFacts> | undefined,
  series: SeriesFn,
  isQuarterly: boolean
): CashFlowYear[] {
  const ocfTags = [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ];
  // SEC's convention reports capex as a positive outflow amount; this
  // codebase's established convention (see toCashFlowYears in yahoo.ts)
  // stores it negative, so it's negated below to stay consistent for every
  // consumer (charts, freeCashFlow math) regardless of which source a given
  // period came from.
  const capexTags = [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsForCapitalImprovements",
    "PaymentsToAcquireProductiveAssets",
  ];
  // "ShareBasedCompensation" is the common tag, but a number of large
  // filers (several under the same "big tech" umbrella as the Gross Profit
  // fix above) file this concept under "AllocatedShareBasedCompensationExpense" instead.
  const sbcTags = ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"];
  const niTags = ["NetIncomeLoss", "ProfitLoss"];

  const operatingCashFlowDiscrete = series(facts, ocfTags);
  const capexDiscrete = series(facts, capexTags);
  const stockBasedCompDiscrete = series(facts, sbcTags);
  const netIncomeDiscrete = series(facts, niTags);

  // YTD-cumulative reconstruction only makes sense for quarterly data —
  // see reconstructDiscreteQuartersFromCumulative's doc comment. Annual
  // (10-K) figures are already full-year; nothing to reconstruct.
  const operatingCashFlow = isQuarterly
    ? withReconstructedFallback(operatingCashFlowDiscrete, reconstructDiscreteQuartersFromCumulative(facts, ocfTags, operatingCashFlowDiscrete))
    : operatingCashFlowDiscrete;
  const capex = isQuarterly
    ? withReconstructedFallback(capexDiscrete, reconstructDiscreteQuartersFromCumulative(facts, capexTags, capexDiscrete))
    : capexDiscrete;
  const stockBasedComp = isQuarterly
    ? withReconstructedFallback(stockBasedCompDiscrete, reconstructDiscreteQuartersFromCumulative(facts, sbcTags, stockBasedCompDiscrete))
    : stockBasedCompDiscrete;
  const netIncome = isQuarterly
    ? withReconstructedFallback(netIncomeDiscrete, reconstructDiscreteQuartersFromCumulative(facts, niTags, netIncomeDiscrete))
    : netIncomeDiscrete;

  const periods = new Set([...operatingCashFlow.keys(), ...netIncome.keys()]);
  const rows: CashFlowYear[] = [];
  for (const fiscalYear of periods) {
    const ocf = operatingCashFlow.get(fiscalYear) ?? 0;
    const ni = netIncome.get(fiscalYear);
    if (!operatingCashFlow.has(fiscalYear) && ni == null) continue;
    // Sign standardization (live request: "unified, foolproof FCF formula
    // globally") — same two shared primitives every other provider's
    // mapping function uses (see aggregate.ts's doc comment on
    // normalizeCapex/normalizeStockBasedComp/computeFreeCashFlow for the
    // full rationale). This replaces the previous inline `-Math.abs(...)`,
    // which was correct but duplicated the exact same logic ad hoc instead
    // of sharing one audited implementation with yahoo.ts's two mapping
    // functions.
    const capitalExpenditures = normalizeCapex(capex.get(fiscalYear) ?? 0);
    rows.push({
      fiscalYear,
      operatingCashFlow: ocf,
      freeCashFlow: computeFreeCashFlow(ocf, capitalExpenditures),
      stockBasedCompensation: normalizeStockBasedComp(stockBasedComp.get(fiscalYear) ?? 0),
      capitalExpenditures,
      netIncome: ni ?? 0,
      dataSource: "sec-edgar",
    });
  }
  return rows.sort((a, b) => a.fiscalYear.localeCompare(b.fiscalYear));
}

/**
 * Synthesizes each fiscal year's 4th quarter as a residual — Annual (10-K)
 * minus that year's real, as-filed Q1+Q2+Q3 — for the income statement.
 *
 * Root cause this closes (external audit + independently re-verified
 * against this file's own code before trusting the report): no filer ever
 * submits a standalone "Q4-only" 10-Q, since the 10-K itself covers the
 * full fiscal year — so `quarterlySeries()` structurally can never produce
 * a `-Q4` key from directly-tagged facts alone (unlike
 * `reconstructDiscreteQuartersFromCumulative` above, which reconstructs Q2/
 * Q3 for cash flow from YTD-cumulative facts that DO exist; no equivalent
 * cumulative fact covers Q4 either, since "twelve months ended" IS the
 * annual figure). Previously this silently fell through to the Yahoo/FMP
 * fallback for every historical year, and Yahoo's quarterly endpoint has an
 * undocumented ~4-5 quarter hard cap (see USER_AGENT's doc comment) — so in
 * practice almost every historical Q4 was simply missing.
 *
 * Deliberately conservative, same posture as
 * reconstructDiscreteQuartersFromCumulative: only fires when Q1, Q2, AND Q3
 * are all genuinely present for that fiscal year (real anchors to subtract
 * against) — a year missing any one of the three keeps no synthesized Q4
 * rather than silently absorbing that missing quarter's value into a wrong,
 * inflated "Q4". Never overrides an already-present Q4 (a real 10-Q filer's
 * or an earlier pass's).
 *
 * `sharesOutstandingDiluted` is a weighted-average SNAPSHOT for the period,
 * not a summable flow — subtracting it the way a dollar figure sums would
 * produce a nonsensical negative-ish residual, so the synthesized Q4 row
 * reuses the annual (full-year weighted average) figure directly instead,
 * the same "point-in-time value stands in for the missing period" approach
 * synthesizeBalanceQ4 below uses for the entire balance sheet.
 */
function synthesizeIncomeQ4(annual: IncomeStatementYear[], quarterly: IncomeStatementYear[]): IncomeStatementYear[] {
  const quarterlyByKey = new Map(quarterly.map((row) => [row.fiscalYear, row]));
  const synthesized: IncomeStatementYear[] = [];
  for (const fy of annual) {
    const q4Key = `${fy.fiscalYear}-Q4`;
    if (quarterlyByKey.has(q4Key)) continue;
    const q1 = quarterlyByKey.get(`${fy.fiscalYear}-Q1`);
    const q2 = quarterlyByKey.get(`${fy.fiscalYear}-Q2`);
    const q3 = quarterlyByKey.get(`${fy.fiscalYear}-Q3`);
    if (!q1 || !q2 || !q3) continue;
    synthesized.push({
      fiscalYear: q4Key,
      totalRevenue: fy.totalRevenue - q1.totalRevenue - q2.totalRevenue - q3.totalRevenue,
      grossProfit: fy.grossProfit - q1.grossProfit - q2.grossProfit - q3.grossProfit,
      operatingIncome: fy.operatingIncome - q1.operatingIncome - q2.operatingIncome - q3.operatingIncome,
      netIncome: fy.netIncome - q1.netIncome - q2.netIncome - q3.netIncome,
      // Summed rather than derived from a weighted-average share count —
      // same "sum the quarters" convention essentially every financial data
      // vendor uses for quarterly EPS, even though it's a mild approximation
      // given quarter-to-quarter share-count drift.
      eps: fy.eps - q1.eps - q2.eps - q3.eps,
      sharesOutstandingDiluted: fy.sharesOutstandingDiluted,
      dividendsPerShare: fy.dividendsPerShare - q1.dividendsPerShare - q2.dividendsPerShare - q3.dividendsPerShare,
      dataSource: "sec-edgar",
    });
  }
  return synthesized;
}

/**
 * Cash flow's equivalent of synthesizeIncomeQ4 — see that function's doc
 * comment for the shared rationale (Annual − Q1 − Q2 − Q3, only when all
 * three real quarters exist). Every field here (OCF, capex, SBC, net
 * income) is a genuine flow, so straight subtraction is correct with no
 * "point-in-time" caveat the way sharesOutstandingDiluted needed above.
 * `freeCashFlow` is recomputed from the synthesized OCF/capex rather than
 * subtracted directly, to stay consistent with how toSecCashFlowRows
 * derives it (freeCashFlow = OCF + negative capex) everywhere else in this
 * file.
 */
function synthesizeCashFlowQ4(annual: CashFlowYear[], quarterly: CashFlowYear[]): CashFlowYear[] {
  const quarterlyByKey = new Map(quarterly.map((row) => [row.fiscalYear, row]));
  const synthesized: CashFlowYear[] = [];
  for (const fy of annual) {
    const q4Key = `${fy.fiscalYear}-Q4`;
    if (quarterlyByKey.has(q4Key)) continue;
    const q1 = quarterlyByKey.get(`${fy.fiscalYear}-Q1`);
    const q2 = quarterlyByKey.get(`${fy.fiscalYear}-Q2`);
    const q3 = quarterlyByKey.get(`${fy.fiscalYear}-Q3`);
    if (!q1 || !q2 || !q3) continue;
    const operatingCashFlow = fy.operatingCashFlow - q1.operatingCashFlow - q2.operatingCashFlow - q3.operatingCashFlow;
    const capitalExpenditures =
      fy.capitalExpenditures - q1.capitalExpenditures - q2.capitalExpenditures - q3.capitalExpenditures;
    synthesized.push({
      fiscalYear: q4Key,
      operatingCashFlow,
      freeCashFlow: computeFreeCashFlow(operatingCashFlow, capitalExpenditures),
      stockBasedCompensation:
        fy.stockBasedCompensation - q1.stockBasedCompensation - q2.stockBasedCompensation - q3.stockBasedCompensation,
      capitalExpenditures,
      netIncome: fy.netIncome - q1.netIncome - q2.netIncome - q3.netIncome,
      dataSource: "sec-edgar",
    });
  }
  return synthesized;
}

/**
 * Balance sheet figures are point-in-time snapshots, not flows — a fiscal
 * year-end's balance IS the Q4 balance (a 10-K's period-end date and a
 * would-be Q4 10-Q's period-end date are the same date; no filer ever needs
 * to separately report the latter, since the former already covers it). So
 * unlike synthesizeIncomeQ4/synthesizeCashFlowQ4's residual subtraction,
 * the correct fix here is simply reusing the annual row's own figures under
 * a `-Q4` key whenever no directly-tagged quarterly Q4 entry exists.
 */
function synthesizeBalanceQ4(annual: BalanceSheetYear[], quarterly: BalanceSheetYear[]): BalanceSheetYear[] {
  const quarterlyKeys = new Set(quarterly.map((row) => row.fiscalYear));
  const synthesized: BalanceSheetYear[] = [];
  for (const fy of annual) {
    const q4Key = `${fy.fiscalYear}-Q4`;
    if (quarterlyKeys.has(q4Key)) continue;
    synthesized.push({ ...fy, fiscalYear: q4Key, dataSource: "sec-edgar" });
  }
  return synthesized;
}

export interface SecFinancials {
  status: "ok" | "not-registered" | "unavailable";
  income: IncomeStatementYear[];
  balance: BalanceSheetYear[];
  cashFlow: CashFlowYear[];
  /** "fiscalYear-Qn" keyed (e.g. "2023-Q2") — see quarterlySeries' doc comment. Empty for foreign private issuers, which generally don't file 10-Qs. */
  incomeQuarterly: IncomeStatementYear[];
  balanceQuarterly: BalanceSheetYear[];
  cashFlowQuarterly: CashFlowYear[];
  /**
   * Every known split for this ticker (XBRL-detected + KNOWN_STOCK_SPLITS),
   * exposed so callers outside this file can retroactively adjust
   * non-SEC-sourced rows too — see applyKnownSplitAdjustment's doc comment
   * for why that's a real, separate gap from the per-fact fix inside
   * toSecIncomeRows above. Populated even when `status` isn't "ok" (using
   * detectStockSplits(undefined, symbol), which still returns
   * KNOWN_STOCK_SPLITS' entries with no XBRL payload — see that function),
   * since Yahoo/FMP may still be the ONLY source for a ticker whose SEC
   * fetch failed, and its pre-split years still need adjusting.
   */
  splits: StockSplitEvent[];
}

/**
 * Deep historical financial statements (typically 10+ fiscal years for an
 * established filer) from SEC EDGAR's XBRL company-facts API — the primary
 * "true 10-year history" source in the multi-source aggregation pipeline.
 * See lib/finance/aggregate.ts for how this is merged with Yahoo/FMP data.
 */
// Historical-depth note (checked against an iCharts-vs-Stox audit that
// flagged Stox' SEC-sourced history for a filer stopping around 2009 vs.
// iCharts reaching back to 1997): this file has no hardcoded start-year
// cutoff anywhere — annualSeries/quarterlySeries (and their Detailed
// siblings) all walk whatever fiscal years exist in the companyfacts
// payload with no floor. The ~2009 wall is a property of the *source data*, not this
// integration: SEC's structured-XBRL mandate only took effect for large
// accelerated filers' fiscal periods ending after June 15, 2009 (phased in
// for smaller filers afterward), and the companyfacts API is built
// entirely from structured XBRL — so data.sec.gov genuinely has nothing
// machine-readable before that for almost any filer, regardless of how far
// back its actual 10-K filings go. A pre-2009 chart (like iCharts showing
// 1997) has to come from a different source (e.g. a vendor that hand-parses
// older plain-text/HTML filings) — there's no additional EDGAR request
// shape or tag that unlocks it here.
export async function fetchSecFinancials(symbol: string): Promise<SecFinancials> {
  // Computed once, up front, from KNOWN_STOCK_SPLITS alone (no XBRL payload
  // fetched yet at this point) — see the `splits` field's doc comment on
  // SecFinancials for why every return path below needs this, not just the
  // "ok" one.
  const knownSplitsOnly = detectStockSplits(undefined, symbol);
  const empty = {
    income: [],
    balance: [],
    cashFlow: [],
    incomeQuarterly: [],
    balanceQuarterly: [],
    cashFlowQuarterly: [],
    splits: knownSplitsOnly,
  };
  const map = await getTickerMap();
  if (!map) return { status: "unavailable", ...empty };

  const match = map.get(bareSymbol(symbol));
  if (!match) return { status: "not-registered", ...empty };

  const cikPadded = String(match.cik).padStart(10, "0");
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPadded}.json`, {
      headers: { "User-Agent": USER_AGENT },
      next: { revalidate: 86_400 }, // annual filings — daily revalidation is plenty
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // This is the single most important line in this file for diagnosing
      // "why is history only ~4 years" reports — a non-ok response here
      // means the deep-history layer contributed zero rows and everything
      // downstream silently fell back to Yahoo's ~4-year-capped data. See
      // the USER_AGENT doc comment above for the likely cause of a 403.
      console.warn(
        `[Stox] SEC EDGAR company-facts fetch failed for ${symbol} (CIK ${match.cik}): ` +
          `HTTP ${res.status} ${res.statusText}. Falling back to Yahoo/FMP for this ticker's ` +
          `history (Yahoo alone typically caps out around 4 fiscal years).`
      );
      return { status: "unavailable", ...empty };
    }

    const data = (await res.json()) as XbrlCompanyFacts;
    const facts = data.facts?.["us-gaap"];
    if (!facts) {
      console.warn(`[Stox] SEC EDGAR company-facts response for ${symbol} (CIK ${match.cik}) had no us-gaap facts.`);
      return { status: "unavailable", ...empty };
    }

    // Same XBRL payload backs both — no extra network round trip needed for
    // the quarterly (10-Q) series alongside the annual (10-K/20-F) one.
    //
    // Stock splits apply once, from the full facts payload, and get threaded
    // into both the annual and quarterly income builders below so a split
    // that lands mid-year still retroactively adjusts every prior quarter
    // and fiscal year's per-share figures consistently.
    const splits = detectStockSplits(facts, symbol);
    // See quarterlySeries/inferSecFiscalYearEndMonth's doc comments above —
    // computed once per symbol, then closed over so every quarterly-series
    // call below (across income/balance/cash-flow, however many tag lists
    // each one tries) uses the identical fiscal-year-end assumption without
    // toSecIncomeRows/toSecBalanceRows/toSecCashFlowRows needing to know
    // this parameter exists at all — they still just call `series(facts,
    // tags)` exactly as before, matching the plain SeriesFn/SeriesFnDetailed
    // signature annualSeries/annualSeriesDetailed also satisfy unchanged.
    const fiscalYearEndMonth = inferSecFiscalYearEndMonth(facts);
    const quarterlySeriesForCompany: SeriesFn = (f, tags, unitKey) => quarterlySeries(f, tags, fiscalYearEndMonth, unitKey);
    const quarterlySeriesDetailedForCompany: SeriesFnDetailed = (f, tags, unitKey) =>
      quarterlySeriesDetailed(f, tags, fiscalYearEndMonth, unitKey);
    const incomeAnnual = toSecIncomeRows(facts, annualSeries, annualSeriesDetailed, splits);
    const balanceAnnual = toSecBalanceRows(facts, annualSeries);
    const cashFlowAnnual = toSecCashFlowRows(facts, annualSeries, false);
    const incomeQuarterlyRaw = toSecIncomeRows(facts, quarterlySeriesForCompany, quarterlySeriesDetailedForCompany, splits);
    const balanceQuarterlyRaw = toSecBalanceRows(facts, quarterlySeriesForCompany);
    const cashFlowQuarterlyRaw = toSecCashFlowRows(facts, quarterlySeriesForCompany, true);
    // See synthesizeIncomeQ4/synthesizeCashFlowQ4/synthesizeBalanceQ4's doc
    // comments — fills each fiscal year's missing 4th quarter, which no
    // filer ever files as a standalone 10-Q, so it can never come from
    // toSecIncomeRows/toSecBalanceRows/toSecCashFlowRows' tag-based
    // extraction alone.
    const result: SecFinancials = {
      status: "ok",
      income: incomeAnnual,
      balance: balanceAnnual,
      cashFlow: cashFlowAnnual,
      incomeQuarterly: [...incomeQuarterlyRaw, ...synthesizeIncomeQ4(incomeAnnual, incomeQuarterlyRaw)].sort((a, b) =>
        a.fiscalYear.localeCompare(b.fiscalYear)
      ),
      balanceQuarterly: [...balanceQuarterlyRaw, ...synthesizeBalanceQ4(balanceAnnual, balanceQuarterlyRaw)].sort(
        (a, b) => a.fiscalYear.localeCompare(b.fiscalYear)
      ),
      cashFlowQuarterly: [...cashFlowQuarterlyRaw, ...synthesizeCashFlowQ4(cashFlowAnnual, cashFlowQuarterlyRaw)].sort(
        (a, b) => a.fiscalYear.localeCompare(b.fiscalYear)
      ),
      splits,
    };
    // A 200 response with zero extracted rows is a different failure mode
    // than a 403 (the tag lists in toSecIncomeRows/etc. not matching this
    // filer's chosen XBRL tags) — worth its own log line since it wouldn't
    // otherwise be distinguishable from "SEC EDGAR is fine, this ticker
    // just doesn't have annual data" from the outside.
    if (result.income.length === 0 && result.balance.length === 0 && result.cashFlow.length === 0) {
      console.warn(
        `[Stox] SEC EDGAR company-facts for ${symbol} (CIK ${match.cik}) fetched OK but yielded ` +
          `0 fiscal years — likely an XBRL tag mismatch (see toSecIncomeRows/toSecBalanceRows tag lists).`
      );
    }
    return result;
  } catch (err) {
    if (isAbortError(err)) {
      console.warn(
        `[Stox] SEC EDGAR company-facts fetch timed out after ${FETCH_TIMEOUT_MS}ms for ${symbol} (CIK ${match.cik}) — falling back to Yahoo/FMP for this ticker's history.`
      );
    } else {
      console.warn(`[Stox] SEC EDGAR company-facts fetch threw for ${symbol}:`, err instanceof Error ? err.message : err);
    }
    return { status: "unavailable", ...empty };
  }
}
