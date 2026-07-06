import { describe, it, expect } from 'vitest'
import { matchHeaders, parseDate, assembleDetails, rowToImport } from './calendarImportParse'

describe('matchHeaders', () => {
  it('maps known headers case/space-insensitively, order-independent', () => {
    const m = matchHeaders([' Begin Date ', 'TITLE', 'End Date', 'Statute Reference'])
    expect(m.title).toBe('TITLE')
    expect(m.beginDate).toBe(' Begin Date ')
    expect(m.endDate).toBe('End Date')
    expect(m.extras).toEqual(['Statute Reference'])
  })
})

describe('parseDate', () => {
  it('parses ISO and M/D/YYYY', () => {
    expect(parseDate('2026-05-14')).toEqual({ ok: true, iso: '2026-05-14' })
    expect(parseDate('5/14/2026')).toEqual({ ok: true, iso: '2026-05-14' })
  })
  it('parses M/D/YY two-digit years (Excel rewrites M/D/YYYY on save) as 20YY', () => {
    expect(parseDate('1/1/26')).toEqual({ ok: true, iso: '2026-01-01' })
    expect(parseDate('5/14/26')).toEqual({ ok: true, iso: '2026-05-14' })
  })
  it('flags a typo as not-ok (with raw)', () => {
    expect(parseDate('06/02/206').ok).toBe(false)
  })
  it('treats blank as no-date', () => {
    expect(parseDate('')).toEqual({ ok: false })
  })
  it('rejects an out-of-range M/D/Y date', () => {
    expect(parseDate('13/45/2026').ok).toBe(false)
  })
  it('handles a JS Date object', () => {
    expect(parseDate(new Date(2026, 4, 14))).toEqual({ ok: true, iso: '2026-05-14' })
  })
})

describe('matchHeaders details column', () => {
  it('maps a Details/Description/Notes column to the details field', () => {
    expect(matchHeaders(['Title', 'Date', 'Details']).details).toBe('Details')
    expect(matchHeaders(['Title', 'Date', 'Description']).details).toBe('Description')
    const m = matchHeaders(['Title', 'Date', 'Notes', 'Statute Reference'])
    expect(m.details).toBe('Notes')
    expect(m.extras).toEqual(['Statute Reference'])
  })
})

describe('assembleDetails', () => {
  it('leads with the details text, then span note, then labels extras', () => {
    const d = assembleDetails({ detailsText: 'Bring photo ID.', beginIso: '2026-05-14', endIso: '2026-05-29', extras: { 'Statute Reference': 'W.S. 22-5-209', Notes: 'forms on SOS site' } })
    expect(d.startsWith('Bring photo ID.')).toBe(true)
    expect(d).toContain('Through May 29')
    expect(d).toContain('Statute Reference: W.S. 22-5-209')
    expect(d).toContain('Notes: forms on SOS site')
  })
  it('works without a details text (back-compat)', () => {
    const d = assembleDetails({ beginIso: '2026-05-14', endIso: '2026-05-29', extras: {} })
    expect(d).toBe('Through May 29')
  })
})

describe('rowToImport details column', () => {
  it('uses a Details column as the unlabeled details body', () => {
    const map = matchHeaders(['Title', 'Date', 'Details'])
    const r = rowToImport({ Title: 'Reg deadline', Date: '2026-05-04', Details: 'Last day to register.' }, map)
    expect(r.status).toBe('ok')
    expect(r.details).toBe('Last day to register.')
  })
  it('populates time, location, and url from their columns', () => {
    const map = matchHeaders(['Title', 'Date', 'Time', 'Location', 'Link'])
    const r = rowToImport({ Title: 'Hearing', Date: '2026-05-04', Time: '17:00', Location: 'County Clerk', Link: 'https://sos.example.gov' }, map)
    expect(r.time).toBe('17:00')
    expect(r.location).toBe('County Clerk')
    expect(r.url).toBe('https://sos.example.gov')
  })
})

describe('rowToImport', () => {
  it('skips a row with no date, warns on a typo date, ok otherwise', () => {
    const map = matchHeaders(['Title', 'Begin Date', 'End Date', 'Statute Reference'])
    const ok = rowToImport({ Title: 'Filing period', 'Begin Date': '2026-05-14', 'End Date': '2026-05-29', 'Statute Reference': 'W.S. 1' }, map)
    expect(ok.status).toBe('ok'); expect(ok.dateIso).toBe('2026-05-14'); expect(ok.details).toContain('Through May 29')
    const noDate = rowToImport({ Title: 'No deadline', 'Begin Date': '' }, map)
    expect(noDate.status).toBe('skip')
    const noTitle = rowToImport({ Title: '', 'Begin Date': '2026-05-14' }, map)
    expect(noTitle.status).toBe('skip')
    const warn = rowToImport({ Title: 'Typo', 'Begin Date': '06/02/206' }, map)
    expect(warn.status).toBe('warning')
  })
})
