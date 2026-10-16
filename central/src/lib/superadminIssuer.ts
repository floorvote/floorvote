import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { isSuperAdmin, type DashEnv } from './adminAuth'
import { signSuperadminJwt, SUPERADMIN_TOKEN_TTL_SEC } from './superadminJwt'
import { getSuperadminCookieDomain } from './superadminCookie'
import { getSuperadminProfile, type SuperadminProfile } from './superadminProfile'
import type { Env } from '../types'

/**
 * Mint an ES256 superadmin token for `email` iff it is on the allowlist and a private key is set.
 * `profile` is the superadmin's saved name and title. Without one the token carries no profile
 * claims, and instances leave their existing copy alone.
 */
export async function mintSuperadminToken(env: Env, email: string, profile: SuperadminProfile | null): Promise<string | null> {
  const e = (email ?? '').toLowerCase().trim()
  if (!e || !env.SUPERADMIN_JWT_PRIVATE_KEY || !isSuperAdmin(e, env.SUPERADMIN_EMAILS)) return null
  return signSuperadminJwt(e, profile?.name ?? '', env.SUPERADMIN_JWT_PRIVATE_KEY, undefined, profile?.title)
}

export function isSuperadminEmail(env: Env, email: string): boolean {
  return isSuperAdmin((email ?? '').toLowerCase().trim(), env.SUPERADMIN_EMAILS)
}

/**
 * Mint a superadmin token carrying the saved profile and set it as the cross-tenant
 * `superadmin_jwt` cookie. Sets nothing when `email` isn't a superadmin or no private key is set.
 * Expires with the token itself (short TTL), not with the 30-day local admin_session.
 */
export async function setSuperadminCookie(
  c: Context<DashEnv>,
  db: ReturnType<typeof drizzle<typeof schema>>,
  email: string,
): Promise<void> {
  const token = await mintSuperadminToken(c.env, email, await getSuperadminProfile(db, email))
  if (!token) return
  const cookieDomain = getSuperadminCookieDomain(c.env.ADMIN_APP_URL)
  setCookie(c, 'superadmin_jwt', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(Date.now() + SUPERADMIN_TOKEN_TTL_SEC * 1000),
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  })
}
