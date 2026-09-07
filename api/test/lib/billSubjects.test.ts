import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseSubjects, encodeSubjectFilter, decodeSubjectFilter, decodeSubjectFilters,
  decodeSubjectFiltersChecked, dedupeSubjectNames, MAX_SUBJECT_FILTERS, isSubjectsSuppressedForState,
} from '../../src/lib/billSubjects'

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

describe('dedupeSubjectNames', () => {
  it('drops non-strings, empty strings, and duplicates, preserving order', () => {
    expect(dedupeSubjectNames(['Elections', 3, '', null, 'Counties', 'Elections']))
      .toEqual(['Elections', 'Counties'])
  })
})

describe('decodeSubjectFilters', () => {
  it('decodes valid values and drops malformed ones', () => {
    expect(decodeSubjectFilters(['UT:Elections', 'NoColon', 'NJ:Education']))
      .toEqual([{ state: 'UT', name: 'Elections' }, { state: 'NJ', name: 'Education' }])
  })

  it('caps the result at MAX_SUBJECT_FILTERS so a huge list cannot blow the D1 param budget', () => {
    const values = Array.from({ length: MAX_SUBJECT_FILTERS + 20 }, (_, i) => `UT:Subject ${i}`)
    const decoded = decodeSubjectFilters(values)
    expect(decoded).toHaveLength(MAX_SUBJECT_FILTERS)
    expect(decoded[0]).toEqual({ state: 'UT', name: 'Subject 0' })
  })
})

describe('decodeSubjectFiltersChecked', () => {
  it('reports no overflow at the cap', () => {
    const values = Array.from({ length: MAX_SUBJECT_FILTERS }, (_, i) => `UT:S${i}`)
    const out = decodeSubjectFiltersChecked(values)
    expect(out.overflow).toBe(false)
    expect(out.filters).toHaveLength(MAX_SUBJECT_FILTERS)
  })

  it('reports overflow one past the cap rather than truncating silently', () => {
    const values = Array.from({ length: MAX_SUBJECT_FILTERS + 1 }, (_, i) => `UT:S${i}`)
    expect(decodeSubjectFiltersChecked(values).overflow).toBe(true)
  })

  it('does not count malformed values toward the cap', () => {
    const out = decodeSubjectFiltersChecked(['NoColon', 'UT:A'])
    expect(out.overflow).toBe(false)
    expect(out.filters).toEqual([{ state: 'UT', name: 'A' }])
  })
})

describe('isSubjectsSuppressedForState', () => {
  it('is false for an empty suppressed set', () => {
    expect(isSubjectsSuppressedForState(new Set(), 'NJ')).toBe(false)
  })
  it('is true when the state is named directly', () => {
    expect(isSubjectsSuppressedForState(new Set(['NJ']), 'NJ')).toBe(true)
    expect(isSubjectsSuppressedForState(new Set(['NJ']), 'UT')).toBe(false)
  })
  it('is true for every state when "*" is present', () => {
    const suppressed = new Set(['*'])
    expect(isSubjectsSuppressedForState(suppressed, 'NJ')).toBe(true)
    expect(isSubjectsSuppressedForState(suppressed, 'UT')).toBe(true)
  })
})

import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, billSubjects, associationConfig } from '../../src/db/schema'
import { syncBillSubjects, loadSuppressedSubjectStates, SUPPRESSED_SUBJECT_STATES_KEY } from '../../src/lib/billSubjects'
import { eq } from 'drizzle-orm'

describe('loadSuppressedSubjectStates', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('is empty when the tenant has no config row — on by default', async () => {
    const db = getDb(env.DB)
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set())
  })

  it('reads the configured state list', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['NJ', 'AZ']),
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set(['NJ', 'AZ']))
  })

  it('treats a malformed value as "nothing suppressed" rather than failing closed', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: '{not json',
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set())
  })

  it('treats a non-array JSON value as "nothing suppressed"', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify({ NJ: true }),
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set())
  })

  // An operator who types a lowercase state code should still get suppression —
  // the DB always stores state codes uppercase, so a silent case mismatch would
  // leave the feature fully ON with no indication why.
  it('normalizes configured state codes to uppercase', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['nj', 'Az']),
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set(['NJ', 'AZ']))
  })

  it('trims whitespace around configured state codes before normalizing', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify([' nj ']),
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set(['NJ']))
  })

  it('leaves the "*" wildcard intact after normalization', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['*']),
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set(['*']))
  })

  // Normalization must not create a new way for a malformed config to be
  // misread as a real suppression — fail-open has to survive the change.
  it('still fails open on a mixed valid/garbage array — garbage entries are dropped, not normalized into a match', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify(['nj', 123, null, '', '   ', {}, ['AZ']]),
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set(['NJ']))
  })

  it('still fails open on an array of only numbers', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: SUPPRESSED_SUBJECT_STATES_KEY, value: JSON.stringify([1, 2, 3]),
    }).run()
    expect(await loadSuppressedSubjectStates(db)).toEqual(new Set())
  })
})

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

  // CRITICAL 2 regression: LegiScan can send the same subject name twice (distinct
  // subject_ids across sessions). Without deduping, the second insert violates the
  // (bill_id, subject_name) primary key and throws — which upstream (processQueue)
  // treats as a retryable failure, wedging the message in a permanent retry loop.
  it('does not throw on a duplicate subject name, and dedupes it', async () => {
    const db = getDb(env.DB)
    await seedBill(db, 'b4')
    await expect(
      syncBillSubjects(db, 'b4', 'UT', ['Elections', 'Elections', 'Counties'])
    ).resolves.not.toThrow()
    const rows = await db.select().from(billSubjects).where(eq(billSubjects.billId, 'b4')).all()
    expect(rows.map(r => r.subjectName).sort()).toEqual(['Counties', 'Elections'])
  })

  // CRITICAL 3 regression: a multi-row INSERT binds 3 params per subject row. D1
  // rejects any statement with >100 bound params, so 34+ subjects in one INSERT
  // (>100 params) would throw — production bills have gone as high as 164 subjects.
  // syncBillSubjects must chunk the insert so this never happens.
  it('does not throw when a bill has more subjects than fit in one D1 statement', async () => {
    const db = getDb(env.DB)
    await seedBill(db, 'b5')
    const many = Array.from({ length: 40 }, (_, i) => `Subject ${i}`)
    await expect(syncBillSubjects(db, 'b5', 'UT', many)).resolves.not.toThrow()
    const rows = await db.select().from(billSubjects).where(eq(billSubjects.billId, 'b5')).all()
    expect(rows).toHaveLength(40)
  })
})
