"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth/AuthContext";
import { Portal } from "@/components/shared/Portal";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  /** Which tab to open on — e.g. the Topbar's "Sign Up" entry opens straight to Sign Up rather than making the user click a tab first. */
  initialTab?: "login" | "signup";
}

type Tab = "login" | "signup" | "forgot";

const inputClass =
  "w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

const USERNAME_MIN = 3;
const USERNAME_MAX = 24;

/**
 * Username UX fix (live report: typing a real name like "Yuval Rokni" hit
 * a blocking "letters/numbers/underscores only" error only AFTER
 * submitting — surprising and unhelpful, since nothing on the field
 * itself hinted at the restriction while typing). Sanitizes on every
 * keystroke instead of validating after the fact: any run of whitespace
 * collapses to a single underscore (so "Yuval Rokni" becomes
 * "Yuval_Rokni" as you type, "Yuval  Rokni" doesn't leave a double
 * underscore), anything else outside [a-zA-Z0-9_] is silently dropped,
 * and the result is capped at USERNAME_MAX — so the field's value is
 * ALWAYS a valid username shape, and the only thing left for the inline
 * hint below to flag is being too short, which sanitizing alone can't fix.
 */
function sanitizeUsername(raw: string): string {
  return raw
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, USERNAME_MAX);
}

/**
 * Combined Login/Signup modal — one component with a tab switch rather
 * than two separate modals, since a user who opens the wrong tab (e.g.
 * clicks "Log In" but actually needs to create an account) should be able
 * to switch without closing and reopening anything. Same modal shell
 * (backdrop + centered glass-card, max-h-[85vh] + overflow-y-auto for
 * short/mobile viewports) as every other modal in this app
 * (AddStockModal/EditCashModal/EditHoldingModal/SellHoldingModal).
 */
