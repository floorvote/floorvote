import { describe, it, expect } from 'vitest'
import { EMPTY_BILL_FILTER, parseBillFilter, serializeBillFilter } from '../../../shared/billFilter'
import { MAX_SUBJECT_FILTERS } from '../../../shared/limits'
import { billFilterFromBulkBody, subjectCapError } from '../../src/routes/billsApi/filterRequest'

// The bulk routes take their filter as a JSON body. It is parsed into the same bill filter value a query string
// is, so the body's shape stays and its meaning is the list's.

const everyFilterBody = {
  status: ['Passed', 'In committee'], stage: ['enacted'], priority: ['high', '__any__'], position: ['none'],
  session: ['2026 Regular'], year: ['2026', '2025'], state: ['UT'], tag: ['__any__', 'Energy'],
  subject: ['UT:Elections', 'NJ:Resolutions: Congratulatory'], q: '"voter id", mail', minRelevance: '4',
  myBills: '1', unvoted: 'true', newMatches: true, drafts: '1', match: 'any',
  cf: { committee: ['Labor'], '3f2a9c1e-7b4d-4a8e-9c55': ['x', '__any__'] },
}
const everyFilterQuery =
  'status=Passed&status=In%20committee&stage=enacted&priority=high&priority=__any__&position=none&session=2026%20Regular&year=2026&year=2025&state=UT'
  + '&tag=__any__&tag=Energy&subject=UT:Elections&subject=NJ:Resolutions:%20Congratulatory&q=%22voter%20id%22,%20mail&minRelevance=4'
  + '&myBills=1&unvoted=true&newMatches=true&drafts=1&match=any&cf_committee=Labor&cf_3f2a9c1e-7b4d-4a8e-9c55=x&cf_3f2a9c1e-7b4d-4a8e-9c55=__any__'

