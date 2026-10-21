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

type FeedEventBody = { id: string; type: string; billId: string | null; createdAt: string; metadata: Record<string, unknown> }
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
      const id = await seedRow()

      expect(metaOf(await feed(), id).firstBills).toEqual([{
        id: b, billNumber: 'HB 7', title: 'Ballot Access Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null,
        summary: 'Moves the filing deadline.',
      }])
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

    it('counts one bill as a row of one', async () => {
      await moved(await analyzed('HB 1', 5))
      const id = await seedRow()
      const meta = metaOf(await feed(), id)
      expect(meta.count).toBe(1)
      expect(meta.firstBills.map((b) => b.billNumber)).toEqual(['HB 1'])
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
      const id = await seedRow()
      expect(metaOf(await feed(), id).count).toBe(1)
    })

    it('resolves each day\'s row from that day\'s updates only', async () => {
      const a = await analyzed('HB 1', 5)
      const b = await analyzed('HB 2', 5)
      await moved(a, at('09:00:00', '2026-03-04'))
      await moved(b, at('09:00:00', '2026-03-05'))
      await moved(await analyzed('HB 3', 5), at('10:00:00', '2026-03-05'))
      const first = await seedRow('2026-03-04')
      const second = await seedRow('2026-03-05')

      const body = await feed()
      expect(metaOf(body, first).count).toBe(1)
      expect(metaOf(body, second).count).toBe(2)
    })

    it('leaves out a suppressed update', async () => {
      const b = await analyzed('HB 1', 5)
      await event(b, 'bill_updated', at('09:00:00'), {}, 'system', true)
      await moved(await analyzed('HB 2', 5))
      const id = await seedRow()
      expect(metaOf(await feed(), id).firstBills.map((x) => x.billNumber)).toEqual(['HB 2'])
    })

    describe('who is left out', () => {
      // Each case puts one bill that qualifies beside the one under test, so the row
      // still shows and its count says whether the second bill was let in.
      const withBaseline = async () => { await moved(await analyzed('HB 1', 5)) }

      it('a bill with a priority of its own, which keeps its own card', async () => {
        await withBaseline()
        const p = await analyzed('HB 2', 9, { priority: 'low' })
        const update = await moved(p)
        const id = await seedRow()
        const body = await feed()
        expect(metaOf(body, id).count).toBe(1)
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
        expect(metaOf(body, id).count).toBe(1)
        expect(metaOf(body, id).firstBills.map((x) => x.billNumber)).toEqual(['HB 1'])
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
          expect(metaOf(body, id).count).toBe(1)
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
        expect(metaOf(await feed(), id).count).toBe(1)
      })

      it('not a bill engaged with on another day', async () => {
        await withBaseline()
        const b = await analyzed('HB 2', 9)
        await moved(b)
        await event(b, 'comment_added', at('11:00:00', '2026-03-03'), { preview: 'Yesterday.' }, adminId)
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)
      })

      it('a bill with no match type', async () => {
        await withBaseline()
        await moved(await analyzed('HB 2', 9, { matchType: null }))
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(1)
      })

      it('a bill below the instance\'s minimum relevance for new matches, and one with no score while there is a minimum', async () => {
        await db().insert(associationConfig).values({ key: 'new_match_min_relevance', value: '5' })
        await withBaseline() // relevance 5, at the minimum
        await moved(await analyzed('HB 2', 4))
        await moved(await analyzed('HB 3', null))
        const id = await seedRow()
        const meta = metaOf(await feed(), id)
        expect(meta.count).toBe(1)
        expect(meta.firstBills.map((x) => x.billNumber)).toEqual(['HB 1'])
      })

      it('a bill whose only event is its match', async () => {
        await withBaseline()
        await event(await analyzed('HB 2', 9), 'bill_matched')
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(1)
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
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(1)
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
        const b = await analyzed('HB 2', 9)
        const update = await moved(b)
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)

        await db().update(bills).set({ priority: 'medium' }).where(eq(bills.id, b))

        const body = await feed()
        expect(metaOf(body, id).count).toBe(1)
        expect(metaOf(body, id).firstBills.map((x) => x.billNumber)).toEqual(['HB 1'])
        expect(body.events.map((e) => e.id)).toContain(update)
        expect((await list(id)).entries.flatMap((e) => e.bills.map((x) => x.id))).not.toContain(b)
      })

      it('drops a bill that gains a comment that day, and shows it as its own card', async () => {
        await moved(await analyzed('HB 1', 5))
        const b = await analyzed('HB 2', 9)
        const update = await moved(b, at('09:00:00'))
        const id = await seedRow()

        const comment = await event(b, 'comment_added', at('16:00:00'), { preview: 'Flagging this.' }, adminId)

        const body = await feed()
        expect(metaOf(body, id).count).toBe(1)
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
        await moved(await analyzed('HB 1', 5), at('09:00:00'))
        const id = await seedRow(DAY, '00:30:00')
        expect(metaOf(await feed(), id).lastAt).toBe(at('09:00:00'))

        await event(await analyzed('HB 2', 5), 'hearing_added', `${DAY}T21:15:00Z`, { date: '2026-03-10', time: null, location: 'Room 1', description: 'Committee' })
        const body = await feed()
        expect(metaOf(body, id).lastAt).toBe(at('21:15:00'))
        expect(rowOf(body, id)!.createdAt).toBe(at('00:30:00'))
      })

      it('is not moved by a later update the row doesn\'t stand for', async () => {
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
        await moved(await analyzed('HB 2', 5), at('14:00:00', '2026-03-04'))
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

    it('keeps the row out of the analyzed scope, which lists every update on its own', async () => {
      const b = await analyzed('HB 1', 5)
      const update = await moved(b)
      await seedRow()
      const body = await feed(adminToken, '?scope=analyzed')
      expect(body.events.map((e) => e.id)).toEqual([update])
    })

    it('leaves a bill-less bulk edit and the new-matches row as they were', async () => {
      await moved(await analyzed('HB 1', 5))
      const rowId = await seedRow(DAY, '06:00:00')
      await db().insert(feedEvents).values([
        { id: 'bulk', type: 'priority_set', billId: null, userId: adminId, metadata: JSON.stringify({ priority: 'high', count: 3, billIds: ['x'] }), createdAt: at('12:00:00') },
        { id: 'matches', type: 'new_matches', billId: null, userId: 'system', metadata: JSON.stringify({ billIds: ['y'] }), createdAt: at('11:00:00') },
      ])
      const body = await feed()
      expect(body.events.map((e) => e.id)).toEqual(['bulk', 'matches', rowId])
      expect(metaOf(body, rowId).count).toBe(1)
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
      const id = await seedRow(DAY, '06:00:00')
      const p = await analyzed('HB 9', 5, { priority: 'high' })
      const newer = await event(p, 'comment_added', at('12:00:00'), { preview: 'Later.' }, adminId)
      const older = await event(p, 'comment_added', at('05:00:00'), { preview: 'Earlier.' }, adminId)

      const one = await feed(memberToken, '?page=1&limit=2')
      const two = await feed(memberToken, '?page=2&limit=2')
      expect(one.total).toBe(3)
      expect(one.events.map((e) => e.id)).toEqual([newer, id])
      expect(metaOf(one, id).count).toBe(1)
      expect(two.events.map((e) => e.id)).toEqual([older])
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
        const set = await analyzed('HB 2', 9)
        await moved(keep)
        const update = await moved(set)
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)

        expect((await patch(`/bills/${set}/priority`, { priority: 'high' })).status).toBe(200)

        const body = await feed()
        expect(metaOf(body, id).count).toBe(1)
        expect(metaOf(body, id).firstBills.map((x) => x.billNumber)).toEqual(['HB 1'])
        expect(body.events.find((e) => e.id === update)).toBeDefined()
        expect((await list(id)).entries.map((e) => e.bills[0].id)).toEqual([keep])
      })

      it('takes a whole companion group out of the row when one member is prioritized', async () => {
        const a = await analyzed('HB 1', 5)
        const b = await analyzed('SB 1', 7)
        await group(a, b)
        await moved(a)
        await moved(b)
        await moved(await analyzed('HB 9', 1))
        const id = await seedRow()
        expect(metaOf(await feed(), id).count).toBe(2)

        expect((await patch(`/bills/${a}/priority`, { priority: 'low' })).status).toBe(200)

        expect(metaOf(await feed(), id).count).toBe(1)
        expect((await list(id)).entries.map((e) => e.bills[0].billNumber)).toEqual(['HB 9'])
      })

      it('keeps a dismissed new match in the row, now a plain entry', async () => {
        const b = await analyzed('HB 1', 5, { matchType: 'keyword', newMatchAt: '2026-03-01 08:00:00' })
        await moved(b)
        const id = await seedRow()
        expect((await list(id)).entries[0].newMatch).toBe(true)

        expect((await patch(`/bills/${b}/triage-dismiss`)).status).toBe(200)

        const body = await list(id)
        expect(body.entries.map((e) => [e.bills[0].id, e.newMatch])).toEqual([[b, false]])
        expect(metaOf(await feed(), id).count).toBe(1)
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
