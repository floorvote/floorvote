import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, calendarEvents, calendarEventBills } from '../../src/db/schema'

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

describe('calendar feed', () => {
  let token: string
  let priorityBillId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const uid = await seedUser({ email: 'a@b.com' })
    token = await seedSession(uid)
    priorityBillId = await seedBill({ billNumber: 'H 5174', state: 'RI', session: '2026', priority: 'high' })
    const plainBillId = await seedBill({ billNumber: 'H 9999', state: 'RI', session: '2026' })
    await seedCalendarEvent(priorityBillId, { date: isoDay(3), time: '14:00:00', description: 'Cmte on Elections' })
    await seedCalendarEvent(plainBillId, { uid: 'hearing-plain@test', date: isoDay(4) })
  })

  it('GET /api/calendar/info returns slug + urls (authed), idempotently', async () => {
    const r1 = await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })
    expect(r1.status).toBe(200)
    const b1 = await r1.json() as { slug: string; webcalUrl: string; feedUrl: string }
    expect(b1.slug).toMatch(/^[a-z0-9]{16,}$/)
    expect(b1.webcalUrl.startsWith('webcal://')).toBe(true)
    const b2 = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    expect(b2.slug).toBe(b1.slug)
  })

  it('GET /api/calendar/info requires auth', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/info')
    expect(r.status).toBe(401)
  })

  it('public feed returns text/calendar for priority bills only', async () => {
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const r = await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/calendar')
    const body = await r.text()
    expect(body).toContain('BEGIN:VCALENDAR')
    expect(body).toContain('Cmte on Elections')
    expect(body).not.toContain('hearing-plain')
  })

  it('hearing event URL uses canonical /STATE/SESSION/BILL form (not /bills/:id)', async () => {
    // priorityBillId seeded with state='RI', session='2026', billNumber='H 5174'
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    // Should use canonical path with percent-encoded space, not /bills/<uuid>
    expect(body).toContain('/RI/2026/H%205174')
    expect(body).not.toContain('/RI/2026/H 5174')
    expect(body).not.toMatch(/URL:https:\/\/localhost\/bills\/[0-9a-f-]{36}/)
  })

  it('custom event with no linked bill falls back to /calendar URL', async () => {
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(), uid: 'custom-nolink@t', billId: null, source: 'custom',
      sequence: 0, date: isoDay(7), time: null, location: null,
      description: 'Board Meeting', status: 'confirmed', eventHash: null,
    })
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(body).toContain('Board Meeting')
    expect(body).toContain('URL:https://localhost/calendar')
  })

  it('feed 404s on an unknown slug', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/feed/deadbeefdeadbeef.ics')
    expect(r.status).toBe(404)
  })

  it('excludes confirmed hearings older than the 7-day backward window', async () => {
    const oldBill = await seedBill({ billNumber: 'H OLD', state: 'RI', session: '2026', priority: 'high' })
    await seedCalendarEvent(oldBill, { uid: 'hearing-old@test', date: isoDay(-30), description: 'Old Hearing' })
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(body).not.toContain('Old Hearing')
    expect(body).toContain('Cmte on Elections') // the near-future one still shows
  })

  it('includes a cancelled hearing within the 2-day grace but not an old one', async () => {
    const b = await seedBill({ billNumber: 'H CXL', state: 'RI', session: '2026', priority: 'high' })
    await seedCalendarEvent(b, { uid: 'hearing-cxl-recent@test', date: isoDay(-1), status: 'cancelled', description: 'Recent Cancelled' })
    await seedCalendarEvent(b, { uid: 'hearing-cxl-old@test', date: isoDay(-10), status: 'cancelled', description: 'Old Cancelled' })
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(body).toContain('Recent Cancelled')
    expect(body).not.toContain('Old Cancelled')
  })

  it('uses the JSON-decoded association name (no literal quotes) in X-WR-CALNAME', async () => {
    await getDb(env.DB).insert(associationConfig).values({ key: 'association_name', value: JSON.stringify('Acme Clerks') })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify('Acme Clerks') } })
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(body).toContain('X-WR-CALNAME:Acme Clerks — Tracked Hearings')
    expect(body).not.toContain('"Acme Clerks"')
  })

  it('includes standalone custom events in the feed', async () => {
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(), uid: 'custom-feed@t', billId: null, source: 'custom',
      sequence: 0, date: isoDay(5), time: '17:30:00', location: 'Zoom',
      description: 'Association board meeting', status: 'confirmed', eventHash: null,
    })
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(body).toContain('Association board meeting')
    expect(body).toContain('custom-feed@t')
  })

  it('ICS feed includes DESCRIPTION and URL for a custom event with details + url', async () => {
    const db = getDb(env.DB)
    const billId = await seedBill({ billNumber: 'HB 55', state: 'RI', session: '2026', priority: 'high' })
    const evId = crypto.randomUUID()
    const evUid = 'custom-desc-url@test'
    await db.insert(calendarEvents).values({
      id: evId, uid: evUid, billId: null, source: 'custom',
      sequence: 0, date: isoDay(6), time: null, location: null,
      description: 'Filing Deadline',
      details: 'Candidate filing period ends',
      url: 'https://sos.example.gov/filing',
      status: 'confirmed', eventHash: null,
    })
    await db.insert(calendarEventBills).values([{ eventId: evId, billId }])
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(body).toContain('DESCRIPTION:')
    expect(body).toContain('Candidate filing period ends')
    expect(body).toContain('URL:https://sos.example.gov/filing')
  })

  it('lists all linked bill numbers in a multi-bill custom event summary', async () => {
    const db = getDb(env.DB)
    const b1 = await seedBill({ billNumber: 'H 7', state: 'RI', session: '2026', priority: 'low' })
    const b2 = await seedBill({ billNumber: 'H 8', state: 'RI', session: '2026', priority: 'low' })
    const evId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: evId, uid: 'custom-multi@t', billId: null, source: 'custom',
      sequence: 0, date: isoDay(3), time: null, location: null,
      description: 'Markup', status: 'confirmed', eventHash: null,
    })
    await db.insert(calendarEventBills).values([{ eventId: evId, billId: b1 }, { eventId: evId, billId: b2 }])
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    const body = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(body).toContain('H 7')
    expect(body).toContain('H 8')
    expect(body).toContain('Markup')
  })
})

