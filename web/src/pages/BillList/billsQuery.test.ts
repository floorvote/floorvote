import { describe, it, expect } from 'vitest'
import {
  billsApiParams, billsQueryFromSearch, billsChipSelection, prioritizedChipSelection,
  searchFromListUrl, billsApiParamsFromSearch, billsFacetParams, billFilterForUrl, withCustomFieldKeys,
} from './billsQuery'
import { parseBillFilter, serializeBillFilter, EMPTY_BILL_FILTER } from '../../../../shared/billFilter'

const query = (qs: string, defs: Parameters<typeof billsQueryFromSearch>[1] = []) => billsQueryFromSearch(new URLSearchParams(qs), defs)

describe('billsQueryFromSearch', () => {
  it('reads the filter with the shared parse, so the Bills page and the API read the same string alike', () => {
    const qs = 'status=2&stage=enacted&year=2026&state=UT&position=none&priority=high&tag=a&subject=UT%3AElections&minRelevance=4&myBills=1&unvoted=1&newMatches=1&drafts=1&match=any&search=water'
    expect(query(qs).filter).toEqual(parseBillFilter(qs))
  })

  it('reads sort and dir beside the filter, and an unknown sort as the default', () => {
    expect(query('sort=relevance&dir=desc')).toMatchObject({ sortCol: 'relevance', sortDir: 'desc' })
    expect(query('sort=nope&dir=up')).toMatchObject({ sortCol: 'default', sortDir: 'asc' })
    expect(query('')).toMatchObject({ sortCol: 'default', sortDir: 'asc' })
  })

  it('holds a custom field by its id when the defs know it, and by the key as given when they do not', () => {
    const defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }]
    expect(query('field.tracked_by_team=yes', defs).filter.field).toEqual({ 'cf-uuid-1': ['yes'] })
    expect(query('field.cf-uuid-1=yes', defs).filter.field).toEqual({ 'cf-uuid-1': ['yes'] })
    expect(query('field.tracked_by_team=yes').filter.field).toEqual({ tracked_by_team: ['yes'] })
  })

  it('merges a field named by its slug and by its id, each value once', () => {
    const defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }]
    expect(query('field.tracked_by_team=a&field.cf-uuid-1=a&field.cf-uuid-1=b', defs).filter.field).toEqual({ 'cf-uuid-1': ['a', 'b'] })
  })

  it('drops a year that is not a number, and reads a minimum relevance of zero as none', () => {
    expect(query('year=2026&year=abc').filter.year).toEqual(['2026'])
    expect(query('minRelevance=0').filter.minRelevance).toBeNull()
    expect(query('minRelevance=5').filter.minRelevance).toBe(5)
  })

  it('ignores session: the page has no control, chip, or count for it, so it must not narrow a list', () => {
    expect(query('sessionName=S1&status=2').filter).toEqual(query('status=2').filter)
    expect(billsApiParams(query('sessionName=S1&status=2'), 1, 100)).toBe('page=1&pageSize=100&status=2')
    expect(billsFacetParams(query('sessionName=S1&status=2').filter)).toBe('status=2')
    expect(billsChipSelection('/bills', '?sessionName=S1')).toEqual({ allBills: true, newMatches: false })
  })

  it('returns an immutable value', () => {
    const f = query('status=2&field.x=1').filter
    expect(Object.isFrozen(f)).toBe(true)
    expect(Object.isFrozen(f.status)).toBe(true)
    expect(Object.isFrozen(f.field)).toBe(true)
  })
})

