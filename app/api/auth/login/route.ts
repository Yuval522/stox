import { getDb, ensureSchema } from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
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

  const { identifier, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof identifier !== "string" || !identifier.trim() || typeof password !== "string" || !password) {
    return noStoreJson({ error: "Enter your username/email and password" }, { status: 400 });
  }

  try {
    await ensureSchema();
    const db = getDb();
    const normalized = identifier.trim().toLowerCase();

    const result = await db.execute({
      sql: "SELECT id, username, email, password_hash FROM users WHERE username = ? OR email = ?",
      args: [identifier.trim(), normalized],
    });
    const row = result.rows[0];

    // TEMP DEBUG (2026-09-25, remove after diagnosing the "correct
    // credentials rejected" report): never logs the raw password or the
    // stored hash — only which of the two failure branches actually fired,
    // plus enough shape info (row count, hash length/prefix) to tell a
    // "no matching account" bug apart from a "found the account, bcrypt
    // says no" bug without exposing anything secret. bcrypt hash prefixes
    // are versioning info by design ($2a$/$2b$10$...), not sensitive.
    console.log(
      `[TEMP DEBUG login] identifier(raw)=${JSON.stringify(identifier.trim())} ` +
        `identifier(normalized)=${JSON.stringify(normalized)} rowsFound=${result.rows.length}` +
        (row ? ` matchedUserId=${row.id} matchedUsername=${JSON.stringify(row.username)} matchedEmail=${JSON.stringify(row.email)} hashPrefix=${String(row.password_hash).slice(0, 7)} hashLength=${String(row.password_hash).length}` : "")
    );

    // Same generic error for "no such account" and "wrong password" —
    // distinguishing them would let an attacker enumerate which
    // usernames/emails are registered.
    const genericError = noStoreJson({ error: "Incorrect username/email or password" }, { status: 401 });
    if (!row) {
      console.log("[TEMP DEBUG login] -> rejected: no row matched username or email");
      return genericError;
    }

    const valid = await verifyPassword(password, String(row.password_hash));
    console.log(`[TEMP DEBUG login] -> bcrypt.compare result=${valid} submittedPasswordLength=${password.length}`);
    if (!valid) return genericError;

    const userId = String(row.id);
    const token = await createSession(userId);
    await setSessionCookie(token);

    return noStoreJson({
      user: { id: userId, username: String(row.username), email: String(row.email) },
    });
  } catch (err) {
    return dbErrorJson(err, "Login");
  }
}
