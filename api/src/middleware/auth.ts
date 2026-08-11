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

// Demo instances allow the additive member actions and refuse everything else.
// Mounted globally on /api/* in index.ts rather than applied per-route: there
// are ~68 write routes, and an opt-in guard silently fails to cover the next one
// somebody adds. Deny-by-default mirrors the posture central takes in
// central/src/lib/tenantSurface.ts.
//
// Why not invert this to allow-by-default with a denylist, now that most member
// actions are open: a newly added *additive* route being dead in the demo until
// someone notices is annoying; a newly added *destructive* route being live
// until someone notices is how the demo gets defaced. Deny-by-default fails
// safe. demoReadOnly.test.ts closes the annoying half by refusing to pass while
// any registered non-GET route is uncategorised.
//
// Superadmin gets NO exemption — nobody edits a demo through the GUI, and
// POST /api/internal/demo-reset is the repair mechanism.
//
// Entries are `METHOD <hono path>`, exactly as app.routes reports them, so the
// test can compare them against the live route table by string equality.
export const DEMO_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
  'POST /api/auth/demo-login',              // the auto-login path itself
  'PUT /api/admin/config',                  // self-limits to modules-only (see adminApi.ts)

  // Additive member actions — a visitor doing these is the demo working.
  'POST /api/bills/:id/comments',
  'PATCH /api/comments/:id',                // own comment only (commentsApi.ts checks userId)
  'POST /api/bills/:id/votes',
  'DELETE /api/bills/:id/votes',            // clearing your own vote
  'POST /api/comments/:id/reactions',
  'DELETE /api/comments/:id/reactions/:emoji',
  'PUT /api/bills/:id/note',                // personal note
  'PATCH /api/bills/:id/priority',
  'PATCH /api/bills/:id/triage-dismiss',    // single-bill; bulk-dismiss stays denied
  'POST /api/bills/:id/position',
  'DELETE /api/bills/:id/position',
  'PUT /api/bills/:id/custom-fields',

  // Per-user read state. Invisible to other visitors, and locking it leaves the
  // notification badge permanently stuck.
  'POST /api/feed/seen',
  'POST /api/notifications/mark-read',
  'POST /api/notifications/mark-read/:commentId',
  'POST /api/notifications/mark-read-by-bill/:billId',
])

// The guard runs before route matching (mounted on /api/*), so it cannot ask
// Hono which route matched — it compiles each allowlist path into a regex and
// matches the request pathname itself. `:param` matches one path segment.
const ALLOW_MATCHERS = [...DEMO_WRITE_ALLOWLIST].map(entry => {
  const [method, path] = entry.split(' ')
  const source = path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+')
  return { method, re: new RegExp(`^${source}$`) }
})

export const demoReadOnly = createMiddleware<{
  Bindings: Env
  Variables: AuthVariables
}>(async (c, next) => {
  if (c.env.DEMO_MODE !== 'true') return await next()

  // HEAD and OPTIONS must pass — refusing OPTIONS breaks CORS preflight.
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return await next()

  const path = new URL(c.req.url).pathname

  // Operator surface, already gated by internalAuthFail's shared secret. Left
  // open so the reset cron and ops scripts keep working on a demo tenant; a 403
  // here would shadow that route's own 401.
  if (path.startsWith('/api/internal/')) return await next()

  if (ALLOW_MATCHERS.some(m => m.method === method && m.re.test(path))) return await next()

  return c.json({ error: 'This demo is read-only' }, 403)
})
