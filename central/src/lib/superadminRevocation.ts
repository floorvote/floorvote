// Central-side revocation list for superadmin SSO tokens (finding M3).
//
// A superadmin JWT carries a `jti`. Central can revoke a specific token by
// recording its `jti` here; central's verify paths (requireAdmin SSO bootstrap,
// dashboard /me) consult this list and reject a revoked token immediately. This
// lets an operator kill ONE token without rotating the signing key (which logs
// every superadmin out). Tenants do NOT consult this list — they have no link to
// central's DB at verify time and rely on the short token TTL instead, so a
// revoked token's residual *tenant* access is bounded by SUPERADMIN_TOKEN_TTL_SEC.
//
// Storage reuses the existing key/value `settings` table — no new migration. The
// stored value is the token's `exp` (epoch seconds) so expired entries can be
// pruned (a revocation is meaningless once the token would have expired anyway).
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema-legiscan'
import { getSetting, setSetting } from './settings'
import type { LsDb } from '../types-legiscan'

const PREFIX = 'revoked_jti:'

export async function revokeSuperadminJti(db: LsDb, jti: string, expEpochSec: number): Promise<void> {
  await setSetting(db, PREFIX + jti, String(Math.floor(expEpochSec)))
}

export async function isSuperadminJtiRevoked(db: LsDb, jti: string): Promise<boolean> {
  if (!jti) return false
  return (await getSetting(db, PREFIX + jti, '')) !== ''
}

/**
 * Drop revocation rows whose token has already expired (value < nowSec). Safe to
 * call opportunistically; revoked tokens that are still within their TTL are kept.
 */
export async function pruneRevokedSuperadminJtis(db: LsDb, nowSec: number = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.delete(schema.settings).where(
    sql`${schema.settings.key} LIKE ${PREFIX + '%'} AND CAST(${schema.settings.value} AS INTEGER) < ${Math.floor(nowSec)}`,
  )
}
