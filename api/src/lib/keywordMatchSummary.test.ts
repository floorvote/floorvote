import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { getDb } from '../db/client'
import { clearDb, seedBill } from '../../test/helpers'
import { matchesKeywords } from './keywords'
import {
  summarizeKeywordMatches, foldForMatch, isFoldSafe, clearKeywordMatchCorpus, setMaxCachedCharsForTest,
} from './keywordMatchSummary'
import { BILL_KEYWORD_MATCH_CASES, KEYWORD_MATCH_CASES } from '../../../shared/keywordMatchFixtures'

describe('foldForMatch', () => {
  it('lowercases ASCII and Latin-1 exactly as toLowerCase does', () => {
    for (let c = 0; c <= 255; c++) {
      const ch = String.fromCharCode(c)
      expect(foldForMatch(ch), `U+${c.toString(16)}`).toBe(ch.toLowerCase())
    }
  })

  it('replaces every character outside Latin-1 with a sentinel no keyword can contain, keeping the length', () => {
    const folded = foldForMatch('Voters\u2019 Rights \u2014 \u65E5\u672C \u{1F5F3}')
    expect(folded).toBe('voters\u0001 rights \u0001 \u0001\u0001 \u0001\u0001')
    expect([...folded].every(ch => ch.charCodeAt(0) <= 255)).toBe(true)
  })

  it('turns the line separators the regex dot refuses to cross into newlines', () => {
    expect(foldForMatch('a\u2028b\u2029c')).toBe('a\nb\nc')
  })

  it('does not lowercase non-Latin-1 characters into Latin-1 ones', () => {
    // toLowerCase would turn the dotted capital I into "i" plus a combining dot.
    expect(foldForMatch('\u0130')).toBe('\u0001')
    // And the Kelvin sign into an ASCII "k".
    expect(foldForMatch('\u212A')).toBe('\u0001')
  })

  it('handles text longer than one chunk', () => {
    const long = 'Ab\u2014'.repeat(10_000)
    expect(foldForMatch(long)).toBe('ab\u0001'.repeat(10_000))
  })
})

describe('isFoldSafe', () => {
  it.each(['election', '*corporat*', '5.#*', '\u00E9lection', '\u00A7 12', 'Stra\u00DFe'])('accepts %s', kw => {
    expect(isFoldSafe(kw)).toBe(true)
  })

  it.each([
    ['a curly quote', 'voters\u2019 rights'],
    ['a non-Latin script', '\u65E5\u672C'],
    ['y with diaeresis, whose capital is outside Latin-1', '\u00FF'],
    ['the micro sign, whose capital is Greek', '\u00B5'],
    ['the sentinel character itself', 'a\u0001b'],
    ['a newline, which a folded line separator becomes', 'a\nb'],
    ['a carriage return', 'a\rb'],
  ])('rejects %s', (_name, kw) => {
    expect(isFoldSafe(kw)).toBe(false)
  })
})

