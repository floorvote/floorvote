import { describe, it, expect } from 'vitest'
import { committeeGroups } from './committeeGroups'

// The Committee filter's options (#471), built from the facets' counts and names: grouped by state, each state's
// committees by size, and its procedural committees (Rules, Assignments, Calendars) last and marked, since one
// can hold half a session's bills.

const INFO = {
  101: { name: 'Judiciary', state: 'NJ', chamber: 'S' },
  102: { name: 'Rules', state: 'NJ', chamber: 'S' },
  103: { name: 'Education', state: 'NJ', chamber: 'A' },
  104: { name: 'Budget', state: 'NJ', chamber: 'A' },
  201: { name: 'State Affairs', state: 'TX', chamber: 'H' },
}

describe('committeeGroups', () => {
  it('groups committees by state, in state order', () => {
    const groups = committeeGroups({ 201: 4, 101: 2 }, INFO)
    expect(groups.map(g => g.state)).toEqual(['NJ', 'TX'])
  })

  it('orders a state\'s committees by count and then by name, with procedural ones last however large', () => {
    const [nj] = committeeGroups({ 101: 2, 102: 40, 103: 2, 104: 9 }, INFO)
    expect(nj.options.map(o => o.value)).toEqual(['104', '103', '101', '102'])
    expect(nj.options.map(o => o.procedural)).toEqual([false, false, false, true])
  })

  it('labels each committee with its chamber, and carries its count', () => {
    const [nj] = committeeGroups({ 101: 2 }, INFO)
    expect(nj.options).toEqual([{ value: '101', label: 'Judiciary (Senate)', count: 2, procedural: false }])
  })

  it('keeps a picked committee the counts leave out, at zero, so it can be unpicked', () => {
    const [nj] = committeeGroups({ 101: 2 }, INFO, ['102'])
    expect(nj.options.map(o => [o.value, o.count])).toEqual([['101', 2], ['102', 0]])
  })

  it('leaves out a count with no name to show for it', () => {
    expect(committeeGroups({ 999: 3, 201: 1 }, INFO).flatMap(g => g.options.map(o => o.value))).toEqual(['201'])
  })
})
