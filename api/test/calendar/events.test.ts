import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { calendarEvents, calendarEventBills } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

type BillChip = { billNumber: string; state: string | null; priority: string | null }
type EventRow = {
  id: string; uid: string; source: string; billId: string | null
  date: string | null; time: string | null
  location: string | null; description: string | null; status: string
  bills: BillChip[]
}

describe('GET /api/calendar/events', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const uid = await seedUser({ email: 'a@b.com' })
    token = await seedSession(uid)

    const priorityBill = await seedBill({ billNumber: 'H 100', state: 'RI', session: '2026', priority: 'high' })
    const plainBill = await seedBill({ billNumber: 'H 200', state: 'RI', session: '2026' })
    await seedCalendarEvent(priorityBill, { uid: 'h-prio@t', date: isoDay(3), description: 'Elections Cmte' })
    await seedCalendarEvent(plainBill, { uid: 'h-plain@t', date: isoDay(4), description: 'Other Cmte' })
    // a standalone custom event (no bill)
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(), uid: 'custom-1@t', billId: null, source: 'custom',
      sequence: 0, date: isoDay(5), time: '17:30:00', location: 'Zoom',
      description: 'Board meeting', status: 'confirmed', eventHash: null,
    })
  })

  it('requires auth', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/events')
    expect(r.status).toBe(401)
  })

  it('returns priority hearings + custom events, excludes non-priority hearings', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/events', { headers: { Cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const rows = await r.json() as EventRow[]
    const uids = rows.map(e => e.uid).sort()
    expect(uids).toEqual(['custom-1@t', 'h-prio@t'])
    const custom = rows.find(e => e.uid === 'custom-1@t')!
    expect(custom.source).toBe('custom')
    expect(custom.billId).toBeNull()
    expect(custom.description).toBe('Board meeting')
    const hearing = rows.find(e => e.uid === 'h-prio@t')!
    expect(hearing.bills).toHaveLength(1)
    expect(hearing.bills[0].billNumber).toBe('H 100')
    expect(hearing.bills[0].priority).toBe('high')
  })

  it('honors from/to window params — out-of-window returns empty', async () => {
    const from = isoDay(10), to = isoDay(20)
    const r = await SELF.fetch(`http://localhost/api/calendar/events?from=${from}&to=${to}`, { headers: { Cookie: `session=${token}` } })
    const rows = await r.json() as EventRow[]
    expect(rows).toHaveLength(0)
  })

  it('honors from/to window params — in-window returns matching events', async () => {
    // seeded events are at isoDay(3), isoDay(5); use a window that covers both
    const from = isoDay(2), to = isoDay(6)
    const r = await SELF.fetch(`http://localhost/api/calendar/events?from=${from}&to=${to}`, { headers: { Cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const rows = await r.json() as EventRow[]
    // priority hearing at day+3 and custom event at day+5 both fall inside [day+2, day+6]
    const uids = rows.map(e => e.uid).sort()
    expect(uids).toEqual(['custom-1@t', 'h-prio@t'])
  })

  it('treats empty or malformed from/to as default window', async () => {
    // all three seeded events are within default window; bad params should not break the query
    const r1 = await SELF.fetch(`http://localhost/api/calendar/events?to=`, { headers: { Cookie: `session=${token}` } })
    expect(r1.status).toBe(200)
    const rows1 = await r1.json() as EventRow[]
    const uids1 = rows1.map(e => e.uid).sort()
    expect(uids1).toEqual(['custom-1@t', 'h-prio@t'])

    const r2 = await SELF.fetch(`http://localhost/api/calendar/events?from=garbage`, { headers: { Cookie: `session=${token}` } })
    expect(r2.status).toBe(200)
    const rows2 = await r2.json() as EventRow[]
    const uids2 = rows2.map(e => e.uid).sort()
    expect(uids2).toEqual(['custom-1@t', 'h-prio@t'])
  })

  it('returns a bills[] array per event (multi-bill for custom, single for hearings)', async () => {
    const db = getDb(env.DB)
    const b1 = await seedBill({ billNumber: 'S 10', state: 'RI', session: '2026', priority: 'low' })
    const b2 = await seedBill({ billNumber: 'S 11', state: 'RI', session: '2026', priority: 'medium' })
    const evId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: evId, uid: 'custom-multi@t', billId: null, source: 'custom',
      sequence: 0, date: isoDay(6), time: null, location: null,
      description: 'Joint session', status: 'confirmed', eventHash: null,
    })
    await db.insert(calendarEventBills).values([
      { eventId: evId, billId: b1 }, { eventId: evId, billId: b2 },
    ])

    const r = await SELF.fetch('http://localhost/api/calendar/events', { headers: { Cookie: `session=${token}` } })
    const rows = await r.json() as Array<{ id: string; bills: Array<{ billNumber: string; state: string | null; priority: string | null }> }>

    const multi = rows.find(e => e.id === evId)!
    expect(multi.bills.map(b => b.billNumber).sort()).toEqual(['S 10', 'S 11'])
    expect(multi.bills.every(b => b.state === 'RI')).toBe(true)

    const hearing = rows.find(e => e.bills.some(b => b.billNumber === 'H 100'))!
    expect(hearing.bills).toHaveLength(1)
  })

  it('merges hearing rows that share date|time|description|location into one event with all bills', async () => {
    const b1 = await seedBill({ billNumber: 'S 2136', state: 'RI', session: '2026', priority: 'high' })
    const b2 = await seedBill({ billNumber: 'H 7377', state: 'RI', session: '2026', priority: 'medium' })
    // Two separate hearing rows (one per bill) for the SAME real hearing.
    await seedCalendarEvent(b1, { uid: 'sj-s2136@t', date: isoDay(8), time: '10:00:00', location: 'Room 313', description: 'Senate Judiciary Consideration', eventHash: 'eh-a' })
    await seedCalendarEvent(b2, { uid: 'sj-h7377@t', date: isoDay(8), time: '10:00:00', location: 'Room 313', description: 'Senate Judiciary Consideration', eventHash: 'eh-b' })

    const r = await SELF.fetch('http://localhost/api/calendar/events', { headers: { Cookie: `session=${token}` } })
    const rows = await r.json() as Array<EventRow & { eventHash: string | null; eventHashes: string[] }>

    const judiciary = rows.filter(e => e.description === 'Senate Judiciary Consideration')
    // Collapsed to a single entry...
    expect(judiciary).toHaveLength(1)
    // ...holding both bills...
    expect(judiciary[0].bills.map(b => b.billNumber).sort()).toEqual(['H 7377', 'S 2136'])
    // ...and carrying both event_hashes so the sidebar deep-link resolves either one.
    expect(judiciary[0].eventHashes.sort()).toEqual(['eh-a', 'eh-b'])
  })

  it('does NOT merge custom events that happen to share date/time/description', async () => {
    const db = getDb(env.DB)
    for (const n of ['c-dup-1@t', 'c-dup-2@t']) {
      await db.insert(calendarEvents).values({
        id: crypto.randomUUID(), uid: n, billId: null, source: 'custom', sequence: 0,
        date: isoDay(9), time: '09:00:00', location: 'HQ', description: 'Standup', status: 'confirmed', eventHash: null,
      })
    }
    const r = await SELF.fetch('http://localhost/api/calendar/events', { headers: { Cookie: `session=${token}` } })
    const rows = await r.json() as EventRow[]
    const standups = rows.filter(e => e.description === 'Standup')
    expect(standups.map(e => e.uid).sort()).toEqual(['c-dup-1@t', 'c-dup-2@t'])
  })

  it('filters cancelled events with grace window', async () => {
    const db = getDb(env.DB)
    // future cancelled event — should appear (within grace, since it's in the future)
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(), uid: 'cancelled-future@t', billId: null, source: 'custom',
      sequence: 1, date: isoDay(5), time: null, location: null,
      description: 'Cancelled future', status: 'cancelled', eventHash: null,
    })
    // stale cancelled event 10 days in the past — should NOT appear
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(), uid: 'cancelled-old@t', billId: null, source: 'custom',
      sequence: 1, date: isoDay(-10), time: null, location: null,
      description: 'Cancelled old', status: 'cancelled', eventHash: null,
    })
    const r = await SELF.fetch('http://localhost/api/calendar/events', { headers: { Cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const rows = await r.json() as EventRow[]
    const uids = rows.map(e => e.uid).sort()
    expect(uids).toContain('cancelled-future@t')
    expect(uids).not.toContain('cancelled-old@t')
  })
})

