import { Pool, type QueryResultRow } from "@neondatabase/serverless";

/**
 * Server-only database client. Never import this from a "use client"
 * component — @neondatabase/serverless depends on Node.js APIs that don't
 * exist in the browser.
 *
 * Why Postgres/Neon instead of a local file: Vercel's serverless functions
 * have a read-only filesystem outside /tmp, and even /tmp is ephemeral
 * (wiped between cold starts) and not shared across concurrent instances —
 * there is no way for a plain on-disk file to correctly back multi-user
 * data there. That's an architectural fact of serverless hosting, not a
 * missing setting, so unlike the previous Turso-based setup there is
 * deliberately NO "falls back to a local file" branch here: this app needs
 * a real network-reachable Postgres connection in every environment,
 * local dev included, or it fails loudly (see dbErrorJson in
 * lib/http/noStore.ts) instead of silently "working" on one machine and
 * breaking the moment it's deployed.
 *
 * Connection string resolution (see .env.local.example for the full setup
 * steps): reads DATABASE_URL, falling back to POSTGRES_URL — both are
 * injected automatically into every environment (Production, Preview, and
 * Development) the moment you connect the Neon integration from Vercel's
 * dashboard Storage tab. No CLI install, no separate account signup, and
 * no manually copying a URL/token into Environment Variables — Vercel's
 * marketplace integration does all of that for you in one click. For
 * local development, either run `vercel env pull .env.development.local`
 * (after `vercel link`) to fetch the same value, or copy it from the
 * Vercel dashboard by hand into your own .env.local.
 *
 * A consequence worth knowing if you ever try to point this at a
 * non-Neon Postgres for local testing: @neondatabase/serverless's `Pool`
 * speaks WebSocket to the server by default (Neon's own infrastructure
 * natively terminates that), not the raw Postgres wire protocol a plain
 * `postgres://` server understands — confirmed directly during this
 * repo's own sandboxed testing, where pointing `Pool` at a real, freshly
 * initialized local Postgres instance failed with a WebSocket-level
 * connection error, not a SQL/schema problem (schema and query logic were
 * verified separately, against that same local Postgres, using the plain
 * `pg` driver instead). Against a genuine Neon-hosted DATABASE_URL this is
 * a non-issue; it only bites you if you try to swap in an ordinary
 * self-hosted Postgres without also running Neon's `wsproxy` in front of
 * it (see node_modules/@neondatabase/serverless/DEPLOY.md).
 */

declare global {
  // eslint-disable-next-line no-var
  var __finlensDbPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __finlensDbMigrated: Promise<void> | undefined;
}

function resolveConnectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "No Postgres connection string found (checked DATABASE_URL, POSTGRES_URL). " +
        "Connect the Neon integration from your Vercel project's Storage tab " +
        "(auto-injects these for Production/Preview/Development), then for local " +
        "dev run `vercel env pull .env.development.local` — see .env.local.example."
    );
  }
  return url;
}

/**
 * Cached on `globalThis` rather than a plain module-level `let` — Next.js
 * dev mode hot-reloads route handler modules on every save, which would
 * otherwise open a fresh pool on every single edit. Same pattern used for
 * the previous libsql client and commonly used for Prisma/DB clients in
 * Next.js dev. Reusing one Pool across warm serverless invocations (rather
 * than opening/closing one per request) is also the more efficient of the
 * two patterns Neon's driver supports for a long-lived Node.js function
 * runtime (as opposed to a one-shot edge function).
 */
function getPool(): Pool {
  if (!globalThis.__finlensDbPool) {
    globalThis.__finlensDbPool = new Pool({ connectionString: resolveConnectionString() });
  }
  return globalThis.__finlensDbPool;
}

type ExecuteQuery = string | { sql: string; args?: unknown[] };

interface ExecuteResult<T extends QueryResultRow = Record<string, unknown>> {
  rows: T[];
}

/**
 * Thin adapter kept intentionally shaped like the previous libsql Client's
 * `execute()` — same `{ sql, args }` input, same `{ rows }` output — so
 * every call site (lib/auth/session.ts, every app/api/**\/route.ts) needed
 * ZERO changes for this migration. The one real difference this papers
 * over: SQLite/libsql uses positional `?` placeholders, Postgres uses
 * `$1, $2, ...`. None of this app's hand-written SQL contains a literal
 * `?` character outside of a placeholder position, so a plain left-to-right
 * substitution is safe.
 */
function toPositionalPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

