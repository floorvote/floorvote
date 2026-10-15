import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { billGroupOverrides, bills } from '../../src/db/schema'
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
  let reach!: () => void
  const released = new Promise<void>(r => { release = r })
  const atHold = new Promise<void>(r => { reach = r })
  const g = { release, released, atHold, held: false, reached: () => { g.held = true; reach() } }
  return g
}

/** A statement that reads one or more bills' group overrides (not the walk's check for any). */
const readsOverrides = (query: string) => /^\s*select/i.test(query) && query.includes('from "bill_group_overrides"')

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

  it('writes a grouping in one attempt when nothing races it', async () => {
    // 0103's triggers update other bills' group tags in the same statement as
    // the key update, so the update reports more changes than the keys it set.
    // That is still a write that applied, and must not be retried.
    let walks = 0
    const counting = {
      prepare: (query: string) => {
        if (readsOverrides(query)) walks++
        return env.DB.prepare(query)
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
      exec: (query: string) => env.DB.exec(query),
    } as unknown as D1Database
    await groupByHand(getDb(counting), 'a190', 'b1713', admin)
    expect(await keys('a190', 'b1713')).toEqual(['a190', 'a190'])
    // One read of each bill's overrides: a single walk of the two bills.
    expect(walks).toBe(2)
  })

  it("reads no bill's overrides on a delivery when the instance has none", async () => {
    let reads = 0
    const counting = {
      prepare: (query: string) => { if (readsOverrides(query)) reads++; return env.DB.prepare(query) },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
      exec: (query: string) => env.DB.exec(query),
    } as unknown as D1Database
    await syncIdenticalCompanions(getDb(counting), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }])
    expect(await keys('a190', 'b1713')).toEqual(['a190', 'a190'])
    expect(reads).toBe(0)
  })

  it('leaves a split bill out when a sync of its group was part way through its walk', async () => {
    await syncIdenticalCompanions(db(), 'legiscan:190', [{ sastBillId: 1713, kind: 'identical' }, { sastBillId: 1714, kind: 'identical' }])
    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', 'a190', 'a190'])
    // An override elsewhere in the instance, so the walk reads each bill's.
    await seedBill({ id: 'd2000', billNumber: 'H2000', state: 'NJ', externalId: 'legiscan:2000' })
    await seedBill({ id: 'e2001', billNumber: 'H2001', state: 'NJ', externalId: 'legiscan:2001' })
    await groupByHand(db(), 'd2000', 'e2001', admin)

    // The sync has read A190's overrides, from before the split, and reads
    // its companions (S1714 by now split) after the split has finished.
    const g = gate()
    const syncing = syncIdenticalCompanions(
      getDb(holding({ holdQuery: (_q, seen) => seen.some(readsOverrides) }, g.released, g.reached)),
      'legiscan:190',
      [{ sastBillId: 1713, kind: 'identical' }, { sastBillId: 1714, kind: 'identical' }],
    )
    await Promise.race([g.atHold, syncing])
    await splitFromGroup(db(), 'c1714', admin)
    g.release()
    await syncing
    // The split did land in the middle of the sync.
    expect(g.held).toBe(true)

    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', 'a190', null])
  })

  it('reads the overrides again when one is stored after its walk, even before that action regroups', async () => {
    await syncIdenticalCompanions(db(), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }])

    // A sync adds S1714 to the group and is about to write when an admin's
    // split of S1713 is stored. The split's own recompute hasn't run (its
    // worker could die there), so only the sync's guard can see the split.
    const g = gate()
    const syncing = syncIdenticalCompanions(
      getDb(holding({ holdBatch: qs => qs.some(q => q.includes('team_events')) }, g.released, g.reached)),
      'legiscan:1714',
      [{ sastBillId: 190, kind: 'identical' }],
    )
    await Promise.race([g.atHold, syncing])
    await db().insert(billGroupOverrides).values({ billId: 'a190', otherBillId: 'b1713', kind: 'split', actorUserId: other })
    g.release()
    await syncing
    expect(g.held).toBe(true)

    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', null, 'a190'])
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
    expect(g.held).toBe(true)

    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', null, 'a190'])
    // A fresh recompute finds nothing to change.
    await recomputeGroups(db(), ['a190', 'b1713', 'c1714'])
    expect(await keys('a190', 'b1713', 'c1714')).toEqual(['a190', null, 'a190'])
  })
})
