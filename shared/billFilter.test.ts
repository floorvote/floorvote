import { describe, it, expect } from 'vitest'
import {
  BILL_FILTER_DEFS, EMPTY_BILL_FILTER, FILTER_ANY, FILTER_NONE, activeFilterCount, activeFilters, billsListPath, parseBillFilter, serializeBillFilter, withBillFilter, type BillFilter,
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
    status: multi(), stage: multi(), year: some(['2024', '2025', '2026']), sessionName: multi(), state: some(['NJ', 'TX', 'UT']),
    position: multi([FILTER_ANY, FILTER_NONE]), priority: multi([FILTER_ANY, FILTER_NONE]), tag: multi([FILTER_ANY]),
    subject: some([
      { state: 'UT', name: 'Elections' }, { state: 'NJ', name: 'Resolutions: Congratulatory' }, { state: '*', name: 'a&b=c' },
      { state: 'TX', name: ' spaced ' }, { state: 'UT', name: '日本' },
    ]),
    minRelevance: r() < 0.5 ? null : int(106) - 5,
    search: pick(['', '', 'election', '"voter id", mail', 'a&b', 'café +plus', ' padded ', 'tab\there', '  ']),
    myBills: r() < 0.5, unvoted: r() < 0.5, newMatches: r() < 0.5, drafts: r() < 0.5,
    match: r() < 0.5 ? 'any' : 'all',
    field: cf,
  }
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1)

