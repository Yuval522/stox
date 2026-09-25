import { randomBytes } from "crypto";
import { getDb, ensureSchema } from "@/lib/db/client";

/**
 * Password reset tokens follow the exact same "opaque random value is the
 * DB primary key" pattern as lib/auth/session.ts's session tokens — same
 * reasoning: nothing to verify beyond "does this exact token exist and is
 * it unexpired", no signing secret to manage or rotate. Kept as its own
 * module (rather than folded into session.ts) because a reset token proves
 * a different thing than a session token ("this browser asked to change
 * this account's password" vs. "this browser IS this user right now") and
 * the two must never be accepted interchangeably by any route.
 */

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Creates a new reset token for a user, first deleting any reset tokens
 * that user already had outstanding — only the most recently requested
 * link should ever work, so an old, possibly-leaked token (e.g. sitting in
 * a log from an earlier request) can't still be redeemed after a newer
 * request superseded it.
 */
export async function createPasswordResetToken(userId: string): Promise<string> {
  await ensureSchema();
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const now = Date.now();

  await db.execute({ sql: "DELETE FROM password_resets WHERE user_id = ?", args: [userId] });
  await db.execute({
    sql: "INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    args: [token, userId, now, now + RESET_TTL_MS],
  });

  return token;
}

/**
 * Validates a token without consuming it — used by reset-password to look
 * up which account a submitted token belongs to. Returns null for a
 * missing, unknown, or expired token (an expired row is lazily deleted
 * here, mirroring session.ts's getCurrentUser lazy-cleanup pattern).
 */
export async function getUserIdForResetToken(token: string): Promise<string | null> {
  await ensureSchema();
  const db = getDb();

  const result = await db.execute({
    sql: "SELECT user_id, expires_at FROM password_resets WHERE token = ?",
    args: [token],
  });
  const row = result.rows[0];
  if (!row) return null;

  if (Number(row.expires_at) < Date.now()) {
    await db.execute({ sql: "DELETE FROM password_resets WHERE token = ?", args: [token] });
    return null;
  }

  return String(row.user_id);
}

/** Deletes a reset token so it can never be redeemed a second time. */
export async function consumePasswordResetToken(token: string): Promise<void> {
  await ensureSchema();
  const db = getDb();
  await db.execute({ sql: "DELETE FROM password_resets WHERE token = ?", args: [token] });
}
