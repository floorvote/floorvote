import { describe, it, expect } from 'vitest'
import { committeeGroups } from './committeeGroups'

// The Committee filter's options (#471), built from the facets' counts and names: grouped by state, each state's
// committees by count and then by name. A committee that mostly routes bills, such as Rules, sorts like any other.

const INFO = {
  101: { name: 'Judiciary', state: 'NJ', chamber: 'S' },
  102: { name: 'Rules', state: 'NJ', chamber: 'S' },
  103: { name: 'Education', state: 'NJ', chamber: 'A' },
  104: { name: 'Budget', state: 'NJ', chamber: 'A' },
  105: { name: 'Veterans', state: 'NJ', chamber: 'A' },
  201: { name: 'State Affairs', state: 'TX', chamber: 'H' },
}

describe('committeeGroups', () => {
  it('groups committees by state, in state order', () => {
    const groups = committeeGroups({ 201: 4, 101: 2 }, INFO)
    expect(groups.map(g => g.state)).toEqual(['NJ', 'TX'])
  })

  it('orders a state\'s committees by count and then by name', () => {
    const [nj] = committeeGroups({ 101: 2, 103: 2, 104: 9 }, INFO)
    expect(nj.options.map(o => o.value)).toEqual(['104', '103', '101'])
  })

  it('lists a large Rules committee first, by its count, ahead of a smaller Judiciary', () => {
    const [nj] = committeeGroups({ 101: 2, 102: 40, 103: 2, 104: 9 }, INFO)
    expect(nj.options.map(o => o.label)).toEqual(['Rules (Senate)', 'Budget (Assembly)', 'Education (Assembly)', 'Judiciary (Senate)'])
  })

  it('lists a small Rules committee among the others by its count, not last', () => {
    const [nj] = committeeGroups({ 101: 2, 102: 5, 103: 1 }, INFO)
    expect(nj.options.map(o => o.value)).toEqual(['102', '101', '103'])
  })

  it('breaks a tie between committees of the same count by name, Rules included', () => {
    const [nj] = committeeGroups({ 101: 3, 102: 3, 105: 3 }, INFO)
    expect(nj.options.map(o => o.label)).toEqual(['Judiciary (Senate)', 'Rules (Senate)', 'Veterans (Assembly)'])
  })

  it('gives every option the same fields, none of them a procedural flag', () => {
    const [nj] = committeeGroups({ 101: 2, 102: 40 }, INFO)
    for (const option of nj.options) expect(Object.keys(option).sort()).toEqual(['count', 'label', 'value'])
  })

  it('does not order a committee named like a procedural one differently, however its name reads', () => {
    const info = {
      1: { name: 'Rules and Administration', state: 'NJ', chamber: 'S' },
      2: { name: 'Legislative Reference', state: 'NJ', chamber: 'S' },
      3: { name: 'Committee of the Whole', state: 'NJ', chamber: 'H' },
      4: { name: 'Health', state: 'NJ', chamber: 'H' },
    }
    const [nj] = committeeGroups({ 1: 9, 2: 8, 3: 7, 4: 1 }, info)
    expect(nj.options.map(o => o.value)).toEqual(['1', '2', '3', '4'])
  })

  it('labels each committee with its chamber, and carries its count', () => {
    const [nj] = committeeGroups({ 101: 2 }, INFO)
    expect(nj.options).toEqual([{ value: '101', label: 'Judiciary (Senate)', count: 2 }])
  })

  it('keeps a picked Rules committee the counts leave out at zero, by name among the other zeros', () => {
    const [nj] = committeeGroups({}, INFO, ['105', '102'])
    expect(nj.options.map(o => [o.label, o.count])).toEqual([['Rules (Senate)', 0], ['Veterans (Assembly)', 0]])
  })

  it('keeps a picked committee the counts leave out, at zero, so it can be unpicked', () => {
    const [nj] = committeeGroups({ 101: 2 }, INFO, ['102'])
    expect(nj.options.map(o => [o.value, o.count])).toEqual([['101', 2], ['102', 0]])
  })

  it('leaves out a count with no name to show for it', () => {
    expect(committeeGroups({ 999: 3, 201: 1 }, INFO).flatMap(g => g.options.map(o => o.value))).toEqual(['201'])
  })
})
