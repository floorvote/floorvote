import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, calendarEvents, calendarEventBills, billCustomFieldValues, customFieldDefinitions } from '../../src/db/schema'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { resetMail, lastBatch } from '../mail'

// The 30-event cap (#675) leaves prioritized, custom, hearing, and date-field
// events alone, so a week heavy in those could still pass Gmail's ~102 KB clip.
// The email truncates long details (never the calendar's), then drops events,
// prioritized-bill ones last, and counts them in the "and N more" line (#774).

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const GMAIL_CLIP_BYTES = 102 * 1024
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const OVERFLOW = /and (\d+) more on the calendar/
const LONG_DETAILS = (tag: string) => `Agenda ${tag}: ` + 'a long paragraph of committee background and testimony notes. '.repeat(60) + `ENDMARK-${tag}`

let token: string
let userId: string

beforeEach(async () => {
  await clearDb()
  userId = await seedUser({ email: 'member@b.com', role: 'admin' })
  token = await seedSession(userId)
  const weekday = String(new Date().getUTCDay())
  await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
  resetMail()
})

async function emailed(): Promise<string> {
  await runWeekAhead(env as any, getDb(env.DB))
  return lastBatch()?.[0].html ?? ''
}

async function seedCustom(from: number, to: number) {
  const db = getDb(env.DB)
  for (let i = from; i < to; i++) {
    await db.insert(calendarEvents).values({
      id: `cust-${i}`, uid: `cust-${i}@test`, billId: null, source: 'custom', sequence: 0,
      date: isoDay(1 + (i % 5)), time: `${String(8 + (i % 10)).padStart(2, '0')}:00:00`,
      description: `Custom event ${String(i).padStart(3, '0')}`, status: 'confirmed',
      location: `Conference Room ${i}, 100 Capitol Way`, url: `https://example.org/events/${i}`,
      details: LONG_DETAILS(`c${i}`),
    })
  }
}

async function seedHearings(n: number) {
  for (let i = 0; i < n; i++) {
    const billId = await seedBill({ billNumber: `HB ${900 + i}`, state: 'DC', priority: 'high', externalId: `legiscan:h${i}` })
    await seedCalendarEvent(billId, {
      date: isoDay(1 + (i % 5)), time: `${String(8 + (i % 10)).padStart(2, '0')}:15:00`,
      description: `Prioritized hearing ${String(i).padStart(3, '0')}`,
      location: `Hearing Room ${i}`, eventHash: `hh-${i}`,
    })
  }
}

async function seedFieldEvents(n: number) {
  const db = getDb(env.DB)
  await db.insert(customFieldDefinitions).values({ id: 'f1', name: 'Comment deadline', type: 'date', displayOrder: 0 })
  for (let i = 0; i < n; i++) {
    const billId = await seedBill({ billNumber: `SB ${i}`, state: 'DC', priority: 'low', externalId: `legiscan:f${i}` })
    await db.insert(billCustomFieldValues).values({ billId, fieldId: 'f1', value: isoDay(1 + (i % 5)), setBy: userId })
  }
}

async function seedBodyWithPriority(n: number) {
  const db = getDb(env.DB)
  for (let i = 0; i < n; i++) {
    const id = `body-p-${i}`
    await db.insert(calendarEvents).values({
      id, uid: `${id}@test`, billId: null, source: 'body', sequence: 0, date: isoDay(1 + (i % 5)),
      time: `${String(8 + (i % 10)).padStart(2, '0')}:45:00`, description: `Body priority ${String(i).padStart(3, '0')}`,
      status: 'confirmed', ruleMatch: null, details: LONG_DETAILS(`b${i}`), location: `Room ${i}`,
    })
    const billId = await seedBill({ billNumber: `HB ${500 + i}`, state: 'DC', priority: 'high', externalId: `legiscan:b${i}` })
    await db.insert(calendarEventBills).values({ eventId: id, billId })
  }
}

