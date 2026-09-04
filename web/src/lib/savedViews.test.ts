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

  it('resolves the short `?view=<id>` form by id, with no filter params to match against', () => {
    expect(findActiveView('?view=v2', views)?.id).toBe('v2')
  })

  it('returns null for a short `?view=<id>` naming a view that does not exist', () => {
    expect(findActiveView('?view=ghost', views)).toBeNull()
  })

  it('prefers the view named by `view` when two views share the same query', () => {
    const dupes = [
      { id: 'a1', query: 'subject=UT%3AAudits' },
      { id: 'a2', query: 'subject=UT%3AAudits' },
    ]
    expect(findActiveView('?view=a2&subject=UT%3AAudits', dupes)?.id).toBe('a2')
    expect(findActiveView('?view=a1&subject=UT%3AAudits', dupes)?.id).toBe('a1')
  })

  it('falls back to the first query match when `view` names neither duplicate', () => {
    const dupes = [
      { id: 'a1', query: 'subject=UT%3AAudits' },
      { id: 'a2', query: 'subject=UT%3AAudits' },
    ]
    expect(findActiveView('?subject=UT%3AAudits', dupes)?.id).toBe('a1')
  })

  it('resolves the short `?view=<slug>` form by slug', () => {
    const withSlugs = [{ id: 'uuid-1', slug: 'clerk-bills', query: 'subject=UT%3AElections' }]
    expect(findActiveView('?view=clerk-bills', withSlugs)?.id).toBe('uuid-1')
  })

  it('resolves a legacy `?view=<uuid>` bookmark by id even when the view now also has a slug', () => {
    const withSlugs = [{ id: 'uuid-1', slug: 'clerk-bills', query: 'subject=UT%3AElections' }]
    expect(findActiveView('?view=uuid-1', withSlugs)?.id).toBe('uuid-1')
  })

  it('resolves a bookmark taken under a view\'s pre-rename slug via previousSlug', () => {
    const renamed = [{ id: 'uuid-1', slug: 'county-clerk-bills', previousSlug: 'clerk-bills', query: 'subject=UT%3AElections' }]
    expect(findActiveView('?view=clerk-bills', renamed)?.id).toBe('uuid-1')
  })
})
