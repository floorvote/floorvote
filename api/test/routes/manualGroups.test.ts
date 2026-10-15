import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { asc, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { billGroupOverrides, bills, comments, officialPositions, teamEvents } from '../../src/db/schema'
import { syncIdenticalCompanions } from '../../src/lib/companionGroups'
import { centralFetch } from '../../src/lib/centralFetch'

// Grouping and splitting bills by hand (#382). An admin groups any two bills
// in the instance, or splits a bill from its companion group, from the bill
// page's overflow menu. The override is kept per instance and every sync's
// recompute reads it with the provider's identical links, so a split stays
// split while the provider still says identical, and a manual group stays
// grouped while the provider names no relationship.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

type Detail = {
  groupBills: Array<{ billId: string; billNumber: string }>
  comments: Array<{ id: string }>
  position: { position: string } | null
  groupingEvents: Array<{ type: string; actorName: string | null; with: Array<{ billNumber: string }> }>
}

describe('grouping and splitting bills by hand', () => {
  const cookie: Record<string, string> = {}
  const user: Record<string, string> = {}
  const db = () => getDb(env.DB)
  const send = vi.fn()
  const testEnv = () => ({ ...env, TENANT_ID: 'test-org', BILL_QUEUE: { send, sendBatch: vi.fn() } }) as unknown as typeof env

  async function as(name: string, path: string, init: RequestInit = {}) {
    return app.request(`/api${path}`, {
      ...init,
      headers: { Cookie: cookie[name], 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    }, testEnv())
  }
  const groupWith = (name: string, billId: string, withBillId: string) =>
    as(name, `/bills/${billId}/group`, { method: 'POST', body: JSON.stringify({ withBillId }) })
  const splitOff = (name: string, billId: string) => as(name, `/bills/${billId}/split`, { method: 'POST' })
  async function detail(billId: string): Promise<Detail> {
    const res = await as('ann', `/bills/${billId}`)
    expect(res.status).toBe(200)
    return await res.json() as Detail
  }
  async function keys(...ids: string[]) {
    const rows = await db().select({ id: bills.id, k: bills.groupKey }).from(bills).all()
    return ids.map(id => rows.find(r => r.id === id)?.k ?? null)
  }
  // A sync of a bill's identical relationships, as each delivery from central runs it.
  const sync = (handle: string, companions: number[]) =>
    syncIdenticalCompanions(db(), handle, companions.map(sastBillId => ({ sastBillId, kind: 'identical' })))

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    send.mockReset()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockResolvedValue(new Response('{}', { status: 200 }))
    for (const [name, role] of [['ann', 'member'], ['ada', 'admin']] as const) {
      user[name] = await seedUser({ name, email: `${name}@example.com`, role })
      cookie[name] = `session=${await seedSession(user[name])}`
    }
    // Ids sort a < b < c < d, so a group's key is its first bill's id.
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'RI', externalId: 'legiscan:190' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'RI', externalId: 'legiscan:1713' })
    await seedBill({ id: 'c1714', billNumber: 'S1714', state: 'RI', externalId: 'legiscan:1714' })
    await seedBill({ id: 'd2000', billNumber: 'H2000', state: 'RI', externalId: 'legiscan:2000' })
  })

  describe('permission', () => {
    it('refuses a standard member, who can neither group nor split bills', async () => {
      await sync('legiscan:1713', [190])
      expect((await groupWith('ann', 'c1714', 'd2000')).status).toBe(403)
      expect((await splitOff('ann', 'b1713')).status).toBe(403)
      expect(await keys('a190', 'b1713', 'c1714', 'd2000')).toEqual(['a190', 'a190', null, null])
    })
  })

  describe('grouping', () => {
    it('groups two bills no provider links, in a state that publishes no companion data', async () => {
      const res = await groupWith('ada', 'c1714', 'd2000')
      expect(res.status).toBe(200)
      expect(await keys('c1714', 'd2000')).toEqual(['c1714', 'c1714'])
      expect((await detail('d2000')).groupBills.map(b => b.billNumber)).toEqual(['H2000', 'S1714'])
    })

    it("joins the bill's group with the other bill's group", async () => {
      await sync('legiscan:1713', [190])
      expect((await groupWith('ada', 'c1714', 'd2000')).status).toBe(200)
      expect((await groupWith('ada', 'b1713', 'd2000')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'c1714', 'd2000')).toEqual(['a190', 'a190', 'a190', 'a190'])
    })

    it('refuses two bills already in one group, and stores no override for them', async () => {
      // A190 and S1714 are grouped through S1713, not with each other.
      await sync('legiscan:190', [1713])
      await sync('legiscan:1714', [1713])
      const res = await groupWith('ada', 'a190', 'c1714')
      expect(res.status).toBe(409)
      expect(await db().select().from(billGroupOverrides).all()).toEqual([])
      expect(await db().select().from(teamEvents).where(eq(teamEvents.actorUserId, user.ada)).all()).toEqual([])
    })

    it("refuses the bill itself, a draft, and a bill that doesn't exist", async () => {
      await seedBill({ id: 'e-draft', billNumber: 'DRAFT-1', state: 'RI', isDraft: true })
      expect((await groupWith('ada', 'a190', 'a190')).status).toBe(400)
      expect((await groupWith('ada', 'a190', 'e-draft')).status).toBe(400)
      expect((await groupWith('ada', 'e-draft', 'a190')).status).toBe(400)
      expect((await groupWith('ada', 'a190', 'nope')).status).toBe(404)
      expect((await as('ada', '/bills/a190/group', { method: 'POST', body: '{}' })).status).toBe(400)
      expect(await keys('a190', 'e-draft')).toEqual([null, null])
    })

    it("queues the analysis of a companion that didn't match once it is grouped with a tracked bill", async () => {
      await seedBill({ id: 'e300', billNumber: 'S300', state: 'RI', externalId: 'legiscan:300', matchType: null, textR2Key: 'texts/300.pdf' })
      expect((await groupWith('ada', 'a190', 'e300')).status).toBe(200)
      expect(send).toHaveBeenCalledWith({ tenantId: 'test-org', billId: 'legiscan:300', groupAnalysis: true })
    })
  })

  describe('splitting', () => {
    it('removes the bill from its group and gives each bill back its own engagement', async () => {
      await sync('legiscan:1713', [190])
      await db().insert(comments).values({ id: 'c1', billId: 'a190', userId: user.ann, content: '<p>on A190</p>', createdAt: '2026-10-01 09:00:00' })
      await db().insert(comments).values({ id: 'c2', billId: 'b1713', userId: user.ann, content: '<p>on S1713</p>', createdAt: '2026-10-01 10:00:00' })
      await db().insert(officialPositions).values([
        { id: 'p1', billId: 'a190', position: 'Support', setBy: user.ada, updatedAt: '2026-10-01 09:00:00' },
        { id: 'p2', billId: 'b1713', position: 'Oppose', setBy: user.ada, updatedAt: '2026-10-01 10:00:00' },
      ])
      expect((await detail('a190')).position?.position).toBe('Oppose')

      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713')).toEqual([null, null])
      const a = await detail('a190')
      expect([a.comments.map(c => c.id), a.position?.position, a.groupBills.length]).toEqual([['c1'], 'Support', 1])
      const b = await detail('b1713')
      expect([b.comments.map(c => c.id), b.position?.position]).toEqual([['c2'], 'Oppose'])
    })

    it('lets the rest follow their own links, so a chain joined only through the bill comes apart', async () => {
      // A190 and S1714 each name S1713, and not each other.
      await sync('legiscan:190', [1713])
      await sync('legiscan:1714', [1713])
      expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', 'a190', 'a190'])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'c1714')).toEqual([null, null, null])
      expect(await db().select().from(billGroupOverrides).where(eq(billGroupOverrides.kind, 'link')).all()).toEqual([])
    })

    it('keeps the rest grouped where their own links join them', async () => {
      // A190 names both, so A190 and S1714 are linked without S1713.
      await sync('legiscan:190', [1713, 1714])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', null, 'a190'])
    })

    it('refuses a bill in no group', async () => {
      expect((await splitOff('ada', 'a190')).status).toBe(409)
      expect((await splitOff('ada', 'nope')).status).toBe(404)
    })
  })

  describe('split preview', () => {
    type Preview = { billNumber: string; parts: Array<Array<{ billId: string; billNumber: string }>> }
    const preview = (name: string, billId: string) => as(name, `/bills/${billId}/split-preview`)
    const numbers = async (res: Response) => ((await res.json()) as Preview).parts.map(p => p.map(b => b.billNumber))

    it('names the groups the rest would fall into, and writes nothing', async () => {
      await sync('legiscan:190', [1713])
      await sync('legiscan:1714', [1713])
      const res = await preview('ada', 'b1713')
      expect(res.status).toBe(200)
      expect(await numbers(res)).toEqual([['A190'], ['S1714']])
      expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', 'a190', 'a190'])
      expect(await db().select().from(billGroupOverrides).all()).toEqual([])
    })

    it('names one part when the rest stay together', async () => {
      await sync('legiscan:190', [1713, 1714])
      expect(await numbers(await preview('ada', 'b1713'))).toEqual([['A190', 'S1714']])
    })

    it('refuses a standard member, a bill in no group, and an unknown bill', async () => {
      await sync('legiscan:1713', [190])
      expect((await preview('ann', 'b1713')).status).toBe(403)
      expect((await preview('ada', 'c1714')).status).toBe(409)
      expect((await preview('ada', 'nope')).status).toBe(404)
    })
  })

  describe('later syncs', () => {
    it('keep a split bill split while the provider still names the bills identical', async () => {
      await sync('legiscan:1713', [190])
      await sync('legiscan:190', [1713])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      await sync('legiscan:1713', [190])
      await sync('legiscan:190', [1713])
      expect(await keys('a190', 'b1713')).toEqual([null, null])
    })

    it('keep bills grouped by hand grouped while the provider names no relationship', async () => {
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      await sync('legiscan:190', [])
      await sync('legiscan:1713', [])
      expect(await keys('a190', 'b1713')).toEqual(['a190', 'a190'])
    })

    it('keep a split undone by grouping the bill again by hand', async () => {
      await sync('legiscan:1713', [190])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713')).toEqual([null, null])
      expect((await groupWith('ada', 'b1713', 'a190')).status).toBe(200)
      await sync('legiscan:1713', [190])
      expect(await keys('a190', 'b1713')).toEqual(['a190', 'a190'])
    })

    it('undo a split from a group of three when the bill is grouped again with one of them', async () => {
      // Grouping again with a bill it was split from takes back its splits
      // from the rest of that bill's group too.
      await seedBill({ id: 'e3000', billNumber: 'H3000', state: 'RI', externalId: 'legiscan:3000' })
      await sync('legiscan:3000', [1713, 190])
      await sync('legiscan:1713', [190])
      expect((await splitOff('ada', 'e3000')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'e3000')).toEqual(['a190', 'a190', null])
      expect((await groupWith('ada', 'e3000', 'a190')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'e3000')).toEqual(['a190', 'a190', 'a190'])
      expect(await db().select().from(billGroupOverrides).where(eq(billGroupOverrides.kind, 'split')).all()).toEqual([])
    })
  })

  describe('bills split apart, and a bill linked to both', () => {
    // A190 and S1713 were identical, and an admin split them.
    beforeEach(async () => {
      await sync('legiscan:1713', [190])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
    })

    it('keeps a new bill identical to both out of both groups', async () => {
      await sync('legiscan:2000', [190, 1713])
      expect(await keys('a190', 'b1713', 'd2000')).toEqual([null, null, null])
    })

    it('keeps it out of both whichever bill names the links, and in whatever order they arrive', async () => {
      await sync('legiscan:190', [2000])
      await sync('legiscan:1713', [2000])
      await sync('legiscan:2000', [])
      expect(await keys('a190', 'b1713', 'd2000')).toEqual([null, null, null])
    })

    it('lets an admin group that bill with one of them, and the other stays out', async () => {
      await sync('legiscan:2000', [190, 1713])
      expect((await groupWith('ada', 'd2000', 'a190')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'd2000')).toEqual(['a190', null, 'a190'])
      // And the provider's next word on any of them changes nothing.
      await sync('legiscan:2000', [190, 1713])
      expect(await keys('a190', 'b1713', 'd2000')).toEqual(['a190', null, 'a190'])
    })

    it('refuses to group a bill with one of them while its group holds the other, naming the two', async () => {
      // S1714 is identical to S1713, so it's in S1713's group.
      await sync('legiscan:1714', [1713])
      expect(await keys('b1713', 'c1714')).toEqual(['b1713', 'b1713'])
      const res = await groupWith('ada', 'c1714', 'a190')
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toBe(
        'A190 and S1713 were split apart, and grouping S1714 with A190 would group them again. To undo that split, group A190 with S1713.')
      expect(await keys('a190', 'b1713', 'c1714')).toEqual([null, 'b1713', 'b1713'])
    })

    it('keeps the rest of a group whole when a new bill is identical to all of it and to the bill split off', async () => {
      // S1714 and H2000 join A190, which is then split from them and grouped with S1713 again.
      await sync('legiscan:1714', [190])
      await sync('legiscan:2000', [190, 1714])
      expect((await splitOff('ada', 'a190')).status).toBe(200)
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'c1714', 'd2000')).toEqual(['a190', 'a190', 'c1714', 'c1714'])
      // A new bill names all four.
      await seedBill({ id: 'e3000', billNumber: 'H3000', state: 'RI', externalId: 'legiscan:3000' })
      await sync('legiscan:3000', [190, 1713, 1714, 2000])
      expect(await keys('a190', 'b1713', 'c1714', 'd2000', 'e3000')).toEqual(['a190', 'a190', 'c1714', 'c1714', null])
    })

    it('keeps both bills of a chain between them out, since each is as much to blame', async () => {
      // H2000 is identical to A190, and H3000 to H2000 and S1713.
      await seedBill({ id: 'e3000', billNumber: 'H3000', state: 'RI', externalId: 'legiscan:3000' })
      await sync('legiscan:2000', [190])
      expect(await keys('a190', 'd2000')).toEqual(['a190', 'a190'])
      await sync('legiscan:3000', [2000, 1713])
      expect(await keys('a190', 'b1713', 'd2000', 'e3000')).toEqual([null, null, null, null])
    })

    it('regroups the bills a dropped link had kept apart, though neither was delivered', async () => {
      // The provider no longer names A190 and S1713 identical, so only the chain connects them.
      await sync('legiscan:1713', [])
      await seedBill({ id: 'e3000', billNumber: 'H3000', state: 'RI', externalId: 'legiscan:3000' })
      await sync('legiscan:2000', [190])
      await sync('legiscan:3000', [2000, 1713])
      expect(await keys('a190', 'b1713', 'd2000', 'e3000')).toEqual([null, null, null, null])
      // The provider stops naming H2000 as H3000's companion, so nothing
      // connects A190 and S1713 any more, and H2000 rejoins A190.
      await sync('legiscan:3000', [1713])
      expect(await keys('a190', 'b1713', 'd2000', 'e3000')).toEqual(['a190', 'b1713', 'a190', 'b1713'])
    })
  })

  describe('team events', () => {
    it('records both actions with the admin as actor, and the grouping line names them', async () => {
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      expect((await splitOff('ada', 'b1713')).status).toBe(200)

      const rows = await db().select().from(teamEvents).orderBy(asc(teamEvents.createdAt), asc(teamEvents.type)).all()
      expect(rows.map(r => [r.billId, r.type, r.actorUserId]).sort()).toEqual([
        ['a190', 'grouped', user.ada], ['a190', 'split', user.ada],
        ['b1713', 'grouped', user.ada], ['b1713', 'split', user.ada],
      ])
      const events = (await detail('a190')).groupingEvents
      expect(events.map(e => [e.type, e.actorName, e.with.map(w => w.billNumber)])).toEqual([
        ['grouped', 'ada', ['S1713']],
        ['split', 'ada', ['S1713']],
      ])
      expect(await db().select().from(teamEvents).where(eq(teamEvents.billId, 'c1714')).all()).toEqual([])
    })
  })
})