describe('bill filter property tests', () => {
  it('any bill filter survives value -> serialize -> parse unchanged', () => {
    // A guard against a vacuous property: the generated values are not all empty.
    const generated = SEEDS.map(generate)
    expect(generated.some(f => f.subject.length > 0)).toBe(true)
    expect(generated.some(f => Object.keys(f.field).length > 0)).toBe(true)
    expect(generated.some(f => f.minRelevance !== null)).toBe(true)
    expect(generated.some(f => f.match === 'any')).toBe(true)
    expect(generated.some(f => f.search !== '')).toBe(true)
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
      const reversed: BillFilter = { ...f, field: Object.fromEntries(Object.entries(f.field).reverse()) }
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
    ['session name', { sessionName: ['2026 Regular Session'] }],
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
    ['search', { search: '"voter id", mail & more' }],
    ['my bills', { myBills: true }],
    ['unvoted', { unvoted: true }],
    ['new matches', { newMatches: true }],
    ['drafts', { drafts: true }],
    ['match any', { match: 'any' }],
    ['a custom field by slug', { field: { team_lead: ['Ada'] } }],
    ['a custom field by id', { field: { '3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c': ['x', 'y'] } }],
    ['a custom field with the any sentinel', { field: { committee: [FILTER_ANY], areas: ['x', FILTER_ANY] } }],
    ['every filter at once', {
      status: ['Passed'], stage: ['enacted'], year: ['2026'], sessionName: ['2026 Regular Session'], state: ['UT'], position: [FILTER_NONE],
      priority: [FILTER_ANY], tag: [FILTER_ANY, 'Energy'], subject: [{ state: 'UT', name: 'Elections' }], minRelevance: 3, search: 'election',
      myBills: true, unvoted: true, newMatches: true, drafts: true, match: 'any', field: { committee: ['Labor'], areas: ['x'] },
    }],
  ])('%s', (_name, overrides) => {
    const f = filterOf(overrides)
    expect(roundTrip(f)).toEqual(f)
  })

  it('writes each filter under its own key, as the URL and the API read it today', () => {
    expect(serializeBillFilter(filterOf({ status: ['Passed'], stage: ['enacted'], year: ['2026'], sessionName: ['S'], state: ['UT'] })))
      .toBe('status=Passed&stage=enacted&year=2026&sessionName=S&state=UT')
    expect(serializeBillFilter(filterOf({ position: ['Support'], priority: ['high'], tag: ['Energy'], subject: [{ state: 'UT', name: 'Elections' }] })))
      .toBe('position=Support&priority=high&tag=Energy&subject=UT%3AElections')
    expect(serializeBillFilter(filterOf({ minRelevance: 4, search: 'x', myBills: true, unvoted: true, newMatches: true, drafts: true, match: 'any' })))
      .toBe('minRelevance=4&search=x&myBills=1&unvoted=1&newMatches=1&drafts=1&match=any')
    expect(serializeBillFilter(filterOf({ field: { b: ['2'], a: ['1', '3'] } }))).toBe('field.a=1&field.a=3&field.b=2')
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
    const qs = 'status=Passed&field.team=Ada&unvoted=1'
    expect(parseBillFilter(`?${qs}`)).toEqual(parseBillFilter(qs))
    expect(parseBillFilter(new URLSearchParams(qs))).toEqual(parseBillFilter(qs))
  })

  it('decodes percent escapes and plus signs as a URL does', () => {
    expect(parseBillFilter('status=In%20committee&search=a+b&tag=a%26b').status).toEqual(['In committee'])
    expect(parseBillFilter('search=a+b&tag=a%26b').search).toBe('a b')
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
      const f = parseBillFilter('search=first&search=second&minRelevance=3&minRelevance=9&match=any&match=all&unvoted=0&unvoted=1&myBills=1&myBills=0')
      expect(f.search).toBe('first')
      expect(f.minRelevance).toBe(3)
      expect(f.match).toBe('any')
      expect(f.unvoted).toBe(false)
      expect(f.myBills).toBe(true)
    })
    it('collects every value of a repeated custom field key', () => {
      expect(parseBillFilter('field.team=a&field.team=b').field).toEqual({ team: ['a', 'b'] })
    })
  })

  describe('unknown keys and values', () => {
    it('ignores unknown keys, and the keys that are not filters (sort, dir, view, page)', () => {
      expect(parseBillFilter('bogus=1&sort=priority&dir=desc&view=abc&page=2&pageSize=10&field=1&fieldx=1')).toEqual(EMPTY_BILL_FILTER)
    })
    it('ignores a key whose name only starts like a filter', () => {
      expect(parseBillFilter('statuses=a&Status=b&xfield.a=1').status).toEqual([])
      expect(parseBillFilter('statuses=a&Status=b&xfield.a=1').field).toEqual({})
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

  // One name per filter: `q`, `cf_<slug>`, and `session` were renamed to `search`, `field.<slug>`, and `sessionName`,
  // with no aliases, so the old keys are ignored like any other unknown key.
  describe('the old keys', () => {
    it.each([
      ['q', 'q=election'],
      ['cf_<slug>', 'cf_committee=Labor'],
      ['cf_<id>', 'cf_3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c=1'],
      ['session', 'session=2026%20Regular%20Session'],
    ])('ignores %s', (_name, qs) => {
      expect(parseBillFilter(qs)).toEqual(EMPTY_BILL_FILTER)
    })
    it('reads the new keys beside the old ones, and only the new ones', () => {
      const f = parseBillFilter('q=old&search=new&cf_team=Old&field.team=New&session=Old&sessionName=New')
      expect(f.search).toBe('new')
      expect(f.field).toEqual({ team: ['New'] })
      expect(f.sessionName).toEqual(['New'])
    })
    it('writes the new keys, never the old ones', () => {
      const s = serializeBillFilter(filterOf({ search: 'x', field: { team: ['Ada'] }, sessionName: ['S'] }))
      expect(s).toBe('sessionName=S&search=x&field.team=Ada')
    })
  })

  describe('empty values', () => {
    it('reads an empty search, min relevance, and match as no filter', () => {
      expect(parseBillFilter('search=&minRelevance=&match=')).toEqual(EMPTY_BILL_FILTER)
    })
    it('keeps an empty value of a multi-select filter, as the API has always matched it', () => {
      expect(parseBillFilter('status=').status).toEqual([''])
      expect(roundTrip(filterOf({ status: [''] }))).toEqual(filterOf({ status: [''] }))
    })
  })

  describe('custom fields', () => {
    it('reads field.<key> as a custom field named by that key, a slug or an id', () => {
      expect(parseBillFilter('field.committee=Labor&field.3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c=1').field)
        .toEqual({ committee: ['Labor'], '3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c': ['1'] })
    })
    it('reads field. with no key as a field with an empty key, which matches no field', () => {
      expect(parseBillFilter('field.=x').field).toEqual({ '': ['x'] })
    })
    it('survives a key that names an Object.prototype member, without touching the prototype', () => {
      const f = parseBillFilter('field.__proto__=x&field.constructor=y&field.toString=z')
      expect(Object.keys(f.field).sort()).toEqual(['__proto__', 'constructor', 'toString'])
      expect(Object.getPrototypeOf(f.field)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>).push).toBeUndefined()
      expect(roundTrip(f)).toEqual(f)
    })
    it('keeps the any sentinel as a value', () => {
      expect(parseBillFilter('field.committee=__any__').field).toEqual({ committee: [FILTER_ANY] })
    })
  })

  describe('the value is immutable', () => {
    const parsed = () => parseBillFilter('status=a&subject=UT%3AElections&field.team=Ada')
    it('freezes the filter, its lists, its subjects, and its custom fields', () => {
      const f = parsed()
      expect(Object.isFrozen(f)).toBe(true)
      expect(Object.isFrozen(f.status)).toBe(true)
      expect(Object.isFrozen(f.subject)).toBe(true)
      expect(Object.isFrozen(f.subject[0])).toBe(true)
      expect(Object.isFrozen(f.field)).toBe(true)
      expect(Object.isFrozen(f.field.team)).toBe(true)
    })
    it('throws on a write, in strict mode', () => {
      const f = parsed()
      expect(() => { (f as { search: string }).search = 'x' }).toThrow()
      expect(() => { (f.status as string[]).push('b') }).toThrow()
      expect(() => { (f.field.team as string[]).push('b') }).toThrow()
    })
    it('freezes the empty filter, which every empty parse can share', () => {
      expect(Object.isFrozen(EMPTY_BILL_FILTER)).toBe(true)
      expect(Object.isFrozen(EMPTY_BILL_FILTER.status)).toBe(true)
      expect(Object.isFrozen(EMPTY_BILL_FILTER.field)).toBe(true)
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
      status: ['a'], stage: ['a'], year: ['a'], sessionName: ['a'], state: ['a'], position: ['a'], priority: ['a'], tag: ['a'],
      subject: [{ state: 'a', name: 'b' }], minRelevance: 1, search: 'a', myBills: true, unvoted: true, newMatches: true, drafts: true, match: 'any',
    })).split('&').map(p => p.slice(0, p.indexOf('=')))
    // A custom field's key is `field.<its slug or id>`, so it is the one name not written as itself.
    expect(keys.sort()).toEqual(BILL_FILTER_DEFS.map(d => d.name).filter(n => n !== 'field').sort())
  })
})

