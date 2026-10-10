import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { bills } from '../../db/schema'
import type { AppEnv } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { billSlug, legacySessionSlug, sessionToSlug } from '../../lib/sessionSlug'
import { buildBillDetail } from './detail'
import { nextDraftNumber } from '../../lib/draftNumber'
import { defaultDraftYear } from './draftRoutes'

// billSlug lives in lib/sessionSlug so the draft-number collision check can
// compare the same notion of "answers to this URL" that these routes do.

/**
 * The bill a /STATE/SLUG/NUMBER URL names. An exact slug match wins: the slug
 * central assigned the bill's session, which is unique within the state.
 * Failing that, a slug the URL may have been made with before: the one the
 * session name asks for (which central gave another session of the state, so
 * gave this one "-2"), or the year span a Council Period used before it had its
 * own. More than one match is ambiguous, never a guess.
 */
function resolveSlug<T extends { session: string; sessionSlug: string | null; isDraft: boolean; yearStart: number | null }>(candidates: T[], slug: string):
  { status: 200; match: T } | { status: 404 } | { status: 409; candidates: T[] } {
  const exact = candidates.filter(b => billSlug(b) === slug)
  const matches = exact.length > 0 ? exact : candidates.filter(b =>
    !b.isDraft && (sessionToSlug(b.session) === slug || legacySessionSlug(b.session) === slug))
  if (matches.length === 0) return { status: 404 }
  if (matches.length > 1) return { status: 409, candidates: matches }
  return { status: 200, match: matches[0] }
}

export function registerLookupRoutes(router: Hono<AppEnv>) {
  // GET /bills/:id — composite detail by internal UUID
  // GET /bills/resolve/:state/:sessionSlug/:billNumber — canonical state-aware bill lookup
  router.get('/resolve/:state/:sessionSlug/:billNumber', async (c) => {
    const db = getDb(c.env.DB)
    const { state, sessionSlug: slug, billNumber } = c.req.param()
    const stateUpper = state.toUpperCase()
    const candidates = await db.select({ id: bills.id, session: bills.session, sessionSlug: bills.sessionSlug, state: bills.state, isDraft: bills.isDraft, yearStart: bills.yearStart })
      .from(bills)
      .where(and(eq(bills.billNumber, billNumber), eq(bills.state, stateUpper)))
      .all()
    const found = resolveSlug(candidates, slug)
    if (found.status === 404) return c.json({ error: 'Not found' }, 404)
    if (found.status === 409) {
      return c.json({ error: 'Ambiguous bill: more than one session matches', candidates: found.candidates.map(m => ({ state: m.state, sessionSlug: billSlug(m), billNumber })) }, 409)
    }
    const user = c.get('user')
    return c.json(await buildBillDetail(db, found.match.id, user, c.env))
  })

  // GET /bills/resolve/:sessionSlug/:billNumber — legacy lookup without state.
  // Returns canonical state on unique match so the client can redirect; 409 with
  // candidates if multiple states match (rare cross-state collision).
  router.get('/resolve/:sessionSlug/:billNumber', async (c) => {
    const db = getDb(c.env.DB)
    const { sessionSlug: slug, billNumber } = c.req.param()
    const candidates = await db.select({ id: bills.id, session: bills.session, sessionSlug: bills.sessionSlug, state: bills.state, isDraft: bills.isDraft, yearStart: bills.yearStart })
      .from(bills).where(eq(bills.billNumber, billNumber)).all()
    // A stateless draft (state = '') has no canonical URL to redirect to here —
    // it must keep resolving only via /bills/<uuid>, never via this state-less
    // legacy form (which would otherwise hand the client `state: ''`).
    const found = resolveSlug(candidates.filter(b => b.state !== ''), slug)
    if (found.status === 404) return c.json({ error: 'Not found' }, 404)
    const matches = found.status === 409 ? found.candidates : [found.match]
    if (matches.length > 1) {
      return c.json({
        error: 'Ambiguous bill — use state-prefixed URL',
        candidates: matches.map(m => ({ state: m.state, sessionSlug: billSlug(m), billNumber })),
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

  // GET /bills/draft-defaults — the number and year a new draft should
  // pre-fill with. One call so the form never has to know how either is
  // derived. Admin only, matching the create route. MUST be before /:id.
  //
  // `tenantState` is the authoritative single-state signal: c.env.STATE when
  // the tenant is configured for one state, null when it tracks many. The form
  // shows its State field on null. This replaces a client-side guess from
  // /bills/facets, which only reports states that already have bills and so
  // cannot tell a single-state tenant from a multi-state one whose bills
  // happen to sit in one state.
  //
  // ?state= is the state the admin has picked in that field. Both the number
  // and the year are per-state, so without it a multi-state tenant prefills
  // from the '' bucket and can hand back a number that 409s on create. When
  // neither ?state= nor c.env.STATE yields a state we still answer (with the
  // '' bucket) rather than erroring: the form can submit, and POST /bills/draft
  // is the real guard.
  router.get('/draft-defaults', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const tenantState = (c.env.STATE || '').trim().toUpperCase() || null
    const state = (c.req.query('state') || '').trim().toUpperCase() || tenantState || ''
    const billNumber = await nextDraftNumber(db, state)
    return c.json({ billNumber, year: await defaultDraftYear(c, db, state), tenantState })
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
