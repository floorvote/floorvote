import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { buildBillDetail } from '../../src/routes/billsApi/detail'

describe('buildBillDetail — subjects', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('returns stored subjects, not a live central lookup', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id: 'bd1',
      externalId: 'legiscan:1',
      billNumber: 'HB0026',
      title: 'Voting Equipment',
      state: 'UT',
      status: 'Passed',
      session: '',
      subjects: '["Election Administration","Procurement"]',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()

    const detail = await buildBillDetail(db, 'bd1', { id: 'u1', role: 'admin' }, env)

    expect(detail.subjects).toEqual(['Election Administration', 'Procurement'])
  })

  it('returns an empty array when a bill has no subjects', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id: 'bd2',
      externalId: 'legiscan:2',
      billNumber: 'HB1',
      title: 'T',
      state: 'IL',
      status: '',
      session: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()

    const detail = await buildBillDetail(db, 'bd2', { id: 'u1', role: 'admin' }, env)

    expect(detail.subjects).toEqual([])
  })
})
