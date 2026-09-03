import { describe, it, expect, beforeEach } from 'vitest'
import { parseSubjects, encodeSubjectFilter, decodeSubjectFilter } from '../../src/lib/billSubjects'

describe('parseSubjects', () => {
  it('returns strings from a JSON array, deduped, order preserved', () => {
    expect(parseSubjects('["Elections","Counties","Elections"]')).toEqual(['Elections', 'Counties'])
  })
  it('returns [] for null, malformed JSON, or a non-array', () => {
    expect(parseSubjects(null)).toEqual([])
    expect(parseSubjects('{oops')).toEqual([])
    expect(parseSubjects('{"a":1}')).toEqual([])
  })
  it('drops non-string and empty members', () => {
    expect(parseSubjects('["Elections",3,"",null]')).toEqual(['Elections'])
  })
})

describe('subject filter encoding', () => {
  it('round-trips a plain name', () => {
    expect(decodeSubjectFilter(encodeSubjectFilter('UT', 'Election Law')))
      .toEqual({ state: 'UT', name: 'Election Law' })
  })
  it('splits on the first colon only, so names may contain colons', () => {
    expect(decodeSubjectFilter('TX:Resolutions: Congratulatory'))
      .toEqual({ state: 'TX', name: 'Resolutions: Congratulatory' })
  })
  it('returns null when there is no colon', () => {
    expect(decodeSubjectFilter('Elections')).toBeNull()
  })
  it('returns null for an empty state or empty name', () => {
    expect(decodeSubjectFilter(':Elections')).toBeNull()
    expect(decodeSubjectFilter('UT:')).toBeNull()
  })
})

import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, billSubjects } from '../../src/db/schema'
import { syncBillSubjects } from '../../src/lib/billSubjects'
import { eq } from 'drizzle-orm'

describe('syncBillSubjects', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  async function seedBill(db: ReturnType<typeof getDb>, id: string) {
    await db.insert(bills).values({
      id, billNumber: 'HB1', title: 'T', state: 'UT', status: '', session: '',
    }).run()
  }

  it('inserts rows, then replaces them wholesale on the next call', async () => {
    const db = getDb(env.DB)
    await seedBill(db, 'b1')

    await syncBillSubjects(db, 'b1', 'UT', ['Elections', 'Counties'])
    let rows = await db.select().from(billSubjects).where(eq(billSubjects.billId, 'b1')).all()
    expect(rows.map(r => r.subjectName).sort()).toEqual(['Counties', 'Elections'])
    expect(rows.every(r => r.state === 'UT')).toBe(true)

    await syncBillSubjects(db, 'b1', 'UT', ['Referenda'])
    rows = await db.select().from(billSubjects).where(eq(billSubjects.billId, 'b1')).all()
    expect(rows.map(r => r.subjectName)).toEqual(['Referenda'])
  })

  it('clears rows when the list is empty', async () => {
    const db = getDb(env.DB)
    await seedBill(db, 'b2')
    await syncBillSubjects(db, 'b2', 'UT', ['Elections'])
    await syncBillSubjects(db, 'b2', 'UT', [])
    const rows = await db.select().from(billSubjects).where(eq(billSubjects.billId, 'b2')).all()
    expect(rows).toEqual([])
  })

  it('is idempotent — the same list twice leaves one row per subject', async () => {
    const db = getDb(env.DB)
    await seedBill(db, 'b3')
    await syncBillSubjects(db, 'b3', 'UT', ['Elections'])
    await syncBillSubjects(db, 'b3', 'UT', ['Elections'])
    const rows = await db.select().from(billSubjects).where(eq(billSubjects.billId, 'b3')).all()
    expect(rows).toHaveLength(1)
  })
})
