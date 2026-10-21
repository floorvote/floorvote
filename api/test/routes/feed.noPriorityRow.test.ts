import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, feedEvents } from '../../src/db/schema'

// The no-priority updates row (#919): one bill-less row a day standing for the
// legislative activity on analyzed bills with no priority. Which bills it lists
// is resolved on every read, so these seed the row and its day's events by hand
// and read GET /feed and the row's bill list. The processor's write is covered
// in api/test/queue/processor-no-priority-row.test.ts.

type FeedEventBody = { id: string; type: string; billId: string | null; billGroupKey?: string | null; billPriority?: string | null; createdAt: string; metadata: Record<string, unknown>; noPriorityCard?: boolean }
type FeedBody = { events: FeedEventBody[]; total: number; latestEventAt: string | null }
type ListBill = { id: string; billNumber: string; title: string; state: string | null; sessionSlug: string | null; isDraft: boolean; groupKey: string | null; summary: string | null }
type ListEntry = { key: string; newMatch: boolean; bills: ListBill[]; events: Array<{ id: string; type: string; billId: string; metadata: Record<string, unknown>; createdAt: string }> }
type ListBody = { entries: ListEntry[]; total: number; page: number; limit: number; hasMore: boolean }
type RowMeta = { count: number; firstBills: ListBill[]; lastAt: string }

const DAY = '2026-03-04'
const at = (time: string, day = DAY) => `${day} ${time}`

