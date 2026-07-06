import { hashToken } from './crypto'

/**
 * Shared demo session — prevents write amplification.
 *
 * When DEMO_MODE=true the auto-login middleware (api/src/index.ts) logs every
 * visitor in as `demo-user`. It previously minted a BRAND-NEW `sessions` row on
 * every cookieless (or stale-cookie) request, each with a 30-day expiry. Because
 * demo HTML is served `no-store` (so the edge can't absorb it), every crawler /
 * bot hit ran the Worker and inserted another row — unbounded growth between the
 * nightly resets, matching the June 2026 crawler spike.
 *
 * The fix: reuse ONE shared session row for `demo-user`. `ensureDemoSession` is
 * idempotent (INSERT OR IGNORE on a fixed id), so the row count stays at one no
 * matter how much bot traffic arrives, and it self-heals if the nightly reset
 * wipes sessions.
 *
 * The raw token is a known constant. This is safe: DEMO_MODE already auto-logs
 * EVERY visitor in as `demo-user`, so the token grants nothing beyond what the
 * demo hands out for free, and a matching session row only ever exists on a
 * DEMO_MODE instance (created here) — never on a real tenant.
 */

export const DEMO_SESSION_ID = 'demo-shared-session'
export const DEMO_SESSION_TOKEN = 'demo-shared-session-token'

// Far-future expiry in SQLite space-format UTC (NOT ISO — ISO and space format
// mixed in one column break ORDER BY / datetime() comparison; see
// docs/date-format-convention.md). datetime() parses this as a valid future time.
const DEMO_SESSION_EXPIRES_DB = '9999-12-31 23:59:59'

/**
 * Ensure the single shared `demo-user` session row exists (idempotent) and
 * return its raw token to hand out as the `session` cookie. INSERT OR IGNORE
 * keeps the row count at one and recreates it after a reset wipes sessions.
 */
export async function ensureDemoSession(db: D1Database): Promise<string> {
  const tokenHash = await hashToken(DEMO_SESSION_TOKEN)
  await db
    .prepare('INSERT OR IGNORE INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .bind(DEMO_SESSION_ID, 'demo-user', tokenHash, DEMO_SESSION_EXPIRES_DB)
    .run()
  return DEMO_SESSION_TOKEN
}
