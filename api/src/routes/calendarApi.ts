import { Hono } from 'hono'
import { eq, and, isNotNull, gte, lte, or, asc, inArray } from 'drizzle-orm'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { getDb } from '../db/client'
import { calendarEvents, calendarEventBills, bills, associationConfig } from '../db/schema'
import { buildVCalendar, tzidForState, type IcalEvent } from '../lib/ical'
import { hearingBody, customBody, customUrl } from '../lib/calendarIcsBody'
import { billUrl } from '../../../shared/sessionSlug'
import { collectPriorityLegiscanIds, backfillCalendar } from '../lib/calendarBackfill'
import { nowDb } from '../lib/dbTime'
import { PRODUCT_NAME } from '../../../shared/brand'
import { importUid, importEventHash, type ImportRow } from '../lib/calendarImport'
import type { AppEnv } from '../types'

export const calendarRouter = new Hono<AppEnv>()

const daysFromNow = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const daysAgo = (offsetDays: number) => new Date(Date.now() - offsetDays * 86400_000).toISOString().slice(0, 10)

function sanitizeUrl(u: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  if (u == null) return { ok: true, value: null }
  const t = u.trim()
  if (t === '') return { ok: true, value: null }
  try {
    const parsed = new URL(t)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false }
    return { ok: true, value: t }
  } catch { return { ok: false } }
}

// Accept only a plausible IANA zone (e.g. "America/New_York", "Pacific/Honolulu",
// "UTC") so we never persist arbitrary client input. Returns null otherwise.
function sanitizeTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null
  const t = tz.trim()
  return /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(t) || t === 'UTC' ? t : null
}

async function getOrCreateSlug(db: ReturnType<typeof getDb>): Promise<string> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'calendar_feed_slug')).get()
  if (row?.value) return row.value
  const slug = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => (b % 36).toString(36)).join('')
  await db.insert(associationConfig).values({ key: 'calendar_feed_slug', value: slug })
    .onConflictDoNothing()
  const after = await db.select().from(associationConfig).where(eq(associationConfig.key, 'calendar_feed_slug')).get()
  return after?.value ?? slug
}

calendarRouter.post('/backfill', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const ids = await collectPriorityLegiscanIds(db)
  c.executionCtx.waitUntil(backfillCalendar(c.env, ids))
  return c.json({ ok: true, queued: ids.length }, 202)
})

