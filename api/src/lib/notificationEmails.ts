import { eq } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import type { AppDb } from '../types'
import { DEFAULT_WEEK_AHEAD_DAY } from '../../../shared/notifications'

export const NOTIFICATION_EMAILS_KEY = 'notification_emails_enabled'
export const WEEK_AHEAD_DAY_KEY = 'week_ahead_day'
export const NEW_PEOPLE_DIGEST_DAY_KEY = 'digest_weekly_day_for_new_people'

async function readSaved(db: AppDb, key: string): Promise<unknown> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, key)).get()
  if (!row) return undefined
  try { return JSON.parse(row.value) } catch { return undefined }
}

const isWeekday = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6

/**
 * The admin's one switch for notification emails. On unless saved as false, so a value that can't be read counts as on.
 * Off stops the email digest, the week ahead email, and the emails for mentions and replies. Sign-in links, invites,
 * email-change confirmations, and operator and outage alerts keep sending.
 */
export async function notificationEmailsEnabled(db: AppDb): Promise<boolean> {
  return (await readSaved(db, NOTIFICATION_EMAILS_KEY)) !== false
}

/** The weekday the week ahead email goes out (0 Sunday to 6 Saturday, UTC). Friday when none was saved. */
export async function readWeekAheadDay(db: AppDb): Promise<number> {
  const saved = await readSaved(db, WEEK_AHEAD_DAY_KEY)
  return isWeekday(saved) ? saved : DEFAULT_WEEK_AHEAD_DAY
}

/**
 * The weekday a person added from now on gets their digest on, or null for every morning. Only migration 0127 saves
 * it, on an instance whose digest was weekly.
 */
export async function digestDayForNewPeople(db: AppDb): Promise<number | null> {
  const saved = await readSaved(db, NEW_PEOPLE_DIGEST_DAY_KEY)
  return isWeekday(saved) ? saved : null
}
