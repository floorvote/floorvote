import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { sessions, users } from '../db/schema'
import { hashToken } from '../lib/crypto'
import { isSuperadminRequest } from '../lib/superadminRequest'
import { dbTsToEpoch } from '../../../shared/time'
import type { Env } from '../types'

// Attach { user } to the Hono context for protected routes.
// Returns 401 if the session cookie is absent, invalid, or expired.
// Returns 403 if the user account has been deactivated.

export type AuthVariables = {
  user: {
    id: string
    email: string
    name: string
    role: 'admin' | 'member' | 'owner'
    canVote: boolean
  }
}

export const requireAuth = createMiddleware<{
  Bindings: Env
  Variables: AuthVariables
}>(async (c, next) => {
  const rawToken = getCookie(c, 'session')
  if (!rawToken) return c.json({ error: 'Not authenticated' }, 401)

  const db = getDb(c.env.DB)
  const tokenHash = await hashToken(rawToken)

  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .get()

  if (!session) return c.json({ error: 'Not authenticated' }, 401)
  // Parse via dbTsToEpoch: `new Date()` reads the SQLite space
  // format ("YYYY-MM-DD HH:MM:SS") as LOCAL time, so on any non-UTC runtime an
  // unexpired session could read as expired (or vice versa). dbTsToEpoch treats
  // both the space and ISO shapes as UTC.
  const expiryMs = dbTsToEpoch(session.expiresAt)
  if (isNaN(expiryMs) || expiryMs < Date.now()) {
    // Clean up the expired session row
    await db.delete(sessions).where(eq(sessions.id, session.id))
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const user = await db.select().from(users).where(eq(users.id, session.userId)).get()
  if (!user) return c.json({ error: 'Not authenticated' }, 401)

  if (user.deactivatedAt && !(await isSuperadminRequest(c))) {
    return c.json({ error: 'Account deactivated' }, 403)
  }

  if (user.role !== 'admin' && user.role !== 'member' && user.role !== 'owner') {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  c.set('user', {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    canVote: !!user.canVote,
  })

  await next()
})

// Use this on routes that require an admin role.
// Must be used AFTER requireAuth (depends on c.get('user') being set).
export const requireAdmin = createMiddleware<{
  Bindings: Env
  Variables: AuthVariables
}>(async (c, next) => {
  const user = c.get('user')
  if (!user) {
    // requireAdmin must be used after requireAuth — user should always be set here
    throw new Error('requireAdmin called without requireAuth')
  }
  if (user.role !== 'admin' && user.role !== 'owner') {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
})

export const requireOwner = createMiddleware<{
  Bindings: Env
  Variables: AuthVariables
}>(async (c, next) => {
  const user = c.get('user')
  if (!user) {
    throw new Error('requireOwner called without requireAuth')
  }
  if (user.role !== 'owner') {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
})

export const demoGuard = createMiddleware<{
  Bindings: Env
  Variables: AuthVariables
}>(async (c, next) => {
  if (c.env.DEMO_MODE !== 'true') return await next()
  const user = c.get('user')
  if (await isSuperadminRequest(c)) return await next()
  return c.json({ error: 'Configuration is locked in demo mode' }, 403)
})

// Demo instances are read-only. Mounted globally on /api/* in index.ts rather
// than applied per-route: there are ~60 write routes, and an opt-in guard
// silently fails to cover the next one somebody adds. Deny-by-default mirrors
// the posture central takes in central/src/lib/tenantSurface.ts.
//
// Superadmin gets NO exemption — nobody edits a demo through the GUI, and
// POST /api/internal/demo-reset is the repair mechanism.
const DEMO_WRITE_ALLOWLIST = new Set([
  '/api/auth/demo-login',   // the auto-login path itself
  '/api/admin/config',      // self-limits to modules-only (see adminApi.ts)
])

export const demoReadOnly = createMiddleware<{
  Bindings: Env
  Variables: AuthVariables
}>(async (c, next) => {
  if (c.env.DEMO_MODE !== 'true') return await next()

  // HEAD and OPTIONS must pass — refusing OPTIONS breaks CORS preflight.
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return await next()

  const path = new URL(c.req.url).pathname
  if (DEMO_WRITE_ALLOWLIST.has(path)) return await next()

  // Operator surface, already gated by internalAuthFail's shared secret. Left
  // open so the nightly reset cron and ops scripts keep working on a demo
  // tenant; a 403 here would shadow that route's own 401.
  if (path.startsWith('/api/internal/')) return await next()

  return c.json({ error: 'This demo is read-only' }, 403)
})
