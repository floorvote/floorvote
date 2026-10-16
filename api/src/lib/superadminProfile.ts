import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import type { getDb } from '../db/client'
import { verifySuperadminJwt } from '../../../shared/superadminJwt'
import { isSuperadminEmailViaCentral } from './superadminCentral'
import { centralFetch } from './centralFetch'
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
 * overwriting name and title (central's `title` maps to `users.title` as it is,
 * and is also written to `users.subtitle` for the previous build).
 * A token without the profile claims, from central before profiles, changes
 * nothing. Returns the row as it now stands.
 */
export async function applyTokenProfile<U extends Pick<UserRow, 'id' | 'name' | 'title'>>(
  db: Db,
  user: U,
  token: { name: string; title: string | null },
): Promise<U> {
  if (token.title === null) return user
  const name = token.name.trim()
  const title = token.title.trim() || null
  if (user.name === name && user.title === title) return user
  // keep subtitle in sync until the drop migration (follow-up issue)
  await db.update(users).set({ name, title, subtitle: title }).where(eq(users.id, user.id))
  return { ...user, name, title, subtitle: title }
}

/**
 * For a member who already has an instance session: if the request also carries a
 * verified central token for their own address, refresh their profile from it.
 * Writes only when something changed. Returns the row as it now stands.
 */
export async function refreshProfileFromRequestToken<E extends { Bindings: Env }, U extends Pick<UserRow, 'id' | 'name' | 'title'> & { email: string }>(
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

/** How long the background refresh waits on central for a superadmin's profile. */
const CENTRAL_PROFILE_TIMEOUT_MS = 2000

/**
 * After an emailed-link sign-in: if the member is a known superadmin, ask central
 * for their profile and refresh the instance's copy. Members not on the cached
 * superadmin list are never looked up. Central answers `{ profile: null }` when it
 * has nothing to give, and that, anything unexpected, an error, or no answer
 * within the timeout leaves the existing name and title. Never throws. The
 * caller runs it in waitUntil, so no sign-in waits on central.
 */
export async function refreshProfileFromCentral(
  env: Env,
  db: Db,
  user: Pick<UserRow, 'id' | 'email' | 'name' | 'title'>,
): Promise<void> {
  const refresh = async () => {
    if (!(await isSuperadminEmailViaCentral(env, user.email))) return
    const res = await centralFetch(env, '/admin/superadmin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email }),
    })
    if (!res.ok) return
    const { profile } = await res.json<{ profile?: { name?: unknown; title?: unknown } | null }>()
    if (typeof profile?.name !== 'string' || typeof profile?.title !== 'string') return
    await applyTokenProfile(db, user, { name: profile.name, title: profile.title })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, CENTRAL_PROFILE_TIMEOUT_MS) })
  try {
    await Promise.race([refresh(), timeout])
  } catch (err) {
    console.error('[auth/verify] superadmin profile refresh failed:', err instanceof Error ? err.message : err)
  } finally {
    clearTimeout(timer)
  }
}
