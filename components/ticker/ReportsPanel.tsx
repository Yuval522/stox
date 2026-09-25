// Deleted: the SEC Filings / "Reports" tab was removed along with the SEC
// EDGAR integration it depended on (see CLAUDE.md's Data layer section and
// the removal of lib/finance/providers/sec-edgar.ts). There is no non-SEC
// substitute for this feature, so it was removed outright rather than
// rewired to another provider.
//
// This file could not be unlinked from disk in this sandbox (the mounted
// filesystem intermittently refuses rm/unlink on some tracked files — see
// CLAUDE.md's "Known constraints" section) and is stubbed out here instead.
// It is no longer imported anywhere (see components/ticker/DataExplorerTabs.tsx,
// which no longer references ReportsPanel or a "Reports" tab) and contributes
// nothing to the build.
export {};
