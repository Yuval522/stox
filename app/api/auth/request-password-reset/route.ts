import { getDb, ensureSchema } from "@/lib/db/client";
import { createPasswordResetToken } from "@/lib/auth/passwordReset";
import { sendPasswordResetEmail, isEmailConfigured } from "@/lib/email/resend";
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
    const username = String(row.username);
    const token = await createPasswordResetToken(userId);

    // Deliberately derived from the incoming request rather than a
    // hardcoded/env-configured domain — this way the emailed link always
    // points at whichever host actually served the request (a Vercel
    // preview deployment, production, or http://localhost:3000 in local
    // dev) with zero extra configuration.
    const origin = new URL(request.url).origin;
    const resetUrl = `${origin}/?resetToken=${encodeURIComponent(token)}`;

    if (isEmailConfigured()) {
      const emailResult = await sendPasswordResetEmail({ to: normalized, username, resetUrl, token });
      if (!emailResult.ok) {
        // Sending failed (bad/revoked API key, Resend outage, recipient
        // rejected, free-tier sender restrictions, ...) — log the real
        // reason server-side, and still log the token itself as a
        // fallback so the user isn't locked out of their own account just
        // because the email didn't go out. The response to the client
        // stays the same generic message either way (anti-enumeration).
        console.error(`[Stox] Failed to send password reset email to ${normalized}:`, emailResult.error);
        console.log(
          `[Stox] Password reset requested for user "${username}" (${normalized}). ` +
            `Email delivery failed (see error above) — reset token (valid 1 hour): ${token}`
        );
      }
    } else {
      // No RESEND_API_KEY configured — documented, non-broken fallback
      // (see .env.local.example), matching this project's established
      // "optional integration, documented fallback" pattern already used
      // for FMP_API_KEY. Visible via `vercel logs` in
      // production or the terminal in local dev.
      console.log(
        `[Stox] Password reset requested for user "${username}" (${normalized}). ` +
          `RESEND_API_KEY is not set, so no email was sent — reset token (valid 1 hour): ${token}`
      );
    }

    return genericResponse;
  } catch (err) {
    return dbErrorJson(err, "Request password reset");
  }
}
