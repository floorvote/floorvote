import { describe, it, expect } from 'vitest'
import s2026Raw from '../../fixtures/lis/20261-sample.json?raw'
import s2027Raw from '../../fixtures/lis/20271-sample.json?raw'
import { parseCsv, parseCsvRecords, forEachCsvRow } from '../../../src/providers/lis/csv'
import type { LisFiles } from '../../../src/providers/lis/client'
import {
  buildLisBill, continuationTarget, LisAssembler, LIS_FILE_ORDER, lisBillNumber, lisCarriedFromCandidates, lisCarry,
  lisDate, lisExtras, lisHistory, lisStatus, LIS_STATUS, parseVotes, toLisMasterListEntry, type LisIds, type LisRecord,
} from '../../../src/providers/lis/map'
import { vocabulary } from '../../../src/providers/lis/vocabulary'
import { inventory } from '../../../src/providers/lis/inventory'
import { inventoryProblems, unfedExtras } from '../../helpers/fieldInventory'

// Real rows from https://lis.blob.core.windows.net/lisfiles/{20261,20271}/, trimmed to a few bills.
const files2026 = JSON.parse(s2026Raw) as LisFiles
const files2027 = JSON.parse(s2027Raw) as LisFiles
function assemble(code: string, files: LisFiles) {
  const a = new LisAssembler(code, files.bills)
  for (const file of LIS_FILE_ORDER) if (file !== 'bills' && files[file]) a.add(file, files[file])
  return a
}
const y2026 = assemble('20261', files2026).result()
const y2027 = assemble('20271', files2027).result()
const label = (n: string, code = '20261', set = y2026) => vocabulary.statuses[lisStatus(set.records.get(n)!, code)].label

const SESSION = { session_id: 3000000001, session_name: '2026 Regular Session', year_start: 2026, year_end: 2026 }
const counter = (base: number) => { const m = new Map<string, number>(); return (k: string) => m.get(k) ?? (m.set(k, base + m.size), base + m.size - 1) }
const ids = (): LisIds => ({ person: counter(3000000200), rollCall: counter(3000000400), doc: counter(3000000600), committee: counter(3000000800) })

/** A session's files as the inventory names their fields: each file's rows by its header, and VOTE.CSV's count line and rows. */
function fields(files: LisFiles): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const file of LIS_FILE_ORDER) {
    if (file === 'votes') {
      const rows: { id: string; pairs: { member: string; vote: string }[] }[] = []
      let count: string | undefined
      forEachCsvRow(files.votes, (row, line) => {
        if (line === 1) { count = row[0]; return }
        const pairs = []
        for (let i = 1; i + 1 < row.length; i += 2) pairs.push({ member: row[i], vote: row[i + 1] })
        rows.push({ id: row[0], pairs })
      })
      out.votes = files.votes ? { count, rows } : { rows }
    } else if (files[file]) {
      out[file] = parseCsvRecords(files[file])
    }
  }
  return out
}

/** A record built by hand from the fields a test cares about. */
function record(number: string, bill: Record<string, string>, history: [string, string, string][]): LisRecord {
  return {
    bill: { Bill_id: number, Bill_description: '', Emergency: 'N', Passed_house: 'N', Passed_senate: 'N', Passed: 'N', Failed: 'N',
      Carried_over: 'N', Approved: 'N', Vetoed: 'N', Chapter_id: '', Introduction_date: '', ...bill },
    history: history.map(h => h.join('\t')).join('\n'),
    sponsors: [], summaries: [], fiscal: [], votes: {}, dockets: [],
  }
}

