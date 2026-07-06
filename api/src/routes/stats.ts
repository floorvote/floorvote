import { Hono } from 'hono'
import type { Context } from 'hono'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { users, bills, memberVotes, associationConfig, magicLinks, calendarEvents } from '../db/schema'
import { count, eq, isNotNull, isNull, and, inArray, sql, exists, gte, lte, or } from 'drizzle-orm'
import type { AppEnv } from '../types'
import { sessionToSlug } from '../lib/sessionSlug'
import { centralFetch } from '../lib/centralFetch'
import { loadUpcomingDemoHearings } from '../lib/demoCalendar'
import { newMatchWhere } from './billsApi/query'
import { getNewMatchMinRelevance } from '../lib/newMatch'

const statsRouter = new Hono<AppEnv>()

statsRouter.use('*', requireAuth)

const CALENDAR_UPCOMING_DAYS = 30

statsRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const today = new Date().toISOString().slice(0, 10)
  const in30 = new Date(Date.now() + CALENDAR_UPCOMING_DAYS * 86400_000).toISOString().slice(0, 10)
  const [billCount, memberCount, calUpcoming] = await Promise.all([
    db.select({ count: count() }).from(bills).get(),
    // Members = users who have accepted their invite (used a magic link) and are not deactivated.
    // Deliberately NOT keyed on a live `sessions` row: those are ephemeral (deleted on logout,
    // role/deactivation change, and expiry), which would undercount real members. Matches the
    // `hasLoggedIn` definition the Members admin page uses for its "Active" status.
    db.select({ count: count() }).from(users).where(and(
      isNull(users.deactivatedAt),
      exists(db.select({ id: magicLinks.id }).from(magicLinks).where(and(eq(magicLinks.userId, users.id), isNotNull(magicLinks.usedAt)))),
    )).get(),
    db.select({ count: count() })
      .from(calendarEvents)
      .leftJoin(bills, eq(calendarEvents.billId, bills.id))
      .where(and(
        eq(calendarEvents.status, 'confirmed'),
        isNotNull(calendarEvents.date),
        gte(calendarEvents.date, today),
        lte(calendarEvents.date, in30),
        or(
          and(eq(calendarEvents.source, 'hearing'), isNotNull(bills.priority)),
          eq(calendarEvents.source, 'custom'),
        ),
      ))
      .get(),
  ])

  // New keyword-match worklist size — admin/owner only (drives the sidebar "N new" chip).
  const user = c.get('user')
  let newMatchesCount = 0
  if (user.role === 'admin' || user.role === 'owner') {
    const threshold = await getNewMatchMinRelevance(db)
    const row = await db.select({ count: count() }).from(bills).where(newMatchWhere(threshold)).get()
    newMatchesCount = row?.count ?? 0
  }

  return c.json({
    billCount: billCount?.count ?? 0,
    memberCount: memberCount?.count ?? 0,
    calendarUpcomingCount: calUpcoming?.count ?? 0,
    calendarUpcomingDays: CALENDAR_UPCOMING_DAYS,
    newMatchesCount,
  })
})

statsRouter.get('/sidebar', async (c) => {
  const db = getDb(c.env.DB)
  const userId = c.get('user').id

  const [
    priorityBillRows,
    unvotedRows,
    priorityBillList,
  ] = await Promise.all([
    // 1. Count priority bills
    db.select({ count: count() }).from(bills).where(isNotNull(bills.priority)).get(),
    // 2. Priority bills user hasn't voted on (left join, vote is null)
    db
      .select({ count: count() })
      .from(bills)
      .leftJoin(memberVotes, and(eq(memberVotes.billId, bills.id), eq(memberVotes.userId, userId)))
      .where(and(isNotNull(bills.priority), isNull(memberVotes.id)))
      .get(),
    // 3. Priority bills with user's vote, ordered high→medium→low
    db
      .select({
        id: bills.id,
        billNumber: bills.billNumber,
        session: bills.session,
        state: bills.state,
        title: bills.title,
        summary: bills.tenantSummary,
        priority: bills.priority,
        myVote: memberVotes.position,
      })
      .from(bills)
      .leftJoin(memberVotes, and(eq(memberVotes.billId, bills.id), eq(memberVotes.userId, userId)))
      .where(isNotNull(bills.priority))
      .orderBy(sql`CASE WHEN ${bills.priority}='high' THEN 0 WHEN ${bills.priority}='medium' THEN 1 ELSE 2 END`)
      .all(),
  ])

  const priorityBillCount = priorityBillRows?.count ?? 0
  const unvotedPriorityCount = unvotedRows?.count ?? 0

  const upcomingHearings = await fetchUpcomingHearings(c, db)

  return c.json({
    priorityBillCount,
    unvotedPriorityCount,
    upcomingHearings,
    priorityBills: priorityBillList.map(b => ({ ...b, sessionSlug: sessionToSlug(b.session) })),
  })
})

interface HearingBill {
  id: string
  billNumber: string
  title: string
  summary: string | null
  priority: 'high' | 'medium' | 'low' | null
  state: string | null
  sessionSlug: string | null
  myVote: string | null
}