async function execute<T extends QueryResultRow = Record<string, unknown>>(
  query: ExecuteQuery
): Promise<ExecuteResult<T>> {
  const { sql, args } = typeof query === "string" ? { sql: query, args: undefined } : query;
  const pool = getPool();
  const result = await pool.query<T>(toPositionalPlaceholders(sql), args);
  return { rows: result.rows };
}

/**
 * Kept as a named export (rather than exposing the raw Pool) so route
 * handlers keep calling `getDb().execute(...)` exactly as before.
 */
export function getDb(): { execute: typeof execute } {
  return { execute };
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  // Password reset tokens: opaque random token (same style as sessions'),
  // short-lived (1 hour, see lib/auth/passwordReset.ts), single-use —
  // deleted the moment it's redeemed or superseded by a newer request for
  // the same user. Deliberately a separate table from `sessions` even
  // though the shape is similar: a reset token proves "requested a
  // password change," not "is currently logged in," and the two must
  // never be confused or accepted interchangeably by any route.
  `CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id)`,
  // Deliberately a single JSON blob per (user_id, data_key) rather than
  // normalized per-holding/per-symbol tables — this exactly mirrors the
  // shape each client store (portfolio/watchlist/settings) already
  // serializes to localStorage as one JSON object, so migrating from
  // "localStorage on one browser" to "a row owned by this user" is a
  // straight lift of the same JSON with no business-logic changes to
  // derive.ts/aggregate.ts/etc. The composite PRIMARY KEY here is what the
  // user_data upsert's `ON CONFLICT (user_id, data_key)` clause targets.
  `CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT NOT NULL,
    data_key TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, data_key)
  )`,
  // Secure API Keys Migration: user-supplied Finnhub/Polygon/Alpha Vantage
  // keys, one row per (user, provider). `encrypted_key` is never plaintext
  // — see lib/security/encryption.ts — and this table is deliberately
  // separate from `user_data` (rather than another data_key like
  // "settings") specifically so these secrets never ride along inside the
  // general, unencrypted settings JSON blob the way they used to.
  `CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    -- Last 4 chars only, plaintext, purely for a "connected, ending in
    -- ab12" settings-page display without decrypting on every page load —
    -- same low-risk convention as e.g. a card processor showing a card's
    -- last 4 digits. The real key is only ever decrypted server-side at
    -- the moment it's used to call a provider (lib/db/apiKeys.ts).
    key_last4 TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider)
  )`,
  // Strategy Builder precomputed universe metrics: one row per curated
  // screening symbol (lib/finance/symbols.ts's STRATEGY_UNIVERSE_SYMBOLS),
  // refreshed by a background cron job (app/api/cron/refresh-strategy-universe,
  // lib/strategy/universe-refresh.ts) instead of live Yahoo Finance calls
  // made at request time by lib/strategy/execute.ts. This is what lets a
  // screening query run instantly and reliably against several hundred symbols'
  // worth of RSI/SMA technicals without a burst of live network calls (and
  // its associated rate-limit risk) on every single request. Every column
  // besides symbol/name/updated_at is nullable — any individual fetch
  // (quote or technical) can legitimately fail for one symbol without
  // that blocking the row from existing at all; execute.ts's live-fetch
  // fallback path only kicks in for a symbol with NO row here yet.
  `CREATE TABLE IF NOT EXISTS strategy_universe_metrics (
    symbol TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price DOUBLE PRECISION,
    change_percent DOUBLE PRECISION,
    market_cap DOUBLE PRECISION,
    pe_ratio DOUBLE PRECISION,
    dividend_yield_percent DOUBLE PRECISION,
    volume DOUBLE PRECISION,
    rsi14 DOUBLE PRECISION,
    price_vs_sma50 DOUBLE PRECISION,
    price_vs_sma200 DOUBLE PRECISION,
    updated_at BIGINT NOT NULL
  )`,
];

/**
 * Idempotent (CREATE TABLE/INDEX IF NOT EXISTS) migration runner. Cached
 * as an in-flight/completed promise on globalThis so concurrent requests
 * during the same process lifetime don't all race to run it, and repeat
 * calls after the first are instant no-ops.
 */
export function ensureSchema(): Promise<void> {
  if (!globalThis.__finlensDbMigrated) {
    globalThis.__finlensDbMigrated = (async () => {
      const db = getDb();
      for (const sql of SCHEMA_STATEMENTS) {
        await db.execute(sql);
      }
    })();
  }
  return globalThis.__finlensDbMigrated;
}
