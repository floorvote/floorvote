import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { asc, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills, teamEvents } from '../../src/db/schema'

// Companion groups form at ingest: a bill delivered from central carries its
// related bills, each with the kind central's vocabulary gives it, and the
// bills linked by `identical` relationships in either direction share a group
// key, the smallest member id.

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }

type Related = { identifier: string; sastBillId: number; kind: string }

// What central serves for each bill, keyed by its handle.
const central = new Map<string, { number: string; relatedBills: Related[]; updatedAt?: string }>()

function centralBill(handle: string) {
  const b = central.get(handle)!
  return {
    billId: handle,
    sessionId: '1',
    state: 'NJ',
    number: b.number,
    title: `${b.number} title`,
    abstract: null,
    status: 'Introduced',
    statusDate: null,
    updatedAt: b.updatedAt ?? '2026-10-01T00:00:00Z',
    stateUrl: null,
    textHash: null,
    textR2Key: null,
    texts: [],
    actions: [],
    sponsors: [],
    votes: [],
    relatedBills: b.relatedBills.map(r => ({ ...r, session: '1', relationType: 'same-as' })),
  }
}

const identical = (identifier: string, sastBillId: number): Related => ({ identifier, sastBillId, kind: 'identical' })

async function deliver(handle: string, opts: { metadataOnly?: boolean } = { metadataOnly: true }) {
  await processCentralNotification({ tenantId: 'test-org', billId: handle, ...opts }, testEnv as never, getDb(env.DB))
}

async function groupKeyOf(id: string) {
  return (await getDb(env.DB).select({ k: bills.groupKey }).from(bills).where(eq(bills.id, id)).get())?.k ?? null
}

async function eventsOf(id: string) {
  const rows = await getDb(env.DB).select().from(teamEvents).where(eq(teamEvents.billId, id)).orderBy(asc(teamEvents.createdAt)).all()
  return rows.map(r => ({ type: r.type, actorUserId: r.actorUserId, ...JSON.parse(r.metadata) }))
}

