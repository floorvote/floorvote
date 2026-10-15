import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { nowDb } from './dbTime'

type DB = ReturnType<typeof drizzle<typeof schema>>

/** A superadmin's name and title, kept here once and applied by every instance at sign-in. */
export type SuperadminProfile = { name: string; title: string }

// The same limits an instance puts on a member's name and subtitle.
export const PROFILE_NAME_MAX = 100
export const PROFILE_TITLE_MAX = 200

/** The saved profile for `email`, or null when that superadmin has never set one. */
export async function getSuperadminProfile(db: DB, email: string): Promise<SuperadminProfile | null> {
  const row = await db
    .select({ name: schema.superadminProfiles.name, title: schema.superadminProfiles.title })
    .from(schema.superadminProfiles)
    .where(eq(schema.superadminProfiles.email, email.toLowerCase().trim()))
    .get()
  return row ?? null
}

export async function saveSuperadminProfile(db: DB, email: string, profile: SuperadminProfile): Promise<void> {
  const e = email.toLowerCase().trim()
  await db
    .insert(schema.superadminProfiles)
    .values({ email: e, ...profile })
    .onConflictDoUpdate({
      target: schema.superadminProfiles.email,
      set: { ...profile, updatedAt: nowDb() },
    })
}
