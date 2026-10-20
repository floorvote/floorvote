import { describe, it, expect } from 'vitest'
import { committeeChipLabel } from './activeFilterGroups'

// A committee chip names the committee from the labels the facets give, on a cold load too (#471), and says which
// scope the list is filtered by.
describe('committeeChipLabel', () => {
  const labels = { 1021: 'Judiciary (Senate)' }

  it('names the committee from the labels it is given, under each scope', () => {
    expect(committeeChipLabel('1021', 'current', labels)).toBe('In Judiciary (Senate)')
    expect(committeeChipLabel('1021', 'any', labels)).toBe('Referred to Judiciary (Senate)')
  })

  it('reads by id for a committee no label names', () => {
    expect(committeeChipLabel('77', 'any', labels)).toBe('Referred to committee 77')
  })
})
