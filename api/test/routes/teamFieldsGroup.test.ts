import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, billCustomFieldValues, bills, customFieldDefinitions, officialPositions, teamEvents } from '../../src/db/schema'
import { syncIdenticalCompanions } from '../../src/lib/companionGroups'
import { rowidOf } from '../../src/db/rowid'
import { centralFetch } from '../../src/lib/centralFetch'

// The team fields a companion group shares: official position, priority,
// custom field values, tags, triage, and the team summary. Each stays stored on
// the bill where it was set, and every member's page reads the one set most
// recently. Splitting the group gives each bill back its own.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

type Replaced = { field: string; fieldId?: string; label: string; billId: string; billNumber: string; value: string; replacedBy: { billId: string; billNumber: string; value: string } }
type Detail = {
  position: { position: string; setByName: string; updatedAt: string } | null
  priority: string | null
  customFieldValues: Record<string, { value: string; setBy: string | null; updatedAt: string }>
  tenantSummary: string | null
  tags: string[]
  triagedAt: string | null
  groupingEvents: Array<{ type: string; replaced: Replaced[] }>
}

describe('team fields across a companion group', () => {
  const cookie: Record<string, string> = {}
  const user: Record<string, string> = {}
  const db = () => getDb(env.DB)

  async function as(name: string, path: string, init: RequestInit = {}) {
    return SELF.fetch(`https://x/api${path}`, {
      ...init,
      headers: { Cookie: cookie[name], 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  }
  async function detail(billId: string, name = 'ada'): Promise<Detail> {
    const res = await as(name, `/bills/${billId}`)
    expect(res.status).toBe(200)
    return await res.json() as Detail
  }
  // What a member's page shows for each shared value, in one comparable shape.
  async function shown(billId: string) {
    const d = await detail(billId)
    return {
      position: d.position?.position ?? null,
      priority: d.priority,
      committee: d.customFieldValues.cf1?.value ?? null,
      summary: d.tenantSummary,
      tags: d.tags,
    }
  }
  async function newMatchIds(): Promise<string[]> {
    const res = await as('ada', '/bills?newMatches=1')
    expect(res.status).toBe(200)
    // One row per group, which names its bills.
    return ((await res.json()) as { bills: Array<{ id: string; group?: Array<{ id: string }> }> }).bills.flatMap(b => b.group?.map(g => g.id) ?? [b.id]).sort()
  }
  async function fieldEvents(billId: string) {
    const rows = await db().select().from(teamEvents)
      .where(and(eq(teamEvents.billId, billId), eq(teamEvents.type, 'field_changed')))
      .orderBy(teamEvents.createdAt, rowidOf(teamEvents)).all()
    return rows.map(r => ({ actorUserId: r.actorUserId, ...JSON.parse(r.metadata) as Record<string, unknown> }))
  }

  const group = () => syncIdenticalCompanions(db(), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }])
  const split = () => syncIdenticalCompanions(db(), 'legiscan:1713', [])

  async function position(billId: string, value: string, updatedAt: string) {
    await db().insert(officialPositions).values({ id: crypto.randomUUID(), billId, position: value, setBy: user.ada, createdAt: updatedAt, updatedAt })
  }
  async function priority(billId: string, value: 'high' | 'medium' | 'low', setAt: string) {
    await db().update(bills).set({ priority: value, prioritySetAt: setAt }).where(eq(bills.id, billId))
  }
  async function committee(billId: string, value: string, updatedAt: string) {
    await db().insert(billCustomFieldValues).values({ billId, fieldId: 'cf1', value, setBy: user.ada, updatedAt })
  }
  async function analysis(billId: string, summary: string, tags: string[], aiProcessedAt: string) {
    await db().update(bills).set({ tenantSummary: summary, tags: JSON.stringify(tags), aiProcessedAt }).where(eq(bills.id, billId))
  }

  // A190's values were set at 10:00 for position and 09:00 for the rest;
  // S1713's the other way round.
  async function conflictingValues() {
    await position('a190', 'Support', '2026-10-01 10:00:00')
    await position('b1713', 'Oppose', '2026-10-01 09:00:00')
    await priority('a190', 'low', '2026-10-01 09:00:00')
    await priority('b1713', 'high', '2026-10-01 10:00:00')
    await committee('a190', 'Energy', '2026-10-01 09:00:00')
    await committee('b1713', 'Labor', '2026-10-01 10:00:00')
    await analysis('a190', 'A190 summary', ['Energy'], '2026-10-01 09:00:00')
    await analysis('b1713', 'S1713 summary', ['Labor'], '2026-10-01 10:00:00')
  }

  beforeEach(async () => {
    await clearDb()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    for (const [name, role] of [['ann', 'member'], ['ada', 'admin']] as const) {
      user[name] = await seedUser({ name, email: `${name}@example.com`, role })
      cookie[name] = `session=${await seedSession(user[name])}`
    }
    await db().insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }]) })
    await db().insert(customFieldDefinitions).values({ id: 'cf1', name: 'Committee', slug: 'committee', type: 'dropdown', options: JSON.stringify(['Energy', 'Labor']) })
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713' })
  })

  describe('reading', () => {
    it("shows every shared value the same on each member's page, the one set most recently, and the lead's analysis", async () => {
      await conflictingValues()
      await group()
      // A190 leads (equally far along, no texts, and its number comes first), so its analysis shows, though S1713's is newer.
      const expected = { position: 'Support', priority: 'high', committee: 'Labor', summary: 'A190 summary', tags: ['Energy'] }
      expect(await shown('a190')).toEqual(expected)
      expect(await shown('b1713')).toEqual(expected)
    })

    it("shows a value set on only one member on the other's page too", async () => {
      await position('a190', 'Support', '2026-10-01 10:00:00')
      await committee('b1713', 'Labor', '2026-10-01 10:00:00')
      await group()
      for (const id of ['a190', 'b1713']) {
        expect(await shown(id)).toMatchObject({ position: 'Support', committee: 'Labor' })
      }
    })

    it('breaks a same-second tie by the larger bill id, and counts a value with no time as the oldest', async () => {
      await position('a190', 'Support', '2026-10-01 10:00:00')
      await position('b1713', 'Oppose', '2026-10-01 10:00:00')
      await priority('a190', 'high', '2026-10-01 09:00:00')
      await db().update(bills).set({ priority: 'low', prioritySetAt: null }).where(eq(bills.id, 'b1713'))
      await group()
      for (const id of ['a190', 'b1713']) {
        expect(await shown(id)).toMatchObject({ position: 'Oppose', priority: 'high' })
      }
    })

    it("shows a member's triage on the other's page", async () => {
      await db().update(bills).set({ triagedAt: '2026-10-01 10:00:00', triagedBy: user.ada }).where(eq(bills.id, 'a190'))
      await group()
      expect((await detail('b1713')).triagedAt).toBe('2026-10-01 10:00:00')
    })
  })

  describe("setting a value on one member's page", () => {
    beforeEach(async () => {
      await conflictingValues()
      await group()
    })

    it('sets the position for the group, stored on that bill', async () => {
      expect((await as('ada', '/bills/b1713/position', { method: 'POST', body: JSON.stringify({ position: 'Amend' }) })).status).toBe(200)
      expect((await shown('a190')).position).toBe('Amend')
      const stored = await db().select().from(officialPositions).where(eq(officialPositions.billId, 'a190')).get()
      expect(stored?.position).toBe('Support')
    })

    it('sets the priority for the group, stored on that bill', async () => {
      expect((await as('ada', '/bills/a190/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'medium' }) })).status).toBe(200)
      expect((await shown('b1713')).priority).toBe('medium')
      const stored = await db().select({ priority: bills.priority }).from(bills).where(eq(bills.id, 'b1713')).get()
      expect(stored?.priority).toBe('high')
    })

    it('sets a custom field for the group, stored on that bill', async () => {
      expect((await as('ada', '/bills/a190/custom-fields', { method: 'PUT', body: JSON.stringify({ cf1: 'Energy' }) })).status).toBe(200)
      expect((await shown('b1713')).committee).toBe('Energy')
      const stored = await db().select().from(billCustomFieldValues).where(eq(billCustomFieldValues.billId, 'b1713')).get()
      expect(stored?.value).toBe('Labor')
    })

    it('clears a position, priority, or custom field for the whole group', async () => {
      expect((await as('ada', '/bills/b1713/position', { method: 'DELETE' })).status).toBe(204)
      expect((await as('ada', '/bills/a190/priority', { method: 'PATCH', body: JSON.stringify({ priority: null }) })).status).toBe(200)
      expect((await as('ada', '/bills/a190/custom-fields', { method: 'PUT', body: JSON.stringify({ cf1: null }) })).status).toBe(200)
      for (const id of ['a190', 'b1713']) {
        expect(await shown(id)).toMatchObject({ position: null, priority: null, committee: null })
      }
    })

    it('sets values for the group through a bulk edit of one member', async () => {
      const res = await as('ada', '/bills/bulk', { method: 'POST', body: JSON.stringify({ ids: ['a190'], priority: 'medium', position: 'Monitor', customFields: [{ fieldId: 'cf1', value: 'Energy' }] }) })
      expect(res.status).toBe(200)
      expect(await shown('b1713')).toMatchObject({ position: 'Monitor', priority: 'medium', committee: 'Energy' })
    })
  })

  describe('grouping', () => {
    it('resolves conflicting values to the most recent and lists what it replaced on each grouping event', async () => {
      await conflictingValues()
      await group()
      for (const id of ['a190', 'b1713']) {
        const events = (await detail(id)).groupingEvents
        expect(events.map(e => e.type)).toEqual(['grouped'])
        expect(events[0].replaced).toEqual([
          { field: 'position', label: 'position', billId: 'b1713', billNumber: 'S1713', value: 'Oppose', replacedBy: { billId: 'a190', billNumber: 'A190', value: 'Support' } },
          { field: 'priority', label: 'priority', billId: 'a190', billNumber: 'A190', value: 'Low', replacedBy: { billId: 'b1713', billNumber: 'S1713', value: 'High' } },
          { field: 'customField', fieldId: 'cf1', label: 'Committee', billId: 'a190', billNumber: 'A190', value: 'Energy', replacedBy: { billId: 'b1713', billNumber: 'S1713', value: 'Labor' } },
        ])
      }
    })

    it('lists nothing replaced when the members agree or only one has a value', async () => {
      await position('a190', 'Support', '2026-10-01 10:00:00')
      await position('b1713', 'Support', '2026-10-01 09:00:00')
      await priority('b1713', 'high', '2026-10-01 10:00:00')
      await group()
      expect((await detail('a190')).groupingEvents[0].replaced).toEqual([])
    })
  })

  describe('triage', () => {
    beforeEach(async () => {
      await db().update(bills).set({ newMatchAt: '2026-10-01 08:00:00' }).where(eq(bills.matchType, 'keyword'))
      await group()
    })

    it('dismissing either member takes the whole group out of new matches', async () => {
      expect(await newMatchIds()).toEqual(['a190', 'b1713'])
      expect((await as('ada', '/bills/b1713/triage-dismiss', { method: 'PATCH' })).status).toBe(200)
      expect(await newMatchIds()).toEqual([])
      expect((await detail('a190')).triagedAt).not.toBeNull()
    })

    it('prioritizing either member triages the whole group', async () => {
      expect((await as('ada', '/bills/a190/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })).status).toBe(200)
      expect(await newMatchIds()).toEqual([])
      expect((await shown('b1713')).priority).toBe('high')
    })
  })

  describe('team events', () => {
    beforeEach(async () => {
      await position('a190', 'Support', '2026-10-01 10:00:00')
      await group()
    })

    it("records setting and clearing the position with the group's old and new value and the admin", async () => {
      await as('ada', '/bills/b1713/position', { method: 'POST', body: JSON.stringify({ position: 'Oppose' }) })
      await as('ada', '/bills/a190/position', { method: 'DELETE' })
      expect(await fieldEvents('b1713')).toEqual([
        { actorUserId: user.ada, field: 'position', label: 'position', old: 'Support', new: 'Oppose' },
      ])
      expect(await fieldEvents('a190')).toEqual([
        { actorUserId: user.ada, field: 'position', label: 'position', old: 'Oppose', new: null },
      ])
    })

    it('records setting the priority', async () => {
      await as('ada', '/bills/b1713/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })
      expect(await fieldEvents('b1713')).toEqual([
        { actorUserId: user.ada, field: 'priority', label: 'priority', old: null, new: 'high' },
      ])
    })

    it('records setting a custom field', async () => {
      await as('ada', '/bills/b1713/custom-fields', { method: 'PUT', body: JSON.stringify({ cf1: 'Labor' }) })
      expect(await fieldEvents('b1713')).toEqual([
        { actorUserId: user.ada, field: 'customField', fieldId: 'cf1', label: 'Committee', old: null, new: 'Labor' },
      ])
    })

    it('records a bulk edit on each bill it sets', async () => {
      await as('ada', '/bills/bulk', { method: 'POST', body: JSON.stringify({ ids: ['b1713'], priority: 'low', position: 'Amend' }) })
      expect(await fieldEvents('b1713')).toEqual([
        { actorUserId: user.ada, field: 'priority', label: 'priority', old: null, new: 'low' },
        { actorUserId: user.ada, field: 'position', label: 'position', old: 'Support', new: 'Amend' },
      ])
    })

    it('records nothing when a value is set to what the group already has', async () => {
      await as('ada', '/bills/b1713/position', { method: 'POST', body: JSON.stringify({ position: 'Support' }) })
      await as('ada', '/bills/b1713/position', { method: 'POST', body: JSON.stringify({ position: 'Oppose' }) })
      await as('ada', '/bills/a190/position', { method: 'POST', body: JSON.stringify({ position: 'Oppose' }) })
      expect([...await fieldEvents('a190'), ...await fieldEvents('b1713')]).toEqual([
        { actorUserId: user.ada, field: 'position', label: 'position', old: 'Support', new: 'Oppose' },
      ])
    })
  })

  describe('splitting', () => {
    it("gives each bill back its own values and triage", async () => {
      await conflictingValues()
      await db().update(bills).set({ newMatchAt: '2026-10-01 08:00:00' }).where(eq(bills.matchType, 'keyword'))
      await group()
      await as('ada', '/bills/a190/triage-dismiss', { method: 'PATCH' })
      expect((await shown('a190')).priority).toBe('high')
      expect(await newMatchIds()).toEqual([])
      await split()
      expect(await shown('a190')).toEqual({ position: 'Support', priority: 'low', committee: 'Energy', summary: 'A190 summary', tags: ['Energy'] })
      expect(await shown('b1713')).toEqual({ position: 'Oppose', priority: 'high', committee: 'Labor', summary: 'S1713 summary', tags: ['Labor'] })
      expect(await newMatchIds()).toEqual(['b1713'])
    })
  })
})