interface HearingGroup {
  /** Stable id for keying — composite of date|time|description|location */
  hearingKey: string
  /** Canonical hearing identity, shared with the calendar event for deep-linking. */
  eventHash: string
  type: string | null
  date: string
  time: string | null
  location: string | null
  description: string | null
  bills: HearingBill[]
}

async function fetchUpcomingHearings(
  c: Context<AppEnv>,
  db: ReturnType<typeof getDb>,
): Promise<HearingGroup[]> {
  const provider = (c.env as { PROVIDER?: string }).PROVIDER ?? 'openstates'
  if (provider !== 'legiscan') return []

  // Load modules config
  const modulesRow = await db
    .select({ value: associationConfig.value })
    .from(associationConfig)
    .where(eq(associationConfig.key, 'modules'))
    .get()
  let modules: Record<string, unknown> = {}
  if (modulesRow) {
    try {
      const parsed = JSON.parse(modulesRow.value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        modules = parsed as Record<string, unknown>
      }
    } catch { /* ignore */ }
  }
  const m = modules['upcoming-hearings']
  const enabled = m === true || (typeof m === 'object' && m !== null && (m as { enabled?: unknown }).enabled === true)
  if (!enabled) return []

  // The widget is no longer configurable: it always shows hearings for
  // prioritized bills in the next 30 days. (Matches the hint text in the
  // sidebar customize panel and the header tooltip.)
  const lookaheadDays = 30

  const tenantId = c.env.TENANT_ID
  const userId = c.get('user').id
  let centralResults: Array<{
    eventHash: string
    type: string | null
    date: string
    time: string | null
    location: string | null
    description: string | null
    billId: number
    billNumber: string
    billTitle: string
    state: string | null
    sessionName: string | null
  }> = []

  if ((c.env as { DEMO_MODE?: string }).DEMO_MODE === 'true') {
    // Demo instances have a frozen bill set; serve synthetic, now-relative hearings
    // seeded into the tenant calendar_events table so the widget always has fresh data
    // and matches the Calendar section and bill detail page. No central call.
    centralResults = await loadUpcomingDemoHearings(db, lookaheadDays)
  } else {
    try {
      const res = await centralFetch(c.env, `/tenants/${encodeURIComponent(tenantId)}/upcoming-hearings?days=${lookaheadDays}`)
      if (!res.ok) {
        console.warn(`[hearings] central returned ${res.status}`)
        return []
      }
      centralResults = await res.json()
    } catch (err) {
      console.error('[hearings] central call failed', err)
      return []
    }
  }

  if (centralResults.length === 0) return []

  // Tenant bills store the LegiScan id as externalId = 'legiscan:<n>'.
  // Look up tenant rows, including summary/priority for the chip tooltip.
  const billExternalIds = [...new Set(centralResults.map(h => `legiscan:${h.billId}`))]

  // Scope is fixed to prioritized bills only.
  const billRows = await db
    .select({
      id: bills.id,
      externalId: bills.externalId,
      billNumber: bills.billNumber,
      title: bills.title,
      summary: bills.tenantSummary,
      priority: bills.priority,
      state: bills.state,
      session: bills.session,
    })
    .from(bills)
    .where(and(inArray(bills.externalId, billExternalIds), isNotNull(bills.priority)))
    .all()

  if (billRows.length === 0) return []

  // Member votes for current user, restricted to this set of bills
  const billInternalIds = billRows.map(b => b.id)
  const voteRows = await db
    .select({ billId: memberVotes.billId, position: memberVotes.position })
    .from(memberVotes)
    .where(and(eq(memberVotes.userId, userId), inArray(memberVotes.billId, billInternalIds)))
    .all()
  const myVoteByBillId = new Map(voteRows.map(r => [r.billId, r.position]))

  const billByExternal = new Map<string, HearingBill>()
  for (const row of billRows) {
    if (!row.externalId) continue
    billByExternal.set(row.externalId, {
      id: row.id,
      billNumber: row.billNumber,
      title: row.title,
      summary: row.summary,
      priority: row.priority as HearingBill['priority'],
      state: row.state,
      sessionSlug: row.session ? sessionToSlug(row.session) : null,
      myVote: myVoteByBillId.get(row.id) ?? null,
    })
  }

  // Group by composite hearing key
  const groups = new Map<string, HearingGroup>()
  for (const h of centralResults) {
    const bill = billByExternal.get(`legiscan:${h.billId}`)
    if (!bill) continue
    // Composite key: same date+time+description+location = same hearing
    const hearingKey = `${h.date}|${h.time ?? ''}|${(h.description ?? '').trim()}|${(h.location ?? '').trim()}`
    let g = groups.get(hearingKey)
    if (!g) {
      g = {
        hearingKey,
        eventHash: h.eventHash,
        type: h.type,
        date: h.date,
        time: h.time,
        location: h.location,
        description: h.description,
        bills: [],
      }
      groups.set(hearingKey, g)
    }
    // De-dup bills within a group (a single hearing could have duplicate event rows for the same bill)
    if (!g.bills.some(b => b.id === bill.id)) {
      g.bills.push(bill)
    }
  }

  // Order: by date asc, time asc nulls-last
  return [...groups.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    const at = a.time ?? '99:99:99'
    const bt = b.time ?? '99:99:99'
    return at < bt ? -1 : at > bt ? 1 : 0
  })
}

export { statsRouter }
