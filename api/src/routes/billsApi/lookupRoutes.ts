import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { bills } from '../../db/schema'
import type { AppEnv } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { sessionToSlug } from '../../lib/sessionSlug'
import { buildBillDetail } from './detail'

export function registerLookupRoutes(router: Hono<AppEnv>) {
  // GET /bills/:id — composite detail by internal UUID
  // GET /bills/resolve/:state/:sessionSlug/:billNumber — canonical state-aware bill lookup
  router.get('/resolve/:state/:sessionSlug/:billNumber', async (c) => {
    const db = getDb(c.env.DB)
    const { state, sessionSlug: slug, billNumber } = c.req.param()
    const stateUpper = state.toUpperCase()
    const candidates = await db.select({ id: bills.id, session: bills.session, state: bills.state })
      .from(bills)
      .where(and(eq(bills.billNumber, billNumber), eq(bills.state, stateUpper)))
      .all()
    const match = candidates.find(b => sessionToSlug(b.session) === slug)
    if (!match) return c.json({ error: 'Not found' }, 404)
    const user = c.get('user')
    return c.json(await buildBillDetail(db, match.id, user, c.env))
  })

  // GET /bills/resolve/:sessionSlug/:billNumber — legacy lookup without state.
  // Returns canonical state on unique match so the client can redirect; 409 with
  // candidates if multiple states match (rare cross-state collision).
  router.get('/resolve/:sessionSlug/:billNumber', async (c) => {
    const db = getDb(c.env.DB)
    const { sessionSlug: slug, billNumber } = c.req.param()
    const candidates = await db.select({ id: bills.id, session: bills.session, state: bills.state })
      .from(bills).where(eq(bills.billNumber, billNumber)).all()
    const matches = candidates.filter(b => sessionToSlug(b.session) === slug)
    if (matches.length === 0) return c.json({ error: 'Not found' }, 404)
    if (matches.length > 1) {
      return c.json({
        error: 'Ambiguous bill — use state-prefixed URL',
        candidates: matches.map(m => ({ state: m.state, sessionSlug: sessionToSlug(m.session), billNumber })),
      }, 409)
    }
    const user = c.get('user')
    const detail = await buildBillDetail(db, matches[0].id, user, c.env)
    return c.json(detail)
  })

  // GET /bills/drafts — list all draft bills (admin only). MUST be before /:id.
  router.get('/drafts', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const rows = await db
      .select({ id: bills.id, billNumber: bills.billNumber, title: bills.title, state: bills.state })
      .from(bills)
      .where(eq(bills.isDraft, true))
      .orderBy(bills.createdAt)
      .all()
    return c.json({ drafts: rows })
  })

  router.get('/:id', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const bill = await db.select().from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    const user = c.get('user')
    return c.json(await buildBillDetail(db, bill.id, user, c.env))
  })

  // GET /bills/:id/changes — proxy to central change history
  router.get('/:id/changes', async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()

    const bill = await db
      .select({ externalId: bills.externalId })
      .from(bills)
      .where(eq(bills.id, id))
      .get()

    if (!bill?.externalId) return c.json({ changes: [] })

    try {
      const res = await centralFetch(c.env, `/bills/${bill.externalId}/changes`)
      if (!res.ok) return c.json({ changes: [] })
      return c.json(await res.json())
    } catch {
      return c.json({ changes: [] })
    }
  })
}
