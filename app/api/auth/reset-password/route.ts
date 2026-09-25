import { getDb, ensureSchema } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { getUserIdForResetToken, consumePasswordResetToken } from "@/lib/auth/passwordReset";
import { noStoreJson, dbErrorJson } from "@/lib/http/noStore";

// Mobile state-sync fix: never let this be cached — see lib/http/noStore.ts.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid request body" }, { status: 400 });
  }

  const { token, newPassword } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || !token.trim()) {
    return noStoreJson({ error: "Missing or invalid reset token" }, { status: 400 });
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return noStoreJson({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  try {
    await ensureSchema();
    const db = getDb();

    const userId = await getUserIdForResetToken(token);
    if (!userId) {
      return noStoreJson({ error: "This reset link is invalid or has expired" }, { status: 400 });
    }

    const passwordHash = await hashPassword(newPassword);
    await db.execute({
      sql: "UPDATE users SET password_hash = ? WHERE id = ?",
      args: [passwordHash, userId],
    });

    // Force re-login everywhere: any session created under the old
    // (possibly-compromised, possibly-forgotten) password should not
    // silently keep working after a reset.
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] });

    // Single-use — this token can never be redeemed again.
    await consumePasswordResetToken(token);

    const result = await db.execute({
      sql: "SELECT id, username, email FROM users WHERE id = ?",
      args: [userId],
    });
    const row = result.rows[0];
    if (!row) {
      // Extremely unlikely (user deleted between the two queries above) —
      // the password was still changed successfully, just can't log them
      // in automatically.
      return noStoreJson({ error: "Password updated, but please log in again" }, { status: 200 });
    }

    const newSessionToken = await createSession(userId);
    await setSessionCookie(newSessionToken);

    return noStoreJson({
      user: { id: userId, username: String(row.username), email: String(row.email) },
    });
  } catch (err) {
    return dbErrorJson(err, "Reset password");
  }
}
