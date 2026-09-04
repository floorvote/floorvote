import { describe, it, expect } from 'vitest'
import { normalizeViewQuery, findActiveView } from './savedViews'

describe('normalizeViewQuery', () => {
  it('sorts params so ordering does not affect equality', () => {
    expect(normalizeViewQuery('status=2&status=1')).toBe(normalizeViewQuery('status=1&status=2'))
  })

  it('sorts across different keys', () => {
    expect(normalizeViewQuery('tag=Elections&status=1')).toBe(normalizeViewQuery('status=1&tag=Elections'))
  })

  it('strips the view param so an applied view still matches its own query', () => {
    expect(normalizeViewQuery('view=clerk-bills&status=1')).toBe(normalizeViewQuery('status=1'))
  })

  it('strips page, which is pagination rather than filter state', () => {
    expect(normalizeViewQuery('status=1&page=3')).toBe(normalizeViewQuery('status=1'))
  })

  it('tolerates a leading question mark', () => {
    expect(normalizeViewQuery('?status=1')).toBe(normalizeViewQuery('status=1'))
  })

  it('preserves subject values containing a colon', () => {
    expect(normalizeViewQuery('subject=UT:Elections')).toBe(normalizeViewQuery('subject=UT%3AElections'))
  })

  it('treats an empty query as empty', () => {
    expect(normalizeViewQuery('')).toBe('')
  })
})

describe('findActiveView', () => {
  const views = [
    { id: 'v1', query: 'subject=UT%3AElections&subject=UT%3AMarriage' },
    { id: 'v2', query: 'subject=UT%3AAudits' },
  ]

  it('finds the matching view', () => {
    expect(findActiveView('?subject=UT%3AAudits', views)?.id).toBe('v2')
  })

  it('matches when the same filters are applied in a different order', () => {
    expect(findActiveView('?subject=UT%3AMarriage&subject=UT%3AElections', views)?.id).toBe('v1')
  })

  it('still matches while the view param is present in the URL', () => {
    expect(findActiveView('?view=v2&subject=UT%3AAudits', views)?.id).toBe('v2')
  })

  it('returns null once a filter has been removed', () => {
    expect(findActiveView('?subject=UT%3AElections', views)).toBeNull()
  })

  it('returns null once an extra filter has been added', () => {
    expect(findActiveView('?subject=UT%3AAudits&status=1', views)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(findActiveView('?status=1', views)).toBeNull()
  })

  it('returns null for an empty filter state', () => {
    expect(findActiveView('', views)).toBeNull()
  })
})
