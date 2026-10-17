import { describe, it, expect } from 'vitest'
import { groupSharedThings } from './groupShares'

// What a companion group shares, in the bill page's own terms: comments, member votes, the org's position,
// and custom fields once the instance defines any.
describe('groupSharedThings', () => {
  it('lists comments, votes, and the org noun position when no custom field is defined', () => {
    expect(groupSharedThings('team', false)).toBe('comments, votes, and team position')
  })

  it('adds custom fields when at least one is defined', () => {
    expect(groupSharedThings('alliance', true)).toBe('comments, votes, alliance position, and custom fields')
  })

  it('joins with "or" for a negative sentence', () => {
    expect(groupSharedThings('team', false, 'or')).toBe('comments, votes, or team position')
    expect(groupSharedThings('team', true, 'or')).toBe('comments, votes, team position, or custom fields')
  })

  it('falls back to the default noun for an empty one', () => {
    expect(groupSharedThings('', false)).toBe('comments, votes, and team position')
  })
})