// Links to the Bills page. The sidebar, the feed row, the bill page, and the digest emails all link to a filtered
// list, and each builds its URL here, so a link writes the same filter, in the same string, as the page does.
describe('billsListPath', () => {
  it('is /bills with nothing after it for no filter', () => {
    expect(billsListPath()).toBe('/bills')
    expect(billsListPath({})).toBe('/bills')
  })

  it('writes the filter it is given with serializeBillFilter, after /bills?', () => {
    const patch = { priority: ['high', 'medium', 'low'], unvoted: true }
    expect(billsListPath(patch)).toBe(`/bills?${serializeBillFilter(withBillFilter(patch))}`)
    expect(billsListPath(patch)).toBe('/bills?priority=high&priority=medium&priority=low&unvoted=1')
  })

  it('reads back as the filter it was given', () => {
    const patch = { status: ['In committee'], year: ['2026'], state: ['UT'], tag: ['Water & Power'], subject: [{ state: 'UT', name: 'Election Law: Voting' }], minRelevance: 7, newMatches: true }
    const path = billsListPath(patch)
    expect(parseBillFilter(new URL(path, 'https://example.test').searchParams)).toEqual(withBillFilter(patch))
  })

  it('writes keys in the serializer\'s one order, whatever order the patch gave them', () => {
    expect(billsListPath({ state: ['UT'], year: ['2026'] })).toBe('/bills?year=2026&state=UT')
  })

  it('is the path of a bare filter for one that sets nothing', () => {
    expect(billsListPath({ status: [], myBills: false })).toBe('/bills')
  })
})

describe('withBillFilter', () => {
  it('sets the parts it is given on the empty filter', () => {
    expect(withBillFilter({ status: ['a'], match: 'any' })).toEqual({ ...EMPTY_BILL_FILTER, status: ['a'], match: 'any' })
  })

  it('sets them on the filter it is given, and leaves that filter alone', () => {
    const base = withBillFilter({ status: ['a'], tag: ['t'] })
    const next = withBillFilter({ status: ['b'] }, base)
    expect(next).toEqual({ ...EMPTY_BILL_FILTER, status: ['b'], tag: ['t'] })
    expect(base.status).toEqual(['a'])
    expect(next).not.toBe(base)
  })

  it('returns a frozen value', () => {
    expect(Object.isFrozen(withBillFilter({ status: ['a'] }))).toBe(true)
  })
})

