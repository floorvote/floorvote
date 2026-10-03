import { describe, it, expect } from 'vitest'
import { committeeKey, staleCommittees } from './councilCommittees'

describe('council committee names', () => {
  it('compares the site name and the calendar name as one committee', () => {
    expect(committeeKey('Committee on Youth Affairs')).toBe(committeeKey('Youth Affairs'))
    expect(committeeKey('Committee on the Judiciary and Public Safety')).toBe(committeeKey('Judiciary and Public Safety'))
  })

  it('flags saved committees the Council no longer has, but not legislative meetings', () => {
    const current = ['Committee on Youth Affairs', 'Committee of the Whole', 'Committee on the Judiciary and Public Safety']
    expect(staleCommittees(['Youth Affairs', 'Legislative Meeting', 'Committee of the Whole', 'Recreation, Libraries and Youth Affairs'], current))
      .toEqual(['Recreation, Libraries and Youth Affairs'])
  })
})