describe('billsApiParams', () => {
  it('writes the page, then the filter as the shared serialize writes it, then the sort', () => {
    const q = query('status=2&priority=high&newMatches=1&tag=elections&sort=bill&dir=desc')
    expect(billsApiParams(q, 1, 100)).toBe(`page=1&pageSize=100&${serializeBillFilter(q.filter)}&sort=bill&dir=desc`)
  })

  it("writes the filter in the shared module's one key order, whatever order the URL had", () => {
    const s = billsApiParams(query('newMatches=1&tag=elections&priority=high&status=2'), 1, 100)
    expect(s).toBe('page=1&pageSize=100&status=2&priority=high&tag=elections&newMatches=1')
  })

  // Regression guard for the bill LIST honouring the group operator: if this silently stops emitting
  // `match=any`, the list disagrees with the facet counts and the row highlighting they drive, with no error.
  it('emits match=any when the operator is set, hydrated from the URL', () => {
    const q = query('status=2&priority=high&newMatches=1&match=any&tag=elections')
    expect(q.filter.match).toBe('any')
    expect(billsApiParams(q, 1, 100)).toBe('page=1&pageSize=100&status=2&priority=high&tag=elections&newMatches=1&match=any')
  })

  it('omits match when the operator is not set', () => {
    const q = query('status=2')
    expect(q.filter.match).toBe('all')
    expect(billsApiParams(q, 1, 100)).not.toContain('match=')
  })

  it('round-trips the stage filter', () => {
    const q = query('stage=enacted&stage=vetoed')
    expect(q.filter.stage).toEqual(['enacted', 'vetoed'])
    expect(billsApiParams(q, 1, 100)).toBe('page=1&pageSize=100&stage=enacted&stage=vetoed')
  })

  it('parses a bare /bills URL to an empty (page-1) query', () => {
    expect(billsApiParams(query(''), 1, 100)).toBe('page=1&pageSize=100')
  })

  it('round-trips sort/dir and minRelevance', () => {
    expect(billsApiParams(query('sort=relevance&dir=desc&minRelevance=5'), 1, 100)).toBe('page=1&pageSize=100&minRelevance=5&sort=relevance&dir=desc')
  })

  it('writes a custom field by its id, so two URLs for one field key one cache entry', () => {
    const defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }]
    expect(billsApiParams(query('field.tracked_by_team=yes', defs), 1, 100)).toBe('page=1&pageSize=100&field.cf-uuid-1=yes')
    expect(billsApiParams(query('field.cf-uuid-1=yes', defs), 1, 100)).toBe(billsApiParams(query('field.tracked_by_team=yes', defs), 1, 100))
  })

  it('writes every filter the page holds: nothing the URL carried is dropped, but session', () => {
    const qs = 'status=2&stage=enacted&year=2026&state=UT&position=none&priority=high&tag=a&subject=UT%3AElections&minRelevance=4&search=water&myBills=1&unvoted=1&newMatches=1&drafts=1&match=any&field.x=1'
    const sent = new URLSearchParams(billsApiParams(query(qs), 2, 100))
    expect(parseBillFilter(sent)).toEqual(parseBillFilter(qs))
    expect(sent.get('page')).toBe('2')
  })
})

describe('billsFacetParams', () => {
  it('is the shared serialize of the filter, search included', () => {
    const f = query('status=2&tag=a&match=any&field.x=1&search=water').filter
    expect(billsFacetParams(f)).toBe(serializeBillFilter(f))
    expect(billsFacetParams(f)).toContain('search=water')
  })

  it('is empty for the filter with nothing set', () => {
    expect(billsFacetParams(EMPTY_BILL_FILTER)).toBe('')
  })

  it('carries what the list request carries, minus the page and the sort', () => {
    const q = query('status=2&priority=high&minRelevance=4&drafts=1&sort=bill&dir=desc')
    const list = new URLSearchParams(billsApiParams(q, 1, 100))
    list.delete('page'); list.delete('pageSize'); list.delete('sort'); list.delete('dir')
    expect(billsFacetParams(q.filter)).toBe(list.toString())
  })
})

describe('withCustomFieldKeys', () => {
  const defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }, { id: 'cf-uuid-2', slug: null }]

  it('names each field by its id', () => {
    const filter = parseBillFilter('field.tracked_by_team=a&field.cf-uuid-2=b&field.unknown=c')
    expect(withCustomFieldKeys(filter, defs, 'id').field).toEqual({ 'cf-uuid-1': ['a'], 'cf-uuid-2': ['b'], unknown: ['c'] })
  })

  it('names each field by its slug, or its id when it has none', () => {
    const filter = parseBillFilter('field.cf-uuid-1=a&field.cf-uuid-2=b&field.unknown=c')
    expect(withCustomFieldKeys(filter, defs, 'slug').field).toEqual({ tracked_by_team: ['a'], 'cf-uuid-2': ['b'], unknown: ['c'] })
  })

  it('returns a new frozen value and leaves the filter it was given alone', () => {
    const filter = parseBillFilter('field.tracked_by_team=a')
    const out = withCustomFieldKeys(filter, defs, 'id')
    expect(out).not.toBe(filter)
    expect(Object.isFrozen(out)).toBe(true)
    expect(filter.field).toEqual({ tracked_by_team: ['a'] })
  })
})

describe('billFilterForUrl', () => {
  it('names a custom field by its slug and leaves the search box out, which never reaches the URL', () => {
    const defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }]
    const f = query('status=2&field.cf-uuid-1=yes&search=water', defs).filter
    expect(serializeBillFilter(billFilterForUrl(f, defs))).toBe('status=2&field.tracked_by_team=yes')
  })
})

