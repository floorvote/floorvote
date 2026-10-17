import { describe, it, expect } from 'vitest'
import {
  BILL_FILTER_DEFS, EMPTY_BILL_FILTER, FILTER_ANY, FILTER_NONE, parseBillFilter, serializeBillFilter, type BillFilter,
} from './billFilter'

// The bill filter is one typed value that travels as a query string: the URL, a saved view, a list request, a
// facet request. These tests pin the contract at the module's two ends, value -> serialize -> parse, and that
// serialize writes equal filters as equal strings.

const filterOf = (overrides: Partial<BillFilter> = {}): BillFilter => ({ ...EMPTY_BILL_FILTER, ...overrides })
const roundTrip = (f: BillFilter): BillFilter => parseBillFilter(serializeBillFilter(f))

// A small seeded generator (mulberry32), so a failure reproduces from its seed and the suite needs no dependency.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Values that stress the query string: separators, encodings, spaces, quotes, and non-ASCII.
const AWKWARD = [
  'a', 'Passed', 'In committee', 'a&b', 'k=v', '50%', 'a+b', 'a b', '#tag', 'x,y', '"quoted phrase"', "it's", 'café', '日本', '🗳', 'a/b?c', ' padded ', '',
]

function generate(seed: number): BillFilter {
  const r = rng(seed)
  const int = (n: number) => Math.floor(r() * n)
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]
  const some = <T,>(xs: readonly T[], max = 4): T[] => Array.from({ length: int(max + 1) }, () => pick(xs))
  const multi = (extra: readonly string[] = []) => some([...AWKWARD, ...extra, '2025', 'NJ', 'high', 'Energy'])
  const slugs = ['committee', 'areas', 'team_lead', '3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c', 'a b', 'x&y', '', '__proto__', 'café']
  const cf: Record<string, string[]> = {}
  for (const key of some(slugs, 3)) cf[key] = Array.from({ length: 1 + int(3) }, () => pick([...AWKWARD, FILTER_ANY]))
  return {
    status: multi(), stage: multi(), year: some(['2024', '2025', '2026']), session: multi(), state: some(['NJ', 'TX', 'UT']),
    position: multi([FILTER_ANY, FILTER_NONE]), priority: multi([FILTER_ANY, FILTER_NONE]), tag: multi([FILTER_ANY]),
    subject: some([
      { state: 'UT', name: 'Elections' }, { state: 'NJ', name: 'Resolutions: Congratulatory' }, { state: '*', name: 'a&b=c' },
      { state: 'TX', name: ' spaced ' }, { state: 'UT', name: '日本' },
    ]),
    minRelevance: r() < 0.5 ? null : int(106) - 5,
    q: pick(['', '', 'election', '"voter id", mail', 'a&b', 'café +plus', ' padded ', 'tab\there', '  ']),
    myBills: r() < 0.5, unvoted: r() < 0.5, newMatches: r() < 0.5, drafts: r() < 0.5,
    match: r() < 0.5 ? 'any' : 'all',
    cf,
  }
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1)