// The cache holds folded text, so a count from it must agree with matching the
// raw text, for every keyword list the cache is allowed to serve.
describe('matching folded text agrees with matching raw text', () => {
  const EXTRA: { text: string; keywords: string[] }[] = [
    { text: 'Voters\u2019 Rights Act', keywords: ['voters', 'rights'] },
    { text: 'Voters\u2019 Rights Act', keywords: ['rights act'] },
    { text: 'Voters \u2014 Rights', keywords: ['voters', 'rights', 'voters rights'] },
    { text: 'Voters\u2014rights', keywords: ['voters', 'rights'] },
    // A phrase must not match across a character the folded text has replaced.
    { text: 'Health Care\u2014Access', keywords: ['care access'] },
    { text: 'Health Care \u2014 Access', keywords: ['care access'] },
    { text: 'Voters\u2019rights act', keywords: ['voters rights'] },
    { text: 'Voters\u2019 rights act', keywords: ['voters rights'] },
    { text: 'board\u2003of\u2003canvassers', keywords: ['board of canvassers'] },
    { text: 'board of canvassers', keywords: ['board of canvassers'] },
    { text: 'a\u2028b', keywords: ['a b'] },
    { text: 'a\u2014b', keywords: ['a b'] },
    { text: 'Elections\u2014Reform', keywords: ['election*', '*reform'] },
    { text: 'R\u00E9forme \u00E9lectorale', keywords: ['\u00E9lectorale', 'r\u00E9forme', 'electorale'] },
    { text: 'R\u00C9FORME \u00C9LECTORALE', keywords: ['\u00E9lectorale', 'r\u00E9forme'] },
    { text: 'r\u00E9forme \u00E9lectorale', keywords: ['\u00C9LECTORALE'] },
    { text: 'caf\u00E9s and caf\u00E9', keywords: ['caf\u00E9', 'caf\u00E9*'] },
    { text: 'S\u00E9lection de caf\u00E9', keywords: ['*lection'] },
    { text: 'Stra\u00DFe', keywords: ['stra\u00DFe', 'strasse'] },
    { text: 'See \u00A7 12.5 of the code', keywords: ['\u00A7 12.5', '12.#'] },
    { text: 'Tax\u2019s \u201CReform\u201D 2024', keywords: ['reform', 'tax', '2024'] },
    // Characters that case-fold onto ASCII letters under toLowerCase but not under the regex.
    { text: 'The \u212Aelvin scale', keywords: ['kelvin'] },
    { text: 'The \u212Aelvin scale', keywords: ['kelvin*'] },
    { text: '\u0130stanbul bill', keywords: ['istanbul'] },
    { text: '\u0130stanbul bill', keywords: ['*istanbul'] },
    { text: 'Fa\u017Fcist laws', keywords: ['fascist'] },
    { text: 'Fa\u017Fcist laws', keywords: ['fa*cist'] },
    // Line separators stop a star in the raw text.
    { text: 'alpha\u2028beta', keywords: ['alpha*beta'] },
    { text: 'alpha\u2029beta', keywords: ['alpha*beta'] },
    { text: 'alpha\u2014beta', keywords: ['alpha*beta'] },
    { text: 'alpha\nbeta', keywords: ['alpha*beta'] },
    { text: '\u65E5\u672C bill 12', keywords: ['bill', 'bill*', '12'] },
    { text: 'caf\u00E9 \u{1F5F3} vote', keywords: ['vote', 'caf\u00E9'] },
  ]

  const cases = [
    ...KEYWORD_MATCH_CASES.map(c => ({ text: c.text, keywords: c.keywords })),
    ...BILL_KEYWORD_MATCH_CASES.map(c => ({
      text: `${c.bill.title ?? ''} ${c.bill.description ?? ''} ${c.bill.billNumber}`, keywords: c.keywords,
    })),
    ...EXTRA,
  ].filter(c => c.keywords.every(isFoldSafe))

  it('has a body of cases to check', () => {
    expect(cases.length).toBeGreaterThan(60)
  })

  it.each(cases.map(c => [JSON.stringify(c.text).slice(0, 60) + ' / ' + JSON.stringify(c.keywords), c] as const))(
    '%s', (_name, { text, keywords }) => {
      expect(matchesKeywords(foldForMatch(text), keywords)).toBe(matchesKeywords(text, keywords))
    },
  )
})