export function AuthModal({ open, onClose, initialTab = "login" }: AuthModalProps) {
  const { login, signup, requestPasswordReset, resetPassword } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Forgot-password view has its own two independent sub-forms (request a
  // token by email, then redeem that token for a new password) shown
  // together rather than as separate steps — see this state's comment
  // above the JSX below for why.
  const [resetEmail, setResetEmail] = useState("");
  const [resetRequestMessage, setResetRequestMessage] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");

  // Reset every field whenever the modal (re)opens — including switching
  // to the tab the caller asked for — so a stray password/error from a
  // previous open never lingers.
  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setUsername("");
      setEmail("");
      setPassword("");
      setIdentifier("");
      setLoginPassword("");
      setError(null);
      setSubmitting(false);
      setResetEmail("");
      setResetRequestMessage(null);
      setResetToken("");
      setResetNewPassword("");
    }
  }, [open, initialTab]);

  if (!open) return null;

  function switchTab(next: Tab) {
    setTab(next);
    setError(null);
  }

  async function handleLogin() {
    setError(null);
    if (!identifier.trim() || !loginPassword) {
      setError("Enter your username/email and password");
      return;
    }
    setSubmitting(true);
    const result = await login({ identifier: identifier.trim(), password: loginPassword });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  async function handleSignup() {
    setError(null);
    if (!username.trim() || !email.trim() || !password) {
      setError("Fill in all fields");
      return;
    }
    // Character shape is already guaranteed by sanitizeUsername() running
    // on every keystroke (see the Username field's onChange below) — the
    // only thing that can still be wrong here is length, surfaced live by
    // the hint under the field rather than saved for a submit-time error.
    if (username.length < USERNAME_MIN) {
      setError(`Username needs at least ${USERNAME_MIN} characters`);
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setSubmitting(true);
    const result = await signup({ username: username.trim(), email: email.trim(), password });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  async function handleRequestReset() {
    setError(null);
    setResetRequestMessage(null);
    if (!resetEmail.trim()) {
      setError("Enter your account email");
      return;
    }
    setSubmitting(true);
    const result = await requestPasswordReset({ email: resetEmail.trim() });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setResetRequestMessage(result.message);
  }

  async function handleResetPassword() {
    setError(null);
    if (!resetToken.trim() || !resetNewPassword) {
      setError("Enter your reset token and a new password");
      return;
    }
    if (resetNewPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setSubmitting(true);
    const result = await resetPassword({ token: resetToken.trim(), newPassword: resetNewPassword });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  return (
    <Portal>
      <div className="fixed inset-0 z-[59] bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tab === "login" ? "Log in" : tab === "signup" ? "Create account" : "Reset password"}
        className="glass-card fixed left-1/2 top-1/2 z-[60] max-h-[85vh] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">
            {tab === "login" ? "Log In" : tab === "signup" ? "Create Account" : "Reset Password"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {tab !== "forgot" && (
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-md bg-card/60 p-1">
            <button
              type="button"
              onClick={() => switchTab("login")}
              className={cn(
                "h-11 rounded-md text-sm font-medium transition-colors md:h-9",
                tab === "login" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Log In
            </button>
            <button
              type="button"
              onClick={() => switchTab("signup")}
              className={cn(
                "h-11 rounded-md text-sm font-medium transition-colors md:h-9",
                tab === "signup" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Sign Up
            </button>
          </div>
        )}

        {tab === "login" ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Username or Email</label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="you@example.com"
                autoComplete="username"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Password</label>
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="••••••••"
                autoComplete="current-password"
                className={inputClass}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="button"
              disabled={submitting}
              onClick={handleLogin}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Log In
            </button>
            <button
              type="button"
              onClick={() => {
                setResetEmail(identifier.includes("@") ? identifier.trim() : "");
                switchTab("forgot");
              }}
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Forgot password?
            </button>
          </div>
        ) : tab === "signup" ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(sanitizeUsername(e.target.value))}
                placeholder="e.g. yuval522"
                autoComplete="username"
                className={inputClass}
              />
              {/* Real-time inline feedback (live report: the old
                  letters/numbers/underscores error only ever showed up
                  AFTER a failed submit) — sanitizeUsername already strips
                  spaces/symbols as you type, so the only thing left to
                  flag here is length; turns red only once something's
                  been typed and it's still too short, stays a quiet
                  neutral hint otherwise so it doesn't read as an error
                  before the user has even started. */}
              <p className={cn("mt-1 text-[11px]", username.length > 0 && username.length < USERNAME_MIN ? "text-destructive" : "text-muted-foreground")}>
                {username.length > 0 && username.length < USERNAME_MIN
                  ? `Needs at least ${USERNAME_MIN} characters (spaces become underscores)`
                  : `${USERNAME_MIN}-${USERNAME_MAX} characters — letters, numbers, and underscores`}
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSignup()}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="button"
              disabled={submitting}
              onClick={handleSignup}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Account
            </button>
            <p className="text-[11px] text-muted-foreground">
              Creating an account moves your current portfolio, watchlist, and settings from this browser into your
              new account.
            </p>
          </div>
        ) : (
          // Forgot-password view shows both sub-forms at once (request a
          // token by email, then paste that token + a new password) rather
          // than as a two-step wizard: no email provider is configured for
          // this project yet (see .env.local.example), so the token is
          // delivered via server log instead of an email link the user
          // could click through automatically — they have to copy it over
          // by hand, and showing both forms together avoids an extra
          // "next" click for something that isn't actually sequential from
          // the UI's point of view.
          <div className="space-y-4">
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Enter your account email. If it matches an account, a reset token will be generated — since this app
                doesn&apos;t send real emails yet, an admin can retrieve it from the server logs.
              </p>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Email</label>
                <input
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleRequestReset()}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className={inputClass}
                />
              </div>
              {resetRequestMessage && <p className="text-xs text-success">{resetRequestMessage}</p>}
              <button
                type="button"
                disabled={submitting}
                onClick={handleRequestReset}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Request Reset Token
              </button>
            </div>

            <div className="h-px bg-border" />

            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Reset Token</label>
                <input
                  type="text"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder="Paste the token from the server logs"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">New Password</label>
                <input
                  type="password"
                  value={resetNewPassword}
                  onChange={(e) => setResetNewPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleResetPassword()}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  className={inputClass}
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <button
                type="button"
                disabled={submitting}
                onClick={handleResetPassword}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Reset Password
              </button>
            </div>

            <button
              type="button"
              onClick={() => switchTab("login")}
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Back to Log In
            </button>
          </div>
        )}
      </div>
    </Portal>
  );
}
