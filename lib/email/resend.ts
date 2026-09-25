import { Resend } from "resend";

/**
 * Server-only email client. Deliberately NOT constructed at module load —
 * `new Resend(apiKey)` would throw immediately for every environment that
 * hasn't set RESEND_API_KEY yet (every environment until someone actually
 * configures it), which would break importing this file at all. Instead
 * this mirrors the FMP_API_KEY "optional integration,
 * documented fallback" pattern already used elsewhere in this app:
 * isEmailConfigured() lets a call site check first and fall back to
 * something else (see app/api/auth/request-password-reset/route.ts, which
 * falls back to console-logging the reset token) rather than the whole
 * route 500ing because no email provider is set up.
 */

let client: Resend | null = null;

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function getClient(): Resend {
  if (!client) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      // Callers are expected to check isEmailConfigured() first — this is
      // a programmer-error guard, not a user-facing failure path.
      throw new Error("RESEND_API_KEY is not set");
    }
    client = new Resend(apiKey);
  }
  return client;
}

// Resend's free tier, before a custom domain is verified, can only send
// FROM this exact address (see Resend's own testing/getting-started docs —
// resend.com/docs/dashboard/domains/introduction). Once a real domain is
// verified in the Resend dashboard, set RESEND_FROM_EMAIL (e.g.
// "Stox <noreply@yourdomain.com>") and this constant is only ever the
// fallback for local dev / not-yet-verified deployments.
const DEFAULT_FROM = "Stox <onboarding@resend.dev>";

interface PasswordResetEmailParams {
  to: string;
  username: string;
  resetUrl: string;
  token: string;
}

export async function sendPasswordResetEmail(
  params: PasswordResetEmailParams
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { to, username, resetUrl, token } = params;
  const from = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;

  try {
    const result = await getClient().emails.send({
      from,
      to,
      subject: "Reset your Stox password",
      html: buildPasswordResetEmailHtml({ username, resetUrl, token }),
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error sending email" };
  }
}

/**
 * Plain inline-styled HTML (no <style> block, no external stylesheet) —
 * the only reliable way to get consistent rendering across email clients,
 * many of which strip <style> tags or ignore external CSS entirely. Not an
 * attempt to reproduce the app's actual dark "retro-digital" theme
 * (unreadable in an email client that forces light mode, e.g. Gmail's
 * "Dark mode" toggle inverts unstyled-but-not-explicitly-dark content
 * unpredictably) — this is a plain light-background transactional email,
 * deliberately simple.
 */
function buildPasswordResetEmailHtml(params: { username: string; resetUrl: string; token: string }): string {
  const { username, resetUrl, token } = params;
  const escapedUsername = escapeHtml(username);
  const escapedResetUrl = escapeHtml(resetUrl);
  const escapedToken = escapeHtml(token);

  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:0.08em;color:#18181b;text-transform:uppercase;">Stox</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 0 32px;">
                <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;color:#18181b;">Reset your password</h1>
                <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#52525b;">
                  Hi ${escapedUsername}, we received a request to reset the password on your Stox account. Click the
                  button below to choose a new one. This link expires in <strong>1 hour</strong>.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;" align="center">
                <a href="${escapedResetUrl}"
                   style="display:inline-block;background-color:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;">
                  Reset Password
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <p style="margin:0 0 6px 0;font-size:12px;color:#71717a;">
                  If the button doesn't work, copy your one-time reset token into the reset form:
                </p>
                <p style="margin:0;padding:10px 12px;background-color:#f4f4f5;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#18181b;word-break:break-all;">
                  ${escapedToken}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px 32px;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#a1a1aa;">
                  If you didn't request a password reset, you can safely ignore this email — your password won't be
                  changed.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
