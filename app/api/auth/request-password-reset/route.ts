import { getDb, ensureSchema } from "@/lib/db/client";
import { createPasswordResetToken } from "@/lib/auth/passwordReset";
import { noStoreJson, dbErrorJson } from "@/lib/http/noStore";

// Mobile state-sync fix: never let this be cached — see lib/http/noStore.ts.
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid request body" }, { status: 400 });
  }

  const { email } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return noStoreJson({ error: "Enter a valid email address" }, { status: 400 });
  }

  // Same response regardless of whether the account exists — distinguishing
  // them would let an attacker enumerate which emails are registered, the
  // same anti-enumeration reasoning as login's genericError.
  const genericResponse = noStoreJson({
    message: "If an account exists for that email, a password reset link has been generated.",
  });

  try {
    await ensureSchema();
    const db = getDb();
    const normalized = email.trim().toLowerCase();

    const result = await db.execute({
      sql: "SELECT id, username FROM users WHERE email = ?",
      args: [normalized],
    });
    const row = result.rows[0];
    if (!row) return genericResponse;

    const userId = String(row.id);
    const token = await createPasswordResetToken(userId);

    // No email provider is configured in this project (no RESEND_API_KEY or
    // equivalent — see .env.local.example) so the reset token is delivered
    // via server log instead of a real email, matching this project's
    // established "optional integration, documented fallback" pattern
    // (see FMP_API_KEY/SEC_EDGAR_CONTACT). Visible via `vercel logs` in
    // production or the terminal in local dev. TODO: wire up a real email
    // provider and stop logging tokens once one is configured.
    console.log(
      `[Stox] Password reset requested for user "${String(row.username)}" (${normalized}). ` +
        `Reset token (valid 1 hour): ${token}`
    );

    return genericResponse;
  } catch (err) {
    return dbErrorJson(err, "Request password reset");
  }
}
