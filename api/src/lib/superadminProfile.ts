import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import type { getDb } from '../db/client'
import { verifySuperadminJwt } from '../../../shared/superadminJwt'
import { isSuperadminEmailViaCentral } from './superadminCentral'
import type { Env } from '../types'

type Db = ReturnType<typeof getDb>
type UserRow = typeof users.$inferSelect

/** Shown when a superadmin tries to edit their name or title on an instance. */
export const SUPERADMIN_PROFILE_MANAGED_ERROR =
  'Your name and title are managed in the admin dashboard. Change them there.'

/**
 * Whether the signed-in member is a superadmin: on central's superadmin list (the
 * instance's cached hashed copy), or holding a verified central-issued token for
 * their own address. Never a stored flag, so removal from the list ends it.
 * Recognition only, which outlasts the token's 8 hours: it keeps the profile
 * read-only and grants no authority (that is isSuperadminRequest).
 */
export async function isSuperadminUser<E extends { Bindings: Env }>(c: Context<E, any, any>, email: string): Promise<boolean> {
  const jwt = getCookie(c, 'superadmin_jwt')
  if (jwt && c.env.SUPERADMIN_JWT_PUBLIC_KEY) {
    const payload = await verifySuperadminJwt(jwt, c.env.SUPERADMIN_JWT_PUBLIC_KEY)
    if (payload && payload.email.toLowerCase().trim() === email.toLowerCase().trim()) return true
  }
  return isSuperadminEmailViaCentral(c.env, email)
}

/**
 * Copy the central profile in a superadmin token onto the instance's user row,
 * overwriting name and title (the instance's `subtitle`). A token without the
 * profile claims, from central before profiles, changes nothing. Returns the row
 * as it now stands.
 */
export async function applyTokenProfile<U extends Pick<UserRow, 'id' | 'name' | 'subtitle'>>(
  db: Db,
  user: U,
  token: { name: string; title: string | null },
): Promise<U> {
  if (token.title === null) return user
  const name = token.name.trim()
  const subtitle = token.title.trim() || null
  if (user.name === name && user.subtitle === subtitle) return user
  await db.update(users).set({ name, subtitle }).where(eq(users.id, user.id))
  return { ...user, name, subtitle }
}

/**
 * For a member who already has an instance session: if the request also carries a
 * verified central token for their own address, refresh their profile from it.
 * Writes only when something changed. Returns the row as it now stands.
 */
export async function refreshProfileFromRequestToken<E extends { Bindings: Env }, U extends Pick<UserRow, 'id' | 'name' | 'subtitle'> & { email: string }>(
  c: Context<E, any, any>,
  db: Db,
  user: U,
): Promise<U> {
  const jwt = getCookie(c, 'superadmin_jwt')
  if (!jwt || !c.env.SUPERADMIN_JWT_PUBLIC_KEY) return user
  const payload = await verifySuperadminJwt(jwt, c.env.SUPERADMIN_JWT_PUBLIC_KEY)
  if (!payload || payload.email.toLowerCase().trim() !== user.email.toLowerCase().trim()) return user
  return applyTokenProfile(db, user, payload)
}