describe('summarizeKeywordMatches memory handling', () => {
  const tenant = 'memory-test'

  // A DB whose prepared statements are counted, so a test can tell a re-read from a cache hit.
  function countingDb() {
    const state = { billReads: 0 }
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (query: string) => {
            if (query.includes('"abstract"')) state.billReads++
            return target.prepare(query)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { state, db: getDb(DB as typeof env.DB) }
  }

  beforeEach(async () => {
    await clearDb()
    clearKeywordMatchCorpus()
  })

  afterEach(() => {
    clearKeywordMatchCorpus()
    vi.restoreAllMocks()
  })

  describe('non-ASCII bills', () => {
    beforeEach(async () => {
      await seedBill({ externalId: 'legiscan:1', title: 'Voters\u2019 Rights \u2014 \u00C9lections Reform', billNumber: 'HB 1', matchType: null })
      await seedBill({ externalId: 'legiscan:2', title: 'Road Maintenance', billNumber: 'HB 2', matchType: null })
    })

    it('counts the same from the cache as from the first read', async () => {
      const { state, db } = countingDb()
      const first = await summarizeKeywordMatches(db, tenant, ['\u00E9lections', 'rights'], [])
      const second = await summarizeKeywordMatches(db, tenant, ['\u00E9lections', 'rights'], [])
      expect(first).toEqual({ total: 2, matched: 1, newlyMatched: 1, unmatched: 0 })
      expect(second).toEqual(first)
      expect(state.billReads).toBe(1)
    })

    it('gives a phrase the same count from the cache as from the first read, across an em-dash or curly quote', async () => {
      await seedBill({ externalId: 'legiscan:3', title: 'Health Care\u2014Access Act', billNumber: 'HB 3', matchType: null })
      await seedBill({ externalId: 'legiscan:4', title: 'Voters\u2019rights Act', billNumber: 'HB 4', matchType: null })
      await seedBill({ externalId: 'legiscan:5', title: 'Health Care Access Act', billNumber: 'HB 5', matchType: null })
      const { db } = countingDb()
      const keywords = ['care access', 'voters rights']
      const first = await summarizeKeywordMatches(db, tenant, keywords, [])
      const second = await summarizeKeywordMatches(db, tenant, keywords, [])
      expect(first).toMatchObject({ total: 5, matched: 1 })
      expect(second).toEqual(first)
    })

    it('answers a keyword outside Latin-1 from the bills, not from the folded cache', async () => {
      const { state, db } = countingDb()
      await summarizeKeywordMatches(db, tenant, ['road'], [])
      const withQuote = await summarizeKeywordMatches(db, tenant, ['voters\u2019 rights'], [])
      expect(withQuote).toMatchObject({ total: 2, matched: 1 })
      // The cache is neither used nor discarded: a safe list afterwards is still a hit.
      await summarizeKeywordMatches(db, tenant, ['road'], [])
      expect(state.billReads).toBe(2)
    })

    it('does not match a different curly quote when the keyword has one', async () => {
      const { db } = countingDb()
      await summarizeKeywordMatches(db, tenant, ['road'], [])
      expect(await summarizeKeywordMatches(db, tenant, ['voters\u2018 rights'], [])).toMatchObject({ matched: 0 })
    })
  })

  describe('concurrent calls on a cold cache', () => {
    beforeEach(async () => {
      await seedBill({ externalId: 'legiscan:1', title: 'Election Reform Act', billNumber: 'HB 1', matchType: null })
      await seedBill({ externalId: 'legiscan:2', title: 'Road Maintenance', billNumber: 'HB 2', matchType: null })
    })

    it('share one read of the bills and each get their own counts', async () => {
      const { state, db } = countingDb()
      const results = await Promise.all([
        summarizeKeywordMatches(db, tenant, ['election'], []),
        summarizeKeywordMatches(db, tenant, ['road'], []),
        summarizeKeywordMatches(db, tenant, ['election', 'road'], []),
      ])
      expect(state.billReads).toBe(1)
      expect(results.map(r => r.matched)).toEqual([1, 1, 2])
    })

    it('read again after a failed load, rather than sharing the failure', async () => {
      const failing = countingDb()
      const original = failing.db
      const broken = { ...original, select: () => { throw new Error('d1 down') } } as unknown as typeof original
      await expect(summarizeKeywordMatches(broken, tenant, ['election'], [])).rejects.toThrow('d1 down')
      expect(await summarizeKeywordMatches(original, tenant, ['election'], [])).toMatchObject({ matched: 1 })
    })
  })

  describe('the size guard', () => {
    beforeEach(async () => {
      await seedBill({ externalId: 'legiscan:1', title: 'Election Reform Act', billNumber: 'HB 1', matchType: null })
      await seedBill({ externalId: 'legiscan:2', title: 'Election Day Holiday', billNumber: 'HB 2', matchType: null })
      await seedBill({ externalId: 'legiscan:3', title: 'Road Maintenance', billNumber: 'HB 3', matchType: null })
    })

    it('keeps the corpus when it is under the limit', async () => {
      setMaxCachedCharsForTest(10_000)
      const { state, db } = countingDb()
      await summarizeKeywordMatches(db, tenant, ['election'], [])
      await summarizeKeywordMatches(db, tenant, ['election'], [])
      expect(state.billReads).toBe(1)
    })

    it('does not cache a corpus over the limit, but still answers every call correctly', async () => {
      setMaxCachedCharsForTest(20)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { state, db } = countingDb()
      const first = await summarizeKeywordMatches(db, tenant, ['election'], ['road'])
      const second = await summarizeKeywordMatches(db, tenant, ['election'], ['road'])
      expect(first).toEqual({ total: 3, matched: 2, newlyMatched: 2, unmatched: 1 })
      expect(second).toEqual(first)
      // The first call tried to build the corpus and then counted by streaming; the
      // second knew the corpus was too big and only streamed.
      expect(state.billReads).toBe(3)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('not cached')
    })

    it('counts across several pages without keeping them', async () => {
      setMaxCachedCharsForTest(20)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2299)
         INSERT INTO bills (id, external_id, bill_number, title, state)
         SELECT printf('bulk-%05d', i), 'bulk:' || i, 'SB ' || i,
                CASE WHEN i % 10 = 0 THEN 'Tax Reform' ELSE 'Fish Hatcheries' END, 'RI'
         FROM n`,
      ).run()
      expect(await summarizeKeywordMatches(getDb(env.DB), tenant, ['tax'], [])).toMatchObject({ total: 2303, matched: 230 })
    })
  })
})