describe('companion groups at ingest', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    central.clear()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const handle = decodeURIComponent(String(url).split('/bills/')[1] ?? '')
      return { ok: true, json: async () => centralBill(handle) }
    }))
    // Bills the instance already tracks, by handle. Their ids sort a < b < c.
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713' })
    await seedBill({ id: 'c1714', billNumber: 'S1714', state: 'NJ', externalId: 'legiscan:1714' })
  })

  it('groups two bills when one names the other identical, with the smallest id as the key', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    expect(await groupKeyOf('a190')).toBe('a190')
    expect(await groupKeyOf('b1713')).toBe('a190')
    expect(await groupKeyOf('c1714')).toBeNull()
  })

  it('groups through a relationship named in either direction', async () => {
    central.set('legiscan:190', { number: 'A190', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [] })
    await deliver('legiscan:190')
    await deliver('legiscan:1713')
    expect(await groupKeyOf('a190')).toBe('a190')
    expect(await groupKeyOf('b1713')).toBe('a190')
  })

  it('forms one group from a chain', async () => {
    central.set('legiscan:1714', { number: 'S1714', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1714')
    await deliver('legiscan:1713')
    expect([await groupKeyOf('a190'), await groupKeyOf('b1713'), await groupKeyOf('c1714')]).toEqual(['a190', 'a190', 'a190'])
  })

  it('groups only identical bills, never package or related ones', async () => {
    await seedBill({ id: 'd2000', billNumber: 'S2000', state: 'NJ', externalId: 'legiscan:2000' })
    central.set('legiscan:1713', {
      number: 'S1713',
      relatedBills: [
        { identifier: 'A190', sastBillId: 190, kind: 'package' },
        { identifier: 'S2000', sastBillId: 2000, kind: 'related' },
        identical('S1714', 1714),
      ],
    })
    await deliver('legiscan:1713')
    expect([await groupKeyOf('a190'), await groupKeyOf('d2000')]).toEqual([null, null])
    expect([await groupKeyOf('b1713'), await groupKeyOf('c1714')]).toEqual(['b1713', 'b1713'])
  })

  it('leaves a bill ungrouped while its companion is not in the instance, and groups them once it arrives', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A999', 999)] })
    await deliver('legiscan:1713')
    expect(await groupKeyOf('b1713')).toBeNull()

    central.set('legiscan:999', { number: 'A999', relatedBills: [] })
    await deliver('legiscan:999')
    const a999 = (await getDb(env.DB).select({ id: bills.id }).from(bills).where(eq(bills.externalId, 'legiscan:999')).get())!.id
    const key = [a999, 'b1713'].sort()[0]
    expect(await groupKeyOf('b1713')).toBe(key)
    expect(await groupKeyOf(a999)).toBe(key)
  })

  it('writes an automatic grouping event on each bill, naming the bills it joined', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    expect(await eventsOf('a190')).toEqual([
      expect.objectContaining({ type: 'grouped', actorUserId: null, with: [{ billId: 'b1713', billNumber: 'S1713' }], groupBillIds: ['a190', 'b1713'], replaced: [] }),
    ])
    expect(await eventsOf('b1713')).toEqual([
      expect.objectContaining({ type: 'grouped', actorUserId: null, with: [{ billId: 'a190', billNumber: 'A190' }] }),
    ])
    expect(await eventsOf('c1714')).toEqual([])
  })

  it('writes no new event when a delivery leaves the group as it was', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    await deliver('legiscan:1713')
    expect(await eventsOf('a190')).toHaveLength(1)
  })

  it('names only the newcomer on the bills already grouped when a third joins', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    central.set('legiscan:1714', { number: 'S1714', relatedBills: [identical('S1713', 1713)] })
    await deliver('legiscan:1714')
    expect((await eventsOf('a190')).at(-1)).toMatchObject({ type: 'grouped', with: [{ billId: 'c1714', billNumber: 'S1714' }] })
    expect((await eventsOf('c1714')).at(-1)).toMatchObject({
      type: 'grouped',
      with: [{ billId: 'a190', billNumber: 'A190' }, { billId: 'b1713', billNumber: 'S1713' }],
    })
  })

  it('separates the bills when the relationship disappears, and records the split on each', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [], updatedAt: '2026-10-02T00:00:00Z' })
    await deliver('legiscan:1713')
    expect([await groupKeyOf('a190'), await groupKeyOf('b1713')]).toEqual([null, null])
    expect((await eventsOf('a190')).at(-1)).toMatchObject({ type: 'split', actorUserId: null, with: [{ billId: 'b1713', billNumber: 'S1713' }] })
    expect((await eventsOf('b1713')).at(-1)).toMatchObject({ type: 'split', with: [{ billId: 'a190', billNumber: 'A190' }] })
  })

  it('splits a chain at the link that disappears and rekeys what remains', async () => {
    central.set('legiscan:190', { number: 'A190', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1714', { number: 'S1714', relatedBills: [identical('S1713', 1713)] })
    await deliver('legiscan:190')
    await deliver('legiscan:1714')
    expect(await groupKeyOf('c1714')).toBe('a190')

    central.set('legiscan:190', { number: 'A190', relatedBills: [] })
    await deliver('legiscan:190')
    expect(await groupKeyOf('a190')).toBeNull()
    expect(await groupKeyOf('b1713')).toBe('b1713')
    expect(await groupKeyOf('c1714')).toBe('b1713')
  })

  it('refreshes the companions of a bill whose provider data is unchanged, so a vocabulary change applies on any delivery', async () => {
    await getDb(env.DB).update(bills)
      .set({ providerUpdatedAt: '2026-10-01T00:00:00Z', aiProcessedAt: '2026-10-01 00:00:00' })
      .where(eq(bills.id, 'b1713'))
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    // A plain delivery of an unchanged, analyzed bill skips the upsert entirely.
    await deliver('legiscan:1713', {})
    expect(await groupKeyOf('b1713')).toBe('a190')
  })
})
