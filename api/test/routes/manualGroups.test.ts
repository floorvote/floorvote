import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { asc, eq } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { billGroupOverrides, bills, comments, officialPositions, teamEvents } from '../../src/db/schema'
import { rowidOf } from '../../src/db/rowid'
import { previewSplit, syncIdenticalCompanions } from '../../src/lib/companionGroups'
import { centralFetch } from '../../src/lib/centralFetch'

// Grouping and splitting bills by hand (#382). An admin groups any two bills
// in the instance, or splits a bill from its companion group, from the bill
// page's overflow menu. The override is kept per instance and every sync's
// recompute reads it with the provider's identical links, so a split stays
// split while the provider still says identical, and a manual group stays
// grouped while the provider names no relationship.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

type Detail = {
  groupBills: Array<{ billId: string; billNumber: string; state: string; sessionSlug: string; status: string }>
  comments: Array<{ id: string }>
  position: { position: string } | null
  groupingEvents: Array<{ type: string; actorName: string | null; with: Array<{ billNumber: string }>; undoneSplits?: Array<Array<{ billNumber: string }>>; commentBills?: Array<{ billId: string; billNumber: string }> }>
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
    await clearDb()
    send.mockReset()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockResolvedValue(new Response('{}', { status: 200 }))
    for (const [name, role] of [['ann', 'member'], ['ada', 'admin'], ['olive', 'owner']] as const) {
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

  describe('an owner', () => {
    // The owner role holds every admin ability, so all three routes take it.
    it('groups, previews a split, and splits, as an admin does', async () => {
      expect((await groupWith('olive', 'a190', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713')).toEqual(['a190', 'a190'])
      expect((await as('olive', '/bills/b1713/split-preview')).status).toBe(200)
      expect((await splitOff('olive', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713')).toEqual([null, null])
      const events = await db().select().from(teamEvents).where(eq(teamEvents.actorUserId, user.olive)).all()
      expect(events.map(e => [e.billId, e.type]).sort()).toEqual([['a190', 'grouped'], ['a190', 'split'], ['b1713', 'grouped'], ['b1713', 'split']])
    })
  })

  describe('grouping', () => {
    it('groups bills from different states and sessions, since the picker and the route take any two in the instance', async () => {
      await seedBill({ id: 'g5000', billNumber: 'TX5000', state: 'TX', session: '2027', sessionId: '9', externalId: 'legiscan:5000' })
      const res = await groupWith('ada', 'a190', 'g5000')
      expect(res.status).toBe(200)
      expect(await keys('a190', 'g5000')).toEqual(['a190', 'a190'])
      expect(((await res.json()) as { groupBills: Array<{ billNumber: string }> }).groupBills.map(b => b.billNumber)).toEqual(['A190', 'TX5000'])
      // A later sync that names neither bill's companions leaves them grouped.
      await sync('legiscan:190', [])
      await sync('legiscan:5000', [])
      expect(await keys('a190', 'g5000')).toEqual(['a190', 'a190'])
      // And each bill's page shows the other in its group.
      expect((await detail('g5000')).groupBills.map(b => b.billNumber)).toEqual(['TX5000', 'A190'])
    })

    it('groups two bills no provider links, in a state that publishes no companion data', async () => {
      const res = await groupWith('ada', 'c1714', 'd2000')
      expect(res.status).toBe(200)
      expect(await keys('c1714', 'd2000')).toEqual(['c1714', 'c1714'])
      expect((await detail('d2000')).groupBills.map(b => b.billNumber)).toEqual(['H2000', 'S1714'])
    })

    it('lists a hand-made group on both pages with each bill\'s state and session slug, though no provider relates the bills', async () => {
      await db().update(bills).set({ sessionSlug: '2026' }).where(eq(bills.id, 'c1714'))
      await db().update(bills).set({ sessionSlug: '2025-2026' }).where(eq(bills.id, 'd2000'))
      expect((await groupWith('ada', 'c1714', 'd2000')).status).toBe(200)
      expect((await detail('c1714')).groupBills).toEqual([
        { billId: 'c1714', billNumber: 'S1714', state: 'RI', sessionSlug: '2026', status: '' },
        { billId: 'd2000', billNumber: 'H2000', state: 'RI', sessionSlug: '2025-2026', status: '' },
      ])
      expect((await detail('d2000')).groupBills.map(b => [b.billNumber, b.state, b.sessionSlug])).toEqual([['H2000', 'RI', '2025-2026'], ['S1714', 'RI', '2026']])
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

  describe('the split preview matches the split', () => {
    // The confirmation's text is the admin's only warning, so what it says the rest will fall into must be
    // what the split leaves. Each shape is previewed, then split for real, and the two compared.
    const NUMBERS: Record<string, string> = { a190: 'A190', b1713: 'S1713', c1714: 'S1714', d2000: 'H2000', e3000: 'H3000', f4000: 'H4000' }
    const HANDLE: Record<string, number> = { a190: 190, b1713: 1713, c1714: 1714, d2000: 2000, e3000: 3000, f4000: 4000 }

    /** Deliver each pair as the provider names it: the bill with the smaller id names the other. */
    const linkAll = async (...pairs: Array<[string, string]>) => {
      const named = new Map<string, number[]>()
      for (const [a, b] of pairs) named.set(a, [...(named.get(a) ?? []), HANDLE[b]])
      for (const [a, companions] of named) await sync(`legiscan:${HANDLE[a]}`, companions)
    }
    /** The groups the rest fell into, by bill number, as the keys the split really left. */
    async function leftBy(billId: string, rest: string[]): Promise<string[][]> {
      const rows = await db().select({ id: bills.id, k: bills.groupKey }).from(bills).all()
      const key = (id: string) => rows.find(r => r.id === id)!.k ?? `alone:${id}`
      const byKey = new Map<string, string[]>()
      for (const id of rest) byKey.set(key(id), [...(byKey.get(key(id)) ?? []), NUMBERS[id]])
      return [...byKey.values()].map(p => p.sort((x, y) => x.localeCompare(y, 'en', { numeric: true }))).sort((x, y) => x[0].localeCompare(y[0], 'en', { numeric: true }))
    }
    async function expectPreviewMatchesSplit(billId: string, rest: string[], expected: string[][]) {
      const overridesBefore = await db().select().from(billGroupOverrides).all()
      const parts = await previewSplit(db(), billId)
      const previewed = parts!.map(p => p.map(b => b.billNumber))
      expect(previewed).toEqual(expected)
      // Previewing wrote nothing.
      expect(await db().select().from(billGroupOverrides).all()).toEqual(overridesBefore)
      expect((await splitOff('ada', billId)).status).toBe(200)
      expect(await leftBy(billId, rest)).toEqual(previewed)
    }
    const extra = async () => {
      await seedBill({ id: 'e3000', billNumber: 'H3000', state: 'RI', externalId: 'legiscan:3000' })
      await seedBill({ id: 'f4000', billNumber: 'H4000', state: 'RI', externalId: 'legiscan:4000' })
    }

    it('a group of two leaves one bill alone', async () => {
      await linkAll(['b1713', 'a190'])
      await expectPreviewMatchesSplit('b1713', ['a190'], [['A190']])
      expect((await previewSplit(db(), 'b1713'))).toBeNull()
    })

    it('a triangle leaves the other two together, whichever bill goes', async () => {
      await linkAll(['a190', 'b1713'], ['a190', 'c1714'], ['b1713', 'c1714'])
      await expectPreviewMatchesSplit('a190', ['b1713', 'c1714'], [['S1713', 'S1714']])
    })

    it('a star splits into singles when its hub goes', async () => {
      await linkAll(['b1713', 'a190'], ['b1713', 'c1714'], ['b1713', 'd2000'])
      await expectPreviewMatchesSplit('b1713', ['a190', 'c1714', 'd2000'], [['A190'], ['H2000'], ['S1714']])
    })

    it('a star keeps together when a leaf goes', async () => {
      await linkAll(['b1713', 'a190'], ['b1713', 'c1714'], ['b1713', 'd2000'])
      await expectPreviewMatchesSplit('a190', ['b1713', 'c1714', 'd2000'], [['H2000', 'S1713', 'S1714']])
    })

    it('a chain comes apart where the bill was its middle', async () => {
      await linkAll(['a190', 'b1713'], ['b1713', 'c1714'], ['c1714', 'd2000'])
      await expectPreviewMatchesSplit('b1713', ['a190', 'c1714', 'd2000'], [['A190'], ['H2000', 'S1714']])
    })

    it('a ring of four stays whole without one of its bills', async () => {
      await linkAll(['a190', 'b1713'], ['b1713', 'c1714'], ['c1714', 'd2000'], ['a190', 'd2000'])
      await expectPreviewMatchesSplit('b1713', ['a190', 'c1714', 'd2000'], [['A190', 'H2000', 'S1714']])
    })

    it('a group joined by hand comes apart at the bill the admin joined it through', async () => {
      await linkAll(['b1713', 'a190'])
      expect((await groupWith('ada', 'b1713', 'c1714')).status).toBe(200)
      await expectPreviewMatchesSplit('b1713', ['a190', 'c1714'], [['A190'], ['S1714']])
    })

    it('a group across states, joined by hand, is previewed as it splits', async () => {
      await seedBill({ id: 'g5000', billNumber: 'TX5000', state: 'TX', externalId: 'legiscan:5000' })
      expect((await groupWith('ada', 'a190', 'g5000')).status).toBe(200)
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      NUMBERS.g5000 = 'TX5000'
      await expectPreviewMatchesSplit('a190', ['b1713', 'g5000'], [['S1713'], ['TX5000']])
    })

    it('a group holding an earlier split keeps that split in the preview', async () => {
      // H2000 was split from A190 and stays out, and S1714 is identical to A190, S1713, and H2000.
      await extra()
      await linkAll(['a190', 'b1713'], ['a190', 'c1714'], ['b1713', 'c1714'], ['d2000', 'c1714'])
      expect((await splitOff('ada', 'd2000')).status).toBe(200)
      const rest = ['a190', 'c1714']
      const parts = (await previewSplit(db(), 'b1713'))!.map(p => p.map(b => b.billNumber))
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect(await leftBy('b1713', rest)).toEqual(parts)
    })

    it('a bill in no group has nothing to preview', async () => {
      expect(await previewSplit(db(), 'a190')).toBeNull()
    })
  })

  describe('grouping again what was split', () => {
    // Grouping a bill again with one it was split from undoes that split, and takes every other split between
    // the two groups with it, since a split is a cannot-link and nothing else deletes one. The admin is told
    // which, before (the preview) and after (the response and the grouping event).
    type Undone = Array<Array<{ billId: string; billNumber: string }>>
    const names = (pairs: Undone | undefined) => (pairs ?? []).map(p => p.map(b => b.billNumber))
    const groupPreview = (name: string, billId: string, withBillId: string) =>
      as(name, `/bills/${billId}/group-preview?withBillId=${withBillId}`)

    /** H3000 split from a group of A190 and S1713, so it holds a split with each. */
    async function splitOffThreeGroup() {
      await seedBill({ id: 'e3000', billNumber: 'H3000', state: 'RI', externalId: 'legiscan:3000' })
      await sync('legiscan:3000', [1713, 190])
      await sync('legiscan:1713', [190])
      expect((await splitOff('ada', 'e3000')).status).toBe(200)
    }

    it('previews no undone split for two bills that were never split, and writes nothing', async () => {
      const res = await groupPreview('ada', 'c1714', 'd2000')
      expect(res.status).toBe(200)
      expect(((await res.json()) as { undoneSplits: Undone }).undoneSplits).toEqual([])
      expect(await keys('c1714', 'd2000')).toEqual([null, null])
      expect(await db().select().from(billGroupOverrides).all()).toEqual([])
    })

    it('previews the one split of a pair, by bill number', async () => {
      await sync('legiscan:1713', [190])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      const res = await groupPreview('ada', 'b1713', 'a190')
      expect(names(((await res.json()) as { undoneSplits: Undone }).undoneSplits)).toEqual([['A190', 'S1713']])
    })

    it('previews every split between the two groups, including the ones the bill was not a part of', async () => {
      await splitOffThreeGroup()
      // Regrouping H3000 with A190 also takes back its split from S1713, which it never named.
      const res = await groupPreview('ada', 'e3000', 'a190')
      expect(res.status).toBe(200)
      expect(names(((await res.json()) as { undoneSplits: Undone }).undoneSplits)).toEqual([['A190', 'H3000'], ['H3000', 'S1713']])
      expect(await db().select().from(billGroupOverrides).where(eq(billGroupOverrides.kind, 'split')).all()).toHaveLength(2)
    })

    it('previews the same from either bill of the pair', async () => {
      await splitOffThreeGroup()
      const fromHere = names(((await (await groupPreview('ada', 'e3000', 'a190')).json()) as { undoneSplits: Undone }).undoneSplits)
      const fromThere = names(((await (await groupPreview('ada', 'a190', 'e3000')).json()) as { undoneSplits: Undone }).undoneSplits)
      expect(fromThere).toEqual(fromHere)
    })

    it('answers the preview with the refusals the grouping would give', async () => {
      await sync('legiscan:1713', [190])
      await seedBill({ id: 'e-draft', billNumber: 'DRAFT-1', state: 'RI', isDraft: true })
      expect((await groupPreview('ada', 'a190', 'b1713')).status).toBe(409)
      expect((await groupPreview('ada', 'a190', 'a190')).status).toBe(400)
      expect((await groupPreview('ada', 'a190', 'e-draft')).status).toBe(400)
      expect((await groupPreview('ada', 'a190', 'nope')).status).toBe(404)
      expect((await as('ada', '/bills/a190/group-preview')).status).toBe(400)
      expect((await groupPreview('ann', 'a190', 'd2000')).status).toBe(403)
      expect((await groupPreview('olive', 'a190', 'd2000')).status).toBe(200)
    })

    it('answers a preview that would be a refused conflict with the same refusal as the grouping', async () => {
      await sync('legiscan:1713', [190])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      await sync('legiscan:1714', [1713])
      const refused = await groupWith('ada', 'c1714', 'a190')
      const previewed = await groupPreview('ada', 'c1714', 'a190')
      expect([refused.status, previewed.status]).toEqual([409, 409])
      expect(await previewed.json()).toEqual(await refused.json())
    })

    it('reports an ordinary grouping as undoing nothing', async () => {
      const body = await (await groupWith('ada', 'c1714', 'd2000')).json() as { undoneSplitCount: number; undoneSplits: Undone }
      expect(body.undoneSplitCount).toBe(0)
      expect(body.undoneSplits).toEqual([])
    })

    it('reports the split a regrouped pair undoes', async () => {
      await sync('legiscan:1713', [190])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      const body = await (await groupWith('ada', 'b1713', 'a190')).json() as { undoneSplitCount: number; undoneSplits: Undone }
      expect(body.undoneSplitCount).toBe(1)
      expect(names(body.undoneSplits)).toEqual([['A190', 'S1713']])
    })

    it('reports every split a regrouping undoes, and agrees with what the preview said', async () => {
      await splitOffThreeGroup()
      const said = names(((await (await groupPreview('ada', 'e3000', 'a190')).json()) as { undoneSplits: Undone }).undoneSplits)
      const body = await (await groupWith('ada', 'e3000', 'a190')).json() as { undoneSplitCount: number; undoneSplits: Undone }
      expect(body.undoneSplitCount).toBe(2)
      expect(names(body.undoneSplits)).toEqual(said)
      expect(await db().select().from(billGroupOverrides).where(eq(billGroupOverrides.kind, 'split')).all()).toEqual([])
    })

    it('records the undone splits on the grouping event, so the page still shows them later', async () => {
      await splitOffThreeGroup()
      expect((await groupWith('ada', 'e3000', 'a190')).status).toBe(200)
      // The sync that first grouped the three wrote an event of its own, with no actor.
      const grouped = (await detail('e3000')).groupingEvents.filter(e => e.type === 'grouped' && e.actorName === 'ada')
      expect(grouped).toHaveLength(1)
      expect(names(grouped[0].undoneSplits as Undone)).toEqual([['A190', 'H3000'], ['H3000', 'S1713']])
    })

    it('records no undone splits on the event of an ordinary grouping, nor on a split', async () => {
      expect((await groupWith('ada', 'c1714', 'd2000')).status).toBe(200)
      expect((await splitOff('ada', 'c1714')).status).toBe(200)
      const events = (await detail('c1714')).groupingEvents
      expect(events.map(e => [e.type, e.undoneSplits ?? []])).toEqual([['grouped', []], ['split', []]])
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

  describe('a chain from a split bill into an intact group', () => {
    it('keeps the group whole, and only the bills of the chain drop out', async () => {
      // A190, S1714, and H2000 stay grouped after S1713 is split from them.
      await sync('legiscan:190', [1713, 1714, 2000])
      await sync('legiscan:1714', [2000])
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect(await keys('a190', 'b1713', 'c1714', 'd2000')).toEqual(['a190', null, 'a190', 'a190'])
      // H3000 is identical to H2000, and H4000 to H3000 and S1713: a chain
      // back to S1713 with no bill identical to both sides.
      await seedBill({ id: 'e3000', billNumber: 'H3000', state: 'RI', externalId: 'legiscan:3000' })
      await seedBill({ id: 'f4000', billNumber: 'H4000', state: 'RI', externalId: 'legiscan:4000' })
      await sync('legiscan:3000', [2000])
      await sync('legiscan:4000', [3000, 1713])
      expect(await keys('a190', 'b1713', 'c1714', 'd2000', 'e3000', 'f4000')).toEqual(['a190', null, 'a190', 'a190', null, null])
    })
  })

  // The bills a hand-made grouping or split line is about because a comment was posted on them before it.
  // The line itself always appears when an admin made it (the web decides that), but whether it has a
  // comments sentence follows `commentBills`.
  describe('the bills whose earlier comments a hand-made line explains', () => {
    const named = async (billId: string) => (await detail(billId)).groupingEvents.map(e => [e.type, e.actorName, e.commentBills ? e.commentBills.map(b => b.billNumber) : 'absent'])

    it('is empty for a grouping by hand when neither bill has comments', async () => {
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      expect(await named('a190')).toEqual([['grouped', 'ada', []]])
    })

    it('names the other bill when it had a comment before the admin grouped them', async () => {
      await db().insert(comments).values({ id: 'c1', billId: 'b1713', userId: user.ann, content: '<p>hi</p>', createdAt: '2020-01-01 00:00:00' })
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      expect(await named('a190')).toEqual([['grouped', 'ada', ['S1713']]])
      expect((await detail('a190')).groupingEvents[0].commentBills).toEqual([{ billId: 'b1713', billNumber: 'S1713' }])
      expect(await named('b1713')).toEqual([['grouped', 'ada', []]])
    })

    it('names the bill that left on a split by hand, though its comments are no longer served', async () => {
      await db().insert(comments).values({ id: 'c1', billId: 'b1713', userId: user.ann, content: '<p>hi</p>', createdAt: '2020-01-01 00:00:00' })
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect((await detail('a190')).comments).toEqual([])
      expect(await named('a190')).toEqual([['grouped', 'ada', ['S1713']], ['split', 'ada', ['S1713']]])
      // On S1713's own page the split event is about A190, which had no comments.
      expect(await named('b1713')).toEqual([['grouped', 'ada', []], ['split', 'ada', []]])
    })

    it('is empty for a split by hand when the bill that left had no earlier comments', async () => {
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect(await named('a190')).toEqual([['grouped', 'ada', []], ['split', 'ada', []]])
    })

    it('reads a split followed by a regroup, naming the bill again on the regrouping when it commented in between', async () => {
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      expect((await splitOff('ada', 'b1713')).status).toBe(200)
      expect((await groupWith('ada', 'a190', 'b1713')).status).toBe(200)
      // Dated so the comment falls between the split and the regrouping.
      const rows = await db().select({ id: teamEvents.id }).from(teamEvents).where(eq(teamEvents.billId, 'a190')).orderBy(rowidOf(teamEvents)).all()
      expect(rows).toHaveLength(3)
      for (const [i, at] of ['2026-10-01 12:00:00', '2026-10-02 12:00:00', '2026-10-04 12:00:00'].entries()) {
        await db().update(teamEvents).set({ createdAt: at }).where(eq(teamEvents.id, rows[i].id))
      }
      await db().insert(comments).values({ id: 'c1', billId: 'b1713', userId: user.ann, content: '<p>hi</p>', createdAt: '2026-10-03 12:00:00' })
      expect(await named('a190')).toEqual([['grouped', 'ada', []], ['split', 'ada', []], ['grouped', 'ada', ['S1713']]])
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
