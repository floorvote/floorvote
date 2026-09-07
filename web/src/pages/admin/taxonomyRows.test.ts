import { describe, it, expect } from 'vitest'
import {
  rowsFromTaxonomy, rowsToTaxonomy, rowProblems,
  parsePastedRows, withTrailingBlank, moveRow, sortRows, deriveSortDirection,
} from './taxonomyRows'

describe('rowsFromTaxonomy / rowsToTaxonomy', () => {
  it('turns stored items into rows with a string description', () => {
    expect(rowsFromTaxonomy([{ name: 'Elections' }, { name: 'Housing', description: 'zoning' }]))
      .toEqual([
        { name: 'Elections', description: '' },
        { name: 'Housing', description: 'zoning' },
      ])
  })

  it('drops nameless rows and trims on the way back', () => {
    expect(rowsToTaxonomy([
      { name: '  Elections  ', description: '  voting  ' },
      { name: '', description: 'orphaned' },
      { name: '', description: '' },
    ])).toEqual([{ name: 'Elections', description: 'voting' }])
  })

  it('omits an empty description rather than storing an empty string', () => {
    expect(rowsToTaxonomy([{ name: 'Elections', description: '   ' }]))
      .toEqual([{ name: 'Elections' }])
  })

  it('preserves row order', () => {
    expect(rowsToTaxonomy([
      { name: 'B', description: '' },
      { name: 'A', description: '' },
    ]).map(t => t.name)).toEqual(['B', 'A'])
  })
})

describe('rowProblems', () => {
  it('flags every row of a duplicated name, case- and whitespace-insensitively', () => {
    expect(rowProblems([
      { name: 'Elections', description: 'voting' },
      { name: 'Housing', description: '' },
      { name: '  elections ', description: 'local admin' },
    ])).toEqual({ 0: 'Duplicate', 2: 'Duplicate' })
  })

  it('flags a description with no name', () => {
    expect(rowProblems([{ name: '', description: 'municipal broadband' }]))
      .toEqual({ 0: 'Needs a name' })
  })

  it('does not flag a wholly empty row', () => {
    expect(rowProblems([{ name: '', description: '' }])).toEqual({})
  })

  it('returns nothing for a clean list', () => {
    expect(rowProblems([
      { name: 'Elections', description: '' },
      { name: 'Housing', description: 'zoning' },
    ])).toEqual({})
  })
})

describe('parsePastedRows', () => {
  it('reads a single column', () => {
    expect(parsePastedRows('Elections\nHousing')).toEqual([
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ])
  })

  it('reads two tab-separated columns', () => {
    expect(parsePastedRows('Elections\tvoting\nHousing\tzoning')).toEqual([
      { name: 'Elections', description: 'voting' },
      { name: 'Housing', description: 'zoning' },
    ])
  })

  it('reads "Name: description" lines', () => {
    expect(parsePastedRows('Elections: voting\n\nHousing')).toEqual([
      { name: 'Elections', description: 'voting' },
      { name: 'Housing', description: '' },
    ])
  })

  it('prefers the tab split when a line has both a tab and a colon', () => {
    expect(parsePastedRows('Rule 3: Exceptions\tprocedural'))
      .toEqual([{ name: 'Rule 3: Exceptions', description: 'procedural' }])
  })

  it('ignores carriage returns and blank lines', () => {
    expect(parsePastedRows('Elections\r\n\r\nHousing')).toEqual([
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
    ])
  })

  it('drops a line with no name', () => {
    expect(parsePastedRows(': orphaned\nElections'))
      .toEqual([{ name: 'Elections', description: '' }])
  })
})

describe('withTrailingBlank', () => {
  it('appends a blank row when the last row is used', () => {
    expect(withTrailingBlank([{ name: 'Elections', description: '' }])).toHaveLength(2)
  })

  it('leaves an existing trailing blank alone', () => {
    const rows = [{ name: 'Elections', description: '' }, { name: '', description: '' }]
    expect(withTrailingBlank(rows)).toEqual(rows)
  })

  it('gives an empty list one blank row', () => {
    expect(withTrailingBlank([])).toEqual([{ name: '', description: '' }])
  })
})

