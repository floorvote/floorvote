import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { billCommittees, bills } from '../../src/db/schema'
import { syncBillCommittees } from '../../src/lib/billCommittees'

// A bill's committee rows are replaced in one transaction (#471): a write that fails leaves the rows it would have
// replaced, so a retry that takes the processor's early skip doesn't leave the bill with none.
describe('syncBillCommittees', () => {
  beforeEach(clearDb)

  it('leaves the bill\'s rows in place when the new ones fail to write', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({ id: 'b1', externalId: 'legiscan:1', billNumber: 'S1', title: 'T', state: 'RI', status: 'Introduced', session: '2026' })
    await syncBillCommittees(db, 'b1', 'RI', { committeeId: '1021', name: 'Judiciary', chamber: 'S' }, [])
    // A null state breaks the insert's NOT NULL.
    await expect(syncBillCommittees(db, 'b1', null as unknown as string, { committeeId: '1030', name: 'Rules', chamber: 'S' }, [])).rejects.toThrow()
    const rows = await db.select({ id: billCommittees.committeeId }).from(billCommittees).all()
    expect(rows).toEqual([{ id: '1021' }])
  })
})