describe('billFilterFromBulkBody', () => {
  it('reads a body with every filter as the value the same filter in a query string gives', () => {
    expect(billFilterFromBulkBody(everyFilterBody)).toEqual(parseBillFilter(everyFilterQuery))
  })

  it('reads every filter into its own place, none lost and none added', () => {
    const f = billFilterFromBulkBody(everyFilterBody)
    expect(f.status).toEqual(['Passed', 'In committee'])
    expect(f.stage).toEqual(['enacted'])
    expect(f.priority).toEqual(['high', '__any__'])
    expect(f.position).toEqual(['none'])
    expect(f.session).toEqual(['2026 Regular'])
    expect(f.year).toEqual(['2026', '2025'])
    expect(f.state).toEqual(['UT'])
    expect(f.tag).toEqual(['__any__', 'Energy'])
    expect(f.subject).toEqual([{ state: 'UT', name: 'Elections' }, { state: 'NJ', name: 'Resolutions: Congratulatory' }])
    expect(f.q).toBe('"voter id", mail')
    expect(f.minRelevance).toBe(4)
    expect([f.myBills, f.unvoted, f.newMatches, f.drafts]).toEqual([true, true, true, true])
    expect(f.match).toBe('any')
    expect(f.cf).toEqual({ committee: ['Labor'], '3f2a9c1e-7b4d-4a8e-9c55': ['x', '__any__'] })
  })

  it('serializes to what the query string gave, so the two wire formats are one filter', () => {
    expect(serializeBillFilter(billFilterFromBulkBody(everyFilterBody))).toBe(serializeBillFilter(parseBillFilter(everyFilterQuery)))
  })

  it.each([[undefined], [null], [''], ['text'], [0], [5], [true], [[]], [['status']], [{}]])('reads %j as no filter at all', (body) => {
    expect(billFilterFromBulkBody(body)).toEqual(EMPTY_BILL_FILTER)
  })

  it('ignores a key that is not a filter', () => {
    expect(billFilterFromBulkBody({ bogus: ['x'], page: 2, ids: ['a'], sort: 'priority', search: 'x', field: { a: ['b'] }, cf_team: ['x'] })).toEqual(EMPTY_BILL_FILTER)
  })

  describe('toggles', () => {
    it.each(['myBills', 'unvoted', 'newMatches', 'drafts'] as const)('%s is on for "1", "true", 1, and true', (key) => {
      for (const v of ['1', 'true', 1, true]) expect(billFilterFromBulkBody({ [key]: v })[key], String(v)).toBe(true)
    })
    it.each(['myBills', 'unvoted', 'newMatches', 'drafts'] as const)('%s is off for "0", "false", "", 0, false, null, and anything else', (key) => {
      for (const v of ['0', 'false', '', 0, false, null, 'yes', 2, [], {}, ['1']]) expect(billFilterFromBulkBody({ [key]: v })[key], JSON.stringify(v)).toBe(false)
    })
  })

  describe('multi-select filters', () => {
    it('keeps strings in order, and reads numbers as the strings they print as', () => {
      expect(billFilterFromBulkBody({ year: [2026, '2025'], status: ['b', 'a'] })).toMatchObject({ year: ['2026', '2025'], status: ['b', 'a'] })
    })
    it('reads a lone value as the list of one, so a filter a client wrote loosely still narrows', () => {
      expect(billFilterFromBulkBody({ status: 'Passed', year: 2026 })).toMatchObject({ status: ['Passed'], year: ['2026'] })
    })
    it('drops what is neither a string nor a number: null, booleans, objects, and arrays', () => {
      expect(billFilterFromBulkBody({ status: ['a', null, true, { x: 1 }, ['b'], 'c'] }).status).toEqual(['a', 'c'])
    })
    it('reads a null or missing filter as none', () => {
      expect(billFilterFromBulkBody({ status: null, stage: undefined }).status).toEqual([])
    })
    it('drops a subject that is not state:name and keeps more than the cap, for the route to refuse', () => {
      const subject = [...Array.from({ length: MAX_SUBJECT_FILTERS + 1 }, (_, i) => `UT:S${i}`), 'NoColon', 'UT:']
      expect(billFilterFromBulkBody({ subject }).subject).toHaveLength(MAX_SUBJECT_FILTERS + 1)
    })
  })

  describe('single-valued filters', () => {
    it('reads a search, a min relevance, and the match mode, as strings or numbers', () => {
      expect(billFilterFromBulkBody({ q: 'x', minRelevance: '3', match: 'any' })).toMatchObject({ q: 'x', minRelevance: 3, match: 'any' })
      expect(billFilterFromBulkBody({ minRelevance: 3 }).minRelevance).toBe(3)
      expect(billFilterFromBulkBody({ minRelevance: 0 }).minRelevance).toBe(0)
    })
    it('reads an empty search and an invalid min relevance as none', () => {
      expect(billFilterFromBulkBody({ q: '', minRelevance: '', match: '' })).toEqual(EMPTY_BILL_FILTER)
      expect(billFilterFromBulkBody({ minRelevance: 'abc' }).minRelevance).toBeNull()
      expect(billFilterFromBulkBody({ q: { x: 1 }, minRelevance: [3], match: ['any'] })).toEqual(EMPTY_BILL_FILTER)
    })
    it('reads only match "any" as the any mode', () => {
      expect(billFilterFromBulkBody({ match: 'any' }).match).toBe('any')
      for (const v of ['all', 'ANY', true, 1]) expect(billFilterFromBulkBody({ match: v }).match, String(v)).toBe('all')
    })
  })

  describe('custom fields', () => {
    it('reads cf as one list of values per field, named by a slug or an id', () => {
      expect(billFilterFromBulkBody({ cf: { team: ['Ada'], 'abc-123': ['x', 'y'] } }).cf).toEqual({ team: ['Ada'], 'abc-123': ['x', 'y'] })
    })
    it('reads a lone value as the list of one, and drops a field with no values', () => {
      expect(billFilterFromBulkBody({ cf: { team: 'Ada', empty: [], none: null } }).cf).toEqual({ team: ['Ada'] })
    })
    it('reads a cf that is not an object as none', () => {
      for (const cf of ['x', 5, ['a'], null, true]) expect(billFilterFromBulkBody({ cf }).cf, JSON.stringify(cf)).toEqual({})
    })
    it('reads a field named as an Object.prototype member without touching the prototype', () => {
      const body = JSON.parse('{"cf":{"__proto__":["x"],"constructor":["y"]}}')
      const f = billFilterFromBulkBody(body)
      expect(Object.keys(f.cf).sort()).toEqual(['__proto__', 'constructor'])
      expect(({} as Record<string, unknown>).push).toBeUndefined()
    })
  })

  it('does not change the body it was given', () => {
    const body = JSON.parse(JSON.stringify(everyFilterBody))
    billFilterFromBulkBody(body)
    expect(body).toEqual(everyFilterBody)
  })

  it('returns an immutable value', () => {
    const f = billFilterFromBulkBody(everyFilterBody)
    expect(Object.isFrozen(f)).toBe(true)
    expect(Object.isFrozen(f.status)).toBe(true)
    expect(Object.isFrozen(f.cf)).toBe(true)
  })
})

describe('subjectCapError', () => {
  const withSubjects = (n: number, extra: string[] = []) =>
    billFilterFromBulkBody({ subject: [...Array.from({ length: n }, (_, i) => `UT:Subject ${i + 1}`), ...extra] })

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

  it('reads the same for a query string as for a body', () => {
    const qs = Array.from({ length: MAX_SUBJECT_FILTERS + 1 }, (_, i) => `subject=UT:S${i}`).join('&')
    expect(subjectCapError(parseBillFilter(qs))).not.toBeNull()
  })
})
