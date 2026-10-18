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
import { legacyHandle } from '../../../../shared/billHandle'

// billSlug lives in lib/sessionSlug so the draft-number collision check can
// compare the same notion of "answers to this URL" that these routes do.

type Candidate = { id: string; state: string; session: string; sessionSlug: string | null; isDraft: boolean; yearStart: number | null }

/**
 * The bill a /STATE/SLUG/NUMBER URL names. An exact slug match wins: the slug
 * central assigned the bill's session, which is unique within the state, so
 * a bill's canonical URL always reaches it. Failing that, a slug the URL may
 * have been made with before: the one the session name asks for (which central
 * gave another session of the state, so gave this one "-2"), or the one an
 * older release gave a session the current rule renames (legacySessionSlug:
 * "2026" for "2026 Special Session 1"). More than one such match is ambiguous,
 * never a guess.
 *
 * An exact match can also be a slug older links used for other bills:
 * /MD/2026/HB5 is the 2026 Regular Session's HB5 today, and was the 2026
 * Special Session 1's HB5 too. Those bills come back as `others`, so the page
 * can point to them rather than land there silently.
 */
function resolveSlug<T extends Candidate>(candidates: T[], slug: string):
  { status: 200; match: T; others: T[] } | { status: 404 } | { status: 409; candidates: T[] } {
  const olderLinkTo = (b: T) => !b.isDraft && (sessionToSlug(b.session) === slug || legacySessionSlug(b.session) === slug)
  const exact = candidates.filter(b => billSlug(b) === slug)
  if (exact.length === 1) return { status: 200, match: exact[0], others: candidates.filter(b => b !== exact[0] && olderLinkTo(b)) }
  const matches = exact.length > 0 ? exact : candidates.filter(olderLinkTo)
  if (matches.length === 0) return { status: 404 }
  if (matches.length > 1) return { status: 409, candidates: matches }
  return { status: 200, match: matches[0], others: [] }
}

/** How a bill is listed when a URL could mean more than one: enough for the
 *  page to name its session and link to its canonical URL. */
const billChoice = (b: Candidate, billNumber: string) => ({ state: b.state, sessionSlug: billSlug(b), session: b.session, billNumber })

/** The bill detail, plus `otherSessionMatches` when an older link to this URL
 *  may have meant another bill (resolveSlug). Absent otherwise. */
function withOthers<D extends object>(detail: D, others: Candidate[], billNumber: string) {
  return others.length === 0 ? detail : { ...detail, otherSessionMatches: others.map(b => billChoice(b, billNumber)) }
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
      return c.json({ error: 'Ambiguous bill: more than one session matches', candidates: found.candidates.map(m => billChoice(m, billNumber)) }, 409)
    }
    const user = c.get('user')
    return c.json(withOthers(await buildBillDetail(db, found.match.id, user, c.env), found.others, billNumber))
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
    // A bill in another state that an older link may have meant is ambiguous
    // here, not a note: the page redirects to the match's state-prefixed URL,
    // where only that state's bills are candidates, so the note would vanish.
    if (found.status === 409 || found.others.some(b => b.state !== found.match.state)) {
      const ambiguous = found.status === 409 ? found.candidates : [found.match, ...found.others]
      return c.json({
        error: 'Ambiguous bill — use state-prefixed URL',
        candidates: ambiguous.map(m => billChoice(m, billNumber)),
      }, 409)
    }
    const user = c.get('user')
    return c.json(withOthers(await buildBillDetail(db, found.match.id, user, c.env), found.others, billNumber))
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
      const res = await centralFetch(c.env, `/bills/${legacyHandle(bill.externalId)}/changes`)
      if (!res.ok) return c.json({ changes: [] })
      return c.json(await res.json())
    } catch {
      return c.json({ changes: [] })
    }
  })
}
