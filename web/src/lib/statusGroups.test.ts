import { describe, it, expect } from 'vitest'
import { groupStatusOptions } from './statusGroups'

// The grouped Status control's options (#677): the fixed stage list for the headings and the facets' `statusGroups`
// for what sits under each. Counts and statusGroups in, grouped options out.

const group = (labels: string[], statusGroups: Record<string, { stage: string | null; rank: number }>, stage: Record<string, number> = {}) =>
  groupStatusOptions({ labels, counts: { stage }, statusGroups })

describe('groupStatusOptions', () => {
  it('lists the stages as headings, most advanced first, then Other last', () => {
    const groups = group(['A', 'B', 'C', 'D'], {
      A: { stage: 'introduced', rank: 101 }, B: { stage: 'enacted', rank: 701 }, C: { stage: null, rank: 0 }, D: { stage: 'in_committee', rank: 201 },
    })
    expect(groups.map(g => g.label)).toEqual(['Enacted', 'In committee', 'Introduced', 'Other'])
    expect(groups.map(g => g.stage)).toEqual(['enacted', 'in_committee', 'introduced', null])
  })

  it('lists the statuses under a heading most advanced first by rank, then by label', () => {
    const groups = group(['Signed', 'Chaptered', 'Became Law', 'Act'], {
      Signed: { stage: 'enacted', rank: 701 }, Chaptered: { stage: 'enacted', rank: 705 },
      'Became Law': { stage: 'enacted', rank: 701 }, Act: { stage: 'enacted', rank: 701 },
    })
    expect(groups[0]?.options.map(o => o.value)).toEqual(['Chaptered', 'Act', 'Became Law', 'Signed'])
  })

  it('puts the statuses with no stage under Other, in rank order and then label order', () => {
    const groups = group(['Zed', 'Not Applicable', 'Alpha'], {
      Zed: { stage: null, rank: 0 }, 'Not Applicable': { stage: null, rank: 0 }, Alpha: { stage: null, rank: 0 },
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Other')
    expect(groups[0].options.map(o => o.value)).toEqual(['Alpha', 'Not Applicable', 'Zed'])
  })

  it('puts a label the facets did not name, such as one seen earlier in the session, under Other', () => {
    const groups = group(['Seen Earlier'], {})
    expect(groups.map(g => g.label)).toEqual(['Other'])
    expect(groups[0].options.map(o => o.value)).toEqual(['Seen Earlier'])
  })

  it('puts a stage the page does not know under Other', () => {
    const groups = group(['Odd'], { Odd: { stage: 'new_stage_central_added', rank: 900 } })
    expect(groups.map(g => g.label)).toEqual(['Other'])
  })

  it('gives a heading no row when its stage has no listed statuses, and Other none when nothing is unstaged', () => {
    const groups = group(['Passed'], { Passed: { stage: 'passed', rank: 401 } }, { passed: 1, enacted: 4, introduced: 9 })
    expect(groups.map(g => g.label)).toEqual(['Passed legislature'])
  })

  it('carries the stage count beside a heading, and 0 for a stage the counts do not have', () => {
    const groups = group(['A', 'B'], { A: { stage: 'enacted', rank: 701 }, B: { stage: 'passed', rank: 401 } }, { enacted: 7 })
    expect(groups.map(g => [g.label, g.count])).toEqual([['Enacted', 7], ['Passed legislature', 0]])
  })

  it('has no count for Other, which no stage names', () => {
    const groups = group(['X'], { X: { stage: null, rank: 0 } }, { enacted: 3 })
    expect(groups.map(g => [g.label, g.count])).toEqual([['Other', null]])
  })

  it('words a bare LegiScan code as the word, and orders by the word', () => {
    const groups = group(['4', 'Aardvark Law'], { '4': { stage: 'passed', rank: 401 }, 'Aardvark Law': { stage: 'passed', rank: 401 } })
    expect(groups[0]?.options).toEqual([{ value: 'Aardvark Law', label: 'Aardvark Law' }, { value: '4', label: 'Passed' }])
  })

  it('lists each label once, however often it is given', () => {
    const groups = group(['A', 'A'], { A: { stage: 'enacted', rank: 701 } })
    expect(groups.map(g => g.options.length)).toEqual([1])
  })

  it('returns nothing for no labels', () => {
    expect(group([], {})).toEqual([])
  })
})