describe('GET /api/calendar/bill-options', () => {
  let token: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const uid = await seedUser({ email: 'a@b.com' }); token = await seedSession(uid)
    await seedBill({ billNumber: 'H 100', state: 'RI', session: '2026', matchType: 'keyword' })
    await seedBill({ billNumber: 'H 200', state: 'RI', session: '2026', matchType: null }) // lightweight stub
  })
  it('requires auth', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/bill-options')
    expect(r.status).toBe(401)
  })
  it('returns tracked bills only (matchType set)', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/bill-options', { headers: { Cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const rows = await r.json() as Array<{ id: string; billNumber: string; title: string }>
    expect(rows.map(b => b.billNumber)).toEqual(['H 100'])
  })
})

describe('POST /api/calendar/events', () => {
  let adminToken: string, memberToken: string, billId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const admin = await seedUser({ email: 'admin@b.com', role: 'admin' }); adminToken = await seedSession(admin)
    const member = await seedUser({ email: 'm@b.com', role: 'member' }); memberToken = await seedSession(member)
    billId = await seedBill({ billNumber: 'H 100', state: 'RI', session: '2026', matchType: 'manual' })
  })

  it('rejects non-admins', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST', headers: { Cookie: `session=${memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'X', date: '2026-07-01' }),
    })
    expect(r.status).toBe(403)
  })

  it('creates a custom event with source=custom and a uid', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST', headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Board meeting', date: '2026-07-01', time: '17:30', location: 'Zoom', billIds: [billId] }),
    })
    expect(r.status).toBe(201)
    const ev = await r.json() as { id: string; source: string; uid: string; billIds: string[] }
    expect(ev.source).toBe('custom')
    expect(ev.uid).toMatch(/@/)
    expect(ev.billIds).toEqual([billId])
  })

  it('requires a description and a date', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST', headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: '', date: '' }),
    })
    expect(r.status).toBe(400)
  })
})