describe('the no-priority updates row', () => {
  let adminId: string
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    await clearDb()
    adminId = await seedUser({ role: 'admin', name: 'Ada Admin', email: 'ada@example.com' })
    adminToken = await seedSession(adminId)
    memberToken = await seedSession(await seedUser({ name: 'Mia Member', email: 'mia@example.com' }))
  })

  const db = () => getDb(env.DB)
  const get = async <T>(path: string, token = memberToken): Promise<T> => {
    const res = await SELF.fetch(`http://localhost/api${path}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return await res.json() as T
  }
  const feed = (token = memberToken, qs = '') => get<FeedBody>(`/feed${qs}`, token)
  const list = (id: string, qs = '', token = memberToken) => get<ListBody>(`/feed/events/${id}/bills${qs}`, token)

  // The day's row, written when the first update of the day landed.
  const seedRow = async (day = DAY, time = '06:00:00') => {
    const id = `row-${day}`
    await db().insert(feedEvents).values({ id, type: 'no_priority_updates' as never, billId: null, userId: 'system', metadata: '{}', createdAt: at(time, day) })
    return id
  }
  const analyzed = (billNumber: string, relevanceScore: number | null, more: Parameters<typeof seedBill>[0] = {}) =>
    seedBill({ billNumber, title: `Act on ${billNumber}`, relevanceScore: relevanceScore ?? undefined, matchType: 'keyword', priority: null, ...more })
  let n = 0
  const event = async (billId: string, type: string, createdAt = at('09:00:00'), metadata: unknown = {}, userId = 'system', suppressed = false) => {
    const id = `e${++n}`
    await db().insert(feedEvents).values({ id, type: type as never, billId, userId, metadata: JSON.stringify(metadata), createdAt, suppressed })
    return id
  }
  const moved = (billId: string, createdAt = at('09:00:00'), newValue = 'Referred to committee') =>
    event(billId, 'bill_updated', createdAt, { changes: [{ changeType: 'action_added', oldValue: null, newValue, detail: null }] })
  const group = async (...ids: string[]) => {
    await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }
  const rowOf = (body: FeedBody, id: string) => body.events.find((e) => e.id === id)
  const metaOf = (body: FeedBody, id: string) => rowOf(body, id)!.metadata as RowMeta

  describe('GET /feed', () => {
    it('returns one row for a day with passive events on 3 analyzed bills with no priority, counting 3 and naming the two most relevant, with no cards for them', async () => {
      const low = await analyzed('HB 1', 3)
      const high = await analyzed('HB 2', 9)
      const mid = await analyzed('HB 3', 6)
      for (const b of [low, high, mid]) await moved(b)
      const id = await seedRow()

      const body = await feed()
      expect(body.events.filter((e) => e.type === 'no_priority_updates').map((e) => e.id)).toEqual([id])
      expect(rowOf(body, id)).toMatchObject({ billId: null })
      expect(metaOf(body, id).count).toBe(3)
      expect(metaOf(body, id).firstBills.map((b) => b.billNumber)).toEqual(['HB 2', 'HB 3'])
      expect(body.events.filter((e) => e.billId !== null)).toEqual([])
      expect(body.total).toBe(1)
    })

    it('gives each of the first bills what a chip and its hover card need', async () => {
      const b = await analyzed('HB 7', 8, { title: 'Ballot Access Act', tenantSummary: 'Moves the filing deadline.', state: 'RI', sessionSlug: '2026' })
      await moved(b)
      await moved(await analyzed('HB 1', 2))
      const id = await seedRow()

      expect(metaOf(await feed(), id).firstBills[0]).toEqual({
        id: b, billNumber: 'HB 7', title: 'Ballot Access Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null,
        summary: 'Moves the filing deadline.',
      })
    })

    it('shows no row for a day none of whose updates qualify, and leaves it out of the total', async () => {
      const b = await analyzed('HB 1', 5, { priority: 'high' })
      await moved(b)
      const id = await seedRow()

      const body = await feed()
      expect(rowOf(body, id)).toBeUndefined()
      // The prioritized bill's update is its own card.
      expect(body.events.map((e) => e.billId)).toEqual([b])
      expect(body.total).toBe(1)
    })

    it('counts two bills as two, naming both', async () => {
      await moved(await analyzed('HB 1', 5))
      await moved(await analyzed('HB 2', 7))
      const id = await seedRow()
      const meta = metaOf(await feed(), id)
      expect(meta.count).toBe(2)
      expect(meta.firstBills.map((b) => b.billNumber)).toEqual(['HB 2', 'HB 1'])
    })

    it('counts many bills exactly, naming only the first two', async () => {
      for (let i = 0; i < 60; i++) await moved(await analyzed(`HB ${100 + i}`, 1 + (i % 10)))
      const id = await seedRow()
      const meta = metaOf(await feed(), id)
      expect(meta.count).toBe(60)
      expect(meta.firstBills).toHaveLength(2)
    })

    it('counts a bill with two updates in the day once', async () => {
      const b = await analyzed('HB 1', 5)
      await moved(b, at('09:00:00'))
      await moved(b, at('15:00:00'), 'Hearing held')
      await moved(await analyzed('HB 2', 5))
      const id = await seedRow()
      expect(metaOf(await feed(), id).count).toBe(2)
    })

    it('resolves each day\'s row from that day\'s updates only', async () => {
      const a = await analyzed('HB 1', 5)
      const b = await analyzed('HB 2', 5)
      await moved(a, at('09:00:00', '2026-03-04'))
      await moved(await analyzed('HB 4', 5), at('10:00:00', '2026-03-04'))
      await moved(b, at('09:00:00', '2026-03-05'))
      await moved(await analyzed('HB 3', 5), at('10:00:00', '2026-03-05'))
      await moved(await analyzed('HB 5', 5), at('11:00:00', '2026-03-05'))
      const first = await seedRow('2026-03-04')
      const second = await seedRow('2026-03-05')

      const body = await feed()
      expect(metaOf(body, first).count).toBe(2)
      expect(metaOf(body, second).count).toBe(3)
    })

    it('leaves out a suppressed update', async () => {
      const b = await analyzed('HB 1', 5)
      await event(b, 'bill_updated', at('09:00:00'), {}, 'system', true)
      await moved(await analyzed('HB 2', 6))
      await moved(await analyzed('HB 3', 5))
      const id = await seedRow()
      expect(metaOf(await feed(), id).firstBills.map((x) => x.billNumber)).toEqual(['HB 2', 'HB 3'])
    })

    describe('who is left out', () => {
      // Each case puts two bills that qualify beside the one under test, so the row
      // still shows (a row of one is its bill's card, #921) and its count says
      // whether the third bill was let in.
      const withBaseline = async () => {
        await moved(await analyzed('HB 1', 6))
        await moved(await analyzed('HB 0', 5))
      }

      it('a bill with a priority of its own, which keeps its own card', async () => {
        await withBaseline()
        const p = await analyzed('HB 2', 9, { priority: 'low' })
        const update = await moved(p)
        const id = await seedRow()
        const body = await feed()
        expect(metaOf(body, id).count).toBe(2)
        expect(body.events.map((e) => e.id)).toContain(update)
      })

      it('a bill whose companion has a priority, and the companion group as a whole', async () => {
        await withBaseline()
        const a = await analyzed('HB 2', 9)
        const b = await analyzed('SB 2', 9, { priority: 'high' })
        await group(a, b)
        const update = await moved(a)
        const id = await seedRow()
        const body = await feed()
        expect(metaOf(body, id).count).toBe(2)
        expect(metaOf(body, id).firstBills.map((x) => x.billNumber)).toEqual(['HB 1', 'HB 0'])
        expect(body.events.map((e) => e.id)).toContain(update)
      })

      for (const [type, metadata] of [
        ['comment_added', { preview: 'Worth a look.' }],
        ['vote_milestone', { message: '4 members have voted on this bill' }],
        ['position_set', { position: 'Support' }],
        ['priority_set', { priority: null }],
      ] as const) {
        it(`a bill engaged with that day by ${type}, which shows as its own card instead`, async () => {
          await withBaseline()
          const b = await analyzed('HB 2', 9)
          const update = await moved(b, at('09:00:00'))
          const engagement = await event(b, type, at('11:00:00'), metadata, adminId)
          const id = await seedRow()
          const body = await feed()
          expect(metaOf(body, id).count).toBe(2)
          expect(body.events.map((e) => e.id)).toEqual(expect.arrayContaining([update, engagement]))
        })
      }

      it('a bill whose companion was engaged with that day', async () => {
        await withBaseline()
        const a = await analyzed('HB 2', 9)
        const b = await analyzed('SB 2', 9)
        await group(a, b)
        await moved(a)
        await event(b, 'comment_added', at('11:00:00'), { preview: 'On the companion.' }, adminId)
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)
      })

      it('not a bill engaged with on another day', async () => {
        await withBaseline()
        const b = await analyzed('HB 2', 9)
        await moved(b)
        await event(b, 'comment_added', at('11:00:00', '2026-03-03'), { preview: 'Yesterday.' }, adminId)
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(3)
      })

      it('a bill with no match type', async () => {
        await withBaseline()
        await moved(await analyzed('HB 2', 9, { matchType: null }))
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)
      })

      it('a bill below the instance\'s minimum relevance for new matches, and one with no score while there is a minimum', async () => {
        await db().insert(associationConfig).values({ key: 'new_match_min_relevance', value: '5' })
        await withBaseline() // relevance 6, and 5, at the minimum
        await moved(await analyzed('HB 2', 4))
        await moved(await analyzed('HB 3', null))
        const id = await seedRow()
        const meta = metaOf(await feed(), id)
        expect(meta.count).toBe(2)
        expect(meta.firstBills.map((x) => x.billNumber)).toEqual(['HB 1', 'HB 0'])
      })

      it('a bill whose only event is its match', async () => {
        await withBaseline()
        await event(await analyzed('HB 2', 9), 'bill_matched')
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)
      })
    })

    it('lets in a manually added bill and a draft, as analyzed bills', async () => {
      await moved(await analyzed('HB 1', 5, { matchType: 'manual' }))
      await moved(await analyzed('Draft 1', 4, { matchType: 'manual', isDraft: true, title: '' }))
      const id = await seedRow()
      const meta = metaOf(await feed(), id)
      expect(meta.count).toBe(2)
      expect(meta.firstBills.find((b) => b.billNumber === 'Draft 1')).toMatchObject({ isDraft: true })
    })

    for (const type of ['hearing_added', 'hearing_changed', 'hearing_cancelled']) {
      it(`counts a bill whose only change that day is ${type}`, async () => {
        await event(await analyzed('HB 1', 5), type, at('09:00:00'), { date: '2026-03-10', time: '10:00', location: 'Room 1', description: 'Committee' })
        await moved(await analyzed('HB 2', 5))
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)
      })
    }

    it('counts a companion group\'s moved members as one entry', async () => {
      const a = await analyzed('HB 1', 5)
      const b = await analyzed('SB 1', 7)
      await group(a, b)
      await moved(a)
      await moved(b)
      await moved(await analyzed('HB 2', 6))
      const id = await seedRow()
      const meta = metaOf(await feed(), id)
      expect(meta.count).toBe(2)
      // The group ranks by its most relevant member, and its chip is that member.
      expect(meta.firstBills.map((x) => x.billNumber)).toEqual(['SB 1', 'HB 2'])
    })

    describe('after the row was written', () => {
      it('drops a bill that gains a priority from the count, and shows its update as its own card', async () => {
        await moved(await analyzed('HB 1', 5))
        await moved(await analyzed('HB 3', 4))
        const b = await analyzed('HB 2', 9)
        const update = await moved(b)
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(3)

        await db().update(bills).set({ priority: 'medium' }).where(eq(bills.id, b))

        const body = await feed()
        expect(metaOf(body, id).count).toBe(2)
        expect(metaOf(body, id).firstBills.map((x) => x.billNumber)).toEqual(['HB 1', 'HB 3'])
        expect(body.events.map((e) => e.id)).toContain(update)
        expect((await list(id)).entries.flatMap((e) => e.bills.map((x) => x.id))).not.toContain(b)
      })

      it('drops a bill that gains a comment that day, and shows it as its own card', async () => {
        await moved(await analyzed('HB 1', 5))
        await moved(await analyzed('HB 3', 4))
        const b = await analyzed('HB 2', 9)
        const update = await moved(b, at('09:00:00'))
        const id = await seedRow()

        const comment = await event(b, 'comment_added', at('16:00:00'), { preview: 'Flagging this.' }, adminId)

        const body = await feed()
        expect(metaOf(body, id).count).toBe(2)
        expect(body.events.map((e) => e.id)).toEqual(expect.arrayContaining([update, comment]))
        expect((await list(id)).entries.flatMap((e) => e.bills.map((x) => x.id))).not.toContain(b)
      })

      it('hides the row once its last bill leaves it', async () => {
        const b = await analyzed('HB 1', 5)
        await moved(b)
        const id = await seedRow()
        await db().update(bills).set({ priority: 'low' }).where(eq(bills.id, b))
        const body = await feed()
        expect(rowOf(body, id)).toBeUndefined()
        expect(body.total).toBe(1)
      })
    })

    describe('the row\'s time', () => {
      // The row keeps the time of the day's first update, which orders it on the
      // server. The client files it under the viewer's day of its newest update.
      it('sends the time of the newest update it stands for, which follows a later update', async () => {
        await moved(await analyzed('HB 0', 5), at('08:00:00'))
        await moved(await analyzed('HB 1', 5), at('09:00:00'))
        const id = await seedRow(DAY, '00:30:00')
        expect(metaOf(await feed(), id).lastAt).toBe(at('09:00:00'))

        await event(await analyzed('HB 2', 5), 'hearing_added', `${DAY}T21:15:00Z`, { date: '2026-03-10', time: null, location: 'Room 1', description: 'Committee' })
        const body = await feed()
        expect(metaOf(body, id).lastAt).toBe(at('21:15:00'))
        expect(rowOf(body, id)!.createdAt).toBe(at('00:30:00'))
      })

      it('is not moved by a later update the row doesn\'t stand for', async () => {
        await moved(await analyzed('HB 0', 5), at('08:00:00'))
        await moved(await analyzed('HB 1', 5), at('09:00:00'))
        await moved(await analyzed('HB 2', 5, { priority: 'high' }), at('22:00:00'))
        const engaged = await analyzed('HB 3', 5)
        await moved(engaged, at('23:00:00'))
        await event(engaged, 'comment_added', at('23:30:00'), { preview: 'Looking.' }, adminId)
        await event(await analyzed('HB 4', 5), 'bill_updated', at('23:45:00'), {}, 'system', true)
        const id = await seedRow(DAY, '00:30:00')
        expect(metaOf(await feed(), id).lastAt).toBe(at('09:00:00'))
      })

      it('gives each row on the page its own day\'s newest update', async () => {
        await moved(await analyzed('HB 1', 5), at('09:00:00', '2026-03-03'))
        await moved(await analyzed('HB 3', 5), at('08:00:00', '2026-03-03'))
        await moved(await analyzed('HB 2', 5), at('14:00:00', '2026-03-04'))
        await moved(await analyzed('HB 4', 5), at('08:00:00', '2026-03-04'))
        const first = await seedRow('2026-03-03', '00:30:00')
        const second = await seedRow('2026-03-04', '00:30:00')
        const body = await feed()
        expect(metaOf(body, first).lastAt).toBe(at('09:00:00', '2026-03-03'))
        expect(metaOf(body, second).lastAt).toBe(at('14:00:00', '2026-03-04'))
      })
    })

    describe('the Feed dot', () => {
      it('never moves the latest-event signal', async () => {
        await moved(await analyzed('HB 1', 5), at('09:00:00'))
        await seedRow(DAY, '06:00:00')
        expect((await feed()).latestEventAt).toBeNull()
      })

      it('leaves the signal on the team\'s latest activity, even when the row is newer', async () => {
        const p = await analyzed('HB 9', 5, { priority: 'high' })
        await event(p, 'comment_added', at('08:00:00'), { preview: 'Morning.' }, adminId)
        await moved(await analyzed('HB 1', 5), at('09:00:00'))
        await seedRow(DAY, '10:00:00')
        expect((await feed()).latestEventAt).toBe(at('08:00:00'))
      })
    })

    it('shows a member and an admin the same row', async () => {
      await moved(await analyzed('HB 1', 5))
      await moved(await analyzed('HB 2', 6))
      const id = await seedRow()
      expect(metaOf(await feed(memberToken), id).count).toBe(2)
      expect(metaOf(await feed(memberToken), id)).toEqual(metaOf(await feed(adminToken), id))
    })

    it('leaves a bill-less bulk edit and the new-matches row as they were', async () => {
      await moved(await analyzed('HB 1', 5))
      await moved(await analyzed('HB 2', 5))
      const rowId = await seedRow(DAY, '06:00:00')
      await db().insert(feedEvents).values([
        { id: 'bulk', type: 'priority_set', billId: null, userId: adminId, metadata: JSON.stringify({ priority: 'high', count: 3, billIds: ['x'] }), createdAt: at('12:00:00') },
        { id: 'matches', type: 'new_matches', billId: null, userId: 'system', metadata: JSON.stringify({ billIds: ['y'] }), createdAt: at('11:00:00') },
      ])
      const body = await feed()
      expect(body.events.map((e) => e.id)).toEqual(['bulk', 'matches', rowId])
      expect(metaOf(body, rowId).count).toBe(2)
      expect(rowOf(body, 'bulk')!.metadata).toEqual({ priority: 'high', count: 3, billIds: ['x'] })
    })

    it('leaves a day with only team activity as it was', async () => {
      const b = await analyzed('HB 1', 5)
      const update = await moved(b, at('09:00:00'))
      const comment = await event(b, 'comment_added', at('10:00:00'), { preview: 'Discuss.' }, adminId)
      const id = await seedRow()
      const body = await feed()
      expect(body.events.map((e) => e.id)).toEqual([comment, update])
      expect(rowOf(body, id)).toBeUndefined()
    })

    it('pages the feed honestly around a row', async () => {
      await moved(await analyzed('HB 1', 5), at('09:00:00'))
      await moved(await analyzed('HB 2', 5), at('09:30:00'))
      const id = await seedRow(DAY, '06:00:00')
      const p = await analyzed('HB 9', 5, { priority: 'high' })
      const newer = await event(p, 'comment_added', at('12:00:00'), { preview: 'Later.' }, adminId)
      const older = await event(p, 'comment_added', at('05:00:00'), { preview: 'Earlier.' }, adminId)

      const one = await feed(memberToken, '?page=1&limit=2')
      const two = await feed(memberToken, '?page=2&limit=2')
      expect(one.total).toBe(3)
      expect(one.events.map((e) => e.id)).toEqual([newer, id])
      expect(metaOf(one, id).count).toBe(2)
      expect(two.events.map((e) => e.id)).toEqual([older])
    })
  })

  // #921: a day whose row resolves to one entry (a bill, or one companion
  // group) shows that entry's card instead: GET /feed returns its legislative
  // updates that day, each marked noPriorityCard, and no row. Two or more
  // entries stay one row. Decided on every read, like the row itself.
  describe('GET /feed, a day whose row resolves to one entry (#921)', () => {
    const cardsOf = (body: FeedBody) => body.events.filter((e) => e.noPriorityCard === true).map((e) => e.id)
    const hearing = (billId: string, createdAt = at('11:00:00')) =>
      event(billId, 'hearing_added', createdAt, { date: '2026-03-10', time: '10:00', location: 'Room 2', description: 'Committee' })

    it('returns the one qualifying bill\'s passive events for the day, as its card, and no row', async () => {
      const b = await analyzed('HB 1', 5)
      const update = await moved(b, at('09:00:00'))
      const heard = await hearing(b, at('11:00:00'))
      const id = await seedRow()

      const body = await feed()
      expect(rowOf(body, id)).toBeUndefined()
      expect(body.events.map((e) => e.id)).toEqual([heard, update])
      expect(cardsOf(body)).toEqual([heard, update])
      expect(body.events.every((e) => e.billId === b)).toBe(true)
      expect(body.total).toBe(2)
    })

    it('returns only that day\'s qualifying passive events: not its match, a suppressed update, or another day\'s update', async () => {
      const b = await analyzed('HB 1', 5)
      const update = await moved(b, at('09:00:00'))
      await event(b, 'bill_matched', at('08:00:00'))
      await event(b, 'bill_updated', at('10:00:00'), {}, 'system', true)
      // Another day, shared with a second bill, so that day is a row of two.
      const yesterday = await moved(b, at('09:00:00', '2026-03-03'))
      await moved(await analyzed('HB 2', 4), at('10:00:00', '2026-03-03'))
      const id = await seedRow()
      const other = await seedRow('2026-03-03')

      const body = await feed()
      expect(cardsOf(body)).toEqual([update])
      expect(body.events.map((e) => e.id)).not.toContain(yesterday)
      expect(rowOf(body, id)).toBeUndefined()
      expect(metaOf(body, other).count).toBe(2)
      expect(body.events.map((e) => e.id)).toEqual([update, other])
      expect(body.total).toBe(2)
    })

    it('shows a bill whose only change that day is a hearing as its card', async () => {
      const heard = await hearing(await analyzed('HB 1', 5))
      const id = await seedRow()
      const body = await feed()
      expect(rowOf(body, id)).toBeUndefined()
      expect(cardsOf(body)).toEqual([heard])
    })

    it('keeps two qualifying bills one row of count 2, naming both, with no cards', async () => {
      await moved(await analyzed('HB 1', 5))
      await moved(await analyzed('HB 2', 7))
      const id = await seedRow()

      const body = await feed()
      expect(metaOf(body, id).count).toBe(2)
      expect(metaOf(body, id).firstBills.map((x) => x.billNumber)).toEqual(['HB 2', 'HB 1'])
      expect(body.events.map((e) => e.id)).toEqual([id])
      expect(cardsOf(body)).toEqual([])
      expect(body.total).toBe(1)
    })

    it('gives a companion group alone on a day (two members moved, one entry) its members\' updates, one group\'s card, and no row', async () => {
      const a = await analyzed('HB 1', 5)
      const b = await analyzed('SB 1', 7)
      await group(a, b)
      const aUpdate = await moved(a, at('09:00:00'))
      const bUpdate = await moved(b, at('10:00:00'))
      const id = await seedRow()

      const body = await feed()
      expect(rowOf(body, id)).toBeUndefined()
      expect(cardsOf(body)).toEqual([bUpdate, aUpdate])
      expect(new Set(body.events.map((e) => e.billGroupKey))).toEqual(new Set([[a, b].sort()[0]]))
      expect(body.total).toBe(2)
    })

    it('gives a lone companion group\'s card only its qualifying members\' updates, not a member below the minimum relevance or one with no match type', async () => {
      await db().insert(associationConfig).values({ key: 'new_match_min_relevance', value: '5' })
      const qualifying = await analyzed('HB 1', 6)
      const low = await analyzed('SB 1', 2)
      const unmatched = await analyzed('HB 2', 9, { matchType: null })
      await group(qualifying, low, unmatched)
      const update = await moved(qualifying, at('09:00:00'))
      await moved(low, at('10:00:00'))
      await moved(unmatched, at('11:00:00'))
      const id = await seedRow()

      const body = await feed()
      expect(rowOf(body, id)).toBeUndefined()
      expect(body.events.map((e) => e.id)).toEqual([update])
      expect(cardsOf(body)).toEqual([update])
      expect(body.total).toBe(1)
    })

    it('leaves a lone bill\'s card beside a prioritized bill\'s card, each its own', async () => {
      const lone = await moved(await analyzed('HB 1', 5), at('09:00:00'))
      const p = await analyzed('HB 2', 9, { priority: 'high' })
      const pUpdate = await moved(p, at('10:00:00'))
      const id = await seedRow()

      const body = await feed()
      expect(rowOf(body, id)).toBeUndefined()
      expect(body.events.map((e) => e.id)).toEqual([pUpdate, lone])
      expect(cardsOf(body)).toEqual([lone])
      expect(body.events.find((e) => e.id === pUpdate)!.noPriorityCard).toBe(false)
    })

    it('marks no team activity, prioritized update, bill-less event, or row as the lone card', async () => {
      const p = await analyzed('HB 9', 5, { priority: 'high' })
      await moved(p, at('07:00:00'))
      await event(p, 'comment_added', at('08:00:00'), { preview: 'Morning.' }, adminId)
      await moved(await analyzed('HB 1', 5))
      await moved(await analyzed('HB 2', 6))
      await seedRow()
      await db().insert(feedEvents).values({ id: 'bulk', type: 'priority_set', billId: null, userId: adminId, metadata: JSON.stringify({ priority: 'high', count: 1, billIds: [p] }), createdAt: at('12:00:00') })

      const body = await feed()
      expect(body.events).toHaveLength(4)
      expect(body.events.map((e) => e.noPriorityCard)).toEqual([false, false, false, false])
    })

    describe('a row that drops from two entries to one', () => {
      it('renders as the remaining bill\'s card on the next read after the other is prioritized', async () => {
        const keep = await analyzed('HB 1', 5)
        const set = await analyzed('HB 2', 9)
        const keepUpdate = await moved(keep, at('09:00:00'))
        const setUpdate = await moved(set, at('10:00:00'))
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)

        const res = await SELF.fetch(`http://localhost/api/bills/${set}/priority`, {
          method: 'PATCH', headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: 'high' }),
        })
        expect(res.status).toBe(200)

        const body = await feed()
        expect(rowOf(body, id)).toBeUndefined()
        expect(cardsOf(body)).toEqual([keepUpdate])
        // The prioritized bill's update is its own card, as any prioritized bill's is.
        expect(body.events.map((e) => e.id)).toEqual(expect.arrayContaining([setUpdate, keepUpdate]))
        expect(body.events.filter((e) => e.type === 'bill_updated')).toHaveLength(2)
        expect(body.total).toBe(body.events.length)
      })

      it('renders as the remaining bill\'s card on the next read after the other gains a comment that day', async () => {
        const keep = await analyzed('HB 1', 5)
        const engaged = await analyzed('HB 2', 9)
        const keepUpdate = await moved(keep, at('09:00:00'))
        await moved(engaged, at('10:00:00'))
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)

        await event(engaged, 'comment_added', at('16:00:00'), { preview: 'Flagging this.' }, adminId)

        const body = await feed()
        expect(rowOf(body, id)).toBeUndefined()
        expect(cardsOf(body)).toEqual([keepUpdate])
        expect(body.total).toBe(3)
      })
    })

    it('becomes a row again when a second bill\'s update lands later that day', async () => {
      const first = await moved(await analyzed('HB 1', 5), at('09:00:00'))
      const id = await seedRow()
      expect(cardsOf(await feed())).toEqual([first])

      await moved(await analyzed('HB 2', 6), at('15:00:00'))

      const body = await feed()
      expect(metaOf(body, id).count).toBe(2)
      expect(body.events.map((e) => e.id)).toEqual([id])
      expect(cardsOf(body)).toEqual([])
      expect(body.total).toBe(1)
    })

    it('turns a lone companion group\'s card into a row when a second entry moves that day', async () => {
      const a = await analyzed('HB 1', 5)
      const b = await analyzed('SB 1', 7)
      await group(a, b)
      await moved(a, at('09:00:00'))
      await moved(b, at('10:00:00'))
      const id = await seedRow()
      expect(rowOf(await feed(), id)).toBeUndefined()

      await moved(await analyzed('HB 2', 1), at('12:00:00'))

      expect(metaOf(await feed(), id).count).toBe(2)
    })

    describe('paging', () => {
      it('counts the lone bill\'s updates and never the row, page by page', async () => {
        const b = await analyzed('HB 1', 5)
        const u1 = await moved(b, at('09:00:00'))
        const u2 = await moved(b, at('13:00:00'), 'Hearing held')
        const u3 = await hearing(b, at('15:00:00'))
        const id = await seedRow(DAY, '06:00:00')
        const p = await analyzed('HB 9', 5, { priority: 'high' })
        const c1 = await event(p, 'comment_added', at('16:00:00'), { preview: 'Latest.' }, adminId)
        const c2 = await event(p, 'comment_added', at('05:00:00'), { preview: 'Earliest.' }, adminId)

        const pages: FeedBody[] = []
        for (let page = 1; page <= 3; page++) pages.push(await feed(memberToken, `?page=${page}&limit=2`))
        for (const page of pages) expect(page.total).toBe(5)
        expect(pages.map((pg) => pg.events.map((e) => e.id))).toEqual([[c1, u3], [u2, u1], [c2]])
        expect(pages.flatMap((pg) => pg.events.map((e) => e.id))).not.toContain(id)
        expect(pages.flatMap((pg) => cardsOf(pg))).toEqual([u3, u2, u1])
      })

      it('splits the lone bill\'s updates across a page boundary with none repeated or skipped', async () => {
        const b = await analyzed('HB 1', 5)
        const updates: string[] = []
        for (let i = 0; i < 5; i++) updates.push(await moved(b, at(`1${i}:00:00`), `Action ${i}`))
        await seedRow(DAY, '06:00:00')
        // A day of two entries on either side, so the lone day sits between two rows.
        await moved(await analyzed('HB 2', 5), at('09:00:00', '2026-03-05'))
        await moved(await analyzed('HB 3', 5), at('10:00:00', '2026-03-05'))
        const later = await seedRow('2026-03-05', '06:00:00')
        await moved(await analyzed('HB 4', 5), at('09:00:00', '2026-03-03'))
        await moved(await analyzed('HB 5', 5), at('10:00:00', '2026-03-03'))
        const earlier = await seedRow('2026-03-03', '06:00:00')

        const one = await feed(memberToken, '?page=1&limit=3')
        const two = await feed(memberToken, '?page=2&limit=3')
        const three = await feed(memberToken, '?page=3&limit=3')
        expect(one.total).toBe(7)
        expect([...one.events, ...two.events, ...three.events].map((e) => e.id)).toEqual([later, ...[...updates].reverse(), earlier])
        expect(three.events).toHaveLength(1)
      })

      it('counts the total the same whichever page is read, and as many as the pages hold', async () => {
        const b = await analyzed('HB 1', 5)
        for (let i = 0; i < 3; i++) await moved(b, at(`1${i}:00:00`))
        await seedRow()
        const all = await feed(memberToken, '?limit=100')
        expect(all.total).toBe(all.events.length)
        expect(all.total).toBe(3)
      })
    })

    describe('the Feed dot', () => {
      it('never moves the latest-event signal for the lone bill\'s card', async () => {
        await moved(await analyzed('HB 1', 5), at('09:00:00'))
        await seedRow()
        const body = await feed()
        expect(cardsOf(body)).toHaveLength(1)
        expect(body.latestEventAt).toBeNull()
      })

      it('leaves the signal on the team\'s latest activity when the lone card is newer', async () => {
        const p = await analyzed('HB 9', 5, { priority: 'high' })
        await event(p, 'comment_added', at('08:00:00'), { preview: 'Morning.' }, adminId)
        await moved(await analyzed('HB 1', 5), at('21:00:00'))
        await seedRow()
        const body = await feed()
        expect(cardsOf(body)).toHaveLength(1)
        expect(body.latestEventAt).toBe(at('08:00:00'))
      })
    })

    it('shows a member and an admin the same card', async () => {
      await moved(await analyzed('HB 1', 5))
      await seedRow()
      const member = await feed(memberToken)
      expect(cardsOf(member)).toHaveLength(1)
      expect(member.events).toEqual((await feed(adminToken)).events)
    })

    it('files the card under the UTC day of its own updates, like the row', async () => {
      // Late on the 4th, UTC: the evening of the 4th in the US. Another bill on the 5th, alone too.
      const late = await moved(await analyzed('HB 1', 5), `${DAY}T23:30:00Z`)
      const next = await moved(await analyzed('HB 2', 5), at('01:00:00', '2026-03-05'))
      await seedRow(DAY, '06:00:00')
      await seedRow('2026-03-05', '01:00:00')
      const body = await feed()
      expect(cardsOf(body)).toEqual([next, late])
    })
  })

  describe('GET /feed/events/:id/bills', () => {
    it('lists the row\'s bills by relevance, each with that day\'s changes', async () => {
      const low = await analyzed('HB 1', 2)
      const high = await analyzed('HB 2', 8)
      const lowUpdate = await moved(low, at('09:00:00'), 'Referred to Judiciary')
      const highUpdate = await moved(high, at('10:00:00'), 'Passed second reading')
      const hearing = await event(high, 'hearing_added', at('11:00:00'), { date: '2026-03-10', time: '10:00', location: 'Room 2', description: 'Committee' })
      // Another day's update isn't this row's.
      await moved(high, at('09:00:00', '2026-03-03'), 'Introduced')
      const id = await seedRow()

      const body = await list(id)
      expect(body.total).toBe(2)
      expect(body.hasMore).toBe(false)
      expect(body.entries.map((e) => e.bills.map((b) => b.billNumber))).toEqual([['HB 2'], ['HB 1']])
      expect(body.entries[0].events.map((e) => e.id)).toEqual([hearing, highUpdate])
      expect(body.entries[0].events[1]).toMatchObject({
        type: 'bill_updated', billId: high, createdAt: at('10:00:00'),
        metadata: { changes: [{ changeType: 'action_added', newValue: 'Passed second reading' }] },
      })
      expect(body.entries[1].events.map((e) => e.id)).toEqual([lowUpdate])
    })

    it('pages: page two continues where page one ended, with ties in relevance in a stable order', async () => {
      // Seven bills, five of them tied, so the order within a tie decides the page break.
      const scores = [5, 5, 9, 5, 5, 1, 5]
      for (const [i, s] of scores.entries()) await moved(await analyzed(`HB ${i + 1}`, s))
      const id = await seedRow()

      const all = (await list(id, '?page=1&limit=100')).entries.map((e) => e.key)
      expect(all).toHaveLength(7)
      const pages: string[][] = []
      for (let page = 1; page <= 3; page++) {
        const body = await list(id, `?page=${page}&limit=3`)
        expect(body.total).toBe(7)
        expect(body.hasMore).toBe(page < 3)
        pages.push(body.entries.map((e) => e.key))
      }
      expect(pages.map((p) => p.length)).toEqual([3, 3, 1])
      expect(pages.flat()).toEqual(all)
      // And the same again, read a second time.
      expect((await list(id, '?page=2&limit=3')).entries.map((e) => e.key)).toEqual(pages[1])
    })

    it('pages in about 50 when no limit is asked for', async () => {
      for (let i = 0; i < 55; i++) await moved(await analyzed(`HB ${i}`, 5))
      const id = await seedRow()
      const one = await list(id)
      expect(one.entries).toHaveLength(50)
      expect(one.hasMore).toBe(true)
      expect((await list(id, '?page=2')).entries).toHaveLength(5)
    })

    it('lists a companion group as one entry with each moved member, its most relevant first', async () => {
      const a = await analyzed('HB 1', 5)
      const b = await analyzed('SB 1', 7)
      const c = await analyzed('HB 4', 9) // in the group, but didn't move
      await group(a, b, c)
      const aUpdate = await moved(a, at('09:00:00'))
      const bUpdate = await moved(b, at('10:00:00'))
      const id = await seedRow()

      const body = await list(id)
      expect(body.total).toBe(1)
      expect(body.entries[0].key).toBe(`group:${[a, b, c].sort()[0]}`)
      expect(body.entries[0].bills.map((x) => x.billNumber)).toEqual(['SB 1', 'HB 1'])
      expect(body.entries[0].events.map((e) => e.id)).toEqual([bUpdate, aUpdate])
    })

    it('lists for a member as for an admin', async () => {
      await moved(await analyzed('HB 1', 5))
      const id = await seedRow()
      expect((await list(id, '', memberToken)).entries).toHaveLength(1)
      expect(await list(id, '', memberToken)).toEqual(await list(id, '', adminToken))
    })

    describe('each entry\'s new-match state, for the amber dropdown an admin sees', () => {
      const NEW = { matchType: 'keyword', newMatchAt: '2026-03-01 08:00:00' } as const
      const byBill = (body: ListBody) => new Map(body.entries.map((e) => [e.bills[0].billNumber, e.newMatch]))

      it('marks an untriaged keyword match that arrived as a new match, and no other bill', async () => {
        for (const [number, score, more] of [
          ['HB 1', 9, NEW],
          ['HB 2', 8, { ...NEW, triagedAt: '2026-03-02 08:00:00' }],
          ['HB 3', 7, { matchType: 'manual' as const }],
          ['HB 4', 6, { matchType: 'keyword' as const }],
        ] as const) await moved(await analyzed(number, score, more))
        const id = await seedRow()

        expect(byBill(await list(id))).toEqual(new Map([['HB 1', true], ['HB 2', false], ['HB 3', false], ['HB 4', false]]))
      })

      it('marks a companion group by the group, as the feed\'s cards do: new until any member is triaged', async () => {
        const a = await analyzed('HB 10', 9, NEW)
        const b = await analyzed('SB 10', 5, { matchType: 'manual' })
        await group(a, b)
        const c = await analyzed('HB 20', 4, NEW)
        const d = await analyzed('SB 20', 3, { ...NEW, triagedAt: '2026-03-02 08:00:00' })
        await group(c, d)
        for (const x of [a, b, c, d]) await moved(x)
        const id = await seedRow()

        const body = await list(id)
        expect(body.entries.map((e) => [e.bills.map((x) => x.billNumber), e.newMatch])).toEqual([[['HB 10', 'SB 10'], true], [['HB 20', 'SB 20'], false]])
      })

      it('is the same for a member and an admin', async () => {
        await moved(await analyzed('HB 1', 5, NEW))
        const id = await seedRow()
        expect((await list(id, '', memberToken)).entries[0].newMatch).toBe(true)
      })
    })

    describe('after an admin acts on an entry', () => {
      const patch = (path: string, body?: unknown) =>
        SELF.fetch(`http://localhost/api${path}`, { method: 'PATCH', headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

      it('takes a bill out of the row and gives it its own card once its priority is set', async () => {
        const keep = await analyzed('HB 1', 5)
        const also = await analyzed('HB 3', 4)
        const set = await analyzed('HB 2', 9)
        await moved(keep)
        await moved(also)
        const update = await moved(set)
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(3)

        expect((await patch(`/bills/${set}/priority`, { priority: 'high' })).status).toBe(200)

        const body = await feed()
        expect(metaOf(body, id).count).toBe(2)
        expect(metaOf(body, id).firstBills.map((x) => x.billNumber)).toEqual(['HB 1', 'HB 3'])
        expect(body.events.find((e) => e.id === update)).toBeDefined()
        expect((await list(id)).entries.map((e) => e.bills[0].id)).toEqual([keep, also])
      })

      it('takes a whole companion group out of the row when one member is prioritized', async () => {
        const a = await analyzed('HB 1', 5)
        const b = await analyzed('SB 1', 7)
        await group(a, b)
        await moved(a)
        await moved(b)
        await moved(await analyzed('HB 9', 1))
        await moved(await analyzed('HB 8', 0))
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(3)

        expect((await patch(`/bills/${a}/priority`, { priority: 'low' })).status).toBe(200)

        expect(metaOf(await feed(), id).count).toBe(2)
        expect((await list(id)).entries.map((e) => e.bills[0].billNumber)).toEqual(['HB 9', 'HB 8'])
      })

      it('keeps a dismissed new match in the row, now a plain entry', async () => {
        const b = await analyzed('HB 1', 5, { matchType: 'keyword', newMatchAt: '2026-03-01 08:00:00' })
        const other = await analyzed('HB 2', 4)
        await moved(b)
        await moved(other)
        const id = await seedRow()
        expect((await list(id)).entries[0].newMatch).toBe(true)

        expect((await patch(`/bills/${b}/triage-dismiss`)).status).toBe(200)

        const body = await list(id)
        expect(body.entries.map((e) => [e.bills[0].id, e.newMatch])).toEqual([[b, false], [other, false]])
        expect(metaOf(await feed(), id).count).toBe(2)
      })
    })

    describe('?removed, the entries a reader has already dropped from the pages it has', () => {
      it('starts a page that many entries earlier, so a bill dropped from page one skips no one', async () => {
        const ids: string[] = []
        for (let i = 0; i < 7; i++) {
          const b = await analyzed(`HB ${i + 1}`, 9 - i)
          ids.push(b)
          await moved(b)
        }
        const id = await seedRow()
        const order = (await list(id, '?page=1&limit=100')).entries.map((e) => e.bills[0].id)
        expect(order).toEqual(ids)

        const pageOne = await list(id, '?page=1&limit=3')
        expect(pageOne.entries.map((e) => e.bills[0].id)).toEqual(ids.slice(0, 3))
        // The reader prioritizes the first of them: the row is now six bills.
        await db().update(bills).set({ priority: 'high' }).where(eq(bills.id, ids[0]))

        const without = await list(id, '?page=2&limit=3')
        expect(without.entries.map((e) => e.bills[0].id)).toEqual(ids.slice(4, 7))
        const withRemoved = await list(id, '?page=2&limit=3&removed=1')
        expect(withRemoved.entries.map((e) => e.bills[0].id)).toEqual(ids.slice(3, 6))
        expect(withRemoved.total).toBe(6)
        expect(withRemoved.hasMore).toBe(true)
        expect(withRemoved.page).toBe(2)
      })

      it('says there is more while entries remain past the shifted page', async () => {
        for (let i = 0; i < 7; i++) await moved(await analyzed(`HB ${i + 1}`, 9 - i))
        const id = await seedRow()
        const first = (await list(id, '?page=1&limit=3')).entries[0].bills[0].id
        await db().update(bills).set({ priority: 'high' }).where(eq(bills.id, first))
        const body = await list(id, '?page=2&limit=3&removed=1')
        expect(body.entries).toHaveLength(3)
        expect(body.hasMore).toBe(true)
      })

      it('ignores a negative, fractional, or non-numeric value, and never starts before the first entry', async () => {
        for (let i = 0; i < 4; i++) await moved(await analyzed(`HB ${i + 1}`, 9 - i))
        const id = await seedRow()
        const plain = (await list(id, '?page=1&limit=2')).entries.map((e) => e.key)
        for (const removed of ['-3', '1.5', 'abc', '']) {
          expect((await list(id, `?page=1&limit=2&removed=${removed}`)).entries.map((e) => e.key), removed).toEqual(plain)
        }
        expect((await list(id, '?page=1&limit=2&removed=5')).entries.map((e) => e.key)).toEqual(plain)
      })
    })

    it('still lists a bulk edit\'s bills as it did', async () => {
      const a = await analyzed('HB 1', 5)
      await db().insert(feedEvents).values({ id: 'bulk', type: 'priority_set', billId: null, userId: adminId, metadata: JSON.stringify({ priority: 'high', count: 1, billIds: [a] }), createdAt: at('12:00:00') })
      const body = await get<{ bills: Array<{ id: string }> }>('/feed/events/bulk/bills')
      expect(body.bills.map((x) => x.id)).toEqual([a])
    })
  })
})
