import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { groupByHand, recomputeGroups, splitFromGroup, syncIdenticalCompanions } from '../../src/lib/companionGroups'

// Grouping and splitting by hand while other writes land (#382). Two admins
// acting at once, and a sync recomputing the same group mid-action, must
// never leave a group key that disagrees with the links and overrides.

type Stmt = D1PreparedStatement & { real: D1PreparedStatement; query: string }

/**
 * The instance's D1, with one statement held until `release` resolves:
 * `holdQuery` picks a query by its SQL and the reads before it, and
 * `holdBatch` a batch by its statements. `reached` resolves when the hold
 * begins, so a test can run another write in the middle.
 */
function holding(opts: {
  holdQuery?: (query: string, seen: string[]) => boolean
  holdBatch?: (queries: string[]) => boolean
}, release: Promise<void>, reached: () => void): D1Database {
  const real = env.DB
  const seen: string[] = []
  let held = false
  const hold = async () => { held = true; reached(); await release }
  const wrap = (stmt: D1PreparedStatement, query: string): Stmt => {
    const run = <T>(f: () => Promise<T>) => async () => {
      if (!held && opts.holdQuery?.(query, seen)) await hold()
      seen.push(query)
      return f()
    }
    return {
      real: stmt,
      query,
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), query),
      all: run(() => stmt.all()),
      raw: run(() => stmt.raw()),
      first: run(() => stmt.first()),
      run: run(() => stmt.run()),
    } as unknown as Stmt
  }
  return {
    prepare: (query: string) => wrap(real.prepare(query), query),
    batch: async (stmts: Stmt[]) => {
      if (!held && opts.holdBatch?.(stmts.map(s => s.query ?? ''))) await hold()
      return real.batch(stmts.map(s => s.real ?? s))
    },
    exec: (query: string) => real.exec(query),
  } as unknown as D1Database
}

function gate() {
  let release!: () => void
  let reached!: () => void
  const released = new Promise<void>(r => { release = r })
  const atHold = new Promise<void>(r => { reached = r })
  return { release, released, reached, atHold }
}

async function keys(...ids: string[]) {
  const rows = await getDb(env.DB).select({ id: bills.id, k: bills.groupKey }).from(bills).all()
  return ids.map(id => rows.find(r => r.id === id)?.k ?? null)
}

describe('grouping by hand while other writes land', () => {
  let admin = ''
  let other = ''
  const db = () => getDb(env.DB)

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    admin = await seedUser({ role: 'admin', email: 'ada@example.com', name: 'ada' })
    other = await seedUser({ role: 'admin', email: 'bo@example.com', name: 'bo' })
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713' })
    await seedBill({ id: 'c1714', billNumber: 'S1714', state: 'NJ', externalId: 'legiscan:1714' })
  })

  it('leaves a split bill out when a sync of its group was part way through its walk', async () => {
    await syncIdenticalCompanions(db(), 'legiscan:190', [{ sastBillId: 1713, kind: 'identical' }, { sastBillId: 1714, kind: 'identical' }])
    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', 'a190', 'a190'])

    // The sync has read A190's overrides, from before the split, and reads
    // its companions (S1714 by now split) after the split has finished.
    const g = gate()
    const syncing = syncIdenticalCompanions(
      getDb(holding({ holdQuery: (_q, seen) => seen.some(s => s.includes('bill_group_overrides')) }, g.released, g.reached)),
      'legiscan:190',
      [{ sastBillId: 1713, kind: 'identical' }, { sastBillId: 1714, kind: 'identical' }],
    )
    await Promise.race([g.atHold, syncing])
    await splitFromGroup(db(), 'c1714', admin)
    g.release()
    await syncing

    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', 'a190', null])
  })

  it('agrees with both admins when one groups and the other splits at once', async () => {
    await syncIdenticalCompanions(db(), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }])

    // Ada groups S1714 with A190, and her recompute has read everything and is
    // about to write when Bo splits S1713 from A190.
    const g = gate()
    const grouping = groupByHand(
      getDb(holding({ holdBatch: qs => qs.some(q => q.includes('team_events')) }, g.released, g.reached)),
      'c1714', 'a190', admin,
    )
    await Promise.race([g.atHold, grouping])
    await splitFromGroup(db(), 'b1713', other)
    g.release()
    await grouping

    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', null, 'a190'])
    // A fresh recompute finds nothing to change.
    await recomputeGroups(db(), ['a190', 'b1713', 'c1714'])
    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', null, 'a190'])
  })
})