describe('activeFilters: the one list of filters with a value', () => {
  const names = (f: BillFilter) => activeFilters(f).map(a => a.name)

  it('is empty for a filter with nothing set', () => {
    expect(activeFilters(EMPTY_BILL_FILTER)).toEqual([])
    expect(activeFilterCount(activeFilters(EMPTY_BILL_FILTER))).toBe(0)
  })

  it('holds one entry per multi-select filter, counting each value', () => {
    const list = activeFilters(filterOf({ status: ['2', '3'], tag: ['Water'], position: [FILTER_ANY, FILTER_NONE] }))
    expect(list).toEqual([
      { name: 'status', key: 'status', count: 2 },
      { name: 'position', key: 'position', count: 2 },
      { name: 'tag', key: 'tag', count: 1 },
    ])
    expect(activeFilterCount(list)).toBe(5)
  })

  it('counts a repeated value once', () => {
    expect(activeFilters(filterOf({ year: ['2026', '2026', '2025'] }))).toEqual([{ name: 'year', key: 'year', count: 2 }])
    const subject = { state: 'UT', name: 'Elections' }
    expect(activeFilters(filterOf({ subject: [subject, { ...subject }] }))).toEqual([{ name: 'subject', key: 'subject', count: 1 }])
  })

  it.each(['myBills', 'unvoted', 'newMatches', 'drafts'] as const)('counts the %s toggle once', name => {
    const list = activeFilters(filterOf({ [name]: true }))
    expect(list).toEqual([{ name, key: name, count: 1 }])
    expect(activeFilterCount(list)).toBe(1)
  })

  it('counts a minimum relevance once, zero included, since zero is a minimum in the shared value', () => {
    expect(activeFilters(filterOf({ minRelevance: 5 }))).toEqual([{ name: 'minRelevance', key: 'minRelevance', count: 1 }])
    expect(activeFilters(filterOf({ minRelevance: 0 }))).toEqual([{ name: 'minRelevance', key: 'minRelevance', count: 1 }])
    expect(activeFilters(filterOf({ minRelevance: null }))).toEqual([])
  })

  it('holds a custom field by its own key, each value counted, and skips a field with no values', () => {
    const list = activeFilters(filterOf({ field: { team: ['a', 'b'], 'cf-flag': ['true'], empty: [] } }))
    expect(list).toEqual([
      { name: 'field', key: 'field.team', count: 2 },
      { name: 'field', key: 'field.cf-flag', count: 1 },
    ])
    expect(activeFilterCount(list)).toBe(3)
  })

  it('holds a search as an entry but adds nothing to the count', () => {
    const list = activeFilters(filterOf({ search: 'water' }))
    expect(list).toEqual([{ name: 'search', key: 'search', count: 1 }])
    expect(activeFilterCount(list)).toBe(0)
    expect(activeFilterCount(activeFilters(filterOf({ search: 'water', status: ['2'] })))).toBe(1)
  })

  it('treats a blank search as no search', () => {
    expect(activeFilters(filterOf({ search: '   ' }))).toEqual([])
  })

  it('never holds the match mode', () => {
    expect(activeFilters(filterOf({ match: 'any' }))).toEqual([])
    expect(names(filterOf({ match: 'any', status: ['2'] }))).toEqual(['status'])
  })

  it('leaves out a filter named as hidden, and only that one', () => {
    const f = filterOf({ drafts: true, newMatches: true, status: ['2'] })
    expect(activeFilters(f, { hidden: ['drafts'] }).map(a => a.name)).toEqual(['status', 'newMatches'])
    expect(activeFilters(f, { hidden: [] }).map(a => a.name)).toEqual(['status', 'newMatches', 'drafts'])
  })

  it('holds every filter with a value, in the order serialize writes them, for a filter with everything set', () => {
    const everything = filterOf({
      status: ['2'], stage: ['introduced'], year: ['2026'], sessionName: ['2026 Regular'], state: ['UT'], position: ['Support'], priority: ['high'],
      tag: ['Water'], subject: [{ state: 'UT', name: 'Elections' }], minRelevance: 4, search: 'storm',
      myBills: true, unvoted: true, newMatches: true, drafts: true, match: 'any', field: { team: ['a'] },
    })
    const expected = BILL_FILTER_DEFS.map(d => d.name).filter(n => n !== 'match')
    expect(names(everything)).toEqual(expected)
  })

  it('agrees with serialize: a filter has an entry exactly when it writes a query key (but for the match mode)', () => {
    for (const seed of SEEDS) {
      const f = generate(seed)
      const inList = new Set(activeFilters(f).map(a => a.name))
      const written = new Set([...new URLSearchParams(serializeBillFilter(f)).keys()].map(k => k.startsWith('field.') ? 'field' : k))
      written.delete('match')
      // A blank search is written, but it narrows nothing.
      if (f.search.trim() === '') written.delete('search')
      expect(inList, `seed ${seed}`).toEqual(written)
    }
  })
})
