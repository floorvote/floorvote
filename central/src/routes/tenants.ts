import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { secretsMatch } from '../lib/auth'
import { nowDb } from '../lib/dbTime'
import type { Env } from '../types'

export const tenantsRoutes = new Hono<{ Bindings: Env }>()

tenantsRoutes.use('*', async (c, next) => {
  if (!(await secretsMatch(c.req.header('x-admin-secret'), c.env.ADMIN_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

tenantsRoutes.post('/register', async (c) => {
  const body = await c.req.json<{
    tenantId: string
    name: string
    stateCoverage: string[]
    keywords: string[]
    ingestionMode?: 'all' | 'keyword-filtered'
  }>()

  if (!body.tenantId || !body.name || !body.stateCoverage || !body.keywords) {
    return c.json({ error: 'tenantId, name, stateCoverage, and keywords are required' }, 400)
  }

  const db = drizzle(c.env.DB, { schema })
  const now = nowDb()

  await db.insert(schema.tenants)
    .values({
      tenantId: body.tenantId,
      name: body.name,
      operator: c.env.OPERATOR_NAME,
      stateCoverage: JSON.stringify(body.stateCoverage),
      ingestionMode: body.ingestionMode ?? 'all',
      active: true,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: schema.tenants.tenantId,
      set: {
        name: body.name,
        stateCoverage: JSON.stringify(body.stateCoverage),
        ingestionMode: body.ingestionMode ?? 'all',
        active: true,
        lastSeenAt: now,
      },
    })

  await db.delete(schema.keywordRegistry)
    .where(eq(schema.keywordRegistry.tenantId, body.tenantId))
  if (body.keywords.length > 0) {
    await db.insert(schema.keywordRegistry).values(
      body.keywords.map((keyword) => ({ tenantId: body.tenantId, keyword })),
    )
  }

  return c.json({ tenantId: body.tenantId, registered: true })
})
