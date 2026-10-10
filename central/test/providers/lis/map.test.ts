import { describe, it, expect } from 'vitest'
import s2026Raw from '../../fixtures/lis/20261-sample.json?raw'
import s2027Raw from '../../fixtures/lis/20271-sample.json?raw'
import { parseCsv, parseCsvRecords } from '../../../src/providers/lis/csv'
import type { LisFiles } from '../../../src/providers/lis/client'
import {
  buildLisBill, LisAssembler, LIS_FILE_ORDER, lisBillNumber, lisCarriedOver, lisDate, lisStatus,
  parseVotes, toLisMasterListEntry, type LisIds,
} from '../../../src/providers/lis/map'
import { vocabulary } from '../../../src/providers/lis/vocabulary'

// Real rows from https://lis.blob.core.windows.net/lisfiles/{20261,20271}/, trimmed to a few bills.
function assembleLisRecords(files: LisFiles) {
  const a = new LisAssembler(files.bills)
  for (const file of LIS_FILE_ORDER) if (file !== 'bills') a.add(file, files[file])
  return a.result()
}
const y2026 = assembleLisRecords(JSON.parse(s2026Raw) as LisFiles)
const y2027 = assembleLisRecords(JSON.parse(s2027Raw) as LisFiles)
const label = (n: string, year = 2026, set = y2026) => vocabulary.statuses[lisStatus(set.records.get(n)!, year)].label

const SESSION = { session_id: 3000000001, session_name: '2026 Regular Session', year_start: 2026, year_end: 2026 }
const counter = (base: number) => { const m = new Map<string, number>(); return (k: string) => m.get(k) ?? (m.set(k, base + m.size), base + m.size - 1) }
const ids = (): LisIds => ({ person: counter(3000000200), rollCall: counter(3000000400), doc: counter(3000000600) })

