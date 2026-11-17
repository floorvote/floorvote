import { describe, it, expect } from 'vitest'
import { DEFAULT_WEEK_AHEAD_DAY, digestSentPhrase, weekAheadSentPhrase } from './notifications'

describe('digestSentPhrase', () => {
  it('says every morning for a daily digest', () => {
    expect(digestSentPhrase(null)).toBe('every morning')
    expect(digestSentPhrase(undefined)).toBe('every morning')
  })

  it('names the weekday of a weekly digest, from Sunday (0) to Saturday (6)', () => {
    expect(digestSentPhrase(0)).toBe('every Sunday morning')
    expect(digestSentPhrase(3)).toBe('every Wednesday morning')
    expect(digestSentPhrase(6)).toBe('every Saturday morning')
  })

  it('says every morning for a day that is not a weekday', () => {
    expect(digestSentPhrase(7)).toBe('every morning')
  })
})

describe('weekAheadSentPhrase', () => {
  it('names the weekday, from Sunday (0) to Saturday (6)', () => {
    expect(weekAheadSentPhrase(0)).toBe('every Sunday morning')
    expect(weekAheadSentPhrase(4)).toBe('every Thursday morning')
    expect(weekAheadSentPhrase(6)).toBe('every Saturday morning')
  })

  it('reads a day outside 0 to 6 as Friday, the default', () => {
    expect(DEFAULT_WEEK_AHEAD_DAY).toBe(5)
    expect(weekAheadSentPhrase(5)).toBe('every Friday morning')
    expect(weekAheadSentPhrase(7)).toBe('every Friday morning')
  })
})