describe('the week-ahead email, bounded for every event kind (#774)', () => {
  it('stays under Gmail\'s clip, in bytes, for a week of many prioritized, custom, hearing, and date-field events', async () => {
    await seedCustom(0, 150)
    await seedHearings(60)
    await seedFieldEvents(60)
    await seedBodyWithPriority(60)
    const html = await emailed()
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(GMAIL_CLIP_BYTES)
    expect(html).toContain('Manage email settings')
    expect(html).toContain('Subscribe to your calendar')
    expect(html).toMatch(OVERFLOW)
  })

  it('truncates long details in the email, not on the calendar', async () => {
    await seedCustom(0, 1)
    const html = await emailed()
    expect(html).toContain('Agenda c0: ')
    expect(html).not.toContain('ENDMARK-c0')
    expect(html).toContain('…')
    const r = await SELF.fetch(`http://localhost/api/calendar/events?from=${isoDay(0)}&to=${isoDay(7)}`, { headers: { Cookie: `session=${token}` } })
    const rows = await r.json() as { id: string; details: string | null }[]
    expect(rows.find(e => e.id === 'cust-0')!.details).toContain('ENDMARK-c0')
  })

  it('leaves short details whole', async () => {
    await getDb(env.DB).insert(calendarEvents).values({ id: 'c-short', uid: 'c-short@test', billId: null, source: 'custom', sequence: 0, date: isoDay(2), description: 'Short one', status: 'confirmed', details: 'Bring the printed packet.' })
    const html = await emailed()
    expect(html).toContain('Bring the printed packet.')
    expect(html).not.toContain('…')
  })

  it('drops other kinds before any event with a prioritized bill', async () => {
    await seedHearings(20)
    await seedBodyWithPriority(20)
    await seedCustom(0, 150)
    const html = await emailed()
    expect(html).toMatch(OVERFLOW)
    expect(html.match(/Prioritized hearing \d{3}/g) ?? []).toHaveLength(20)
    expect(html.match(/Body priority \d{3}/g) ?? []).toHaveLength(20)
    expect((html.match(/Custom event \d{3}/g) ?? []).length).toBeLessThan(150)
  })

  it('counts every event left out in the "and N more" line, so the summary adds up', async () => {
    await seedCustom(0, 200)
    const html = await emailed()
    const listed = (html.match(/Custom event \d{3}/g) ?? []).length
    const omitted = Number(html.match(OVERFLOW)![1])
    expect(listed).toBeLessThan(200)
    expect(listed + omitted).toBe(200)
    expect(html).toContain('200 events in the week ahead')
  })

  it('still sends one event that alone is over the budget', async () => {
    await getDb(env.DB).insert(calendarEvents).values({ id: 'c-huge', uid: 'c-huge@test', billId: null, source: 'custom', sequence: 0, date: isoDay(2), description: 'Huge ' + 'x'.repeat(200_000), status: 'confirmed' })
    const html = await emailed()
    expect(html).toContain('Huge ')
    expect(html).toContain('Manage email settings')
    expect(html).not.toMatch(OVERFLOW)
  })

  it('does not split an emoji when it truncates details', async () => {
    // No spaces, so the cut lands on the 300th UTF-16 unit, inside the emoji's pair.
    await getDb(env.DB).insert(calendarEvents).values({ id: 'c-emoji', uid: 'c-emoji@test', billId: null, source: 'custom', sequence: 0, date: isoDay(2), description: 'Emoji one', status: 'confirmed', details: 'x'.repeat(299) + '\u{1F600}' + 'y'.repeat(50) })
    const html = await emailed()
    expect(html).toContain('…')
    // A boolean, so a failure doesn't print the lone surrogate, which crashes the worker's socket.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(html)).toBe(false)
  })

  it('adds no overflow line when the week fits', async () => {
    await seedCustom(0, 5)
    const html = await emailed()
    expect(html).not.toMatch(OVERFLOW)
    expect(html.match(/Custom event \d{3}/g) ?? []).toHaveLength(5)
  })
})
