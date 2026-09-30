import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, desc, inArray, gte, lt, lte } from 'drizzle-orm'
import { isCurrentMember } from '../lib/council-changes'
import { LIMS_PEOPLE_ID_BASE, LIMS_SESSION_ID_BASE } from '../lib/lims-ids'
import * as schema from '../db/schema-legiscan'
import { secretsMatch } from '../lib/auth'
import { textCacheKey, getCachedText, putCachedText } from '../lib/billTextCache'
import { resolveItemDate } from '../lib/itemDate'
import type { LsEnv } from '../types-legiscan'
import { LIMS_STATUS_LABELS } from '../lib/lims-map'
import { councilHearingUrl } from '../lib/lims-hearings'

const STATUS_LABELS: Record<number, string> = {
  0: 'Pre-filed', 1: 'Introduced', 2: 'Engrossed',
  3: 'Enrolled', 4: 'Passed', 5: 'Vetoed', 6: 'Failed',
  ...LIMS_STATUS_LABELS,
}

export const billsLsRoutes = new Hono<{ Bindings: LsEnv }>()

billsLsRoutes.use('*', async (c, next) => {
  if (!(await secretsMatch(c.req.header('x-admin-secret'), c.env.ADMIN_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

// The DC Council hearing calendar (cron/sync-lims.ts syncCouncilCalendar), for
// tenants to filter with their own calendar rules. Registered before '/:id' so
// the literal segment is not read as a bill id. Removed events are returned with
// removedAt set, so a tenant can cancel its copy.
// The Council's committees (chair, members, key staff, agencies) and staff
// directory, from dccouncil.gov (cron/sync-lims.ts syncCouncilDirectory).
billsLsRoutes.get('/council-directory', async (c) => {
  const db = drizzle(c.env.DB, { schema })
  const parse = <T>(s: string | null, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T } catch { return fallback } }
  const committees = await db.select().from(schema.councilCommittees).orderBy(schema.councilCommittees.name).all()
  const people = await db.select().from(schema.councilDirectory).orderBy(schema.councilDirectory.name).all()
  // The current Council Period's members with their terms, so a page or a brief
  // can tell a sitting member from one who has left.
  const today = new Date().toISOString().slice(0, 10)
  const period = await db.select({ yearStart: schema.sessions.yearStart }).from(schema.sessions)
    .where(and(eq(schema.sessions.state, 'DC'), gte(schema.sessions.sessionId, LIMS_SESSION_ID_BASE), eq(schema.sessions.prior, 0))).get()
  const members = await db.select({ peopleId: schema.people.peopleId, name: schema.people.name, role: schema.people.role, termStart: schema.people.termStart, termEnd: schema.people.termEnd })
    .from(schema.people).where(and(gte(schema.people.peopleId, LIMS_PEOPLE_ID_BASE), lt(schema.people.peopleId, LIMS_PEOPLE_ID_BASE * 2))).all()
  const periodStart = period ? `${period.yearStart}-01-01` : null
  const councilmembers = members
    .filter(m => !periodStart || !m.termEnd || m.termEnd >= periodStart)
    .map(m => ({ ...m, current: isCurrentMember(m, today) }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
  const changes = await db.select().from(schema.councilChanges)
    .where(gte(schema.councilChanges.detectedAt, new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)))
    .orderBy(desc(schema.councilChanges.detectedAt), desc(schema.councilChanges.id)).limit(100).all()
  return c.json({
    councilmembers,
    changes: changes.map(ch => ({ kind: ch.kind, committee: ch.committee, person: ch.person, detail: ch.detail, detectedAt: ch.detectedAt })),
    committees: committees.map(r => ({
      slug: r.slug, name: r.name, url: r.url,
      chair: parse(r.chairJson, null), members: parse(r.membersJson, []), staff: parse(r.staffJson, []), agencies: parse(r.agenciesJson, []),
      updatedAt: r.updatedAt,
    })),
    people: people.map(r => ({ kind: r.kind, name: r.name, title: r.title, office: r.office, email: r.email, phone: r.phone })),
    updatedAt: committees[0]?.updatedAt ?? null,
  })
})

billsLsRoutes.get('/council-events', async (c) => {
  const from = c.req.query('from') ?? ''
  const to = c.req.query('to') ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json({ error: 'from and to (YYYY-MM-DD) are required' }, 400)
  }
  const db = drizzle(c.env.DB, { schema })
  const rows = await db.select().from(schema.councilEvents)
    .where(and(gte(schema.councilEvents.date, from), lte(schema.councilEvents.date, to)))
    .orderBy(schema.councilEvents.date, schema.councilEvents.time)
    .all()
  return c.json(rows.map(r => ({
    hearingId: r.hearingId,
    date: r.date,
    time: r.time,
    hearingType: r.hearingType,
    title: r.title,
    jointWith: r.jointWith,
    location: r.location,
    topics: JSON.parse(r.topicsJson) as { topic: string; number: string | null }[],
    witnessList: r.witnessJson ? JSON.parse(r.witnessJson) as { attachmentGuid: string; attachmentName: string } : null,
    url: councilHearingUrl(r.hearingId),
    eventHash: r.eventHash,
    removedAt: r.removedAt,
  })))
})

billsLsRoutes.get('/sessions', async (c) => {
  const state = c.req.query('state')?.toUpperCase()
  if (!state) return c.json({ error: 'state is required' }, 400)
  const db = drizzle(c.env.DB, { schema })
  const sessions = await db
    .select({
      sessionId:   schema.sessions.sessionId,
      sessionName: schema.sessions.sessionName,
      state:       schema.sessions.state,
      yearStart:   schema.sessions.yearStart,
      yearEnd:     schema.sessions.yearEnd,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.state, state))
    .all()
  return c.json({ sessions })
})

// Bulk rich-data lookup for the tenant data export. Returns amendments,
// supplements, and roll-call votes for a batch of bill ids in a few indexed
// `WHERE bill_id IN (...)` queries — far cheaper than one /bills/:id full-detail
// call per bill. Registered before GET /:id (different method, no conflict).
billsLsRoutes.post('/rich-batch', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const rawIds = Array.isArray((body as { ids?: unknown }).ids) ? (body as { ids: unknown[] }).ids : []
  const numericIds = [...new Set(
    rawIds
      .map(id => parseInt(String(id).replace('legiscan:', ''), 10))
      .filter(n => !isNaN(n)),
  )]

  type Rich = {
    amendments: Array<Record<string, unknown>>
    supplements: Array<Record<string, unknown>>
    votes: Array<Record<string, unknown>>
  }
  const byId: Record<string, Rich> = {}
  for (const id of numericIds) byId[String(id)] = { amendments: [], supplements: [], votes: [] }

  if (numericIds.length > 0) {
    const db = drizzle(c.env.DB, { schema })
    // Session year range per bill, for inferring year-less embedded dates.
    const sessionByBill: Record<number, { yearStart: number | null; yearEnd: number | null }> = {}
    for (let i = 0; i < numericIds.length; i += 90) {
      const ids = numericIds.slice(i, i + 90)
      const rows = await db.select({
        billId:    schema.bills.billId,
        yearStart: schema.sessions.yearStart,
        yearEnd:   schema.sessions.yearEnd,
      })
        .from(schema.bills)
        .leftJoin(schema.sessions, eq(schema.bills.sessionId, schema.sessions.sessionId))
        .where(inArray(schema.bills.billId, ids))
        .all()
      for (const r of rows) sessionByBill[r.billId] = { yearStart: r.yearStart ?? null, yearEnd: r.yearEnd ?? null }
    }
    // Chunk to stay well under SQLite's bound-parameter limit on large pages.
    for (let i = 0; i < numericIds.length; i += 90) {
      const ids = numericIds.slice(i, i + 90)
      const [amendmentRows, supplementRows, rollCalls] = await Promise.all([
        db.select().from(schema.billAmendments).where(inArray(schema.billAmendments.billId, ids)).orderBy(schema.billAmendments.date).all(),
        db.select().from(schema.billSupplements).where(inArray(schema.billSupplements.billId, ids)).all(),
        db.select().from(schema.rollCalls).where(inArray(schema.rollCalls.billId, ids)).all(),
      ])
      for (const a of amendmentRows) {
        const yrs = sessionByBill[a.billId] ?? {}
        const { dateResolved, dateInferred } = resolveItemDate(a.date, a.description ?? a.title, yrs)
        byId[String(a.billId)]?.amendments.push({
          amendmentId: a.amendmentId, adopted: a.adopted === 1, chamber: a.chamber ?? null,
          date: a.date ?? null, dateResolved, dateInferred, title: a.title ?? null, description: a.description ?? null,
          mime: a.mime ?? null, url: a.url ?? null, stateLink: a.stateLink ?? null,
        })
      }
      for (const s of supplementRows) {
        const yrs = sessionByBill[s.billId] ?? {}
        const { dateResolved, dateInferred } = resolveItemDate(s.date, s.description ?? s.title, yrs)
        byId[String(s.billId)]?.supplements.push({
          supplementId: s.supplementId, typeId: s.typeId ?? 0, type: s.type ?? '',
          date: s.date ?? null, dateResolved, dateInferred, title: s.title ?? null, description: s.description ?? null,
          mime: s.mime ?? null, url: s.url ?? null, stateLink: s.stateLink ?? null,
        })
      }
      // Opt-in: each member's vote. The data export leaves it off.
      const memberVotesByRc = new Map<number, { name: string; vote: string }[]>()
      if ((body as { memberVotes?: unknown }).memberVotes === true && rollCalls.length > 0) {
        const rcIds = rollCalls.map(rc => rc.rollCallId)
        for (let i = 0; i < rcIds.length; i += 90) {
          const rows = await db
            .select({ rollCallId: schema.rollCallVotes.rollCallId, name: schema.people.name, vote: schema.rollCallVotes.voteText })
            .from(schema.rollCallVotes)
            .leftJoin(schema.people, eq(schema.people.peopleId, schema.rollCallVotes.peopleId))
            .where(inArray(schema.rollCallVotes.rollCallId, rcIds.slice(i, i + 90)))
            .all()
          for (const r of rows) {
            if (!r.name || !r.vote) continue
            memberVotesByRc.set(r.rollCallId, [...(memberVotesByRc.get(r.rollCallId) ?? []), { name: r.name, vote: r.vote }])
          }
        }
      }
      for (const list of memberVotesByRc.values()) list.sort((a, b) => a.name.localeCompare(b.name))
      for (const rc of rollCalls) {
        byId[String(rc.billId)]?.votes.push({
          ...(memberVotesByRc.has(rc.rollCallId) ? { memberVotes: memberVotesByRc.get(rc.rollCallId) } : {}),
          id: String(rc.rollCallId), motionText: rc.description, date: rc.date,
          result: rc.passed ? 'pass' : 'fail', chamber: rc.chamber,
          counts: [
            { option: 'yes', value: rc.yea },
            { option: 'no', value: rc.nay },
            { option: 'not voting', value: rc.nv },
            { option: 'absent', value: rc.absent },
          ],
        })
      }
    }
  }

  return c.json({ byId })
})

billsLsRoutes.get('/:id', async (c) => {
  const rawId = c.req.param('id')
  const numeric = parseInt(rawId.replace('legiscan:', ''), 10)
  if (isNaN(numeric)) return c.json({ error: 'invalid bill id' }, 400)

  const db = drizzle(c.env.DB, { schema })

  const bill = await db.select().from(schema.bills).where(eq(schema.bills.billId, numeric)).get()
  if (!bill) return c.json({ error: 'not found' }, 404)

  const session = bill.sessionId
    ? await db.select({
        sessionName: schema.sessions.sessionName,
        yearStart:   schema.sessions.yearStart,
        yearEnd:     schema.sessions.yearEnd,
      })
        .from(schema.sessions).where(eq(schema.sessions.sessionId, bill.sessionId)).get()
    : null

  const [history, sponsorRows, texts, sasts, rollCalls, calendarEntries, supplementRows, subjectRows, amendmentRows] = await Promise.all([
    db.select().from(schema.billHistory).where(eq(schema.billHistory.billId, numeric)).all(),
    db.select({
      id: schema.billSponsors.id,
      peopleId: schema.billSponsors.peopleId,
      sponsorTypeId: schema.billSponsors.sponsorTypeId,
      sponsorOrder: schema.billSponsors.sponsorOrder,
      name: schema.people.name,
      party: schema.people.party,
      role: schema.people.role,
      bioJson: schema.people.bioJson,
    })
      .from(schema.billSponsors)
      .leftJoin(schema.people, eq(schema.billSponsors.peopleId, schema.people.peopleId))
      .where(eq(schema.billSponsors.billId, numeric))
      .all(),
    db.select().from(schema.billTexts).where(eq(schema.billTexts.billId, numeric)).all(),
    db.select().from(schema.billSasts).where(eq(schema.billSasts.billId, numeric)).all(),
    db.select().from(schema.rollCalls).where(eq(schema.rollCalls.billId, numeric)).all(),
    db.select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, numeric)).all(),
    db.select().from(schema.billSupplements).where(eq(schema.billSupplements.billId, numeric)).all(),
    db.select().from(schema.billSubjects).where(eq(schema.billSubjects.billId, numeric)).all(),
    db.select().from(schema.billAmendments).where(eq(schema.billAmendments.billId, numeric)).orderBy(schema.billAmendments.date).all(),
  ])
  const rcIds = rollCalls.map(rc => rc.rollCallId)
  // Chunked: a big bill can have more roll calls than D1's 100 bound parameters.
  const memberVoteRows: { rollCallId: number; name: string | null; vote: string | null }[] = []
  for (let i = 0; i < rcIds.length; i += 90) {
    memberVoteRows.push(...await db
      .select({ rollCallId: schema.rollCallVotes.rollCallId, name: schema.people.name, vote: schema.rollCallVotes.voteText })
      .from(schema.rollCallVotes)
      .leftJoin(schema.people, eq(schema.people.peopleId, schema.rollCallVotes.peopleId))
      .where(inArray(schema.rollCallVotes.rollCallId, rcIds.slice(i, i + 90)))
      .all())
  }
  const memberVotesByRc = new Map<number, { name: string; vote: string }[]>()
  for (const r of memberVoteRows) {
    if (!r.name || !r.vote) continue
    const list = memberVotesByRc.get(r.rollCallId) ?? []
    list.push({ name: r.name, vote: r.vote })
    memberVotesByRc.set(r.rollCallId, list)
  }
  for (const list of memberVotesByRc.values()) list.sort((a, b) => a.name.localeCompare(b.name))

  const textWithR2 = [...texts]
    .sort((a, b) => b.date.localeCompare(a.date))
    .find(t => t.r2Key)

  // 'fetch_failed' means we tried to download every text we know about and none
  // of them yielded a usable document (see bill_texts.fetch_error). It ranks
  // below 'in_r2' but must outrank 'available', which otherwise implies "we just
  // haven't fetched it yet" and hides a real, persistent failure.
  type TextStatus = 'not_checked' | 'no_texts' | 'available' | 'in_r2' | 'fetch_failed'
  const allTextsFailed = texts.length > 0 && texts.every(t => t.fetchError)
  const textStatus: TextStatus =
    textWithR2 ? 'in_r2' :
    allTextsFailed ? 'fetch_failed' :
    texts.length > 0 ? 'available' :
    bill.textsFetchedAt ? 'no_texts' :
    'not_checked'

  const actions = history
    .sort((a, b) => a.seq - b.seq)
    .map(h => ({
      description: h.action,
      date: h.date,
      chamber: h.chamber,
      classification: [] as string[],
      order: h.seq,
    }))

  const sponsors = sponsorRows
    .sort((a, b) => a.sponsorOrder - b.sponsorOrder)
    .map(s => {
      const name = s.name ?? String(s.peopleId ?? 'Unknown')
      let url: string | null = null
      if (s.bioJson) {
        try {
          const bio = JSON.parse(s.bioJson) as { social?: { biography?: string } }
          url = bio.social?.biography ?? null
        } catch { /* ignore */ }
      }
      if (!url && s.peopleId) url = `https://legiscan.com/${bill.state}/people/${name.replace(/ /g, '-')}/id/${s.peopleId}`
      return {
        name,
        party: s.party ?? null,
        role: s.role ?? null,
        primary: s.sponsorTypeId === 1,
        personId: s.peopleId ? String(s.peopleId) : null,
        url,
      }
    })

  const normalizedTexts = texts.map(t => ({
    docId: String(t.docId),
    note: t.type,
    date: t.date,
    links: [
      ...(t.stateLink ? [{ url: t.stateLink, mediaType: t.mime }] : []),
      ...(t.altStateLink ? [{ url: t.altStateLink, mediaType: t.altMime ?? 'application/pdf' }] : []),
    ],
  }))

  return c.json({
    billId: `legiscan:${bill.billId}`,
    sessionId:   String(bill.sessionId),
    sessionName: session?.sessionName ?? null,
    yearStart:   session?.yearStart   ?? null,
    yearEnd:     session?.yearEnd     ?? null,
    state: bill.state,
    number: bill.billNumber,
    title: bill.title,
    abstract: bill.description ?? null,
    status: STATUS_LABELS[bill.status] ?? String(bill.status),
    statusDate: bill.statusDate ?? null,
    lastAction: bill.lastAction ?? null,
    lastActionDate: bill.lastActionDate ?? null,
    billType: bill.billType ?? null,
    body: bill.body ?? null,
    updatedAt: bill.updatedAt,
    openstatesUrl: null,
    stateUrl: bill.stateLink ?? null,
    legiscanUrl: bill.url ?? null,
    textHash: textWithR2?.textHash ?? null,
    textR2Key: textWithR2?.r2Key ?? null,
    texts: normalizedTexts,
    textStatus,
    actions,
    sponsors,
    votes: rollCalls.map(rc => ({
      id: String(rc.rollCallId),
      // Each member's vote, where the provider records it (DC LIMS readings do).
      memberVotes: (memberVotesByRc.get(rc.rollCallId) ?? []),
      motionText: rc.description,
      date: rc.date,
      result: rc.passed ? 'pass' : 'fail',
      chamber: rc.chamber,
      counts: [
        { option: 'yes', value: rc.yea },
        { option: 'no', value: rc.nay },
        { option: 'not voting', value: rc.nv },
        { option: 'absent', value: rc.absent },
      ],
    })),
    relatedBills: sasts.map(s => ({
      identifier: s.sastBillNumber,
      sastBillId: s.sastBillId,
      session: String(bill.sessionId),
      relationType: s.type.toLowerCase().replace(/\s+/g, '-'),
    })),
    calendar: calendarEntries.map(e => ({
      eventHash: e.eventHash ?? '',
      typeId: e.typeId ?? 0,
      type: e.type ?? '',
      date: e.date ?? '',
      time: e.time ?? null,
      location: e.location ?? null,
      description: e.description ?? null,
    })),
    supplements: supplementRows.map(s => {
      const { dateResolved, dateInferred } = resolveItemDate(s.date, s.description ?? s.title, { yearStart: session?.yearStart, yearEnd: session?.yearEnd })
      return {
        supplementId: s.supplementId,
        typeId: s.typeId ?? 0,
        type: s.type ?? '',
        date: s.date ?? null,
        dateResolved,
        dateInferred,
        title: s.title ?? null,
        description: s.description ?? null,
        mime: s.mime ?? null,
        url: s.url ?? null,
        stateLink: s.stateLink ?? null,
      }
    }),
    amendments: amendmentRows.map(a => {
      const { dateResolved, dateInferred } = resolveItemDate(a.date, a.description ?? a.title, { yearStart: session?.yearStart, yearEnd: session?.yearEnd })
      return {
        amendmentId:   a.amendmentId,
        adopted:       a.adopted === 1,
        chamber:       a.chamber ?? null,
        date:          a.date ?? null,
        dateResolved,
        dateInferred,
        title:         a.title ?? null,
        description:   a.description ?? null,
        mime:          a.mime ?? null,
        url:           a.url ?? null,
        stateLink:     a.stateLink ?? null,
      }
    }),
    subjects: subjectRows.map(s => s.subjectName),
  })
})

billsLsRoutes.get('/:id/changes', async (c) => {
  const rawId = c.req.param('id')
  const numericId = rawId.startsWith('legiscan:')
    ? parseInt(rawId.split(':')[1], 10)
    : parseInt(rawId, 10)
  if (isNaN(numericId)) return c.json({ error: 'invalid bill id' }, 400)

  const db = drizzle(c.env.DB, { schema })
  const changes = await db
    .select()
    .from(schema.billChangeLog)
    .where(eq(schema.billChangeLog.billId, numericId))
    .orderBy(desc(schema.billChangeLog.detectedAt))
    .limit(50)
    .all()

  return c.json({ changes })
})

billsLsRoutes.get('/:id/text/:docId', async (c) => {
  const rawId = c.req.param('id')
  const numeric = parseInt(rawId.replace('legiscan:', ''), 10)
  if (isNaN(numeric)) return c.json({ error: 'invalid bill id' }, 400)
  const docId = parseInt(c.req.param('docId'), 10)
  if (isNaN(docId)) return c.json({ error: 'invalid doc id' }, 400)

  const db = drizzle(c.env.DB, { schema })

  const text = await db.select({ r2Key: schema.billTexts.r2Key })
    .from(schema.billTexts)
    .where(and(eq(schema.billTexts.billId, numeric), eq(schema.billTexts.docId, docId)))
    .get()

  if (!text?.r2Key) return c.json({ error: 'no text available' }, 404)

  const cacheKey = textCacheKey('inline', text.r2Key)
  const cached = await getCachedText(c.env, cacheKey)
  if (cached) return cached

  const obj = await c.env.BILLS_BUCKET.get(text.r2Key)
  if (!obj) return c.json({ error: 'text not found in storage' }, 404)

  const isPdf = text.r2Key.endsWith('.pdf')
  const contentType = isPdf ? 'application/pdf' : 'text/html; charset=utf-8'
  const res = new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? contentType,
      'Content-Disposition': 'inline',
    },
  })
  c.executionCtx.waitUntil(putCachedText(c.env, cacheKey, res.clone()))
  return res
})