describe('bill filter property tests', () => {
  it('any bill filter survives value -> serialize -> parse unchanged', () => {
    // A guard against a vacuous property: the generated values are not all empty.
    const generated = SEEDS.map(generate)
    expect(generated.some(f => f.subject.length > 0)).toBe(true)
    expect(generated.some(f => Object.keys(f.cf).length > 0)).toBe(true)
    expect(generated.some(f => f.minRelevance !== null)).toBe(true)
    expect(generated.some(f => f.match === 'any')).toBe(true)
    expect(generated.some(f => f.q !== '')).toBe(true)
    for (const seed of SEEDS) {
      const f = generate(seed)
      expect(roundTrip(f), `seed ${seed}: ${serializeBillFilter(f)}`).toEqual(f)
    }
  })

  it('serialize -> parse -> serialize is a fixed point', () => {
    for (const seed of SEEDS) {
      const s = serializeBillFilter(generate(seed))
      expect(serializeBillFilter(parseBillFilter(s)), `seed ${seed}`).toBe(s)
    }
  })

  it('two equal filters serialize to the same string, whatever order their custom fields were built in', () => {
    for (const seed of SEEDS) {
      const f = generate(seed)
      const reversed: BillFilter = { ...f, cf: Object.fromEntries(Object.entries(f.cf).reverse()) }
      expect(serializeBillFilter(reversed), `seed ${seed}`).toBe(serializeBillFilter(f))
    }
  })

  it('serialize writes keys in one order, so a query string in any key order comes back canonical', () => {
    for (const seed of SEEDS) {
      const r = rng(seed + 9000)
      const canonical = serializeBillFilter(generate(seed))
      // Shuffle whole keys, keeping a repeated key's values in their order.
      const byKey = new Map<string, string[]>()
      for (const pair of canonical.split('&').filter(Boolean)) {
        const key = pair.slice(0, pair.indexOf('='))
        byKey.set(key, [...(byKey.get(key) ?? []), pair])
      }
      const keys = [...byKey.keys()].sort(() => r() - 0.5)
      const shuffled = keys.flatMap(k => byKey.get(k)!).join('&')
      expect(serializeBillFilter(parseBillFilter(shuffled)), `seed ${seed}`).toBe(canonical)
    }
  })

  it('two different filters serialize to different strings', () => {
    const seen = new Map<string, BillFilter>()
    for (const seed of SEEDS) {
      const f = generate(seed)
      const s = serializeBillFilter(f)
      const prior = seen.get(s)
      if (prior) expect(prior, `seed ${seed} collides on ${s}`).toEqual(f)
      seen.set(s, f)
    }
  })
})

describe('every filter round-trips', () => {
  it.each<[string, Partial<BillFilter>]>([
    ['status', { status: ['Passed', 'In committee'] }],
    ['stage', { stage: ['introduced', 'enacted'] }],
    ['year', { year: ['2025', '2026'] }],
    ['session', { session: ['2026 Regular Session'] }],
    ['state', { state: ['NJ', 'TX'] }],
    ['position', { position: ['Support', 'Oppose'] }],
    ['position sentinels', { position: [FILTER_ANY, FILTER_NONE] }],
    ['priority', { priority: ['high', 'low'] }],
    ['priority sentinels', { priority: [FILTER_ANY, FILTER_NONE] }],
    ['tag', { tag: ['Energy', 'Labor'] }],
    ['any tag', { tag: [FILTER_ANY] }],
    ['subject', { subject: [{ state: 'UT', name: 'Elections' }, { state: 'NJ', name: 'Resolutions: Congratulatory' }] }],
    ['min relevance', { minRelevance: 5 }],
    ['min relevance of zero', { minRelevance: 0 }],
    ['search', { q: '"voter id", mail & more' }],
    ['my bills', { myBills: true }],
    ['unvoted', { unvoted: true }],
    ['new matches', { newMatches: true }],
    ['drafts', { drafts: true }],
    ['match any', { match: 'any' }],
    ['a custom field by slug', { cf: { team_lead: ['Ada'] } }],
    ['a custom field by id', { cf: { '3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c': ['x', 'y'] } }],
    ['a custom field with the any sentinel', { cf: { committee: [FILTER_ANY], areas: ['x', FILTER_ANY] } }],
    ['every filter at once', {
      status: ['Passed'], stage: ['enacted'], year: ['2026'], session: ['2026 Regular Session'], state: ['UT'], position: [FILTER_NONE],
      priority: [FILTER_ANY], tag: [FILTER_ANY, 'Energy'], subject: [{ state: 'UT', name: 'Elections' }], minRelevance: 3, q: 'election',
      myBills: true, unvoted: true, newMatches: true, drafts: true, match: 'any', cf: { committee: ['Labor'], areas: ['x'] },
    }],
  ])('%s', (_name, overrides) => {
    const f = filterOf(overrides)
    expect(roundTrip(f)).toEqual(f)
  })

  it('writes each filter under its own key, as the URL and the API read it today', () => {
    expect(serializeBillFilter(filterOf({ status: ['Passed'], stage: ['enacted'], year: ['2026'], session: ['S'], state: ['UT'] })))
      .toBe('status=Passed&stage=enacted&year=2026&session=S&state=UT')
    expect(serializeBillFilter(filterOf({ position: ['Support'], priority: ['high'], tag: ['Energy'], subject: [{ state: 'UT', name: 'Elections' }] })))
      .toBe('position=Support&priority=high&tag=Energy&subject=UT%3AElections')
    expect(serializeBillFilter(filterOf({ minRelevance: 4, q: 'x', myBills: true, unvoted: true, newMatches: true, drafts: true, match: 'any' })))
      .toBe('minRelevance=4&q=x&myBills=1&unvoted=1&newMatches=1&drafts=1&match=any')
    expect(serializeBillFilter(filterOf({ cf: { b: ['2'], a: ['1', '3'] } }))).toBe('cf_a=1&cf_a=3&cf_b=2')
  })

  it('writes nothing for an empty filter and reads nothing from an empty query', () => {
    expect(serializeBillFilter(EMPTY_BILL_FILTER)).toBe('')
    expect(parseBillFilter('')).toEqual(EMPTY_BILL_FILTER)
    expect(parseBillFilter(new URLSearchParams())).toEqual(EMPTY_BILL_FILTER)
  })

  it('keeps a filter\'s value order, since a chip row shows them as picked', () => {
    expect(serializeBillFilter(filterOf({ status: ['b', 'a'] }))).toBe('status=b&status=a')
    expect(parseBillFilter('status=b&status=a').status).toEqual(['b', 'a'])
  })
})