describe('PATCH /api/bills/:id/priority', () => {
  it('returns 200 and sets priority even when backfill central call fails (fire-and-forget)', async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ email: 'admin@patch.com', role: 'admin' })
    const adminToken = await seedSession(adminId)
    const billId = await seedBill({ billNumber: 'H 100', state: 'RI', session: '2026', externalId: 'legiscan:100' })
    const r = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    expect(r.status).toBe(200)
    const b = await r.json() as { priority: string }
    expect(b.priority).toBe('high')
  })
})

describe('calendar backfill', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('parseLegiScanId parses legiscan ids and rejects others', async () => {
    const { parseLegiScanId } = await import('../../src/lib/calendarBackfill')
    expect(parseLegiScanId('legiscan:501')).toBe(501)
    expect(parseLegiScanId('ocd-bill/abc')).toBeNull()
    expect(parseLegiScanId(null)).toBeNull()
    expect(parseLegiScanId('legiscan:0')).toBeNull()
  })

  it('collectPriorityLegiscanIds returns numeric legiscan ids of priority bills only', async () => {
    const { collectPriorityLegiscanIds } = await import('../../src/lib/calendarBackfill')
    await seedBill({ billNumber: 'H1', state: 'RI', session: '2026', externalId: 'legiscan:501', priority: 'high' })
    await seedBill({ billNumber: 'H2', state: 'RI', session: '2026', externalId: 'legiscan:502' }) // no priority
    const ids = await collectPriorityLegiscanIds(getDb(env.DB))
    expect(ids).toEqual([501])
  })

  it('POST /api/calendar/backfill requires admin and returns queued count', async () => {
    const adminId = await seedUser({ email: 'admin@b.com', role: 'admin' })
    const adminToken = await seedSession(adminId)
    await seedBill({ billNumber: 'H1', state: 'RI', session: '2026', externalId: 'legiscan:501', priority: 'high' })
    const r = await SELF.fetch('http://localhost/api/calendar/backfill', { method: 'POST', headers: { Cookie: `session=${adminToken}` } })
    expect(r.status).toBe(202)
    const b = await r.json() as { ok: boolean; queued: number }
    expect(b.ok).toBe(true)
    expect(b.queued).toBe(1)

    const memberId = await seedUser({ email: 'member@b.com', role: 'member' })
    const memberToken = await seedSession(memberId)
    const r2 = await SELF.fetch('http://localhost/api/calendar/backfill', { method: 'POST', headers: { Cookie: `session=${memberToken}` } })
    expect(r2.status).toBe(403)
  })
})
