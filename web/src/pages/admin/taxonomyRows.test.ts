import { describe, it, expect } from 'vitest'
import {
  rowsFromTaxonomy, rowsToTaxonomy, rowProblems,
  parsePastedRows, withTrailingBlank, moveRow,
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