describe('parseBillFilter', () => {
  it('reads a query string, a leading question mark, and URLSearchParams the same way', () => {
    const qs = 'status=Passed&cf_team=Ada&unvoted=1'
    expect(parseBillFilter(`?${qs}`)).toEqual(parseBillFilter(qs))
    expect(parseBillFilter(new URLSearchParams(qs))).toEqual(parseBillFilter(qs))
  })

  it('decodes percent escapes and plus signs as a URL does', () => {
    expect(parseBillFilter('status=In%20committee&q=a+b&tag=a%26b').status).toEqual(['In committee'])
    expect(parseBillFilter('q=a+b&tag=a%26b').q).toBe('a b')
    expect(parseBillFilter('tag=a%26b').tag).toEqual(['a&b'])
  })

  describe('toggles', () => {
    it.each(['myBills', 'unvoted', 'newMatches', 'drafts'] as const)('%s is on for 1 and for true', (key) => {
      expect(parseBillFilter(`${key}=1`)[key]).toBe(true)
      expect(parseBillFilter(`${key}=true`)[key]).toBe(true)
    })
    it.each(['myBills', 'unvoted', 'newMatches', 'drafts'] as const)('%s is off for 0, false, an empty value, and anything else', (key) => {
      for (const v of ['0', 'false', '', 'yes', 'on', 'TRUE', 'True', ' 1', '2']) {
        expect(parseBillFilter(`${key}=${encodeURIComponent(v)}`)[key], `${key}=${v}`).toBe(false)
      }
      expect(parseBillFilter('')[key]).toBe(false)
    })
    it('serializes an on toggle as 1, so the two spellings give one string', () => {
      expect(serializeBillFilter(parseBillFilter('unvoted=true'))).toBe('unvoted=1')
      expect(serializeBillFilter(parseBillFilter('unvoted=true'))).toBe(serializeBillFilter(parseBillFilter('unvoted=1')))
    })
  })

  describe('repeated keys', () => {
    it('collects every value of a multi-select filter, in order', () => {
      expect(parseBillFilter('status=a&status=b&status=a').status).toEqual(['a', 'b', 'a'])
    })
    it('takes the first value of a single-valued filter', () => {
      const f = parseBillFilter('q=first&q=second&minRelevance=3&minRelevance=9&match=any&match=all&unvoted=0&unvoted=1&myBills=1&myBills=0')
      expect(f.q).toBe('first')
      expect(f.minRelevance).toBe(3)
      expect(f.match).toBe('any')
      expect(f.unvoted).toBe(false)
      expect(f.myBills).toBe(true)
    })
    it('collects every value of a repeated custom field key', () => {
      expect(parseBillFilter('cf_team=a&cf_team=b').cf).toEqual({ team: ['a', 'b'] })
    })
  })

  describe('unknown keys and values', () => {
    it('ignores unknown keys, and the keys that are not filters (sort, dir, view, page)', () => {
      expect(parseBillFilter('bogus=1&sort=priority&dir=desc&view=abc&page=2&pageSize=10&cf=1&field.x=1&search=x&sessionName=x')).toEqual(EMPTY_BILL_FILTER)
    })
    it('ignores a key whose name only starts like a filter', () => {
      expect(parseBillFilter('statuses=a&Status=b&xcf_a=1').status).toEqual([])
      expect(parseBillFilter('statuses=a&Status=b&xcf_a=1').cf).toEqual({})
    })
    it('drops a subject that is not state:name, and keeps the others', () => {
      expect(parseBillFilter('subject=NoColon&subject=UT%3AElections&subject=%3ANoState&subject=UT%3A').subject)
        .toEqual([{ state: 'UT', name: 'Elections' }])
    })
    it('splits a subject on the first colon only, since a name may hold colons', () => {
      expect(parseBillFilter('subject=TX%3AResolutions%3A%20Congratulatory').subject).toEqual([{ state: 'TX', name: 'Resolutions: Congratulatory' }])
    })
    it('does not cap the subjects: the route answers 400 past the limit, and counts only the valid ones', () => {
      const qs = [...Array.from({ length: 41 }, (_, i) => `subject=UT%3AS${i}`), 'subject=bad'].join('&')
      expect(parseBillFilter(qs).subject).toHaveLength(41)
    })
    it('reads a min relevance as an integer, and ignores one that is not a number', () => {
      expect(parseBillFilter('minRelevance=5').minRelevance).toBe(5)
      expect(parseBillFilter('minRelevance=0').minRelevance).toBe(0)
      expect(parseBillFilter('minRelevance=-2').minRelevance).toBe(-2)
      expect(parseBillFilter('minRelevance=7.9').minRelevance).toBe(7)
      expect(parseBillFilter('minRelevance=').minRelevance).toBeNull()
      expect(parseBillFilter('minRelevance=abc').minRelevance).toBeNull()
    })
    it('reads only match=any as the any mode', () => {
      expect(parseBillFilter('match=any').match).toBe('any')
      for (const v of ['all', 'ANY', '', 'or', '1']) expect(parseBillFilter(`match=${v}`).match, v).toBe('all')
    })
  })

  describe('empty values', () => {
    it('reads an empty search, min relevance, and match as no filter', () => {
      expect(parseBillFilter('q=&minRelevance=&match=')).toEqual(EMPTY_BILL_FILTER)
    })
    it('keeps an empty value of a multi-select filter, as the API has always matched it', () => {
      expect(parseBillFilter('status=').status).toEqual([''])
      expect(roundTrip(filterOf({ status: [''] }))).toEqual(filterOf({ status: [''] }))
    })
  })

  describe('custom fields', () => {
    it('reads cf_<key> as a custom field named by that key, a slug or an id', () => {
      expect(parseBillFilter('cf_committee=Labor&cf_3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c=1').cf)
        .toEqual({ committee: ['Labor'], '3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c': ['1'] })
    })
    it('reads cf_ with no key as a field with an empty key, which matches no field', () => {
      expect(parseBillFilter('cf_=x').cf).toEqual({ '': ['x'] })
    })
    it('survives a key that names an Object.prototype member, without touching the prototype', () => {
      const f = parseBillFilter('cf___proto__=x&cf_constructor=y&cf_toString=z')
      expect(Object.keys(f.cf).sort()).toEqual(['__proto__', 'constructor', 'toString'])
      expect(Object.getPrototypeOf(f.cf)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>).push).toBeUndefined()
      expect(roundTrip(f)).toEqual(f)
    })
    it('keeps the any sentinel as a value', () => {
      expect(parseBillFilter('cf_committee=__any__').cf).toEqual({ committee: [FILTER_ANY] })
    })
  })

  describe('the value is immutable', () => {
    const parsed = () => parseBillFilter('status=a&subject=UT%3AElections&cf_team=Ada')
    it('freezes the filter, its lists, its subjects, and its custom fields', () => {
      const f = parsed()
      expect(Object.isFrozen(f)).toBe(true)
      expect(Object.isFrozen(f.status)).toBe(true)
      expect(Object.isFrozen(f.subject)).toBe(true)
      expect(Object.isFrozen(f.subject[0])).toBe(true)
      expect(Object.isFrozen(f.cf)).toBe(true)
      expect(Object.isFrozen(f.cf.team)).toBe(true)
    })
    it('throws on a write, in strict mode', () => {
      const f = parsed()
      expect(() => { (f as { q: string }).q = 'x' }).toThrow()
      expect(() => { (f.status as string[]).push('b') }).toThrow()
      expect(() => { (f.cf.team as string[]).push('b') }).toThrow()
    })
    it('freezes the empty filter, which every empty parse can share', () => {
      expect(Object.isFrozen(EMPTY_BILL_FILTER)).toBe(true)
      expect(Object.isFrozen(EMPTY_BILL_FILTER.status)).toBe(true)
      expect(Object.isFrozen(EMPTY_BILL_FILTER.cf)).toBe(true)
    })
    it('does not change the input it was given', () => {
      const params = new URLSearchParams('status=a&status=b')
      parseBillFilter(params)
      expect(params.toString()).toBe('status=a&status=b')
    })
  })
})

