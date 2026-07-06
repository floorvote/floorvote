import { describe, it, expect } from 'vitest'
import { buildVEvent, buildVCalendar, tzidForState, type IcalEvent } from '../../src/lib/ical'

function ev(overrides: Partial<IcalEvent> = {}): IcalEvent {
  return {
    uid: 'hearing-legiscan-1-x@ri',
    sequence: 0,
    status: 'confirmed',
    date: '2026-06-04',
    time: '14:00',
    location: 'Room 35',
    summary: 'H 5174 — House Cmte on Elections',
    description: null,
    ...overrides,
  }
}
const NOW = '2026-06-02T12:00:00Z'

describe('buildVEvent', () => {
  it('anchors a timed event to its state zone via TZID when tzid is set', () => {
    const s = buildVEvent(ev({ tzid: 'America/New_York' }), NOW)
    expect(s).toContain('DTSTART;TZID=America/New_York:20260604T140000')
    expect(s).toContain('DTEND;TZID=America/New_York:20260604T150000')
  })

  it('emits a UTC instant for a real zone outside the 7 shipped VTIMEZONE blocks', () => {
    // America/Detroit is Eastern (EDT, -4) in June → 14:00 local = 18:00 UTC.
    const s = buildVEvent(ev({ tzid: 'America/Detroit' }), NOW)
    expect(s).toContain('DTSTART:20260604T180000Z')
    expect(s).toContain('DTEND:20260604T190000Z')
    expect(s).not.toContain('TZID')
  })

  it('degrades to a floating time when the tzid is not a real zone', () => {
    const s = buildVEvent(ev({ tzid: 'Bogus/Zone' }), NOW)
    expect(s).toContain('DTSTART:20260604T140000') // no TZID param, no Z
    expect(s).not.toContain('TZID')
    expect(s).not.toContain('140000Z')
  })

  it('keeps all-day events date-only even when a tzid is present', () => {
    const s = buildVEvent(ev({ time: null, tzid: 'America/New_York' }), NOW)
    expect(s).toContain('DTSTART;VALUE=DATE:20260604')
    expect(s).not.toContain('TZID')
  })

  it('emits a timed event with floating DTSTART, UID, SEQUENCE, SUMMARY', () => {
    const s = buildVEvent(ev(), NOW)
    expect(s).toContain('BEGIN:VEVENT')
    expect(s).toContain('UID:hearing-legiscan-1-x@ri')
    expect(s).toContain('SEQUENCE:0')
    expect(s).toContain('DTSTART:20260604T140000')
    expect(s).toContain('SUMMARY:H 5174 — House Cmte on Elections')
    expect(s).toContain('LOCATION:Room 35')
    expect(s).toContain('STATUS:CONFIRMED')
    expect(s).toContain('END:VEVENT')
  })

  it('gives a timed event a default 1-hour duration via DTEND', () => {
    const s = buildVEvent(ev({ time: '14:00' }), NOW)
    expect(s).toContain('DTSTART:20260604T140000')
    expect(s).toContain('DTEND:20260604T150000')
  })

  it('rolls DTEND into the next day when start is in the last hour', () => {
    const s = buildVEvent(ev({ time: '23:30' }), NOW)
    expect(s).toContain('DTSTART:20260604T233000')
    expect(s).toContain('DTEND:20260605T003000')
  })

  it('does not emit DTEND for all-day events', () => {
    const s = buildVEvent(ev({ time: null }), NOW)
    expect(s).toContain('DTSTART;VALUE=DATE:20260604')
    expect(s).not.toContain('DTEND')
  })

  it('falls back to all-day when time is null', () => {
    const s = buildVEvent(ev({ time: null }), NOW)
    expect(s).toContain('DTSTART;VALUE=DATE:20260604')
    expect(s).not.toContain('T140000')
  })

  it('falls back to all-day when time is 00:00:00', () => {
    const s = buildVEvent(ev({ time: '00:00:00' }), NOW)
    expect(s).toContain('DTSTART;VALUE=DATE:20260604')
    expect(s).not.toContain('T000000')
  })

  it('falls back to all-day when time is 00:00 (HH:MM format)', () => {
    const s = buildVEvent(ev({ time: '00:00' }), NOW)
    expect(s).toContain('DTSTART;VALUE=DATE:20260604')
    expect(s).not.toContain('T0000')
  })

  it('handles HH:MM:SS format (already has seconds)', () => {
    const s = buildVEvent(ev({ time: '14:00:00' }), NOW)
    expect(s).toContain('DTSTART:20260604T140000')
  })

  it('zero-pads degenerate single-digit HH:MM times', () => {
    const s = buildVEvent(ev({ time: '9:5' }), NOW)
    expect(s).toContain('DTSTART:20260604T090500')
  })

  it('marks cancelled events', () => {
    const s = buildVEvent(ev({ status: 'cancelled', sequence: 2 }), NOW)
    expect(s).toContain('STATUS:CANCELLED')
    expect(s).toContain('SEQUENCE:2')
  })

  it('emits URL and DESCRIPTION when present', () => {
    const out = buildVEvent({
      uid: 'u', sequence: 0, status: 'confirmed', date: '2026-05-14', time: null,
      location: null, summary: 'Filing period', description: 'Through May 29',
      url: 'https://sos.example.gov',
    } as any, '2026-06-09T00:00:00Z')
    expect(out).toMatch(/\r\nURL:https:\/\/sos\.example\.gov/)
    expect(out).toMatch(/\r\nDESCRIPTION:Through May 29/)
  })

  it('escapes commas, semicolons, and backslashes in text', () => {
    const s = buildVEvent(ev({ summary: 'A, B; C\\D' }), NOW)
    expect(s).toContain('SUMMARY:A\\, B\\; C\\\\D')
  })

  it('folds content lines longer than 75 octets', () => {
    const longSummary = 'H 1234 — ' + 'Long Committee Name '.repeat(6)
    const s = buildVEvent(ev({ summary: longSummary }), NOW)
    const enc = new TextEncoder()
    for (const physical of s.split('\r\n')) {
      expect(enc.encode(physical).length).toBeLessThanOrEqual(75)
    }
    expect(s).toContain('\r\n ') // a fold occurred
  })
})

