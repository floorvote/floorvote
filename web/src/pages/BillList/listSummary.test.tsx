import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { billsQueryFromSearch, type BillsQuery } from './billsQuery'
import { buildListSummary, type SummaryFieldDef } from './listSummary'
import { buildActiveFilterGroups, type ActiveFilterGroupArgs } from './activeFilterGroups'
import { FILTER_ANY, encodeSubjectFilter, withBillFilter } from '../../../../shared/billFilter'

// A list URL as the query the pane summarizes. A search term never rides in the URL the app builds, so a test sets it beside.
const values = (qs: string, over: { search?: string } = {}): BillsQuery => {
  const q = billsQueryFromSearch(new URLSearchParams(qs))
  return over.search === undefined ? q : { ...q, filter: withBillFilter({ search: over.search }, q.filter) }
}
const summarize = (qs: string, over: { search?: string } = {}, extra: Parameters<typeof buildListSummary>[0] extends infer I ? Partial<I> : never = {}) =>
  buildListSummary({ values: values(qs, over), ...extra })

describe('buildListSummary: the headline', () => {
  it('says "All bills" with the default sort named when nothing is filtered', () => {
    const s = summarize('')
    expect(s.text).toBe('All bills · Sorted by default order')
    expect(s.filterCount).toBe(0)
    expect(s.filters).toEqual([])
    expect(s.viewName).toBeNull()
  })

  it('counts each selected value once', () => {
    const s = summarize('status=2&status=3&priority=high&sort=bill')
    expect(s.text).toBe('3 filters · Sorted by Bill')
    expect(s.filterCount).toBe(3)
  })

  it('says "1 filter" for a single value', () => {
    expect(summarize('status=2').text).toBe('1 filter · Sorted by default order')
  })

  it('counts a search term as one filter, alongside the chips', () => {
    expect(summarize('', { search: 'water' }).filterCount).toBe(1)
    expect(summarize('status=2&status=3', { search: 'water' }).text).toBe('3 filters · Sorted by default order')
  })

  it('treats a blank search as no search', () => {
    expect(summarize('', { search: '   ' }).text).toBe('All bills · Sorted by default order')
  })

  it('counts a relevance threshold as one filter', () => {
    expect(summarize('minRelevance=5').filterCount).toBe(1)
    expect(summarize('minRelevance=0').filterCount).toBe(0)
  })

  it('counts a value repeated in the URL once', () => {
    const s = summarize('status=2&status=2&year=2026&year=2026&field.team=yes&field.team=yes')
    expect(s.filterCount).toBe(3)
  })

  it.each([
    ['myBills', 'My bills'], ['newMatches', 'New matches'], ['unvoted', 'Not yet voted'], ['drafts', 'Drafts'],
  ])('counts the %s scope pill as one filter, and never says "All bills" for it', (param, label) => {
    const s = summarize(`${param}=1`)
    expect(s.text).toBe('1 filter · Sorted by default order')
    expect(s.filterCount).toBe(1)
    expect(s.filters).toEqual([label])
  })

  it('counts a scope pill alongside the regular filters, listing it first of them', () => {
    const s = summarize('priority=high&unvoted=1&year=2026', { search: 'water' })
    expect(s.text).toBe('4 filters · Sorted by default order')
    expect(s.filters).toEqual(['Search: “water”', 'Not yet voted', expect.stringMatching(/high/i), 'Year: 2026'])
  })

  it('counts all four scope pills', () => {
    const s = summarize('myBills=1&unvoted=1&newMatches=1&drafts=1')
    expect(s.filterCount).toBe(4)
    expect(s.filters).toEqual(['My bills', 'New matches', 'Not yet voted', 'Drafts'])
  })

  it('does not count the all-of/any-of operator, which is not a filter', () => {
    expect(summarize('match=any').text).toBe('All bills · Sorted by default order')
  })

  it('names a saved view even when its query holds a scope pill, and still lists the pill', () => {
    const s = summarize('newMatches=1', {}, { view: { name: 'Inbox' } })
    expect(s.text).toBe('Inbox · Sorted by default order')
    expect(s.filters).toEqual(['New matches'])
  })

  it('counts every value of a long list', () => {
    const qs = Array.from({ length: 30 }, (_, i) => `status=s${i}`).join('&')
    const s = summarize(qs)
    expect(s.text).toBe('30 filters · Sorted by default order')
    expect(s.filters).toHaveLength(30)
  })
})

describe('buildListSummary: sort names', () => {
  it.each([
    ['bill', 'Bill'], ['status', 'Status'], ['year', 'Year'], ['session', 'Year'], ['lastAction', 'Last action'],
    ['relevance', 'Relevance'], ['position', 'Position'], ['priority', 'Priority'],
  ])('names the %s sort as its column header does', (col, header) => {
    expect(summarize(`sort=${col}&dir=desc`).sortName).toBe(header)
    expect(summarize(`sort=${col}`).text).toBe(`All bills · Sorted by ${header}`)
  })

  it('falls back to the default order for a sort it does not know', () => {
    expect(summarize('sort=nonsense').sortName).toBe('default order')
  })

  it('uses the sort alone, whatever the direction', () => {
    expect(summarize('sort=status&dir=asc').text).toBe(summarize('sort=status&dir=desc').text)
  })
})

