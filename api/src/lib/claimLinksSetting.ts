import { eq, inArray } from 'drizzle-orm'
import { associationConfig, users } from '../db/schema'
import { CLAIM_LINKS_CHANGED_KEY, CLAIM_LINKS_KEY, claimLinksEnabled } from './claimSources'
import { nowDb } from './dbTime'
import type { AppDb } from '../types'

// The admin side of the per-instance claim links setting (#570). The setting
// itself, and how it reads, is `claimLinksEnabled` in lib/claimSources.ts.

export type ClaimLinksSetting = {
  enabled: boolean
  /** When it was last changed, a database timestamp, or null if nobody has. */
  changedAt: string | null
  /** Who last changed it, or null if nobody has, or if they've since been removed. */
  changedBy: { id: string; name: string | null; email: string } | null
}

/** The setting with who last changed it and when, for the admin's Settings page. */
export async function readClaimLinksSetting(db: AppDb): Promise<ClaimLinksSetting> {
  const enabled = await claimLinksEnabled(db)
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, CLAIM_LINKS_CHANGED_KEY)).get()
  let by: string | null = null
  let at: string | null = null
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { by?: unknown; at?: unknown }
      if (typeof parsed.by === 'string') by = parsed.by
      if (typeof parsed.at === 'string') at = parsed.at
    } catch { /* an unreadable record reads as no record */ }
  }
  const changedBy = by === null
    ? null
    : (await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, [by])).get()) ?? null
  return { enabled, changedAt: at, changedBy }
}

/**
 * Turn claim links on or off, recording the admin and the time with the
 * setting. The only writer of either row, so a change is never unattributed.
 */
export async function writeClaimLinksSetting(db: AppDb, enabled: boolean, adminId: string): Promise<ClaimLinksSetting> {
  const upsert = (key: string, value: string) => db.insert(associationConfig).values({ key, value }).onConflictDoUpdate({
    target: associationConfig.key,
    set: { value },
  })
  // One batch, so the setting and the record of who changed it land together.
  await db.batch([
    upsert(CLAIM_LINKS_KEY, JSON.stringify(enabled)),
    upsert(CLAIM_LINKS_CHANGED_KEY, JSON.stringify({ by: adminId, at: nowDb() })),
  ])
  return readClaimLinksSetting(db)
}
