import { describe, it, expect } from 'vitest'
import { fieldPaths, inventoryProblems } from './fieldInventory'

describe('fieldPaths', () => {
  it('names every field, null ones included, dotted with [] for array items', () => {
    expect(fieldPaths({ a: 1, b: { c: null, d: [{ e: 'x' }, { f: true }] }, g: ['s'], h: [], i: {} }))
      .toEqual(['a', 'b.c', 'b.d[].e', 'b.d[].f', 'g[]'])
  })
})

describe('inventoryProblems', () => {
  const fixture = { Id: 1, Tags: ['x'], Meta: { Source: 's', Raw: { Deep: 1 } }, Rows: [{ A: 1, B: 2 }] }

  it('passes when each field is listed by its path, an array of plain values by the array, or under an ignored ancestor', () => {
    expect(inventoryProblems({
      Id: 'mapped',
      Tags: 'mapped',
      Meta: { ignored: 'feed bookkeeping' },
      'Rows[].A': 'mapped',
      'Rows[].B': { extra: 'b' },
    }, [fixture])).toEqual([])
  })

  it('does not let a mapped container cover the fields inside it', () => {
    expect(inventoryProblems({ Id: 'mapped', Tags: 'mapped', Meta: 'mapped', Rows: 'mapped' }, [fixture])).toEqual([
      'not in the inventory: Meta.Raw.Deep',
      'not in the inventory: Meta.Source',
      'not in the inventory: Rows[].A',
      'not in the inventory: Rows[].B',
    ])
  })

  it('checks every fixture, and reports each missing field once', () => {
    expect(inventoryProblems({ Id: 'mapped' }, [{ Id: 1, New: 1 }, { Id: 2, New: 2 }, { Id: 3, Other: [{ X: 1 }] }]))
      .toEqual(['not in the inventory: New', 'not in the inventory: Other[].X'])
  })
})