describe('parseCsv', () => {
  it('keeps text after a closing quote, as Sponsors.csv writes the patron type', () => {
    expect(parseCsv('"Jeion A. Ward   ","H0173","HB1","1" - Chief Patron\n')).toEqual([['Jeion A. Ward   ', 'H0173', 'HB1', '1 - Chief Patron']])
  })

  it('reads quoted commas, doubled quotes and newlines, and trims a spaced header', () => {
    expect(parseCsvRecords('"A", "B"\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([{ A: 'x, y', B: 'say "hi"\nthere' }])
  })

  it('refuses what a file cut short looks like: a quote that never closes, or a row missing fields', () => {
    expect(() => parseCsv('"HB1","Minimum wage; increases\n')).toThrow(/never closes/)
    expect(() => parseCsvRecords('"A","B","C"\n"1","2","3"\n"4","5"\n')).toThrow(/line 3 has 2 fields, not the header's 3/)
    expect(() => parseCsvRecords('"A","B"\n"1","2"\n', ['A', 'C'])).toThrow(/header has no C/)
  })
})

describe('the field inventory', () => {
  it('lists every field of the recorded files', () => {
    expect(inventoryProblems(inventory, [fields(files2026), fields(files2027)], vocabulary)).toEqual([])
  })

  it('fails on a column the LIS adds', () => {
    const changed = { ...files2026, members: '"MBR_HOU","MBR_MBRNO","MBR_NAME","MBR_DISTRICT"\n"H","H0386","Jessica L. Anderson","51"\n' }
    expect(inventoryProblems(inventory, [fields(changed)])).toEqual(['not in the inventory: members[].MBR_DISTRICT'])
  })

  it('feeds every extra but the summaries, which come by their type from one column', () => {
    expect(unfedExtras(vocabulary, inventory)).toEqual(['summaryIntroduced', 'summaryPassed', 'summaryPassedHouse', 'summaryPassedSenate'])
  })
})

describe('LisAssembler', () => {
  it('joins every file into one record per bill', () => {
    expect([...y2026.records.keys()].sort()).toEqual(['HB1', 'HB133', 'HB447', 'HB61', 'HB9', 'HR1'])
    const hb1 = y2026.records.get('HB1')!
    expect(hb1.sponsors[0]).toEqual(['H0173', 'Jeion A. Ward', '1 - Chief Patron'])
    expect(lisHistory(hb1)[0]).toEqual(['2025-11-17', 'H Prefiled and ordered printed; Offered 01-14-2026 26101997D', '26101997D'])
    expect(hb1.summaries.map(s => s[0])).toEqual(['SUMMARY AS INTRODUCED', 'SUMMARY AS PASSED'])
    expect(hb1.summaries[0][1]).toMatch(/^Minimum wage\. Increases the minimum wage/)
    expect(hb1.summaries.every(s => !/[<>]/.test(s[1]))).toBe(true)
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

  it('fails on a file shaped differently, naming it', () => {
    const a = new LisAssembler('20261', files2026.bills)
    expect(() => a.add('history', 'Bill_id,History_date,History_description\n"HB1","1/1/2026","x"\n')).toThrow('LIS 20261 history: the header has no History_refid')
    expect(() => a.add('votes', '"10458X"\n"H14V2610034","H0173","Y","H0297"\n')).toThrow('LIS 20261 votes: line 2 has a member without a vote')
    expect(() => a.add('votes', '"10458X"\n"H14V2610034","H0173","Maybe"\n')).toThrow(/votes: line 2 has a vote "Maybe"/)
    expect(() => new LisAssembler('20261', '"Bill_id","Bill_description"\n"HB1","x"\n')).toThrow(/LIS 20261 bills: the header has no Emergency/)
  })

  it('expects votes and fiscal impact statements only once this session\'s history records them', () => {
    expect(assemble('20261', files2026).expects('votes')).toBe(true)
    expect(assemble('20261', files2026).expects('fiscal')).toBe(true)
    // HB9 came over from 2026 with that session's votes in its history, but those stay in 2026's files.
    const continued = '"HB9","2/6/2026","H Continued to next session in Rules (Voice Vote)",""'
    expect(files2027.history).toContain(continued)
    const earlier = '"HB9","1/30/2026","H Fiscal Impact Statement from Department of Planning and Budget (HB9)","HB9F122"\n"HB9","2/2/2026","H Reported from Rules (15-Y 7-N)","H20V2610001"\n'
    const carried = assemble('20271', { ...files2027, history: files2027.history.replace(continued, earlier + continued) })
    expect(carried.expects('votes')).toBe(false)
    expect(carried.expects('fiscal')).toBe(false)
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

  it('uses Virginia\'s own codes, apart from LegiScan\'s and Maryland\'s', () => {
    for (const code of Object.values(LIS_STATUS)) expect(code).toBeGreaterThan(300)
    expect(Object.keys(vocabulary.statuses).map(Number).sort((a, b) => a - b)).toEqual(Object.values(LIS_STATUS).sort((a, b) => a - b))
  })

  it('calls a bill continued into the next session pending there, not continued again', () => {
    expect(lisCarry(y2027.records.get('HB9')!, '20271').into).toMatchObject({ date: '2026-02-06' })
    expect(label('HB9', '20271', y2027)).toBe('Continued from last session')
    // Prefiled in late 2026 for 2027: history from an earlier year, but not carried over.
    expect(lisCarry(y2027.records.get('HB1532')!, '20271').into).toBeNull()
    expect(label('HB1532', '20271', y2027)).toBe('Introduced')
    expect(lisCarry(y2026.records.get('HB9')!, '20261')).toEqual({ into: null, out: true })
  })

  it('reads a bill referred to committee as in committee', () => {
    const rec = record('HB5', {}, [['2026-01-10', 'H Prefiled and ordered printed', ''], ['2026-01-10', 'H Referred to Committee on Rules', 'H20']])
    expect(vocabulary.statuses[lisStatus(rec, '20261')].label).toBe('In committee')
  })

  it('keeps a carried-over bill\'s progress in its new session', () => {
    // The 2026 budget, continued from the regular session into Special Session I, then passed there.
    const history: [string, string, string][] = [
      ['2025-12-17', 'H Prefiled and ordered printed', ''],
      ['2026-03-14', 'H Continued to 2026 Sp. Sess. 1 pursuant to HJR 316', ''],
      ['2026-05-01', 'H Passed House (60-Y 38-N)', ''],
    ]
    const hb30 = record('HB30', { Carried_over: 'Y', Passed_house: 'Y' }, history)
    expect(vocabulary.statuses[lisStatus(hb30, '20262')].label).toBe('Passed the House')
    expect(vocabulary.statuses[lisStatus(record('HB30', { Carried_over: 'Y' }, history.slice(0, 2)), '20262')].label).toBe('Continued from last session')
  })
})

describe('carry-over', () => {
  it('reads each way the LIS writes a continuation', () => {
    expect(continuationTarget('2026-02-06', 'H Continued to next session in Rules (Voice Vote)')).toBe('20271')
    expect(continuationTarget('2026-02-10', 'H Continued pursuant to House Rule 22 to 2027 in Finance')).toBe('20271')
    expect(continuationTarget('2026-03-14', 'H Continued to 2026 Sp. Sess. 1 pursuant to HJR 316')).toBe('20262')
    expect(continuationTarget('2026-02-02', 'H Subcommittee recommends continuing to  (Voice Vote)')).toBeNull()
    expect(continuationTarget('2026-02-25', 'H Motion for Special and Continuing Order (93-Y 0-N)')).toBeNull()
  })

  it('looks for the earlier copy in every session of the year it was continued, not only the regular one', () => {
    expect(lisCarriedFromCandidates(y2027.records.get('HB9')!, '20271')).toEqual(
      ['20269', '20268', '20267', '20266', '20265', '20264', '20263', '20262', '20261'].map(c => `${c}/HB9`))
    const hb30 = record('HB30', { Carried_over: 'Y' }, [['2026-03-14', 'H Continued to 2026 Sp. Sess. 1 pursuant to HJR 316', '']])
    expect(lisCarriedFromCandidates(hb30, '20262')).toEqual(['20261/HB30'])
    expect(lisCarriedFromCandidates(y2027.records.get('HB1532')!, '20271')).toEqual([])
  })
})

describe('buildLisBill', () => {
  it('builds history, patrons, per-member votes, fiscal statements and dockets', async () => {
    const rec = y2026.records.get('HB1')!
    const b = await buildLisBill(rec, '20261', 3000000101, 'hash', SESSION, ids())
    expect(b).toMatchObject({ bill_number: 'HB1', state: 'VA', status: LIS_STATUS.approved, body: 'H', bill_type: 'B', texts: [] })
    expect(b.title).toBe('Minimum wage; increases incrementally to $15.00 per hour by January 1, 2028.')
    expect(b.description).toBe(rec.summaries[1][1])
    expect(b.state_link).toBe('https://lis.virginia.gov/bill-details/20261/HB1')

    expect(b.history[0]).toMatchObject({ date: '2025-11-17', chamber: 'H', action: 'Prefiled and ordered printed; Offered 01-14-2026 26101997D' })
    expect(b.history.some(h => h.chamber === '' && /Approved by Governor-Chapter 350/.test(h.action))).toBe(true)
    expect(b.referrals[0]).toMatchObject({ chamber: 'H', name: 'Labor and Commerce', committee_id: 3000000800 })
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

  it('refers a bill to one committee per chamber and name', async () => {
    const committee = counter(3000000800)
    const rec = record('SB2', {}, [
      ['2026-01-10', 'S Referred to Committee on Rules', 'S10'],
      ['2026-02-10', 'H Referred to Committee on Rules', 'H20'],
      ['2026-02-20', 'H Referred to Committee on Rules', 'H20'],
    ])
    const b = await buildLisBill(rec, '20261', 1, 'h', SESSION, { ...ids(), committee })
    expect(b.referrals.map(r => [r.chamber, r.name, r.committee_id])).toEqual([
      ['S', 'Rules', 3000000800], ['H', 'Rules', 3000000801], ['H', 'Rules', 3000000801],
    ])
  })

  it('links a carried-over bill to the one it continues', async () => {
    const b = await buildLisBill(y2027.records.get('HB9')!, '20271', 3000000150, 'h', { ...SESSION, year_start: 2027, year_end: 2027 },
      { ...ids(), carriedFrom: 3000000109 })
    expect(b.sasts).toEqual([{ type_id: 4, type: 'Carry Over', sast_bill_number: 'HB9', sast_bill_id: 3000000109 }])
  })

  it('keeps the last action and the latest summary in the masterlist entry', () => {
    const e = toLisMasterListEntry(y2026.records.get('HB1')!, '20261', 1, 'h')
    expect(e).toMatchObject({ number: 'HB1', status: LIS_STATUS.approved, last_action_date: '2026-04-08' })
    expect(e.description).toMatch(/^Minimum wage\./)
    expect(e.last_action).toMatch(/Chapter text \(CHAP0350\)|Approved by Governor/)
  })

  it('reads votes stored compactly', () => {
    expect(parseVotes('H0056N,H0108Y,S0011X')).toEqual([['H0056', 'N'], ['H0108', 'Y'], ['S0011', 'X']])
  })
})

describe('extras', () => {
  it('shows the chapter, and every summary but the latest, as plain text', () => {
    const hb1 = y2026.records.get('HB1')!
    expect(lisExtras(hb1, 2026)).toEqual({
      chapter: 'Chapter 350 of the 2026 Acts of Assembly',
      summaryIntroduced: hb1.summaries[0][1],
    })
    const hb61 = y2026.records.get('HB61')!
    expect(hb61.summaries.map(s => s[0])).toEqual(['SUMMARY AS INTRODUCED', 'SUMMARY AS PASSED HOUSE', 'SUMMARY AS PASSED'])
    expect(lisExtras(hb61, 2026)).toEqual({ summaryIntroduced: hb61.summaries[0][1], summaryPassedHouse: hb61.summaries[1][1] })
    expect(toLisMasterListEntry(hb61, '20261', 1, 'h').description).toBe(hb61.summaries[2][1])
  })

  it('shows the emergency flag only when it is set', () => {
    expect(lisExtras(record('HB5', { Emergency: 'Y' }, []), 2026)).toEqual({ emergency: 'Yes' })
    expect(lisExtras(record('HB5', {}, []), 2026)).toEqual({})
  })

  it('takes the other chamber\'s summary as the later one', () => {
    const sb = { ...record('SB7', {}, []), summaries: [['SUMMARY AS INTRODUCED', 'a'], ['SUMMARY AS PASSED HOUSE', 'c'], ['SUMMARY AS PASSED SENATE', 'b']] as [string, string][] }
    expect(lisExtras(sb, 2026)).toEqual({ summaryIntroduced: 'a', summaryPassedSenate: 'b' })
    expect(toLisMasterListEntry(sb, '20261', 1, 'h').description).toBe('c')
  })

  it('declares each extra the mapping sends', () => {
    for (const key of Object.keys(lisExtras(y2026.records.get('HB1')!, 2026))) expect(vocabulary.extras).toHaveProperty(key)
  })
})
