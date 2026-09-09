import { describe, it, expect } from 'vitest'
import { matchesKeywords, matchesUnion, compileKeyword } from '../../../shared/keywords'

describe('glob keyword compilation', () => {
  it('bare keyword matches a whole word only', () => {
    expect(matchesKeywords('the election today', ['election'])).toBe(true)
    expect(matchesKeywords('general elections', ['election'])).toBe(false)
    expect(matchesKeywords('selection process', ['election'])).toBe(false)
  })

  it('trailing star matches a word start', () => {
    expect(matchesKeywords('general elections', ['election*'])).toBe(true)
    expect(matchesKeywords('the election', ['election*'])).toBe(true)
    expect(matchesKeywords('selection process', ['election*'])).toBe(false)
  })

  it('leading star matches a word end', () => {
    expect(matchesKeywords('a lien on property', ['*lien'])).toBe(true)
    expect(matchesKeywords('resilient infrastructure', ['*lien'])).toBe(false)
    expect(matchesKeywords('multiple liens', ['*lien'])).toBe(false)
  })

  it('both stars match anywhere', () => {
    expect(matchesKeywords('incorporated town', ['*corporat*'])).toBe(true)
    expect(matchesKeywords('resilient', ['*lien*'])).toBe(true)
  })

  it('boundary is punctuation-aware, not space-only', () => {
    expect(matchesKeywords('the election.', ['election'])).toBe(true)
    expect(matchesKeywords('(election)', ['election'])).toBe(true)
    expect(matchesKeywords('mail-in ballot', ['ballot'])).toBe(true)
  })

  it('digits do not block a boundary', () => {
    expect(matchesKeywords('election2024 results', ['election'])).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesKeywords('ELECTION LAW', ['election'])).toBe(true)
  })

  it('supports an internal star', () => {
    expect(matchesKeywords('mail in ballot', ['mail*ballot'])).toBe(true)
    expect(matchesKeywords('ballot by mail', ['mail*ballot'])).toBe(false)
  })

  it('escapes regex metacharacters', () => {
    expect(matchesKeywords('section 1.2 applies', ['1.2'])).toBe(true)
    expect(matchesKeywords('section 132 applies', ['1.2'])).toBe(false)
    expect(matchesKeywords('a (b) c', ['(b)'])).toBe(true)
  })

  it('multi-word phrase is bounded at the phrase ends', () => {
    expect(matchesKeywords('a mail ballot form', ['mail ballot'])).toBe(true)
    expect(matchesKeywords('mail ballots sent', ['mail ballot'])).toBe(false)
    expect(matchesKeywords('mail ballots sent', ['mail ballot*'])).toBe(true)
  })
})

describe('wildcard sole membership', () => {
  it('matches everything when it is the only entry', () => {
    expect(matchesKeywords('Tobacco Amendments', ['*'])).toBe(true)
    expect(matchesKeywords('', ['*'])).toBe(true)
  })

  it('is dropped when other keywords are present', () => {
    expect(matchesKeywords('Tobacco Amendments', ['*', 'county'])).toBe(false)
    expect(matchesKeywords('County Budget', ['*', 'county'])).toBe(true)
  })

  it('reports the wildcard as the matched keyword', () => {
    expect(matchesUnion('anything', ['*'])).toEqual({ matched: true, keyword: '*' })
  })

  it('empty list matches nothing', () => {
    expect(matchesKeywords('Election Law', [])).toBe(false)
  })

  it('treats a run of only asterisks the same as a bare wildcard', () => {
    expect(matchesKeywords('Tobacco Amendments', ['**'])).toBe(true)
    expect(matchesKeywords('Tobacco Amendments', ['**', 'county'])).toBe(false)
    expect(matchesKeywords('County Budget', ['**', 'county'])).toBe(true)
    expect(matchesKeywords('Tobacco Amendments', ['***'])).toBe(true)
    expect(compileKeyword('**')).toBeNull()
  })
})

describe('degenerate keywords', () => {
  it('drops empty and whitespace-only keywords', () => {
    expect(matchesKeywords('anything at all', ['', '   '])).toBe(false)
    expect(compileKeyword('')).toBeNull()
    expect(compileKeyword('   ')).toBeNull()
  })

  it('a list of only blanks matches nothing', () => {
    expect(matchesKeywords('Election Law', ['', ' '])).toBe(false)
  })

  it('reports which keyword matched', () => {
    expect(matchesUnion('a county budget', ['election', 'county'])).toEqual({
      matched: true, keyword: 'county',
    })
  })
})