describe('POST /api/calendar/events — billIds[]', () => {
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
  })

  it('POST accepts billIds[] and links them via the join table', async () => {
    const db = getDb(env.DB)
    const b1 = await seedBill({ billNumber: 'A 1', state: 'RI', session: '2026', priority: 'low' })
    const b2 = await seedBill({ billNumber: 'A 2', state: 'RI', session: '2026', priority: 'low' })
    const adminUid = await seedUser({ email: 'admin@b.com', role: 'admin' })
    const adminToken = await seedSession(adminUid)

    const r = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Caucus', date: isoDay(8), billIds: [b1, b2] }),
    })
    expect(r.status).toBe(201)
    const created = await r.json() as { id: string; billIds: string[] }
    expect(created.billIds.sort()).toEqual([b1, b2].sort())

    const links = await db.select().from(calendarEventBills).where(eq(calendarEventBills.eventId, created.id)).all()
    expect(links).toHaveLength(2)
  })
})

describe('PUT /api/calendar/events/:id', () => {
  let adminToken: string, customId: string, hearingId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const admin = await seedUser({ email: 'admin@b.com', role: 'admin' }); adminToken = await seedSession(admin)
    const billId = await seedBill({ billNumber: 'H 100', state: 'RI', session: '2026', priority: 'high' })
    hearingId = await seedCalendarEvent(billId, { uid: 'h@t' })
    const db = getDb(env.DB)
    customId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: customId, uid: 'c@t', billId: null, source: 'custom', sequence: 0,
      date: '2026-07-01', time: null, location: null, description: 'Old title', status: 'confirmed', eventHash: null,
    })
  })

  it('edits a custom event and bumps sequence', async () => {
    const r = await SELF.fetch(`http://localhost/api/calendar/events/${customId}`, {
      method: 'PUT', headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'New title', date: '2026-07-02' }),
    })
    expect(r.status).toBe(200)
    const db = getDb(env.DB)
    const row = await db.select().from(calendarEvents).where(eq(calendarEvents.id, customId)).get()
    expect(row?.description).toBe('New title')
    expect(row?.sequence).toBe(1)
  })

  it('refuses to edit a hearing row (404)', async () => {
    const r = await SELF.fetch(`http://localhost/api/calendar/events/${hearingId}`, {
      method: 'PUT', headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'hax', date: '2026-07-02' }),
    })
    expect(r.status).toBe(404)
  })
})