billsLsRoutes.get('/:id/text', async (c) => {
  const rawId = c.req.param('id')
  const numeric = parseInt(rawId.replace('legiscan:', ''), 10)
  if (isNaN(numeric)) return c.json({ error: 'invalid bill id' }, 400)

  const db = drizzle(c.env.DB, { schema })

  const texts = await db.select({ r2Key: schema.billTexts.r2Key, docId: schema.billTexts.docId })
    .from(schema.billTexts)
    .where(eq(schema.billTexts.billId, numeric))
    .all()

  const withKey = texts
    .sort((a, b) => b.docId - a.docId)
    .find(t => t.r2Key)

  if (!withKey?.r2Key) return c.json({ error: 'no text available' }, 404)

  const cacheKey = textCacheKey('json', withKey.r2Key)
  const cached = await getCachedText(c.env, cacheKey)
  if (cached) return cached

  const obj = await c.env.BILLS_BUCKET.get(withKey.r2Key)
  if (!obj) return c.json({ error: 'text not found in storage' }, 404)

  const isPdf = withKey.r2Key.endsWith('.pdf')
  let res: Response
  if (isPdf) {
    // Use Buffer.from for base64 (~250-350x faster than a char-by-char btoa
    // loop on multi-MB PDFs, and avoids ~200 MB of transient heap allocation).
    // Requires nodejs_compat — set in wrangler.toml.
    const buf = await obj.arrayBuffer()
    res = c.json({ type: 'pdf', content: Buffer.from(buf).toString('base64') })
  } else {
    res = c.json({ type: 'html', content: await obj.text() })
  }
  c.executionCtx.waitUntil(putCachedText(c.env, cacheKey, res.clone()))
  return res
})
