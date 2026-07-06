import { describe, it, expect } from 'vitest'
import { recoverItemDate, resolveItemDate } from './itemDate'

describe('recoverItemDate', () => {
  const single = { yearStart: 2026, yearEnd: 2026 }   // single-calendar-year session
  const span = { yearStart: 2025, yearEnd: 2026 }      // boundary-spanning session

  it('parses a full M/D/YY date (NJ documents), normalizing the 2-digit year', () => {
    expect(recoverItemDate('Statement SSG 5/21/26 SCS SR99', span)).toBe('2026-05-21')
    expect(recoverItemDate('Fiscal Estimate 3/9/26; 1R', {})).toBe('2026-03-09')
  })

  it('parses a full M/D/YYYY date', () => {
    expect(recoverItemDate('Report 12/1/2025', {})).toBe('2025-12-01')
  })

  it('infers the year for a year-less M/D date when the session is a single calendar year (AZ amendments)', () => {
    expect(recoverItemDate('House COW 04/08 - Floor Amend to Bill - Gutierrez', single)).toBe('2026-04-08')
  })

  it('returns null for a year-less M/D date when the session spans a year boundary', () => {
    expect(recoverItemDate('House COW 04/08 - Floor Amend', span)).toBeNull()
    expect(recoverItemDate('House COW 04/08 - Floor Amend', {})).toBeNull()
  })

  it('returns null when there is no date in the text', () => {
    expect(recoverItemDate('Senate Bill Report', single)).toBeNull()
    expect(recoverItemDate('House bill analysis 2026', single)).toBeNull() // bare year, no M/D
    expect(recoverItemDate(null, single)).toBeNull()
    expect(recoverItemDate('', single)).toBeNull()
  })

  it('rejects out-of-range month/day rather than emitting a bad date', () => {
    expect(recoverItemDate('Section 13/40/26', span)).toBeNull()
    expect(recoverItemDate('Section 13/40', single)).toBeNull()
  })

  it('takes the first date match in the string', () => {
    expect(recoverItemDate('Statement 5/21/26 superseding 6/30/26', span)).toBe('2026-05-21')
  })

  it('normalizes a leading-zero 2-digit year', () => {
    expect(recoverItemDate('Report 5/1/09', {})).toBe('2009-05-01')
  })

  it('does not treat a 3-digit year as a full date', () => {
    // "6/15/202" must not produce a bogus year; with empty opts the year-less
    // branch is also inactive, so the result is null.
    expect(recoverItemDate('Filed 6/15/202', {})).toBeNull()
  })

  it('falls back to year-less M/D inference when a 3-digit year makes the full date invalid (single-year session)', () => {
    // "6/15/202" is not a valid full date (3-digit year), so the full-date branch
    // rejects it; the year-less branch then matches "6/15" and infers the session year.
    expect(recoverItemDate('Filed 6/15/202', single)).toBe('2026-06-15')
  })
})

describe('resolveItemDate', () => {
  const single = { yearStart: 2026, yearEnd: 2026 }

  it('passes a present structured date through, not inferred', () => {
    expect(resolveItemDate('2026-05-14', 'Statement 1/1/26', single)).toEqual({ dateResolved: '2026-05-14', dateInferred: false })
  })

  it('recovers from text when the date is the 0000-00-00 placeholder', () => {
    expect(resolveItemDate('0000-00-00', 'Statement SSG 5/21/26', single)).toEqual({ dateResolved: '2026-05-21', dateInferred: true })
  })

  it('recovers from text when the date is null/empty', () => {
    expect(resolveItemDate(null, 'House COW 04/08 - x', single)).toEqual({ dateResolved: '2026-04-08', dateInferred: true })
    expect(resolveItemDate('', 'House COW 04/08 - x', single)).toEqual({ dateResolved: '2026-04-08', dateInferred: true })
  })

  it('reports no resolved date and not inferred when nothing is recoverable', () => {
    expect(resolveItemDate('0000-00-00', 'Senate Bill Report', single)).toEqual({ dateResolved: null, dateInferred: false })
  })
})
