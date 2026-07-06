import { describe, it, expect } from 'vitest'
import { formatHearingTime } from './Sidebar'

describe('formatHearingTime', () => {
  it('returns null for missing time', () => {
    expect(formatHearingTime(null)).toBeNull()
    expect(formatHearingTime('')).toBeNull()
  })

  it('treats midnight as "time TBD" (null)', () => {
    expect(formatHearingTime('00:00:00')).toBeNull()
    expect(formatHearingTime('0:00')).toBeNull()
  })

  it('formats morning times', () => {
    expect(formatHearingTime('10:00:00')).toBe('10:00 AM')
    expect(formatHearingTime('09:30:00')).toBe('9:30 AM')
  })

  it('formats noon and afternoon times', () => {
    expect(formatHearingTime('12:00:00')).toBe('12:00 PM')
    expect(formatHearingTime('13:30:00')).toBe('1:30 PM')
    expect(formatHearingTime('23:45:00')).toBe('11:45 PM')
  })

  it('returns null for unparseable input', () => {
    expect(formatHearingTime('TBD')).toBeNull()
  })
})