describe('buildListSummary: the saved view', () => {
  it('puts the view name where the count would be', () => {
    const s = summarize('status=2&status=3&sort=bill', {}, { view: { name: 'Watch list' } })
    expect(s.text).toBe('Watch list · Sorted by Bill')
    expect(s.viewName).toBe('Watch list')
    // The filters are still listed, and still counted.
    expect(s.filterCount).toBe(2)
    expect(s.filters).toHaveLength(2)
  })

  it('falls back to the count for a missing view', () => {
    expect(summarize('status=2', {}, { view: null }).text).toBe('1 filter · Sorted by default order')
    expect(summarize('status=2', {}, { view: undefined }).text).toBe('1 filter · Sorted by default order')
  })

  it('falls back to the count for a nameless view', () => {
    expect(summarize('status=2', {}, { view: { name: '  ' } }).text).toBe('1 filter · Sorted by default order')
  })
})

describe('buildListSummary: the filter list reads like the chips', () => {
  it('lists search first, then each dimension in the chip row’s order', () => {
    const s = summarize('state=RI&status=3&year=2026&minRelevance=5&tag=Water&field.team=Alpha', { search: 'storm' }, {
      customFieldDefs: [{ id: 'f1', slug: 'team', name: 'Team', type: 'dropdown' }],
    })
    expect(s.filters).toEqual(['Search: “storm”', 'RI', expect.any(String), 'Year: 2026', 'Relevance 5+', 'Water', 'Team: Alpha'])
  })

  it('names the any/none sentinels as the chips do', () => {
    const s = summarize(`position=${FILTER_ANY}&position=none&priority=${FILTER_ANY}&priority=none&tag=${FILTER_ANY}&field.team=${FILTER_ANY}`)
    expect(s.filters).toEqual(['Any position', 'Not set', 'Any priority', 'No priority', 'Any tag', 'team: Any'])
  })

  it('names a binary custom field by its name alone, and a missing def by its key', () => {
    const defs: SummaryFieldDef[] = [{ id: 'f9', slug: 'tracked', name: 'Tracked by team', type: 'binary' }]
    expect(summarize('field.tracked=yes', {}, { customFieldDefs: defs }).filters).toEqual(['Tracked by team'])
    expect(summarize('field.f9=yes', {}, { customFieldDefs: defs }).filters).toEqual(['Tracked by team'])
    expect(summarize('field.mystery=yes').filters).toEqual(['mystery: yes'])
  })

  it('drops the state prefix from a subject in a single-state tenant only', () => {
    expect(summarize('subject=NJ:Elections', {}, { isMultiState: false }).filters).toEqual(['Elections'])
    expect(summarize('subject=NJ:Elections', {}, { isMultiState: true }).filters).toEqual(['NJ: Elections'])
  })

  it('shows a status or stage it cannot decode as it was given', () => {
    expect(summarize('status=zzz&stage=zzz').filters).toEqual(['zzz', 'zzz'])
  })

  it('matches, label for label, the chips the Bills page draws for the same filters', () => {
    const defs = [{ id: 'f1', slug: 'team', name: 'Team', type: 'dropdown' as const, options: null, displayOrder: 0 },
                  { id: 'f2', slug: 'tracked', name: 'Tracked by team', type: 'binary' as const, options: null, displayOrder: 1 }]
    const qs = 'state=RI&status=3&stage=passed&position=Support&position=none&position=__any__&priority=high&priority=none&priority=__any__' +
      '&year=2025&year=2026&minRelevance=10&tag=Water&tag=__any__&subject=NJ:Elections&field.team=Alpha&field.tracked=yes&field.team=__any__'
    const v = values(qs)
    for (const isMultiState of [false, true]) {
      const noop = vi.fn()
      const args: ActiveFilterGroupArgs = {
        state: [...v.filter.state], status: [...v.filter.status], stage: [...v.filter.stage], position: [...v.filter.position],
        priority: [...v.filter.priority], year: v.filter.year.map(Number), tag: [...v.filter.tag],
        subject: v.filter.subject.map(x => encodeSubjectFilter(x.state, x.name)),
        field: { f1: ['Alpha', FILTER_ANY], f2: ['yes'] }, minRelevance: v.filter.minRelevance ?? 0,
        positionOptions: [{ value: 'Support' }, { value: 'none', label: 'Not set' }], customFieldDefs: defs, isMultiState,
        onRemoveState: noop, onRemoveStatus: noop, onRemoveStage: noop, onRemovePosition: noop, onRemovePriority: noop,
        onRemoveYear: noop, onRemoveTag: noop, onRemoveSubject: noop, onRemoveField: noop, onRemoveMinRelevance: noop,
      }
      const chipTexts = buildActiveFilterGroups(args).flatMap(g => g.chips).map(chip => {
        const { container, unmount } = render(<div>{chip}</div>)
        const text = (container.textContent ?? '').replace(/×$/, '')
        unmount()
        return text
      })
      const s = buildListSummary({ values: v, customFieldDefs: defs, isMultiState })
      expect(s.filters).toEqual(chipTexts)
      expect(s.filterCount).toBe(chipTexts.length)
    }
  })
})