describe('sortRows', () => {
  const blank = { name: '', description: '' }

  it('sorts ascending by name, case-insensitively', () => {
    const rows = [
      { name: 'Zoning', description: '' },
      { name: 'elections', description: '' },
      { name: 'Housing', description: '' },
      blank,
    ]
    expect(sortRows(rows, 'asc').map(r => r.name)).toEqual(['elections', 'Housing', 'Zoning', ''])
  })

  it('descending reverses the order', () => {
    const rows = [
      { name: 'Zoning', description: '' },
      { name: 'elections', description: '' },
      { name: 'Housing', description: '' },
      blank,
    ]
    expect(sortRows(rows, 'desc').map(r => r.name)).toEqual(['Zoning', 'Housing', 'elections', ''])
  })

  it('keeps the trailing blank last in both directions', () => {
    const rows = [
      { name: 'B', description: '' },
      { name: 'A', description: '' },
      blank,
    ]
    expect(sortRows(rows, 'asc')[2]).toBe(blank)
    expect(sortRows(rows, 'desc')[2]).toBe(blank)
  })

  it('sinks nameless rows to just above the trailing blank rather than to the top', () => {
    const orphan = { name: '', description: 'stranded' }
    const rows = [
      { name: 'Zoning', description: '' },
      orphan,
      { name: 'Elections', description: '' },
      blank,
    ]
    expect(sortRows(rows, 'asc').map(r => r.name)).toEqual(['Elections', 'Zoning', '', ''])
    expect(sortRows(rows, 'asc')[2]).toBe(orphan)
  })

  it('is stable: two rows sharing a name keep their relative order, landing adjacent', () => {
    const first = { name: 'Elections', description: 'first' }
    const second = { name: 'elections', description: 'second' }
    const rows = [
      { name: 'Housing', description: '' },
      first,
      second,
      blank,
    ]
    const sorted = sortRows(rows, 'asc')
    expect(sorted.map(r => r.description)).toEqual(['first', 'second', '', ''])
  })

  it('returns the SAME array reference when the sort is a no-op', () => {
    const rows = [
      { name: 'Elections', description: '' },
      { name: 'Housing', description: '' },
      blank,
    ]
    expect(sortRows(rows, 'asc')).toBe(rows)
  })

  it('sorts every row, including the last, when the array does not end in a blank row', () => {
    // Exported and unit-tested alone, so it must not assume its only caller's
    // shape: a real tag that happens to be last is not the trailing blank
    // withTrailingBlank adds, and must be sorted like any other row rather
    // than silently pinned in place.
    const rows = [
      { name: 'Mango', description: '' },
      { name: 'Apple', description: '' },
      { name: 'Zebra', description: 'has desc' },
    ]
    expect(sortRows(rows, 'asc').map(r => r.name)).toEqual(['Apple', 'Mango', 'Zebra'])
    expect(sortRows(rows, 'desc').map(r => r.name)).toEqual(['Zebra', 'Mango', 'Apple'])
  })
})

describe('deriveSortDirection', () => {
  const blank = { name: '', description: '' }

  it('is none for a hand-curated order that is neither ascending nor descending', () => {
    // Mango < Zoning is ascending, but Zoning > Elections is descending —
    // mixed, so neither direction's sort would leave this order unchanged.
    const rows = [
      { name: 'Mango', description: '' },
      { name: 'Zoning', description: '' },
      { name: 'Elections', description: '' },
      blank,
    ]
    expect(deriveSortDirection(rows)).toBe('none')
  })

  it('is asc when the rows are already ascending', () => {
    const rows = [
      { name: 'Elections', description: '' },
      { name: 'Zoning', description: '' },
      blank,
    ]
    expect(deriveSortDirection(rows)).toBe('asc')
  })

  it('is desc when the rows are already descending', () => {
    const rows = [
      { name: 'Zoning', description: '' },
      { name: 'Elections', description: '' },
      blank,
    ]
    expect(deriveSortDirection(sortRows(rows, 'desc'))).toBe('desc')
  })

  it('is none with fewer than two real rows, since the order is ambiguous', () => {
    expect(deriveSortDirection([blank])).toBe('none')
    expect(deriveSortDirection([{ name: 'Elections', description: '' }, blank])).toBe('none')
  })

  it('does not assume a trailing blank: counts every row as real when the last row is not blank', () => {
    // Exported and unit-tested alone, so it must not restate the "subtract
    // one for the trailing blank" assumption that was just removed from
    // sortRows — the same objection applies here. An array with no trailing
    // blank at all must still have both of its rows counted as real.
    expect(deriveSortDirection([
      { name: 'a', description: '' },
      { name: 'b', description: '' },
    ])).toBe('asc')
  })

  it('reports unsorted for rows in neither ascending nor descending order (e.g. after Undo)', () => {
    // Simulates the sequence that used to leave a false claim on screen:
    // sort, then hand back rows in a different order (an Undo, a Reset, or a
    // fresh load), and the derived direction must not still say sorted.
    const sorted = sortRows([
      { name: 'Zoning', description: '' },
      { name: 'Elections', description: '' },
      { name: 'Mango', description: '' },
      blank,
    ], 'asc')
    expect(deriveSortDirection(sorted)).toBe('asc')

    const undone = [
      { name: 'Mango', description: '' },
      { name: 'Zoning', description: '' },
      { name: 'Elections', description: '' },
      blank,
    ]
    expect(deriveSortDirection(undone)).toBe('none')
  })
})

describe('moveRow', () => {
  it('moves a row down', () => {
    expect(moveRow(
      [{ name: 'A', description: '' }, { name: 'B', description: '' }, { name: 'C', description: '' }],
      0, 2,
    ).map(r => r.name)).toEqual(['B', 'C', 'A'])
  })

  it('moves a row up', () => {
    expect(moveRow(
      [{ name: 'A', description: '' }, { name: 'B', description: '' }, { name: 'C', description: '' }],
      2, 0,
    ).map(r => r.name)).toEqual(['C', 'A', 'B'])
  })

  it('returns the list unchanged for an out-of-range index', () => {
    const rows = [{ name: 'A', description: '' }]
    expect(moveRow(rows, 0, 5)).toEqual(rows)
    expect(moveRow(rows, -1, 0)).toEqual(rows)
  })
})
