import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, calendarEventBills, calendarEvents } from '../../src/db/schema'
import { splitFromGroup } from '../../src/lib/companionGroups'

// Companion groups on the calendar (#381). Hearings are real meetings in
// different chambers, so each member's hearing stays its own entry, labeled by
// its bill. What changes is that the team's priority is the group's (a hearing
// on a member with no priority of its own still shows), and the popover is told
// which groups the entry's bills belong to so it can link to them.

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

type Group = { key: string; bills: Array<{ id: string; billNumber: string; state: string | null; sessionSlug: string | null }> }
type Entry = {
  id: string; source: string; time: string | null; location: string | null; description: string | null
  bills: Array<{ id: string; billNumber: string; priority: string | null; isDraft: boolean }>
  groups: Group[]
}

describe('calendar: companion groups', () => {
  let token: string
  let adminId: string
  const db = () => getDb(env.DB)

  async function events(): Promise<Entry[]> {
    const res = await SELF.fetch(`http://localhost/api/calendar/events?from=${isoDay(-30)}&to=${isoDay(60)}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return await res.json() as Entry[]
  }
  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }
  async function icsBody() {
    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
    return await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
  }
  const numbersOf = (e: Entry) => e.bills.map(b => b.billNumber)

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'ada@example.com' })
    token = await seedSession(adminId)
    // Ids sort a < b < c, so a group's key is its first bill's id.
    await seedBill({ id: 'a-house', billNumber: 'H 101', state: 'RI', session: '2026', sessionSlug: '2026rs', priority: 'high' })
    await seedBill({ id: 'b-senate', billNumber: 'S 202', state: 'RI', session: '2026', sessionSlug: '2026rs' })
    await seedBill({ id: 'c-alone', billNumber: 'H 303', state: 'RI', session: '2026' })
  })

  it('keeps both members\' hearings on the same day as separate entries, each labeled by its own bill', async () => {
    await group('a-house', 'b-senate')
    await seedCalendarEvent('a-house', { uid: 'h-1@test', date: isoDay(3), time: '09:00:00', location: 'House Room 1', description: 'House Cmte', eventHash: 'e1' })
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), time: '14:00:00', location: 'Senate Room 2', description: 'Senate Cmte', eventHash: 'e2' })

    const hearings = (await events()).filter(e => e.source === 'hearing')
    expect(hearings).toHaveLength(2)
    expect(hearings.map(numbersOf).sort()).toEqual([['H 101'], ['S 202']])
  })

  it('tells each entry which group its bills belong to, with every member of it', async () => {
    await group('a-house', 'b-senate')
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), description: 'Senate Cmte' })

    const [entry] = (await events()).filter(e => e.source === 'hearing')
    expect(entry.groups).toHaveLength(1)
    expect(entry.groups[0].key).toBe('a-house')
    // Members with no hearing of their own are in it too, so the popover can link to each.
    expect(entry.groups[0].bills.map(b => b.billNumber).sort()).toEqual(['H 101', 'S 202'])
    expect(entry.groups[0].bills.find(b => b.billNumber === 'S 202')).toMatchObject({ id: 'b-senate', state: 'RI' })
  })

  it('gives each member its session slug, so the popover can link to the canonical bill URL', async () => {
    await group('a-house', 'b-senate')
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), description: 'Senate Cmte' })

    const [entry] = (await events()).filter(e => e.source === 'hearing')
    expect(entry.groups[0].bills.map(b => b.sessionSlug)).toEqual(['2026rs', '2026rs'])
  })

  it('counts a member\'s hearing in the upcoming total when only a companion has the priority', async () => {
    await group('a-house', 'b-senate')
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), description: 'Senate Cmte' })
    const stats = async () => (await (await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })).json() as { calendarUpcomingCount: number }).calendarUpcomingCount
    expect(await stats()).toBe(1)
    // An ungrouped bill with no priority is still left out.
    await seedCalendarEvent('c-alone', { uid: 'c-1@test', date: isoDay(4), description: 'Lone Cmte' })
    expect(await stats()).toBe(1)
  })

  it('shows a hearing on a member with no priority of its own when the group has one, under the group\'s priority', async () => {
    await group('a-house', 'b-senate')
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), description: 'Senate Cmte' })

    const hearings = (await events()).filter(e => e.source === 'hearing')
    expect(hearings).toHaveLength(1)
    expect(hearings[0].bills[0]).toMatchObject({ billNumber: 'S 202', priority: 'high' })
  })

  it('puts a hearing on the ICS feed when its member has no priority but the group does', async () => {
    await group('a-house', 'b-senate')
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), description: 'Senate Cmte on Mail Ballots' })
    expect(await icsBody()).toContain('Senate Cmte on Mail Ballots')
  })

  it('still hides a hearing on an ungrouped bill with no priority, and on a group with none', async () => {
    await db().update(bills).set({ priority: null }).where(eq(bills.id, 'a-house'))
    await group('a-house', 'b-senate')
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), description: 'Group Cmte' })
    await seedCalendarEvent('c-alone', { uid: 'c-1@test', date: isoDay(4), description: 'Lone Cmte' })

    expect((await events()).filter(e => e.source === 'hearing')).toHaveLength(0)
    const ics = await icsBody()
    expect(ics).not.toContain('Group Cmte')
    expect(ics).not.toContain('Lone Cmte')
  })

  it('leaves an ungrouped bill\'s entry as it was: its own priority and no groups', async () => {
    await db().update(bills).set({ priority: 'low' }).where(eq(bills.id, 'c-alone'))
    await seedCalendarEvent('c-alone', { uid: 'c-1@test', date: isoDay(4), description: 'Lone Cmte' })

    const [entry] = (await events()).filter(e => e.source === 'hearing')
    expect(entry.bills[0]).toMatchObject({ billNumber: 'H 303', priority: 'low' })
    expect(entry.groups).toEqual([])
  })

  it('keeps one entry listing both bills when the two hearings are the same real meeting', async () => {
    await group('a-house', 'b-senate')
    const same = { date: isoDay(3), time: '10:00:00', location: 'Joint Room', description: 'Joint Cmte' }
    await seedCalendarEvent('a-house', { uid: 'h-1@test', eventHash: 'e1', ...same })
    await seedCalendarEvent('b-senate', { uid: 's-1@test', eventHash: 'e2', ...same })

    const hearings = (await events()).filter(e => e.source === 'hearing')
    expect(hearings).toHaveLength(1)
    expect(numbersOf(hearings[0]).sort()).toEqual(['H 101', 'S 202'])
    expect(hearings[0].groups).toHaveLength(1)
  })

  it('names a group once for a custom event linking both members, and lists a draft member among them', async () => {
    await db().update(bills).set({ isDraft: true, title: '', matchType: 'manual' }).where(eq(bills.id, 'b-senate'))
    await group('a-house', 'b-senate')
    const id = crypto.randomUUID()
    await db().insert(calendarEvents).values({
      id, uid: `custom-${id}@test`, billId: null, source: 'custom', sequence: 0, date: isoDay(5), time: null, location: null,
      description: 'Strategy call', status: 'confirmed', eventHash: null,
    })
    await db().insert(calendarEventBills).values([{ eventId: id, billId: 'a-house' }, { eventId: id, billId: 'b-senate' }])

    const entry = (await events()).find(e => e.id === id)!
    expect(entry.groups).toHaveLength(1)
    expect(entry.groups[0].bills.map(b => b.billNumber).sort()).toEqual(['H 101', 'S 202'])
    expect(entry.bills.find(b => b.billNumber === 'S 202')!.isDraft).toBe(true)
  })

  it('stops linking to a group once it is split, and the unprioritized member\'s hearing goes with it', async () => {
    await group('a-house', 'b-senate')
    await seedCalendarEvent('a-house', { uid: 'h-1@test', date: isoDay(3), description: 'House Cmte', eventHash: 'e1', location: 'R1' })
    await seedCalendarEvent('b-senate', { uid: 's-1@test', date: isoDay(3), description: 'Senate Cmte', eventHash: 'e2', location: 'R2' })
    expect((await events()).filter(e => e.source === 'hearing')).toHaveLength(2)

    expect(await splitFromGroup(db(), 'b-senate', adminId)).toBe(true)

    const after = (await events()).filter(e => e.source === 'hearing')
    expect(after.map(numbersOf)).toEqual([['H 101']])
    expect(after[0].groups).toEqual([])
  })
})
