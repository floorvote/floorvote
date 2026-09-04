import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, associationConfig } from '../../src/db/schema'
import { buildBillDetail } from '../../src/routes/billsApi/detail'
import { SUPPRESSED_SUBJECT_STATES_KEY } from '../../src/lib/billSubjects'

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

describe('buildBillDetail — subjects suppression', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  async function seedBillIn(id: string, state: string, subjects: string) {
    const db = getDb(env.DB)
    await db.insert(bills).values({
      id,
      externalId: `legiscan:${id}`,
      billNumber: 'HB1',
      title: 'T',
      state,
      status: '',
      session: '',
      subjects,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()
  }

  it('a tenant with no config row shows subjects — the default is on', async () => {
    const db = getDb(env.DB)
    await seedBillIn('ut1', 'UT', '["Election Administration"]')

    const detail = await buildBillDetail(db, 'ut1', { id: 'u1', role: 'admin' }, env)

    expect(detail.subjects).toEqual(['Election Administration'])
  })

  it('suppressing ["NJ"] hides subjects for an NJ bill but not a UT bill', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['NJ']),
    }).run()
    await seedBillIn('nj1', 'NJ', '["State and Local Government"]')
    await seedBillIn('ut2', 'UT', '["Election Administration"]')

    const njDetail = await buildBillDetail(db, 'nj1', { id: 'u1', role: 'admin' }, env)
    const utDetail = await buildBillDetail(db, 'ut2', { id: 'u1', role: 'admin' }, env)

    expect(njDetail.subjects).toEqual([])
    expect(utDetail.subjects).toEqual(['Election Administration'])
  })

  it('suppressing ["*"] hides subjects for every state', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['*']),
    }).run()
    await seedBillIn('ut3', 'UT', '["Election Administration"]')
    await seedBillIn('nj2', 'NJ', '["State and Local Government"]')

    const utDetail = await buildBillDetail(db, 'ut3', { id: 'u1', role: 'admin' }, env)
    const njDetail = await buildBillDetail(db, 'nj2', { id: 'u1', role: 'admin' }, env)

    expect(utDetail.subjects).toEqual([])
    expect(njDetail.subjects).toEqual([])
  })

  it('a malformed config value leaves the feature fully enabled', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: '{not valid json',
    }).run()
    await seedBillIn('ut4', 'UT', '["Election Administration"]')

    const detail = await buildBillDetail(db, 'ut4', { id: 'u1', role: 'admin' }, env)

    expect(detail.subjects).toEqual(['Election Administration'])
  })
})
