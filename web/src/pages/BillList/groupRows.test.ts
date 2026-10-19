import { describe, it, expect } from 'vitest'
import { groupPlacement, groupGridStyle, groupItemStyle, subgridCellStyle, GROUP_ROW_GAP } from './groupRows'

// Where each piece of a companion group row sits on the grid its table draws it
// on. Bill numbers and statuses live in different cells of that grid, so the
// only thing that keeps a status level with its own number is that both are
// given the same row; this is the one place that assigns them.

const bills = (n: number) => Array.from({ length: n }, (_, i) => ({ status: `s${i}` }))

describe('groupPlacement', () => {
  it('gives each shown bill its own row, and each distinct status the row of its bill', () => {
    const p = groupPlacement({ shown: bills(2), hidden: [], statuses: ['s0', 's1'] })
    expect(p.rows).toBe(2)
    expect(p.chipRows).toBe(2)
    expect(p.numberRows).toEqual([1, 2])
    expect(p.statusRows).toEqual(['1', '2'])
  })

  it('spreads one shared status across every chip row, so it reads as belonging to all of them', () => {
    const p = groupPlacement({ shown: bills(2), hidden: [], statuses: ['same'] })
    expect(p.numberRows).toEqual([1, 2])
    expect(p.statusRows).toEqual(['1 / span 2'])
  })

  it('puts "+N" on a row of its own below the chip rows, and gives no status that row', () => {
    const distinct = groupPlacement({ shown: bills(2), hidden: [{}, {}], statuses: ['s0', 's1'] })
    expect(distinct.rows).toBe(3)
    expect(distinct.chipRows).toBe(2)
    expect(distinct.moreRow).toBe(3)
    expect(distinct.statusRows).toEqual(['1', '2'])

    const shared = groupPlacement({ shown: bills(2), hidden: [{}], statuses: ['same'] })
    expect(shared.rows).toBe(3)
    expect(shared.moreRow).toBe(3)
    // Centered across the chip rows only, not the "+N" row.
    expect(shared.statusRows).toEqual(['1 / span 2'])
  })

  it('has no "+N" row when nothing is hidden', () => {
    const p = groupPlacement({ shown: bills(2), hidden: [], statuses: ['s0', 's1'] })
    expect(p.rows).toBe(2)
    expect(p.moreRow).toBeNull()
  })

  it('does not span a lone chip row', () => {
    const p = groupPlacement({ shown: bills(1), hidden: [], statuses: ['s0'] })
    expect(p.rows).toBe(1)
    expect(p.statusRows).toEqual(['1'])
  })

  it('works for a group of one shown bill with hidden companions', () => {
    const p = groupPlacement({ shown: bills(1), hidden: [{}], statuses: ['s0'] })
    expect(p.rows).toBe(2)
    expect(p.moreRow).toBe(2)
    expect(p.statusRows).toEqual(['1'])
  })
})

describe('the grid styles a table applies', () => {
  it('lays a group out on one auto-sized row per placement row, closer together than the columns', () => {
    const style = groupGridStyle(3)
    expect(style.gridTemplateRows).toBe('repeat(3, auto)')
    expect(style.rowGap).toBe(GROUP_ROW_GAP)
    expect(GROUP_ROW_GAP).toBe(4)
  })

  it("makes the number and status cells subgrids that span all the group's rows, so their rows are the grid's", () => {
    expect(subgridCellStyle.display).toBe('grid')
    expect(subgridCellStyle.gridTemplateRows).toBe('subgrid')
    expect(subgridCellStyle.gridRow).toBe('1 / -1')
  })

  it("centers an item on its row, or on the rows it spans, and keeps it to the cell's left edge", () => {
    const one = groupItemStyle('2')
    expect(one.gridRow).toBe('2')
    expect(one.alignSelf).toBe('center')
    expect(one.justifySelf).toBe('start')
    expect(groupItemStyle('1 / span 2').gridRow).toBe('1 / span 2')
  })
})