describe('billsChipSelection', () => {
  it('selects the all-bills chip on the unfiltered /bills view', () => {
    expect(billsChipSelection('/bills', '')).toEqual({ allBills: true, newMatches: false })
  })

  it('selects the new-matches chip when newMatches is the only active filter', () => {
    expect(billsChipSelection('/bills', '?newMatches=1')).toEqual({ allBills: false, newMatches: true })
  })

  it('selects neither chip when any other filter is active', () => {
    expect(billsChipSelection('/bills', '?status=2')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?myBills=1')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?priority=high')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?tag=elections')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?minRelevance=5')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?field.42=foo')).toEqual({ allBills: false, newMatches: false })
  })

  it('deselects the new-matches chip when another filter joins newMatches', () => {
    expect(billsChipSelection('/bills', '?newMatches=1&status=2')).toEqual({ allBills: false, newMatches: false })
  })

  it('ignores sort/dir — a sort is not a filter', () => {
    expect(billsChipSelection('/bills', '?sort=relevance&dir=desc')).toEqual({ allBills: true, newMatches: false })
    expect(billsChipSelection('/bills', '?newMatches=1&sort=relevance')).toEqual({ allBills: false, newMatches: true })
  })

  it('selects neither chip away from the bills list (other pages, bill detail)', () => {
    expect(billsChipSelection('/feed', '')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills/HB123', '')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/calendar', '?newMatches=1')).toEqual({ allBills: false, newMatches: false })
  })
})

describe('prioritizedChipSelection', () => {
  const PRIORITY_QS = '?priority=high&priority=medium&priority=low'

  it('selects the priority chip when the filter is exactly the three priority tiers', () => {
    expect(prioritizedChipSelection('/bills', PRIORITY_QS)).toEqual({ priority: true, unvoted: false })
  })

  it('selects the unvoted chip when unvoted=1 joins the same priority filter', () => {
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&unvoted=1`)).toEqual({ priority: false, unvoted: true })
  })

  it('is order-independent for the priority tiers', () => {
    expect(prioritizedChipSelection('/bills', '?priority=low&priority=high&priority=medium')).toEqual({ priority: true, unvoted: false })
  })

  it('selects neither chip when the priority filter is incomplete or has an extra value', () => {
    expect(prioritizedChipSelection('/bills', '?priority=high&priority=medium')).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', '?priority=high')).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', '')).toEqual({ priority: false, unvoted: false })
  })

  it('selects neither chip when any other filter joins the priority filter', () => {
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&status=2`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&myBills=1`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&newMatches=1`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&tag=elections`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&minRelevance=5`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&field.42=foo`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&unvoted=1&status=2`)).toEqual({ priority: false, unvoted: false })
  })

  it('ignores sort/dir — a sort is not a filter', () => {
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&sort=relevance&dir=desc`)).toEqual({ priority: true, unvoted: false })
  })

  it('selects neither chip away from the bills list (other pages, bill detail)', () => {
    expect(prioritizedChipSelection('/feed', PRIORITY_QS)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills/HB123', PRIORITY_QS)).toEqual({ priority: false, unvoted: false })
  })
})

// The one URL-to-request path the loader's prefetch and the split pane share, so
// the two can never key the same list differently.
describe('searchFromListUrl', () => {
  it('reads the query string of a list URL', () => {
    expect(searchFromListUrl('/bills?status=2&sort=bill&dir=asc').toString()).toBe('status=2&sort=bill&dir=asc')
  })
  it('is empty for a URL with no query string', () => {
    expect(searchFromListUrl('/bills').toString()).toBe('')
  })
})

describe('billsApiParamsFromSearch', () => {
  it('matches billsApiParams over the same search at the page size', () => {
    const search = new URLSearchParams('status=2&priority=high&sort=bill&dir=desc')
    expect(billsApiParamsFromSearch(search, 1)).toBe(billsApiParams(billsQueryFromSearch(search), 1, 100))
    expect(billsApiParamsFromSearch(search, 3)).toContain('page=3&pageSize=100')
  })
  it('resolves a custom-field slug to its id when given the defs', () => {
    const search = new URLSearchParams('field.tracked_by_team=yes')
    const defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }]
    expect(billsApiParamsFromSearch(search, 1, defs)).toBe('page=1&pageSize=100&field.cf-uuid-1=yes')
    expect(billsApiParamsFromSearch(search, 1)).toBe('page=1&pageSize=100&field.tracked_by_team=yes')
  })
})

describe('a search term in the list URL', () => {
  it('is read from q, so the list and its summary agree on it', () => {
    expect(billsQueryFromSearch(new URLSearchParams('search=water')).filter.search).toBe('water')
    expect(billsApiParamsFromSearch(new URLSearchParams('search=water'), 1)).toBe('page=1&pageSize=100&search=water')
  })
})
