import { describe, it, expect } from 'vitest'
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
