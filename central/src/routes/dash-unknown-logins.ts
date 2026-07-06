import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema-legiscan'
import { requireAdmin, type DashEnv } from '../lib/adminAuth'
import { resolveTenantRpc } from '../lib/tenantRpc'

export const dashUnknownLoginsRoutes = new Hono<DashEnv>()

dashUnknownLoginsRoutes.use('*', requireAdmin())

type AttemptRow = { id: string; email: string; ipCountry: string | null; userAgent: string | null; createdAt: string }
type TaggedAttempt = AttemptRow & { tenantId: string; tenantName: string }

dashUnknownLoginsRoutes.get('/', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const tenants = await db
    .select({ id: schema.tenants.tenantId, name: schema.tenants.name })
    .from(schema.tenants)
    .all()

  const results = await Promise.allSettled(
    tenants.map(async (t): Promise<TaggedAttempt[]> => {
      const rpc = resolveTenantRpc(c.env, t.id)
      if (!rpc) return []
      const attempts = await rpc.unknownLoginAttempts()
      return attempts.map(a => ({ ...a, tenantId: t.id, tenantName: t.name }))
    }),
  )

  const attempts: TaggedAttempt[] = results
    .filter((r): r is PromiseFulfilledResult<TaggedAttempt[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
    .slice(0, 200)

  return c.json({ data: { attempts }, meta: { generatedAt: new Date().toISOString() } })
})
