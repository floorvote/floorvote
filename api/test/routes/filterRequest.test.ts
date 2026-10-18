import { describe, it, expect } from 'vitest'
import { EMPTY_BILL_FILTER, parseBillFilter, serializeBillFilter } from '../../../shared/billFilter'
import { MAX_SUBJECT_FILTERS } from '../../../shared/limits'
import { parseBulkFilter, subjectCapError } from '../../src/routes/billsApi/filterRequest'

// The bulk routes take their filter as a query string in the JSON body, the same wire format the list reads, and
// read it with the same `parseBillFilter`. A body's own shape and key names are gone.

const everyFilterQuery =
  'status=Passed&status=In%20committee&stage=enacted&priority=high&priority=__any__&position=none&sessionName=2026%20Regular&year=2026&year=2025&state=UT'
  + '&tag=__any__&tag=Energy&subject=UT:Elections&subject=NJ:Resolutions:%20Congratulatory&search=%22voter%20id%22,%20mail&minRelevance=4'
  + '&myBills=1&unvoted=true&newMatches=true&drafts=1&match=any&field.committee=Labor&field.3f2a9c1e-7b4d-4a8e-9c55=x&field.3f2a9c1e-7b4d-4a8e-9c55=__any__'

describe('parseBulkFilter', () => {
  it('reads a string as the bill filter the list reads from the same query string', () => {
    expect(parseBulkFilter(everyFilterQuery)).toEqual(parseBillFilter(everyFilterQuery))
  })

  it('reads every filter into its own place, none lost and none added', () => {
    const f = parseBulkFilter(everyFilterQuery)!
    expect(f.status).toEqual(['Passed', 'In committee'])
    expect(f.stage).toEqual(['enacted'])
    expect(f.priority).toEqual(['high', '__any__'])
    expect(f.position).toEqual(['none'])
    expect(f.sessionName).toEqual(['2026 Regular'])
    expect(f.year).toEqual(['2026', '2025'])
    expect(f.state).toEqual(['UT'])
    expect(f.tag).toEqual(['__any__', 'Energy'])
    expect(f.subject).toEqual([{ state: 'UT', name: 'Elections' }, { state: 'NJ', name: 'Resolutions: Congratulatory' }])
    expect(f.search).toBe('"voter id", mail')
    expect(f.minRelevance).toBe(4)
    expect([f.myBills, f.unvoted, f.newMatches, f.drafts]).toEqual([true, true, true, true])
    expect(f.match).toBe('any')
    expect(f.field).toEqual({ committee: ['Labor'], '3f2a9c1e-7b4d-4a8e-9c55': ['x', '__any__'] })
  })

  it('reads what serializeBillFilter writes as the same filter', () => {
    const f = parseBillFilter(everyFilterQuery)
    expect(parseBulkFilter(serializeBillFilter(f))).toEqual(f)
  })

  it('reads an empty string as the filter with nothing set', () => {
    expect(parseBulkFilter('')).toEqual(EMPTY_BILL_FILTER)
  })

  it('ignores a key that is not a filter', () => {
    expect(parseBulkFilter('bogus=x&page=2&ids=a&sort=priority&q=x&cf_a=b&session=s')).toEqual(EMPTY_BILL_FILTER)
  })

  it.each([[undefined], [null], [0], [5], [true], [false], [[]], [['status=Passed']], [{}], [{ status: ['Passed'] }]])(
    'is null for %j, which is not a query string',
    (filter) => {
      expect(parseBulkFilter(filter)).toBeNull()
    },
  )

  it('reads a field named as an Object.prototype member without touching the prototype', () => {
    const f = parseBulkFilter('field.__proto__=x&field.constructor=y')!
    expect(Object.keys(f.field).sort()).toEqual(['__proto__', 'constructor'])
    expect(({} as Record<string, unknown>).push).toBeUndefined()
  })

  it('returns an immutable value', () => {
    const f = parseBulkFilter(everyFilterQuery)!
    expect(Object.isFrozen(f)).toBe(true)
    expect(Object.isFrozen(f.status)).toBe(true)
    expect(Object.isFrozen(f.field)).toBe(true)
  })
})

describe('subjectCapError', () => {
  const withSubjects = (n: number, extra: string[] = []) =>
    parseBulkFilter([...Array.from({ length: n }, (_, i) => `UT:Subject ${i + 1}`), ...extra].map(v => `subject=${encodeURIComponent(v)}`).join('&'))!

  it('is null at the cap and below it', () => {
    expect(subjectCapError(withSubjects(0))).toBeNull()
    expect(subjectCapError(withSubjects(MAX_SUBJECT_FILTERS))).toBeNull()
  })

  it('is the list route\'s 400 body past the cap', () => {
    expect(subjectCapError(withSubjects(MAX_SUBJECT_FILTERS + 1))).toEqual({ error: `Too many subject filters. The maximum is ${MAX_SUBJECT_FILTERS}.` })
  })

  it('does not count a malformed subject toward the cap', () => {
    expect(subjectCapError(withSubjects(MAX_SUBJECT_FILTERS - 1, ['NoColon', 'AlsoNoColon']))).toBeNull()
    expect(subjectCapError(withSubjects(MAX_SUBJECT_FILTERS, ['NoColon']))).toBeNull()
  })

  it('reads the same for a query string the list takes', () => {
    const qs = Array.from({ length: MAX_SUBJECT_FILTERS + 1 }, (_, i) => `subject=UT:S${i}`).join('&')
    expect(subjectCapError(parseBillFilter(qs))).not.toBeNull()
  })
})