describe('the definitions', () => {
  it('define the sentinels once: any and none', () => {
    expect(FILTER_ANY).toBe('__any__')
    expect(FILTER_NONE).toBe('none')
  })

  it('name every filter of the value, once each, with a kind', () => {
    const names = BILL_FILTER_DEFS.map(d => d.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual(Object.keys(EMPTY_BILL_FILTER).sort())
    expect(new Set(BILL_FILTER_DEFS.map(d => d.kind))).toEqual(new Set(['multi-select', 'toggle', 'range', 'text', 'custom-field']))
  })

  it('give a filter its sentinels: position and priority take any and none, tags take any', () => {
    const sentinels = (name: string) => BILL_FILTER_DEFS.find(d => d.name === name)?.sentinels
    expect(sentinels('position')).toEqual([FILTER_ANY, FILTER_NONE])
    expect(sentinels('priority')).toEqual([FILTER_ANY, FILTER_NONE])
    expect(sentinels('tag')).toEqual([FILTER_ANY])
    expect(sentinels('status')).toEqual([])
  })

  it('give a name that is both a key of the value and the key the query string uses today', () => {
    const keys = serializeBillFilter(filterOf({
      status: ['a'], stage: ['a'], year: ['a'], session: ['a'], state: ['a'], position: ['a'], priority: ['a'], tag: ['a'],
      subject: [{ state: 'a', name: 'b' }], minRelevance: 1, q: 'a', myBills: true, unvoted: true, newMatches: true, drafts: true, match: 'any',
    })).split('&').map(p => p.slice(0, p.indexOf('=')))
    // A custom field's key is `cf_<its slug or id>`, so it is the one name not written as itself.
    expect(keys.sort()).toEqual(BILL_FILTER_DEFS.map(d => d.name).filter(n => n !== 'cf').sort())
  })
})
