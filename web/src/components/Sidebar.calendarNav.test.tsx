import { describe, it, expect } from 'vitest'
import { calendarChipLabel } from './Sidebar'

describe('calendarChipLabel', () => {
  it('returns null when count is null/0', () => {
    expect(calendarChipLabel(null)).toBeNull()
    expect(calendarChipLabel(0)).toBeNull()
  })
  it('labels the upcoming count', () => {
    expect(calendarChipLabel(3)).toBe('3 upcoming')
    expect(calendarChipLabel(1)).toBe('1 upcoming')
  })
})
