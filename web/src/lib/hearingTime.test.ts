import { describe, it, expect } from 'vitest'
import { formatHearingTime, formatHearingTimeShort } from './hearingTime'

describe('formatHearingTime', () => {
  it('returns null for empty / all-day', () => {
    expect(formatHearingTime(null)).toBeNull()
    expect(formatHearingTime('')).toBeNull()
    expect(formatHearingTime('00:00')).toBeNull()
  })
  it('formats to 12-hour clock', () => {
    expect(formatHearingTime('14:00')).toBe('2:00 PM')
    expect(formatHearingTime('09:30:00')).toBe('9:30 AM')
    expect(formatHearingTime('12:15')).toBe('12:15 PM')
  })
})

describe('formatHearingTimeShort', () => {
  it('returns null for empty / all-day', () => {
    expect(formatHearingTimeShort(null)).toBeNull()
    expect(formatHearingTimeShort('00:00')).toBeNull()
  })
  it('drops :00 on the hour and uses a lowercase meridiem letter', () => {
    expect(formatHearingTimeShort('09:00')).toBe('9a')
    expect(formatHearingTimeShort('14:00')).toBe('2p')
    expect(formatHearingTimeShort('12:00')).toBe('12p') // noon
  })
  it('keeps minutes when not on the hour', () => {
    expect(formatHearingTimeShort('13:30')).toBe('1:30p')
    expect(formatHearingTimeShort('09:05:00')).toBe('9:05a')
  })
})