calendarRouter.get('/info', requireAuth, async (c) => {
  const db = getDb(c.env.DB)
  const slug = await getOrCreateSlug(db)
  const host = new URL(c.req.url).host
  const path = `/api/calendar/feed/${slug}.ics`
  return c.json({
    slug,
    feedUrl: `https://${host}${path}`,
    webcalUrl: `webcal://${host}${path}`,
    googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`webcal://${host}${path}`)}`,
  })
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function setEventBills(db: ReturnType<typeof getDb>, eventId: string, billIds: string[]): Promise<string[]> {
  const unique = [...new Set(billIds.filter(Boolean))]
  // keep only ids that match real bills
  const valid = unique.length === 0 ? [] : (await db
    .select({ id: bills.id }).from(bills).where(inArray(bills.id, unique)).all()).map(b => b.id)
  await db.delete(calendarEventBills).where(eq(calendarEventBills.eventId, eventId))
  if (valid.length > 0) {
    await db.insert(calendarEventBills).values(valid.map(billId => ({ eventId, billId })))
  }
  return valid
}

calendarRouter.get('/events', requireAuth, async (c) => {
  const db = getDb(c.env.DB)
  const rawFrom = c.req.query('from')
  const rawTo = c.req.query('to')
  const from = rawFrom && DATE_RE.test(rawFrom) ? rawFrom : daysFromNow(-90)
  const to = rawTo && DATE_RE.test(rawTo) ? rawTo : daysFromNow(365)
  const cancelCutoff = daysAgo(2)

  const rows = await db
    .select({
      id: calendarEvents.id, uid: calendarEvents.uid, source: calendarEvents.source,
      sequence: calendarEvents.sequence, billId: calendarEvents.billId,
      eventHash: calendarEvents.eventHash,
      date: calendarEvents.date, time: calendarEvents.time,
      location: calendarEvents.location, description: calendarEvents.description,
      details: calendarEvents.details, url: calendarEvents.url,
      status: calendarEvents.status,
      billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, priority: bills.priority,
    })
    .from(calendarEvents)
    .leftJoin(bills, eq(calendarEvents.billId, bills.id))
    .where(and(
      isNotNull(calendarEvents.date),
      gte(calendarEvents.date, from),
      lte(calendarEvents.date, to),
      or(
        and(eq(calendarEvents.source, 'hearing'), isNotNull(bills.priority)),
        eq(calendarEvents.source, 'custom'),
      ),
      or(
        eq(calendarEvents.status, 'confirmed'),
        and(eq(calendarEvents.status, 'cancelled'), gte(calendarEvents.date, cancelCutoff)),
      ),
    ))
    .all()

  // Linked bills for custom events come from the join table.
  const customIds = rows.filter(r => r.source === 'custom').map(r => r.id)
  const linkMap = new Map<string, Array<{ id: string; billNumber: string; billTitle: string; state: string | null; priority: string | null }>>()
  if (customIds.length > 0) {
    const links = await db
      .select({
        eventId: calendarEventBills.eventId,
        id: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
        state: bills.state, priority: bills.priority,
      })
      .from(calendarEventBills)
      .innerJoin(bills, eq(calendarEventBills.billId, bills.id))
      .where(inArray(calendarEventBills.eventId, customIds))
      .all()
    for (const l of links) {
      const list = linkMap.get(l.eventId) ?? []
      list.push({ id: l.id, billNumber: l.billNumber, billTitle: l.billTitle, state: l.state, priority: l.priority })
      linkMap.set(l.eventId, list)
    }
  }

  type EventBill = { id: string; billNumber: string; billTitle: string; state: string | null; priority: string | null }
  interface EventResult {
    id: string; uid: string; source: string; billId: string | null
    eventHash: string | null
    /** All event_hashes merged into this entry; the sidebar deep-link focus matches any of them. */
    eventHashes: string[]
    date: string | null; time: string | null; location: string | null
    description: string | null; details: string | null; url: string | null
    status: string; bills: EventBill[]
  }

  const entries: EventResult[] = rows.map(r => {
    const billsArr: EventBill[] = r.source === 'custom'
      ? (linkMap.get(r.id) ?? [])
      : (r.billNumber
          ? [{ id: r.billId!, billNumber: r.billNumber, billTitle: r.billTitle ?? '', state: r.billState, priority: r.priority }]
          : [])
    return {
      id: r.id, uid: r.uid, source: r.source, billId: r.billId,
      eventHash: r.eventHash, eventHashes: r.eventHash ? [r.eventHash] : [],
      date: r.date, time: r.time, location: r.location,
      description: r.description, details: r.details, url: r.url,
      status: r.status,
      bills: billsArr,
    }
  })

  // Custom events pass through individually (each is independently editable).
  // Hearing events that describe the same real hearing — same
  // date|time|description|location — are merged into one entry whose `bills`
  // holds every linked bill. This mirrors the sidebar "upcoming hearings"
  // grouping (see api/src/routes/stats.ts) so the calendar and the widget agree.
  const result: EventResult[] = []
  const hearingGroups = new Map<string, EventResult>()
  for (const e of entries) {
    if (e.source !== 'hearing') { result.push(e); continue }
    const key = `${e.date}|${e.time ?? ''}|${(e.description ?? '').trim()}|${(e.location ?? '').trim()}`
    const g = hearingGroups.get(key)
    if (!g) {
      hearingGroups.set(key, e)
      result.push(e)
      continue
    }
    for (const b of e.bills) {
      if (!g.bills.some(x => x.id === b.id)) g.bills.push(b)
    }
    for (const h of e.eventHashes) {
      if (!g.eventHashes.includes(h)) g.eventHashes.push(h)
    }
    // A merged hearing counts as confirmed if any of its bill rows is confirmed.
    if (e.status === 'confirmed') g.status = 'confirmed'
  }

  return c.json(result)
})

calendarRouter.get('/bill-options', requireAuth, async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db
    .select({ id: bills.id, billNumber: bills.billNumber, title: bills.title, state: bills.state, isDraft: bills.isDraft })
    .from(bills)
    .where(isNotNull(bills.matchType))
    .orderBy(asc(bills.billNumber))
    .all()
  return c.json(rows)
})

calendarRouter.post('/events', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const body = await c.req.json().catch(() => ({})) as {
    description?: string; date?: string; time?: string | null; location?: string | null; billIds?: string[]; timezone?: string | null
    details?: string | null; url?: string | null
  }
  const description = (body.description ?? '').trim()
  const date = (body.date ?? '').trim()
  if (!description || !DATE_RE.test(date)) {
    return c.json({ error: 'description and a valid date (YYYY-MM-DD) are required' }, 400)
  }
  const urlCheck = sanitizeUrl(body.url)
  if (!urlCheck.ok) return c.json({ error: 'url must be http(s)' }, 400)
  const details = (body.details ?? '').trim() || null
  const id = crypto.randomUUID()
  const uid = `custom-${id}@example.com`
  await db.insert(calendarEvents).values({
    id, uid, billId: null, source: 'custom', sequence: 0,
    date, time: body.time?.trim() || null, location: body.location?.trim() || null,
    description, details, url: urlCheck.value, status: 'confirmed', eventHash: null,
    timezone: sanitizeTimezone(body.timezone),
  })
  const billIds = await setEventBills(db, id, body.billIds ?? [])
  return c.json({
    id, uid, source: 'custom', billIds, date,
    time: body.time?.trim() || null,
    location: body.location?.trim() || null,
    description, details, url: urlCheck.value, status: 'confirmed', sequence: 0,
  }, 201)
})

calendarRouter.put('/events/:id', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const existing = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
  if (!existing || existing.source !== 'custom') return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json().catch(() => ({})) as {
    description?: string; date?: string; time?: string | null; location?: string | null; billIds?: string[]
    details?: string | null; url?: string | null
  }
  const description = (body.description ?? '').trim()
  const date = (body.date ?? '').trim()
  if (!description || !DATE_RE.test(date)) {
    return c.json({ error: 'description and a valid date (YYYY-MM-DD) are required' }, 400)
  }
  const urlCheck = sanitizeUrl(body.url)
  if (!urlCheck.ok) return c.json({ error: 'url must be http(s)' }, 400)
  const details = (body.details ?? '').trim() || null
  const newSequence = existing.sequence + 1
  await db.update(calendarEvents).set({
    description, date, time: body.time?.trim() || null, location: body.location?.trim() || null,
    details, url: urlCheck.value,
    billId: null, sequence: newSequence, updatedAt: nowDb(),
  }).where(eq(calendarEvents.id, id))
  const billIds = await setEventBills(db, id, body.billIds ?? [])
  return c.json({
    id, uid: existing.uid, source: 'custom', billIds, date,
    time: body.time?.trim() || null,
    location: body.location?.trim() || null,
    description, details, url: urlCheck.value, status: existing.status, sequence: newSequence,
  })
})

calendarRouter.delete('/events/:id', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const existing = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
  if (!existing || existing.source !== 'custom') return c.json({ error: 'Not found' }, 404)
  await db.update(calendarEvents).set({
    status: 'cancelled', sequence: existing.sequence + 1,
    updatedAt: nowDb(),
  }).where(eq(calendarEvents.id, id))
  return c.json({ id, status: 'cancelled' })
})

calendarRouter.post('/events/:id/restore', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const existing = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
  if (!existing || existing.source !== 'custom') return c.json({ error: 'Not found' }, 404)
  await db.update(calendarEvents).set({
    status: 'confirmed', sequence: existing.sequence + 1,
    updatedAt: nowDb(),
  }).where(eq(calendarEvents.id, id))
  return c.json({ id, status: 'confirmed' })
})

calendarRouter.post('/import', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const body = await c.req.json().catch(() => ({})) as { rows?: ImportRow[] }
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length > 1000) return c.json({ ok: false, error: 'Too many rows; maximum is 1000' }, 413)
  let created = 0, updated = 0, unchanged = 0, skipped = 0
  // uid case-folds the title for stable re-import lookup; the content hash is case-sensitive so genuine edits (incl. casing) bump the sequence.
  for (const raw of rows) {
    const title = (raw.title ?? '').toString().trim()
    const date = (raw.date ?? '').toString().trim()
    if (!title || !DATE_RE.test(date)) { skipped++; continue }
    const urlCheck = sanitizeUrl(raw.url != null ? String(raw.url) : null)
    const row: ImportRow = {
      title, date,
      details: (raw.details ?? '').toString().trim() || null,
      time: (raw.time ?? '').toString().trim() || null,
      location: (raw.location ?? '').toString().trim() || null,
      url: urlCheck.ok ? urlCheck.value : null,
    }
    const uid = await importUid(row)
    const hash = await importEventHash(row)
    const existing = await db.select({ id: calendarEvents.id, sequence: calendarEvents.sequence, eventHash: calendarEvents.eventHash })
      .from(calendarEvents).where(eq(calendarEvents.uid, uid)).get()
    if (!existing) {
      await db.insert(calendarEvents).values({
        id: crypto.randomUUID(), uid, billId: null, source: 'custom', sequence: 0,
        date: row.date, time: row.time, location: row.location, description: row.title,
        details: row.details, url: row.url, status: 'confirmed', eventHash: hash,
        // timezone left null — import rows are date-only; the ICS feed falls back to STATE/default zone.
      })
      created++
    } else if ((existing.eventHash ?? '') !== hash) {
      await db.update(calendarEvents).set({
        date: row.date, time: row.time, location: row.location, description: row.title,
        details: row.details, url: row.url, eventHash: hash,
        sequence: existing.sequence + 1, status: 'confirmed', updatedAt: nowDb(),
      }).where(eq(calendarEvents.id, existing.id))
      updated++
    } else {
      unchanged++
    }
  }
  return c.json({ created, updated, unchanged, skipped })
})

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return result === 0
}

calendarRouter.post('/regenerate-slug', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const slug = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => (b % 36).toString(36)).join('')
  await db.insert(associationConfig).values({ key: 'calendar_feed_slug', value: slug })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: slug } })
  const host = new URL(c.req.url).host
  const path = `/api/calendar/feed/${slug}.ics`
  return c.json({
    slug,
    feedUrl: `https://${host}${path}`,
    webcalUrl: `webcal://${host}${path}`,
    googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`webcal://${host}${path}`)}`,
  })
})

// Public (NO auth) — matched by slug.
calendarRouter.get('/feed/:slugIcs', async (c) => {
  const db = getDb(c.env.DB)
  const slug = c.req.param('slugIcs').replace(/\.ics$/, '')
  const stored = await db.select().from(associationConfig).where(eq(associationConfig.key, 'calendar_feed_slug')).get()
  if (!stored?.value || !constantTimeEqual(stored.value, slug)) return c.text('Not found', 404)

  const confirmedCutoff = daysAgo(7)   // confirmed: last 7 days + all future
  const cancelCutoff = daysAgo(2)      // cancelled: only within a 2-day grace, then drop
  const rows = await db
    .select({
      uid: calendarEvents.uid, sequence: calendarEvents.sequence, status: calendarEvents.status,
      date: calendarEvents.date, time: calendarEvents.time, location: calendarEvents.location,
      description: calendarEvents.description, source: calendarEvents.source,
      timezone: calendarEvents.timezone,
      details: calendarEvents.details, url: calendarEvents.url,
      billId: calendarEvents.billId,
      billNumber: bills.billNumber, billTitle: bills.title, priority: bills.priority, state: bills.state,
      session: bills.session,
    })
    .from(calendarEvents)
    .leftJoin(bills, eq(calendarEvents.billId, bills.id))
    .where(and(
      or(
        and(eq(calendarEvents.source, 'hearing'), isNotNull(bills.priority)),
        eq(calendarEvents.source, 'custom'),
      ),
      or(
        and(eq(calendarEvents.status, 'confirmed'), gte(calendarEvents.date, confirmedCutoff)),
        and(eq(calendarEvents.status, 'cancelled'), gte(calendarEvents.date, cancelCutoff)),
      ),
    ))
    .all()

  const nameRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get()
  // association_name is stored JSON-encoded (matches configApi); parse with a raw fallback.
  let assocName = PRODUCT_NAME
  if (nameRow?.value) {
    try { assocName = JSON.parse(nameRow.value) as string } catch { assocName = nameRow.value }
  }
  const calName = `${assocName} — Tracked Hearings`

  const customUids = rows.filter(r => r.source === 'custom').map(r => r.uid)
  const numbersByUid = new Map<string, string[]>()
  const stateByUid = new Map<string, string>() // custom event → first linked bill's state
  const firstBillByUid = new Map<string, { id: string; state: string | null; session: string | null; billNumber: string }>()
  if (customUids.length > 0) {
    const links = await db
      .select({ uid: calendarEvents.uid, billId: bills.id, billNumber: bills.billNumber, state: bills.state, session: bills.session })
      .from(calendarEvents)
      .innerJoin(calendarEventBills, eq(calendarEventBills.eventId, calendarEvents.id))
      .innerJoin(bills, eq(calendarEventBills.billId, bills.id))
      .where(inArray(calendarEvents.uid, customUids))
      .all()
    for (const l of links) {
      const list = numbersByUid.get(l.uid) ?? []
      list.push(l.billNumber)
      numbersByUid.set(l.uid, list)
      if (l.state && !stateByUid.has(l.uid)) stateByUid.set(l.uid, l.state)
      if (!firstBillByUid.has(l.uid)) firstBillByUid.set(l.uid, { id: l.billId, state: l.state, session: l.session, billNumber: l.billNumber })
    }
  }

  // Default zone for events whose state can't be resolved (see below).
  const fallbackTz = c.env.CALENDAR_DEFAULT_TZ || 'America/New_York'
  const host = new URL(c.req.url).host
  const calendarHref = `https://${host}/calendar`

  const events: IcalEvent[] = rows.map(r => {
    const customNumbers = numbersByUid.get(r.uid) ?? []
    let summary: string
    // Title first, then bill number(s): "<description> — <bills>".
    if (r.source === 'custom') {
      const desc = (r.description ?? '').trim() || 'Event'
      const suffix = customNumbers.length > 0 ? ` — ${customNumbers.join(', ')}` : ''
      summary = `${desc}${suffix}`
    } else {
      const desc = (r.description ?? '').trim()
      summary = desc
        ? `${desc}${r.billNumber ? ` — ${r.billNumber}` : ''}`
        : (r.billNumber ?? 'Event')
    }
    // Anchor timed events to the event's state zone (hearing: the bill's state;
    // custom: first linked bill's state), falling back to the tenant's STATE.
    // When no state resolves (multi-state instance + custom event with no linked
    // bill), use the creator's captured browser zone, then the configured
    // default — never a floating time (which calendar clients misread as UTC).
    const state = (r.source === 'custom' ? stateByUid.get(r.uid) : r.state) || c.env.STATE || null

    let description: string | null = null
    let url: string | null = null
    if (r.source === 'custom') {
      const fb = firstBillByUid.get(r.uid)
      const billHref = fb ? encodeURI(`https://${host}${billUrl({ id: fb.id, state: fb.state, session: fb.session, billNumber: fb.billNumber })}`) : null
      description = customBody({ details: r.details, url: r.url, billNumbers: customNumbers, billHref, calendarHref, assoc: assocName })
      url = customUrl({ url: r.url, billHref, calendarHref })
    } else if (r.billNumber && r.billId) {
      const billHref = encodeURI(`https://${host}${billUrl({ id: r.billId, state: r.state, session: r.session, billNumber: r.billNumber })}`)
      description = hearingBody({ billNumber: r.billNumber, billTitle: r.billTitle ?? null, priority: r.priority, billHref, assoc: assocName })
      url = billHref
    }

    return {
      uid: r.uid, sequence: r.sequence, status: r.status as 'confirmed' | 'cancelled',
      date: r.date, time: r.time, location: r.location,
      summary,
      description,
      url,
      tzid: tzidForState(state) ?? r.timezone ?? fallbackTz,
    }
  })

  const ics = buildVCalendar(events, { calName, now: new Date().toISOString() }) // ts-write-ok: ICS DTSTAMP, display only, not a DB column
  return c.body(ics, 200, { 'content-type': 'text/calendar; charset=utf-8' })
})
