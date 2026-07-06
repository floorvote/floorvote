import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { bills } from '../../db/schema'
import { centralFetch } from '../../lib/centralFetch'
import type { AppEnv } from '../../types'

export function registerTextRoutes(router: Hono<AppEnv>) {
  // GET /bills/:id/text/:docId — proxy to central R2 via Service Binding
  router.get('/:id/text/:docId', async (c) => {
    const db = getDb(c.env.DB)
    const { id, docId } = c.req.param()

    const bill = await db.select({ externalId: bills.externalId }).from(bills).where(eq(bills.id, id)).get()
    if (!bill?.externalId) return c.json({ error: 'Text not available' }, 404)

    const path = `/bills/${bill.externalId}/text/${docId}`
    const upstream = await centralFetch(c.env, path)

    if (!upstream.ok) return c.json({ error: 'Text not available' }, 404)

    return new Response(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'text/html; charset=utf-8',
        'Content-Disposition': 'inline',
      },
    })
  })
}
