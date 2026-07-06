import { drizzle } from 'drizzle-orm/d1'
import { eq, and, gt } from 'drizzle-orm'
import * as schema from '../db/schema-legiscan'
import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { LsEnv } from '../types-legiscan'
import { verifySuperadminJwt } from './superadminJwt'
import { isSuperadminJtiRevoked } from './superadminRevocation'
import { secretsMatch } from './auth'

type DB = ReturnType<typeof drizzle<typeof schema>>

export type DashEnv = { Bindings: LsEnv; Variables: { adminEmail: string } }

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ---------- token utilities ----------

export async function generateToken(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toHex(bytes)
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(hashBuffer))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------- superadmin email check ----------

export function isSuperAdmin(email: string, superAdminEmails: string | undefined): boolean {
  if (!superAdminEmails) return false
  const list = superAdminEmails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  return list.includes(email.toLowerCase())
}

// ---------- admin sessions (central-issued cookies) ----------

export async function createAdminSession(
  db: DB,
  email: string,
  nameOrOpts: string | { ttlMs?: number } = '',
  opts: { ttlMs?: number } = {},
): Promise<{ rawToken: string; expiresAt: string }> {
  // Support both old signature (db, email, opts) and new (db, email, name, opts)
  let name: string
  let resolvedOpts: { ttlMs?: number }
  if (typeof nameOrOpts === 'string') {
    name = nameOrOpts
    resolvedOpts = opts
  } else {
    name = ''
    resolvedOpts = nameOrOpts
  }
  const rawToken = await generateToken()
  const tokenHash = await hashToken(rawToken)
  const ttl = resolvedOpts.ttlMs ?? SESSION_TTL_MS
  const expiresAt = new Date(Date.now() + ttl).toISOString()
  await db.insert(schema.adminSessions).values({
    id: crypto.randomUUID(),
    email: email.toLowerCase(),
    name,
    tokenHash,
    expiresAt,
  })
  return { rawToken, expiresAt }
}

export async function lookupAdminSession(
  db: DB,
  rawToken: string,
): Promise<{ email: string; name: string } | null> {
  const tokenHash = await hashToken(rawToken)
  const row = await db
    .select({ email: schema.adminSessions.email, name: schema.adminSessions.name, expiresAt: schema.adminSessions.expiresAt })
    .from(schema.adminSessions)
    .where(eq(schema.adminSessions.tokenHash, tokenHash))
    .get()
  if (!row) return null
  if (new Date(row.expiresAt).getTime() < Date.now()) return null
  return { email: row.email, name: row.name }
}

export async function deleteAdminSession(db: DB, rawToken: string): Promise<void> {
  const tokenHash = await hashToken(rawToken)
  await db.delete(schema.adminSessions).where(eq(schema.adminSessions.tokenHash, tokenHash))
}

// ---------- middleware ----------

export function requireAdmin(): MiddlewareHandler<DashEnv> {
  return async (c, next) => {
    // 1. Bearer secret (machine-to-machine). Constant-time compare (finding L2):
    // a plain `===` on the secret leaks length/prefix via timing.
    const authHeader = c.req.header('Authorization')
    if (authHeader && c.env.ADMIN_SECRET) {
      if (await secretsMatch(authHeader, `Bearer ${c.env.ADMIN_SECRET}`)) {
        c.set('adminEmail', '__bearer__')
        await next()
        return
      }
    }

    const db = drizzle(c.env.DB, { schema })

    // 2. Existing central session cookie
    const sessionToken = getCookie(c, 'admin_session')
    if (sessionToken) {
      const s = await lookupAdminSession(db, sessionToken)
      if (s) {
        c.set('adminEmail', s.email)
        await next()
        return
      }
    }

    // 3. SSO bootstrap from superadmin_jwt (ES256, central is issuer)
    const jwt = getCookie(c, 'superadmin_jwt')
    if (jwt && c.env.SUPERADMIN_JWT_PUBLIC_KEY) {
      const payload = await verifySuperadminJwt(jwt, c.env.SUPERADMIN_JWT_PUBLIC_KEY, {
        isRevoked: (jti) => isSuperadminJtiRevoked(db, jti),
      })
      if (payload) {
        if (!isSuperAdmin(payload.email, c.env.SUPERADMIN_EMAILS)) {
          return c.json({ error: { code: 'forbidden', message: 'Not authorized' } }, 403)
        }
        const { rawToken, expiresAt } = await createAdminSession(db, payload.email, payload.name)
        setCookie(c, 'admin_session', rawToken, {
          httpOnly: true, secure: true, sameSite: 'Lax', path: '/',
          expires: new Date(expiresAt),
        })
        c.set('adminEmail', payload.email)
        await next()
        return
      }
    }

    return c.json({ error: { code: 'unauthorized', message: 'Not signed in' } }, 401)
  }
}
