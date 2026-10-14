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

/**
 * The instance's D1, with the `n`th read of bill_identical_links held until
 * `release` resolves, so a test can run another delivery in the middle of a
 * recompute's walk over the links. Batches go to the real statements.
 */
function holdingLinkRead(n: number, release: Promise<void>): D1Database {
  const real = env.DB
  let reads = 0
  type Stmt = D1PreparedStatement & { real: D1PreparedStatement }
  const wrap = (stmt: D1PreparedStatement, query: string): Stmt => {
    const run = <T>(f: () => Promise<T>) => async () => {
      if (/^\s*select/i.test(query) && query.includes('bill_identical_links') && ++reads === n) await release
      return f()
    }
    return {
      real: stmt,
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), query),
      all: run(() => stmt.all()),
      raw: run(() => stmt.raw()),
      first: run(() => stmt.first()),
      run: run(() => stmt.run()),
    } as unknown as Stmt
  }
  return {
    prepare: (query: string) => wrap(real.prepare(query), query),
    batch: (stmts: Stmt[]) => real.batch(stmts.map(s => s.real ?? s)),
    exec: (query: string) => real.exec(query),
  } as unknown as D1Database
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

  it('writes one grouping event per bill when both companions are delivered at once', async () => {
    // The tenant queue runs batches concurrently, and a metadata refresh
    // delivers both bills of a pair together, each naming the other.
    central.set('legiscan:190', { number: 'A190', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await Promise.all([deliver('legiscan:190'), deliver('legiscan:1713'), deliver('legiscan:190')])
    expect([await groupKeyOf('a190'), await groupKeyOf('b1713')]).toEqual(['a190', 'a190'])
    expect((await eventsOf('a190')).map(e => e.type)).toEqual(['grouped'])
    expect((await eventsOf('b1713')).map(e => e.type)).toEqual(['grouped'])
  })

  it('settles a chain delivered all at once into one group with one event per bill', async () => {
    central.set('legiscan:190', { number: 'A190', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('S1714', 1714)] })
    central.set('legiscan:1714', { number: 'S1714', relatedBills: [] })
    await Promise.all([deliver('legiscan:190'), deliver('legiscan:1713'), deliver('legiscan:1714')])
    expect([await groupKeyOf('a190'), await groupKeyOf('b1713'), await groupKeyOf('c1714')]).toEqual(['a190', 'a190', 'a190'])
    for (const id of ['a190', 'b1713', 'c1714']) {
      // Each bill ends up grouped with exactly the other two, named once.
      const named = (await eventsOf(id)).filter(e => e.type === 'grouped').flatMap(e => e.with.map((b: { billId: string }) => b.billId))
      expect(named.sort()).toEqual(['a190', 'b1713', 'c1714'].filter(x => x !== id))
    }
  })

  it('keeps a pair grouped when one delivery drops its link while the other adds the reverse one', async () => {
    // Grouped through A190 naming S1713.
    central.set('legiscan:190', { number: 'A190', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [] })
    await deliver('legiscan:190')
    expect(await groupKeyOf('b1713')).toBe('a190')

    // Now A190 drops its link and S1713 names A190 instead: still one pair.
    central.set('legiscan:190', { number: 'A190', relatedBills: [] })
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    // A190's delivery reads its current links, then A190's neighbors (none
    // once its link is gone), then S1713's. Hold that third read until
    // S1713's whole delivery, which adds the reverse link, has finished.
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const first = processCentralNotification({ tenantId: 'test-org', billId: 'legiscan:190', metadataOnly: true }, testEnv as never, getDb(holdingLinkRead(3, held)))
    await new Promise(r => setTimeout(r, 50))
    await deliver('legiscan:1713')
    release()
    await first

    expect([await groupKeyOf('a190'), await groupKeyOf('b1713')]).toEqual(['a190', 'a190'])
    expect((await eventsOf('a190')).map(e => e.type)).toEqual(['grouped'])
    expect((await eventsOf('b1713')).map(e => e.type)).toEqual(['grouped'])
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