describe('buildVEvent — ICS injection guards', () => {
  it('rejects CR/LF smuggled in time → falls back to all-day, no injected lines', () => {
    const s = buildVEvent(ev({ time: '14:00\r\nSUMMARY:INJECTED\r\nX-EVIL:1' }), NOW)
    expect(s).not.toContain('INJECTED')
    expect(s).not.toContain('X-EVIL')
    expect(s).toContain('DTSTART;VALUE=DATE:20260604') // degraded to all-day
    // every physical line is a well-formed property (no smuggled bare value)
    for (const line of s.split('\r\n')) expect(line).toMatch(/^[A-Z][A-Z0-9-]*[:;]| /)
  })

  it('rejects CR/LF smuggled in date → drops DTSTART entirely, no injected lines', () => {
    const s = buildVEvent(ev({ date: '2026-06-04\r\nX-EVIL:1', time: null }), NOW)
    expect(s).not.toContain('X-EVIL')
    expect(s).not.toContain('DTSTART')
  })

  it('treats a non-time string as all-day rather than emitting it raw', () => {
    const s = buildVEvent(ev({ time: 'evening' }), NOW)
    expect(s).not.toContain('evening')
    expect(s).toContain('DTSTART;VALUE=DATE:20260604')
  })

  it('strips CR/LF from uid so it cannot break the content line', () => {
    const s = buildVEvent(ev({ uid: 'u\r\nX-INJECT:evil' }), NOW)
    expect(s).not.toMatch(/\r\nX-INJECT:evil/)
    expect(s).toContain('UID:uX-INJECT:evil') // collapsed onto one line, no injection
  })

  it('does not emit a VTIMEZONE for an event whose time fails validation', () => {
    const s = buildVCalendar(
      [ev({ time: '14:00\r\nX-EVIL:1', tzid: 'America/New_York' })],
      { calName: 'Feed', now: NOW },
    )
    expect(s).not.toContain('X-EVIL')
    expect(s).not.toContain('BEGIN:VTIMEZONE') // no timed DTSTART → no zone needed
  })
})

describe('buildVCalendar', () => {
  it('wraps events with VCALENDAR headers and CRLF', () => {
    const s = buildVCalendar([ev()], { calName: 'RI — Tracked Hearings', now: NOW })
    expect(s.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(s).toContain('VERSION:2.0')
    expect(s).toContain('PRODID:')
    expect(s).toContain('X-WR-CALNAME:RI — Tracked Hearings')
    expect(s).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT12H')
    expect(s).toContain('BEGIN:VEVENT')
    expect(s.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
    expect(s).toContain('\r\n')
  })

  it('renders an empty calendar with no events', () => {
    const s = buildVCalendar([], { calName: 'Empty', now: NOW })
    expect(s).toContain('BEGIN:VCALENDAR')
    expect(s).not.toContain('BEGIN:VEVENT')
    expect(s).toContain('END:VCALENDAR')
  })

  it('includes a VTIMEZONE block for each referenced zone, before the events', () => {
    const s = buildVCalendar([
      ev({ uid: 'nj@x', tzid: 'America/New_York' }),
      ev({ uid: 'ca@x', tzid: 'America/Los_Angeles' }),
    ], { calName: 'Multi', now: NOW })
    expect(s).toContain('BEGIN:VTIMEZONE\r\nTZID:America/New_York')
    expect(s).toContain('BEGIN:VTIMEZONE\r\nTZID:America/Los_Angeles')
    // VTIMEZONE must precede the first VEVENT
    expect(s.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(s.indexOf('BEGIN:VEVENT'))
  })

  it('omits VTIMEZONE when no timed event references a zone', () => {
    const s = buildVCalendar([ev({ tzid: null })], { calName: 'Floating', now: NOW })
    expect(s).not.toContain('BEGIN:VTIMEZONE')
  })

  it('does not pull a VTIMEZONE for an all-day event even with a tzid', () => {
    const s = buildVCalendar([ev({ time: null, tzid: 'America/New_York' })], { calName: 'AllDay', now: NOW })
    expect(s).not.toContain('BEGIN:VTIMEZONE')
  })
})

describe('tzidForState', () => {
  it('maps states to their capitol zone', () => {
    expect(tzidForState('NJ')).toBe('America/New_York')
    expect(tzidForState('CA')).toBe('America/Los_Angeles')
    expect(tzidForState('TX')).toBe('America/Chicago') // Austin = Central
    expect(tzidForState('FL')).toBe('America/New_York') // Tallahassee = Eastern
    expect(tzidForState('AZ')).toBe('America/Phoenix') // no DST
    expect(tzidForState('ri')).toBe('America/New_York') // case-insensitive
  })

  it('returns null for empty/unknown states (event falls back to floating)', () => {
    expect(tzidForState('')).toBeNull()
    expect(tzidForState(null)).toBeNull()
    expect(tzidForState('ZZ')).toBeNull()
  })
})
