import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { clearDb, seedBill, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { officialPositions, teamEvents } from '../../src/db/schema'
import { syncIdenticalCompanions } from '../../src/lib/companionGroups'

// A grouping lists the team field values it replaced, read in the same guarded
// recompute that writes the group keys. A value set while the recompute is
// running makes it read again, so the grouping event never names a value that
// was already gone when the group formed.

/**
 * The instance's D1, with the first read of bill_custom_field_values held
 * until `release` resolves. `reached` resolves when that read is about to run.
 * The recompute reads custom fields last, after it has already read the
 * positions, so a position set while this read is held is one the recompute
 * has missed: only the guard on its write can catch it. Batches go to the
 * real statements.
 */
function holdingCustomFieldRead(release: Promise<void>, reached: () => void): D1Database {
  const real = env.DB
  let held = false
  type Stmt = D1PreparedStatement & { real: D1PreparedStatement }
  const wrap = (stmt: D1PreparedStatement, query: string): Stmt => {
    const run = <T>(f: () => Promise<T>) => async () => {
      if (!held && /^\s*select/i.test(query) && query.includes('"bill_custom_field_values"')) {
        held = true
        reached()
        await release
      }
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

describe('grouping replaces team field values inside the guarded recompute', () => {
  let ada: string

  beforeEach(async () => {
    await clearDb()
    ada = await seedUser({ name: 'Ada', email: 'ada@example.com', role: 'admin' })
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713' })
    const db = getDb(env.DB)
    await db.insert(officialPositions).values([
      { id: 'p1', billId: 'a190', position: 'Support', setBy: ada, createdAt: '2026-10-01 10:00:00', updatedAt: '2026-10-01 10:00:00' },
      { id: 'p2', billId: 'b1713', position: 'Oppose', setBy: ada, createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00' },
    ])
  })

  it('lists the values as they stood when the group formed, after a position set mid-recompute', async () => {
    let release!: () => void
    let reached!: () => void
    const releasing = new Promise<void>(r => { release = r })
    const reaching = new Promise<void>(r => { reached = r })
    const grouping = syncIdenticalCompanions(getDb(holdingCustomFieldRead(releasing, reached)), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }])

    // Once the recompute has read the keys and the positions, an admin sets
    // S1713's position. If it never reads custom fields, the set still lands.
    await Promise.race([reaching, grouping])
    await getDb(env.DB).update(officialPositions)
      .set({ position: 'Amend', updatedAt: '2026-10-01 11:00:00' })
      .where(eq(officialPositions.billId, 'b1713'))
    release()
    await grouping

    const events = await getDb(env.DB).select().from(teamEvents).where(eq(teamEvents.type, 'grouped')).all()
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(JSON.parse(e.metadata).replaced).toEqual([
        { field: 'position', label: 'position', billId: 'a190', billNumber: 'A190', value: 'Support', replacedBy: { billId: 'b1713', billNumber: 'S1713', value: 'Amend' } },
      ])
    }
  })
})
