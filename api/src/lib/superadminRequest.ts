import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifySuperadminJwt } from '../../../shared/superadminJwt'
import type { Env } from '../types'

/**
 * Superadmin operator authority for the current request, derived SOLELY from a
 * valid, unexpired `superadmin_jwt` cookie (ES256, central-issued). Never from
 * the local users row or central's superadmin email list. The instance may use
 * that list to recognize a superadmin's account (see superadminCentral.ts), but
 * recognition grants no authority: anything a superadmin may do that others
 * may not is gated here.
 */
export async function isSuperadminRequest<E extends { Bindings: Env }>(c: Context<E, any, any>): Promise<boolean> {
  const jwt = getCookie(c, 'superadmin_jwt')
  if (!jwt || !c.env.SUPERADMIN_JWT_PUBLIC_KEY) return false
  const payload = await verifySuperadminJwt(jwt, c.env.SUPERADMIN_JWT_PUBLIC_KEY)
  return payload !== null
}