describe('parseCsv', () => {
  it('keeps text after a closing quote, as Sponsors.csv writes the patron type', () => {
    expect(parseCsv('"Jeion A. Ward   ","H0173","HB1","1" - Chief Patron\n')).toEqual([['Jeion A. Ward   ', 'H0173', 'HB1', '1 - Chief Patron']])
  })

  it('reads quoted commas, doubled quotes and newlines, and trims a spaced header', () => {
    expect(parseCsvRecords('"A", "B"\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([{ A: 'x, y', B: 'say "hi"\nthere' }])
  })
})

describe('assembleLisRecords', () => {
  it('joins every file into one record per bill', () => {
    expect([...y2026.records.keys()].sort()).toEqual(['HB1', 'HB133', 'HB447', 'HB61', 'HB9', 'HR1'])
    const hb1 = y2026.records.get('HB1')!
    expect(hb1.sponsors[0]).toEqual(['H0173', 'Jeion A. Ward', '1 - Chief Patron'])
    expect(hb1.history[0]).toEqual(['2025-11-17', 'H Prefiled and ordered printed; Offered 01-14-2026 26101997D', '26101997D'])
    expect(hb1.summary?.type).toBe('SUMMARY AS PASSED')
    expect(hb1.summary?.text).toMatch(/^Minimum wage\./)
    expect(hb1.fiscal.length).toBeGreaterThan(0)
    // DOCKET.CSV covers Senate committees; the House publishes its agendas elsewhere.
    expect(hb1.dockets).toContainEqual(['2026-02-23', 'Senate Commerce and Labor docket'])
    expect(Object.keys(hb1.votes)).toContain('H14V2610034')
    expect(y2026.members.find(m => m.id === 'H0173')).toEqual({ id: 'H0173', name: 'Jeion A. Ward', chamber: 'H' })
  })

  it('normalises the bill numbers and dates the files write differently', () => {
    expect(lisBillNumber('HB0001   ')).toBe('HB1')
    expect(lisDate('1/9/2026')).toBe('2026-01-09')
    expect(lisDate('01/20/2026')).toBe('2026-01-20')
  })
})

describe('lisStatus', () => {
  it('reads the outcome from the flags', () => {
    expect(label('HB1')).toBe('Approved by the Governor')
    expect(label('HB61')).toBe('Vetoed by the Governor')
    expect(label('HB133')).toBe('Failed')
    expect(label('HR1')).toBe('Agreed to')
    expect(label('HB9')).toBe('Continued to next session')
  })

  it('calls a bill continued into the next session pending there, not continued again', () => {
    expect(lisCarriedOver(y2027.records.get('HB9')!, 2027)).toBe(true)
    expect(label('HB9', 2027, y2027)).toBe('Continued from last session')
    // Prefiled in late 2026 for 2027: history from an earlier year, but not carried over.
    expect(lisCarriedOver(y2027.records.get('HB1532')!, 2027)).toBe(false)
    expect(lisCarriedOver(y2026.records.get('HB9')!, 2026)).toBe(false)
  })
})

describe('buildLisBill', () => {
  it('builds history, patrons, per-member votes, fiscal statements and dockets', async () => {
    const rec = y2026.records.get('HB1')!
    const b = await buildLisBill(rec, '20261', 3000000101, 'hash', SESSION, ids())
    expect(b).toMatchObject({ bill_number: 'HB1', state: 'VA', status: 5, body: 'H', bill_type: 'B', texts: [] })
    expect(b.title).toBe('Minimum wage; increases incrementally to $15.00 per hour by January 1, 2028.')
    expect(b.description).toMatch(/^Minimum wage\./)
    expect(b.state_link).toBe('https://lis.virginia.gov/bill-details/20261/HB1')

    expect(b.history[0]).toMatchObject({ date: '2025-11-17', chamber: 'H', action: 'Prefiled and ordered printed; Offered 01-14-2026 26101997D' })
    expect(b.history.some(h => h.chamber === '' && /Approved by Governor-Chapter 350/.test(h.action))).toBe(true)
    expect(b.referrals[0]).toMatchObject({ chamber: 'H', name: 'Labor and Commerce' })
    expect(b.sponsors[0]).toMatchObject({ name: 'Jeion A. Ward', role: 'Delegate', sponsor_type_id: 1, sponsor_order: 1 })

    // Each vote's tally, counted from the member rows, matches the one the history line states.
    expect(b.votes.length).toBeGreaterThan(3)
    for (const v of b.votes) {
      const m = /\((\d+)-Y (\d+)-N/.exec(v.desc)
      if (m) expect([v.yea, v.nay]).toEqual([Number(m[1]), Number(m[2])])
      expect(v.member_votes!.length).toBe(v.total)
    }
    const floor = b.votes.find(v => /passed House/.test(v.desc))!
    expect(floor).toMatchObject({ chamber: 'H', yea: 64, nay: 34, passed: 1 })

    expect(b.supplements[0]).toMatchObject({ type: 'Fiscal Note', state_link: expect.stringMatching(/^https:\/\/lis\.blob\.core\.windows\.net\/files\/\d+\.PDF$/) })
    expect(b.calendar.length).toBeGreaterThan(0)
    expect(b.calendar.every(c => c.type === 'Hearing' && /docket$/.test(c.description))).toBe(true)
  })

  it('links a carried-over bill to the one it continues', async () => {
    const b = await buildLisBill(y2027.records.get('HB9')!, '20271', 3000000150, 'h', { ...SESSION, year_start: 2027, year_end: 2027 },
      { ...ids(), carriedFrom: 3000000109 })
    expect(b.sasts).toEqual([{ type_id: 4, type: 'Carry Over', sast_bill_number: 'HB9', sast_bill_id: 3000000109 }])
  })

  it('keeps the last action and the summary in the masterlist entry', () => {
    const e = toLisMasterListEntry(y2026.records.get('HB1')!, '20261', 1, 'h')
    expect(e).toMatchObject({ number: 'HB1', status: 5, last_action_date: '2026-04-08' })
    expect(e.last_action).toMatch(/Chapter text \(CHAP0350\)|Approved by Governor/)
  })

  it('reads votes stored compactly', () => {
    expect(parseVotes('H0056N,H0108Y,S0011X')).toEqual([['H0056', 'N'], ['H0108', 'Y'], ['S0011', 'X']])
  })
})