describe('DELETE /api/calendar/events/:id', () => {
  let adminToken: string, customId: string, hearingId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const admin = await seedUser({ email: 'admin@b.com', role: 'admin' }); adminToken = await seedSession(admin)
    const billId = await seedBill({ billNumber: 'H 100', state: 'RI', session: '2026', priority: 'high' })
    hearingId = await seedCalendarEvent(billId, { uid: 'h@t' })
    const db = getDb(env.DB)
    customId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: customId, uid: 'c@t', billId: null, source: 'custom', sequence: 2,
      date: '2026-07-01', time: null, location: null, description: 'Meeting', status: 'confirmed', eventHash: null,
    })
  })

  it('soft-cancels a custom event (status=cancelled, sequence bumped)', async () => {
    const r = await SELF.fetch(`http://localhost/api/calendar/events/${customId}`, {
      method: 'DELETE', headers: { Cookie: `session=${adminToken}` },
    })
    expect(r.status).toBe(200)
    const db = getDb(env.DB)
    const row = await db.select().from(calendarEvents).where(eq(calendarEvents.id, customId)).get()
    expect(row?.status).toBe('cancelled')
    expect(row?.sequence).toBe(3)
  })

  it('refuses to cancel a hearing row (404)', async () => {
    const r = await SELF.fetch(`http://localhost/api/calendar/events/${hearingId}`, {
      method: 'DELETE', headers: { Cookie: `session=${adminToken}` },
    })
    expect(r.status).toBe(404)
  })
})

