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

  it('digits block a boundary, exactly as letters do', () => {
    expect(matchesKeywords('election2024 results', ['election'])).toBe(false)
    expect(matchesKeywords('election2024 results', ['election*'])).toBe(true)
  })

  it('a chapter glob matches a statute section but not a subdivision', () => {
    // Bill descriptions lead with the sections affected, so a chapter is an
    // intake signal on its own: "An Act to amend 5.02 of the statutes; ..."
    expect(matchesKeywords('An Act to amend 5.02 of the statutes', ['5.#*'])).toBe(true)
    expect(matchesKeywords('An Act to amend 115.385 of the statutes', ['5.#*'])).toBe(false)
    // "(1) (b) 5.," is a subdivision of ch. 115, not a section of ch. 5. The
    // digit token is the only thing that separates the two.
    expect(matchesKeywords('to amend 115.385 (1) (b) 5., 6.30', ['5.#*'])).toBe(false)
    expect(matchesKeywords('to amend 115.385 (1) (b) 5., 6.30', ['5.*'])).toBe(true)
  })

  it('# matches exactly one digit and is a literal nowhere', () => {
    expect(matchesKeywords('section 5.02', ['5.##'])).toBe(true)
    expect(matchesKeywords('section 5.0', ['5.##'])).toBe(false)
    expect(matchesKeywords('ranked #1 priority', ['#1'])).toBe(false)
  })

  it('a # run does not defeat the prefilter', () => {
    // The prefilter substring-tests the longest literal run. A '#' is not
    // literal text, so a run containing one must be split before that pick —
    // otherwise '5.#' goes into the substring test, no bill contains it, and
    // the keyword silently matches nothing.
    expect(matchesKeywords('to create 59.52 (1)', ['59.#*'])).toBe(true)
    expect(matchesKeywords('to create 765.001 (2)', ['#65.#*'])).toBe(true)
  })

  it('an exact section cite stays exact', () => {
    expect(matchesKeywords('to amend 19.85 (1) (c)', ['19.85'])).toBe(true)
    expect(matchesKeywords('to amend 19.851 (1)', ['19.85'])).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(matchesKeywords('ELECTION LAW', ['election'])).toBe(true)
  })

  it('supports an internal star', () => {
    expect(matchesKeywords('mail in ballot', ['mail*ballot'])).toBe(true)
    expect(matchesKeywords('ballot by mail', ['mail*ballot'])).toBe(false)
  })

  it('collapses a run of interior stars instead of compounding them', () => {
    // Regression for catastrophic backtracking: an uncollapsed run of stars
    // (e.g. 'a***b' -> 'a.*.*.*b') creates one backtracking choice point per
    // star, which compounds multiplicatively on a failing match against long
    // text. This must still match, and must do so promptly.
    expect(matchesKeywords('a big b', ['a***b'])).toBe(true)
    expect(matchesKeywords('mail in ballot', ['mail**ballot'])).toBe(true)
    expect(compileKeyword('a***b')?.source).toBe(compileKeyword('a*b')?.source)
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

describe('matchesUnion return value', () => {
  it('a hit reports the matching keyword', () => {
    expect(matchesUnion('a county budget', ['election', 'county'])).toEqual({
      matched: true, keyword: 'county',
    })
  })

  it('a miss reports an empty keyword', () => {
    expect(matchesUnion('tobacco amendments', ['election', 'county'])).toEqual({
      matched: false, keyword: '',
    })
  })

  it('the wildcard reports the wildcard', () => {
    expect(matchesUnion('anything', ['*'])).toEqual({ matched: true, keyword: '*' })
  })

  it('a literal asterisk in the text does not trigger the wildcard', () => {
    expect(matchesUnion('Budget * Amendments', ['county'])).toEqual({
      matched: false, keyword: '',
    })
  })

  it('a literal asterisk in the text does not prevent a real match', () => {
    expect(matchesUnion('County * Budget', ['county']).matched).toBe(true)
  })
})

describe('literal prefilter', () => {
  // matchesUnion rejects a bill cheaply when the pattern's longest literal run
  // is absent. These are the ways that shortcut could lie.
  it('still matches when the literal differs in case from the text', () => {
    expect(matchesKeywords('ELECTION LAW AMENDMENTS', ['election*'])).toBe(true)
    expect(matchesKeywords('Incorporated Town', ['*corporat*'])).toBe(true)
  })

  it('still matches when the longest literal is not the first segment', () => {
    expect(matchesKeywords('a mail in ballot form', ['mail*ballot'])).toBe(true)
    expect(matchesKeywords('ballot by mail', ['mail*ballot'])).toBe(false)
  })

  it('still matches a pattern whose literal carries regex metacharacters', () => {
    expect(matchesKeywords('section 1.2 applies', ['1.2'])).toBe(true)
    expect(matchesKeywords('section 132 applies', ['1.2'])).toBe(false)
  })

  it('rejects when the literal is present but the boundary fails', () => {
    // The prefilter passes here — "election" is in "selection" — so the regex
    // still has to do the real work.
    expect(matchesKeywords('selection process', ['election*'])).toBe(false)
    expect(matchesKeywords('resilient infrastructure', ['*lien'])).toBe(false)
  })

  it('matches a phrase whose literal spans a space', () => {
    expect(matchesKeywords('the campaign finance report', ['campaign finance*'])).toBe(true)
    expect(matchesKeywords('a finance campaign', ['campaign finance*'])).toBe(false)
  })
})
