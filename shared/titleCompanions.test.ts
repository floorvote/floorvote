import { describe, it, expect } from 'vitest'
import { matchTitleCompanions, normalizeTitle, titleCompanionPairs, titleKey, MIN_TITLE_LENGTH, type TitleMatchBill } from './titleCompanions'

// Title-matched companion suggestions (#521): the pure matcher. Bills in,
// suggested pairs out. A pair is suggested when both bills are in the same
// session, one in each chamber, of the same eligible bill type (never a
// resolution), with titles equal after normalizing case, punctuation, and
// whitespace, at least 30 characters long, and no third bill of that type in
// that session shares the title.

const TITLE = 'An Act relating to elections, voter registration and ballots'
const BILLS = ['B'] as const

let next = 0
function bill(overrides: Partial<TitleMatchBill> = {}): TitleMatchBill {
  next += 1
  return { id: `bill${next}`, sessionId: 's1', chamber: 'H', billType: 'B', title: TITLE, ...overrides }
}
// The pair every negative case below is a variation of, so each case shows the one thing that stops it.
const control = () => expect(matchTitleCompanions([bill({ chamber: 'H' }), bill({ chamber: 'S' })], BILLS)).toHaveLength(1)
const ids = (pairs: Array<[TitleMatchBill, TitleMatchBill]>) => pairs.map(([a, b]) => [a.id, b.id].sort())

describe('normalizeTitle', () => {
  it('ignores case, punctuation, and runs of whitespace', () => {
    expect(normalizeTitle('An Act Relating to ELECTIONS -- Voter Registration.')).toBe('an act relating to elections voter registration')
    expect(normalizeTitle('  An act, relating to elections; voter   registration  ')).toBe('an act relating to elections voter registration')
  })

  it('keeps letters and digits, so bills on different chapters stay apart', () => {
    expect(normalizeTitle('Amends Chapter 17-19')).toBe('amends chapter 17 19')
    expect(normalizeTitle('Amends Chapter 17-19')).not.toBe(normalizeTitle('Amends Chapter 17-20'))
  })

  it('reads accented letters as letters, not punctuation', () => {
    expect(normalizeTitle('Café   licensing')).toBe('café licensing')
  })

  it('makes an empty or all-punctuation title empty', () => {
    expect(normalizeTitle('-- A --')).toBe('a')
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle(' -- . ; ')).toBe('')
  })
})