describe('POST /api/calendar/events/:id/restore', () => {
  let adminToken: string, customId: string

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const admin = await seedUser({ email: 'admin@b.com', role: 'admin' }); adminToken = await seedSession(admin)
    const db = getDb(env.DB)
    customId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: customId, uid: 'restore-test@t', billId: null, source: 'custom', sequence: 3,
      date: '2026-07-01', time: null, location: null, description: 'Board mtg', status: 'cancelled', eventHash: null,
    })
  })

  it('restores a cancelled custom event to confirmed', async () => {
    // POST create → DELETE → POST restore full cycle
    const createRes = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST', headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Board mtg', date: '2026-07-01' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { id: string }
    const id = created.id

    const deleteRes = await SELF.fetch(`http://localhost/api/calendar/events/${id}`, {
      method: 'DELETE', headers: { Cookie: `session=${adminToken}` },
    })
    expect(deleteRes.status).toBe(200)

    // Verify cancelled
    const db = getDb(env.DB)
    const afterDelete = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
    expect(afterDelete?.status).toBe('cancelled')

    const restoreRes = await SELF.fetch(`http://localhost/api/calendar/events/${id}/restore`, {
      method: 'POST', headers: { Cookie: `session=${adminToken}` },
    })
    expect(restoreRes.status).toBe(200)
    const body = await restoreRes.json() as { id: string; status: string }
    expect(body.id).toBe(id)
    expect(body.status).toBe('confirmed')

    // Verify DB row
    const afterRestore = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
    expect(afterRestore?.status).toBe('confirmed')
  })

  it('restores a pre-seeded cancelled event (status=confirmed, sequence bumped)', async () => {
    const r = await SELF.fetch(`http://localhost/api/calendar/events/${customId}/restore`, {
      method: 'POST', headers: { Cookie: `session=${adminToken}` },
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { id: string; status: string }
    expect(body.id).toBe(customId)
    expect(body.status).toBe('confirmed')

    const db = getDb(env.DB)
    const row = await db.select().from(calendarEvents).where(eq(calendarEvents.id, customId)).get()
    expect(row?.status).toBe('confirmed')
    expect(row?.sequence).toBe(4) // was 3, bumped to 4
  })

  it('restored event appears in GET /api/calendar/events as confirmed', async () => {
    const restoreRes = await SELF.fetch(`http://localhost/api/calendar/events/${customId}/restore`, {
      method: 'POST', headers: { Cookie: `session=${adminToken}` },
    })
    expect(restoreRes.status).toBe(200)

    const listRes = await SELF.fetch('http://localhost/api/calendar/events', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(listRes.status).toBe(200)
    const rows = await listRes.json() as Array<{ id: string; status: string }>
    const found = rows.find(e => e.id === customId)
    expect(found).toBeDefined()
    expect(found!.status).toBe('confirmed')
  })

  it('returns 404 for an unknown id', async () => {
    const r = await SELF.fetch(`http://localhost/api/calendar/events/${crypto.randomUUID()}/restore`, {
      method: 'POST', headers: { Cookie: `session=${adminToken}` },
    })
    expect(r.status).toBe(404)
  })

  it('rejects non-admins with 403', async () => {
    const member = await seedUser({ email: 'm@b.com', role: 'member' })
    const memberToken = await seedSession(member)
    const r = await SELF.fetch(`http://localhost/api/calendar/events/${customId}/restore`, {
      method: 'POST', headers: { Cookie: `session=${memberToken}` },
    })
    expect(r.status).toBe(403)
  })
})

describe('custom event details/url', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const admin = await seedUser({ email: 'admin@b.com', role: 'admin' }); adminToken = await seedSession(admin)
  })

  // isoDay, not a literal date: this is the only test in the block that reads the
  // event back from `GET /events`, which windows to [today-90d, today+365d]. With
  // the literal '2026-05-14' it passed until 2026-08-12 and failed from 2026-08-13,
  // when the event fell one day out of the window — a time bomb, not a route bug.
  // Any test that round-trips through the list must date its event relatively.
  it('persists and returns details and url', async () => {
    const eventDay = isoDay(1)
    const r = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'Filing period', date: eventDay,
        details: 'Through May 29\nStatute: W.S. 22-5-209', url: 'https://sos.example.gov',
      }),
    })
    expect(r.status).toBe(201)
    const created = await r.json() as any
    expect(created.details).toContain('Through May 29')
    expect(created.url).toBe('https://sos.example.gov')

    const listRes = await SELF.fetch('http://localhost/api/calendar/events', {
      headers: { Cookie: `session=${adminToken}` },
    })
    const list = await listRes.json() as any[]
    const found = list.find((e: any) => e.id === created.id)
    expect(found.details).toContain('Statute')
    expect(found.url).toBe('https://sos.example.gov')
  })

  it('rejects a non-http url', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x', date: '2026-05-14', url: 'javascript:alert(1)' }),
    })
    expect(r.status).toBe(400)
  })

  it('PUT preserves details and url on update', async () => {
    const createRes = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'Filing period', date: '2026-05-14',
        details: 'Original details', url: 'https://sos.example.gov',
      }),
    })
    const created = await createRes.json() as any

    const updateRes = await SELF.fetch(`http://localhost/api/calendar/events/${created.id}`, {
      method: 'PUT',
      headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'Filing period updated', date: '2026-05-15',
        details: 'Updated details', url: 'https://updated.example.gov',
      }),
    })
    expect(updateRes.status).toBe(200)
    const updated = await updateRes.json() as any
    expect(updated.details).toBe('Updated details')
    expect(updated.url).toBe('https://updated.example.gov')
  })

  it('PUT rejects a non-http url', async () => {
    const createRes = await SELF.fetch('http://localhost/api/calendar/events', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x', date: '2026-05-14' }),
    })
    const created = await createRes.json() as any

    const r = await SELF.fetch(`http://localhost/api/calendar/events/${created.id}`, {
      method: 'PUT',
      headers: { Cookie: `session=${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x', date: '2026-05-14', url: 'data:text/html,<h1>xss</h1>' }),
    })
    expect(r.status).toBe(400)
  })
})
