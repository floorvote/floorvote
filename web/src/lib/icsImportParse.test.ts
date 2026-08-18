import { describe, it, expect } from 'vitest'
import { parseIcs, isIcs } from './icsImportParse'

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${body}\r\nEND:VCALENDAR\r\n`

// A real Outlook/Google export embeds the zone definition; ical.js resolves TZID against it.
const CHICAGO_VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:America/Chicago',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n')

describe('isIcs', () => {
  it('detects a calendar by content, not extension', () => {
    expect(isIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBe(true)
    expect(isIcs('﻿BEGIN:VCALENDAR')).toBe(true)   // BOM
    expect(isIcs('Title,Date\nFoo,2026-05-04')).toBe(false)
  })
})

describe('parseIcs', () => {
  it('maps an all-day event to a date with no time', () => {
    const [r] = parseIcs(wrap('BEGIN:VEVENT\r\nUID:a@x\r\nSUMMARY:Registration deadline\r\nDTSTART;VALUE=DATE:20260504\r\nEND:VEVENT'), 'America/Chicago')
    expect(r.status).toBe('ok')
    expect(r.title).toBe('Registration deadline')
    expect(r.dateIso).toBe('2026-05-04')
    expect(r.time).toBeNull()          // must NOT become 00:00
    expect(r.timezone).toBeNull()
    expect(r.uid).toBe('a@x')
  })

  it('resolves a TZID against the file VTIMEZONE and keeps wall-clock time', () => {
    const [r] = parseIcs(wrap(`${CHICAGO_VTIMEZONE}\r\nBEGIN:VEVENT\r\nUID:b@x\r\nSUMMARY:Hearing\r\nDTSTART;TZID=America/Chicago:20260504T170000\r\nEND:VEVENT`), 'UTC')
    expect(r.dateIso).toBe('2026-05-04')
    expect(r.time).toBe('17:00')
    expect(r.timezone).toBe('America/Chicago')
  })

  it('converts a UTC DTSTART into wall clock in the fallback zone', () => {
    const [r] = parseIcs(wrap('BEGIN:VEVENT\r\nUID:c@x\r\nSUMMARY:Deadline\r\nDTSTART:20260504T220000Z\r\nEND:VEVENT'), 'America/Chicago')
    expect(r.dateIso).toBe('2026-05-04')   // 22:00Z = 17:00 CDT same day
    expect(r.time).toBe('17:00')
    expect(r.timezone).toBe('America/Chicago')
  })

  it('keeps a floating time verbatim with no zone', () => {
    const [r] = parseIcs(wrap('BEGIN:VEVENT\r\nUID:fl@x\r\nSUMMARY:Floating\r\nDTSTART:20260504T170000\r\nEND:VEVENT'), 'America/Chicago')
    expect(r.dateIso).toBe('2026-05-04')
    expect(r.time).toBe('17:00')
    expect(r.timezone).toBeNull()      // NOT the literal string 'floating'
  })

  it('expands a recurring event into separate rows sharing a uid stem', () => {
    const rows = parseIcs(wrap('BEGIN:VEVENT\r\nUID:e@x\r\nSUMMARY:Weekly sync\r\nDTSTART;VALUE=DATE:20260504\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT'), 'UTC')
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.dateIso)).toEqual(['2026-05-04', '2026-05-11', '2026-05-18'])
    expect(rows.every(r => r.status === 'ok')).toBe(true)
    // Each occurrence needs its own uid or the upsert would collapse them into one row.
    expect(new Set(rows.map(r => r.uid)).size).toBe(3)
    expect(rows.every(r => r.uid!.startsWith('e@x'))).toBe(true)
    expect(rows[0].notice).toMatch(/3 occurrences/i)
  })

  it('honours EXDATE when expanding', () => {
    const rows = parseIcs(wrap('BEGIN:VEVENT\r\nUID:x@x\r\nSUMMARY:Skips one\r\nDTSTART;VALUE=DATE:20260504\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE;VALUE=DATE:20260511\r\nEND:VEVENT'), 'UTC')
    expect(rows.map(r => r.dateIso)).toEqual(['2026-05-04', '2026-05-18'])
  })

  it('caps an unbounded daily series at the 12-month horizon and MAX_OCCURRENCES', () => {
    const rows = parseIcs(wrap('BEGIN:VEVENT\r\nUID:d@x\r\nSUMMARY:Daily forever\r\nDTSTART;VALUE=DATE:20260504\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT'), 'UTC')
    expect(rows.length).toBeLessThanOrEqual(200)
    expect(rows[0].notice).toMatch(/capped/i)
  })

  it('skips a VEVENT with no UID', () => {
    const [r] = parseIcs(wrap('BEGIN:VEVENT\r\nSUMMARY:No uid\r\nDTSTART;VALUE=DATE:20260504\r\nEND:VEVENT'), 'UTC')
    expect(r.status).toBe('skip')
    expect(r.reason).toMatch(/uid/i)
  })

  it('unfolds continuation lines and unescapes text', () => {
    const [r] = parseIcs(wrap('BEGIN:VEVENT\r\nUID:f@x\r\nSUMMARY:Filing window\r\nDESCRIPTION:Forms due\\, with ID\r\n  and a note\r\nLOCATION:Clerk\; Room 2\r\nURL:https://x.example/a\r\nDTSTART;VALUE=DATE:20260504\r\nEND:VEVENT'), 'UTC')
    expect(r.details).toBe('Forms due, with ID and a note')
    expect(r.location).toBe('Clerk; Room 2')
    expect(r.url).toBe('https://x.example/a')
  })

  it('ignores non-VEVENT components', () => {
    const rows = parseIcs(wrap(
      'BEGIN:VTODO\r\nUID:t@x\r\nSUMMARY:A task\r\nEND:VTODO\r\n' +
      'BEGIN:VEVENT\r\nUID:g@x\r\nSUMMARY:One\r\nDTSTART;VALUE=DATE:20260504\r\nEND:VEVENT'), 'UTC')
    expect(rows.map(r => r.title)).toEqual(['One'])
  })

  it('returns an empty array for a calendar with no events', () => {
    expect(parseIcs(wrap('BEGIN:VTODO\r\nUID:t@x\r\nEND:VTODO'), 'UTC')).toEqual([])
  })
})