describe('titleKey', () => {
  it('keys a bill by its type and normalized title', () => {
    const key = titleKey({ title: TITLE, billType: 'B', chamber: 'H' }, BILLS)
    expect(key).not.toBeNull()
    expect(key).toContain(normalizeTitle(TITLE))
  })

  it('gives titles that differ only in case or punctuation the same key', () => {
    const a = titleKey({ title: 'AN ACT RELATING TO ELECTIONS -- VOTER REGISTRATION AND BALLOTS', billType: 'B', chamber: 'H' }, BILLS)
    const b = titleKey({ title: 'An act relating to elections: voter registration, and ballots.', billType: 'B', chamber: 'S' }, BILLS)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('reads the bill type without regard to case', () => {
    expect(titleKey({ title: TITLE, billType: 'b', chamber: 'H' }, BILLS)).not.toBeNull()
    expect(titleKey({ title: TITLE, billType: 'b', chamber: 'H' }, BILLS)).toBe(titleKey({ title: TITLE, billType: 'B', chamber: 'S' }, BILLS))
  })

  it('gives bills of different types different keys', () => {
    const a = titleKey({ title: TITLE, billType: 'B', chamber: 'H' }, ['B', 'CB'])
    const b = titleKey({ title: TITLE, billType: 'CB', chamber: 'S' }, ['B', 'CB'])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  it('keys no resolution, nor any type the provider leaves out', () => {
    expect(titleKey({ title: TITLE, billType: 'B', chamber: 'H' }, BILLS)).not.toBeNull()
    for (const billType of ['R', 'JR', 'CR', 'M']) {
      expect(titleKey({ title: TITLE, billType, chamber: 'H' }, BILLS)).toBeNull()
    }
  })

  it('keys no bill whose type or chamber is unknown, as a stub central never fetched', () => {
    expect(titleKey({ title: TITLE, billType: 'B', chamber: 'H' }, BILLS)).not.toBeNull()
    expect(titleKey({ title: TITLE, billType: null, chamber: 'H' }, BILLS)).toBeNull()
    expect(titleKey({ title: TITLE, billType: 'B', chamber: null }, BILLS)).toBeNull()
    expect(titleKey({ title: TITLE, billType: 'B', chamber: '' }, BILLS)).toBeNull()
  })

  it(`keys no title shorter than ${MIN_TITLE_LENGTH} characters once normalized`, () => {
    const exactly = 'a'.repeat(MIN_TITLE_LENGTH)
    expect(titleKey({ title: exactly, billType: 'B', chamber: 'H' }, BILLS)).not.toBeNull()
    expect(titleKey({ title: exactly.slice(1), billType: 'B', chamber: 'H' }, BILLS)).toBeNull()
    // Punctuation doesn't count toward the length: 29 letters and a lot of dots.
    expect(titleKey({ title: `${'a'.repeat(MIN_TITLE_LENGTH - 1)}.......`, billType: 'B', chamber: 'H' }, BILLS)).toBeNull()
  })

  it('keys no bill with an empty title', () => {
    expect(titleKey({ title: TITLE, billType: 'B', chamber: 'H' }, BILLS)).not.toBeNull()
    expect(titleKey({ title: '', billType: 'B', chamber: 'H' }, BILLS)).toBeNull()
  })
})

describe('matchTitleCompanions', () => {
  it('suggests a House bill and a Senate bill with the same title in the same session', () => {
    const h = bill({ chamber: 'H' })
    const s = bill({ chamber: 'S' })
    expect(ids(matchTitleCompanions([h, s], BILLS))).toEqual([[h.id, s.id].sort()])
  })

  it('suggests a pair whose titles differ only in case and punctuation', () => {
    const h = bill({ chamber: 'H', title: 'AN ACT RELATING TO ELECTIONS - VOTER REGISTRATION AND BALLOTS' })
    const s = bill({ chamber: 'S', title: 'An act relating to elections: voter registration, and ballots.' })
    expect(matchTitleCompanions([h, s], BILLS)).toHaveLength(1)
  })

  it('suggests nothing when three bills share the title', () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H' }), bill({ chamber: 'S' }), bill({ chamber: 'S' })], BILLS)).toEqual([])
    expect(matchTitleCompanions([bill({ chamber: 'H' }), bill({ chamber: 'H' }), bill({ chamber: 'S' })], BILLS)).toEqual([])
  })

  it('suggests nothing for two bills in the same chamber', () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H' }), bill({ chamber: 'H' })], BILLS)).toEqual([])
  })

  it('suggests nothing for a pair in different sessions', () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H', sessionId: 's1' }), bill({ chamber: 'S', sessionId: 's2' })], BILLS)).toEqual([])
  })

  it('suggests nothing for a bill with no session', () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H', sessionId: null }), bill({ chamber: 'S', sessionId: null })], BILLS)).toEqual([])
  })

  it('suggests nothing for a pair of different bill types', () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H', billType: 'B' }), bill({ chamber: 'S', billType: 'CB' })], ['B', 'CB'])).toEqual([])
  })

  it('suggests no pair of resolutions', () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H', billType: 'R' }), bill({ chamber: 'S', billType: 'R' })], BILLS)).toEqual([])
    expect(matchTitleCompanions([bill({ chamber: 'H', billType: 'JR' }), bill({ chamber: 'S', billType: 'JR' })], BILLS)).toEqual([])
  })

  it('lets a resolution with the same title stand beside a bill pair without spoiling it', () => {
    const h = bill({ chamber: 'H' })
    const s = bill({ chamber: 'S' })
    const pairs = matchTitleCompanions([h, s, bill({ chamber: 'H', billType: 'R' }), bill({ chamber: 'S', billType: 'R' })], BILLS)
    expect(ids(pairs)).toEqual([[h.id, s.id].sort()])
  })

  it(`suggests nothing for a title under ${MIN_TITLE_LENGTH} characters`, () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H', title: 'Elections' }), bill({ chamber: 'S', title: 'Elections' })], BILLS)).toEqual([])
  })

  it('suggests nothing for two bills with empty titles', () => {
    control()
    expect(matchTitleCompanions([bill({ chamber: 'H', title: '' }), bill({ chamber: 'S', title: '' })], BILLS)).toEqual([])
  })

  it('finds every pair in a session, each on its own title', () => {
    const pairs = matchTitleCompanions([
      bill({ id: 'h1', chamber: 'H', title: `${TITLE} one` }), bill({ id: 's1', chamber: 'S', title: `${TITLE} one` }),
      bill({ id: 'h2', chamber: 'H', title: `${TITLE} two` }), bill({ id: 's2', chamber: 'S', title: `${TITLE} two` }),
      bill({ id: 'h3', chamber: 'H', title: `${TITLE} three` }),
    ], BILLS)
    expect(ids(pairs).sort()).toEqual([['h1', 's1'], ['h2', 's2']])
  })

  it('suggests an Assembly bill with a Senate bill, since any two chambers count', () => {
    expect(matchTitleCompanions([bill({ chamber: 'A' }), bill({ chamber: 'S' })], BILLS)).toHaveLength(1)
  })
})

describe('titleCompanionPairs', () => {
  it('pairs bills by stored key alone, so an instance can pair the rows it reads', () => {
    const rows = [
      { id: 'x', sessionId: 's1', chamber: 'H', titleKey: 'B|k' },
      { id: 'y', sessionId: 's1', chamber: 'S', titleKey: 'B|k' },
      { id: 'z', sessionId: 's1', chamber: 'S', titleKey: null },
    ]
    expect(titleCompanionPairs(rows).map(([a, b]) => [a.id, b.id].sort())).toEqual([['x', 'y']])
  })

  it('pairs nothing when a third row holds the key', () => {
    expect(titleCompanionPairs([{ id: 'a', sessionId: 's1', chamber: 'H', titleKey: 'B|k' }, { id: 'b', sessionId: 's1', chamber: 'S', titleKey: 'B|k' }])).toHaveLength(1)
    const rows = ['H', 'S', 'S'].map((chamber, i) => ({ id: `r${i}`, sessionId: 's1', chamber, titleKey: 'B|k' }))
    expect(titleCompanionPairs(rows)).toEqual([])
  })
})
