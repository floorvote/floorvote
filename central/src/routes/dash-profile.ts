import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { requireAdmin, isSuperAdmin, type DashEnv } from '../lib/adminAuth'
import {
  getSuperadminProfile,
  saveSuperadminProfile,
  PROFILE_NAME_MAX,
  PROFILE_TITLE_MAX,
} from '../lib/superadminProfile'

// The signed-in superadmin's own profile: the one place their name and title are
// edited. Instances copy it at sign-in and show it read-only.
export const dashProfileRoutes = new Hono<DashEnv>()

dashProfileRoutes.use('*', requireAdmin())

// A profile belongs to a person. The machine bearer secret has no identity, and a
// session can outlive the address's place on the superadmin list.
dashProfileRoutes.use('*', async (c, next) => {
  const email = c.get('adminEmail')
  if (email === '__bearer__' || !isSuperAdmin(email, c.env.SUPERADMIN_EMAILS)) {
    return c.json({ error: { code: 'forbidden', message: 'Not authorized' } }, 403)
  }
  await next()
})

const meta = () => ({ generatedAt: new Date().toISOString() })

// GET /admin/dash/profile
dashProfileRoutes.get('/', async (c) => {
  const email = c.get('adminEmail')
  const db = drizzle(c.env.DB, { schema })
  const profile = await getSuperadminProfile(db, email)
  return c.json({ data: { email, name: profile?.name ?? '', title: profile?.title ?? '' }, meta: meta() })
})

// PUT /admin/dash/profile — replace name and title
dashProfileRoutes.put('/', async (c) => {
  const email = c.get('adminEmail')
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const { name, title } = body ?? {}
  if (typeof name !== 'string' || typeof title !== 'string') {
    return c.json({ error: { code: 'bad_request', message: 'Name and title must be strings' } }, 400)
  }
  const profile = { name: name.trim(), title: title.trim() }
  if (profile.name.length > PROFILE_NAME_MAX) {
    return c.json({ error: { code: 'bad_request', message: `Name too long (max ${PROFILE_NAME_MAX} characters)` } }, 400)
  }
  if (profile.title.length > PROFILE_TITLE_MAX) {
    return c.json({ error: { code: 'bad_request', message: `Title too long (max ${PROFILE_TITLE_MAX} characters)` } }, 400)
  }

  const db = drizzle(c.env.DB, { schema })
  await saveSuperadminProfile(db, email, profile)
  // Deliberately no new superadmin_jwt here: only a fresh emailed-link sign-in
  // mints one, so a 30-day dashboard session can't renew cross-tenant access.
  // An edit reaches instances at the next dashboard sign-in.
  return c.json({ data: { email, ...profile }, meta: meta() })
})
