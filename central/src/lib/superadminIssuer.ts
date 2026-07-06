import { isSuperAdmin } from './adminAuth'
import { signSuperadminJwt } from './superadminJwt'
import type { LsEnv } from '../types-legiscan'

/** Mint an ES256 superadmin token for `email` iff it is on the allowlist and a private key is set. */
export async function mintSuperadminToken(env: LsEnv, email: string, name: string): Promise<string | null> {
  const e = (email ?? '').toLowerCase().trim()
  if (!e || !env.SUPERADMIN_JWT_PRIVATE_KEY || !isSuperAdmin(e, env.SUPERADMIN_EMAILS)) return null
  return signSuperadminJwt(e, name ?? '', env.SUPERADMIN_JWT_PRIVATE_KEY)
}

export function isSuperadminEmail(env: LsEnv, email: string): boolean {
  return isSuperAdmin((email ?? '').toLowerCase().trim(), env.SUPERADMIN_EMAILS)
}
