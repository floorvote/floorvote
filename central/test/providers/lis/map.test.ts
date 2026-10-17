import { describe, it, expect } from 'vitest'
import s2026Raw from '../../fixtures/lis/20261-sample.json?raw'
import s2027Raw from '../../fixtures/lis/20271-sample.json?raw'
import { parseCsv, parseCsvRecords, forEachCsvRow } from '../../../src/providers/lis/csv'
import type { LisFiles } from '../../../src/providers/lis/client'
import {
  buildLisBill, continuationTarget, LisAssembler, LIS_FILE_ORDER, lisBillNumber, lisCarriedFromCandidates, lisCarry,
  lisDate, lisExtras, lisHistory, lisRollCallKey, lisStatus, lisVoteHasTally, LIS_STATUS, lisCommitteeKeys, parseVotes, toLisMasterListEntry, type LisIds, type LisRecord,
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

  it('fails on a file cut down to its header, which would rebuild every bill without it', () => {
    const header = (text: string) => text.slice(0, text.indexOf('\n') + 1)
    const check = (changed: Partial<LisFiles>) => () => assemble('20261', { ...files2026, ...changed }).check()
    expect(check({})).not.toThrow()
    expect(check({ history: header(files2026.history) })).toThrow('LIS 20261 history: no rows for any of the bills, so the file is truncated')
    expect(check({ sponsors: header(files2026.sponsors) })).toThrow('LIS 20261 sponsors: no rows for any of the bills')
    expect(check({ votes: header(files2026.votes) })).toThrow('LIS 20261 votes: no rows for the counted votes this session\'s history records')
    expect(check({ fiscal: header(files2026.fiscal) })).toThrow('LIS 20261 fiscal: no rows for the fiscal impact statements')
    // Dockets can be empty, unless the last pass found bills on them.
    const noDockets = assemble('20261', { ...files2026, dockets: header(files2026.dockets) })
    expect(() => noDockets.check()).not.toThrow()
    expect(() => noDockets.check(true)).toThrow('LIS 20261 dockets: no bill is on a docket, though the last pass found some')
    expect(assemble('20261', files2026).docketed).toBe(true)
  })

  it('keeps a summary\'s paragraph breaks', () => {
    const a = new LisAssembler('20261', files2026.bills)
    a.add('summaries', '"SUM_BILNO","SUMMARY_DOCID","SUMMARY_TYPE","SUMMARY_TEXT"\n"HB0001","HB1S","SUMMARY AS INTRODUCED","<p><b>Minimum wage.</b>  Raises it.</p><p>Also   this.</p>"\n')
    expect(a.result().records.get('HB1')!.summaries).toEqual([['SUMMARY AS INTRODUCED', 'Minimum wage. Raises it.\n\nAlso this.']])
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

  it('reads a carried-in bill as pending until it moves, whatever its copied flags say', () => {
    // HB 1238 as the 2027 files carry it: its 2026 flags (passed the House, then
    // defeated in a Senate committee and continued) come along with its history.
    const history: [string, string, string][] = [
      ['2026-02-17', 'H Read third time and passed House (58-Y 36-N 0-A)', '26110413'],
      ['2026-02-18', 'S Referred to Committee on Agriculture, Conservation and Natural Resources', 'S01'],
      ['2026-02-24', 'S Failed to report (defeated) in Agriculture, Conservation and Natural Resources (6-Y 8-N)', 'S1V1968'],
      ['2026-02-24', 'S Continued to next session in Agriculture, Conservation and Natural Resources (11-Y 3-N)', 'S1V1969'],
    ]
    const hb1238 = record('HB1238', { Carried_over: 'Y', Failed: 'Y', Passed_house: 'Y' }, history)
    expect(vocabulary.statuses[lisStatus(hb1238, '20271')].label).toBe('Continued from last session')
    expect(vocabulary.statuses[lisStatus(record('SB228', { Carried_over: 'Y', Failed: 'Y' }, history), '20271')].label)
      .toBe('Continued from last session')
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
    // The regular session first, then the special sessions, latest first: a special session may number from 1 again.
    expect(lisCarriedFromCandidates(y2027.records.get('HB9')!, '20271')).toEqual(
      ['20261', '20269', '20268', '20267', '20266', '20265', '20264', '20263', '20262'].map(c => `${c}/HB9`))
    const hb30 = record('HB30', { Carried_over: 'Y' }, [['2026-03-14', 'H Continued to 2026 Sp. Sess. 1 pursuant to HJR 316', '']])
    expect(lisCarriedFromCandidates(hb30, '20262')).toEqual(['20261/HB30'])
    expect(lisCarriedFromCandidates(y2027.records.get('HB1532')!, '20271')).toEqual([])
  })

  it('looks first in an earlier session the bill\'s own history continued it into', () => {
    // Continued into Special Session I, then on to Special Session II: it came from Special Session I.
    const twice = record('HB30', { Carried_over: 'Y' }, [
      ['2026-03-14', 'H Continued to 2026 Sp. Sess. 1 pursuant to HJR 316', ''],
      ['2026-06-01', 'H Continued to 2026 Sp. Sess. 2 pursuant to HJR 6001', ''],
    ])
    expect(lisCarriedFromCandidates(twice, '20263')[0]).toBe('20262/HB30')
    expect(lisCarriedFromCandidates(twice, '20263')[1]).toBe('20261/HB30')
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

  it('sends an empty calendar only when the pass read a docket file', async () => {
    // 2026 read DOCKET.CSV, and HB9 is on no docket: its calendar is empty, which counts as a pull.
    expect((await buildLisBill(y2026.records.get('HB9')!, '20261', 1, 'h', SESSION, ids())).calendar).toEqual([])
    // 2027 publishes no docket files yet: the calendar says nothing, so nothing is cancelled.
    expect(y2027.records.get('HB9')!.dockets).toBeNull()
    expect((await buildLisBill(y2027.records.get('HB9')!, '20271', 1, 'h', SESSION, ids())).calendar).toBeUndefined()
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

  it('types a master-list row by its prefix, as the full build does, for every Virginia prefix', async () => {
    const expected: Record<string, string> = { HB: 'B', SB: 'B', HJ: 'JR', SJ: 'JR', HR: 'R', SR: 'R' }
    for (const [prefix, type] of Object.entries(expected)) {
      const r = record(`${prefix}12`, {}, [['2026-01-10', 'Prefiled and ordered printed', '']])
      const built = await buildLisBill(r, '20261', 1, 'h', SESSION, ids())
      expect([prefix, toLisMasterListEntry(r, '20261', 1, 'h').bill_type]).toEqual([prefix, type])
      expect([prefix, toLisMasterListEntry(r, '20261', 1, 'h').bill_type]).toEqual([prefix, built.bill_type])
    }
  })

  it('types the sample files\' real rows by prefix', () => {
    const types = Object.fromEntries([...y2026.records].map(([n, r]) => [n, toLisMasterListEntry(r, '20261', 1, 'h').bill_type]))
    expect(types.HB1).toBe('B')
    expect(Object.keys(types).length).toBeGreaterThan(0)
    for (const [n, t] of Object.entries(types)) expect([n, t]).toEqual([n, /^(HJ|SJ)/.test(n) ? 'JR' : /^(HR|SR)/.test(n) ? 'R' : 'B'])
  })

  it('types an unknown prefix as a bill, as the full build does', async () => {
    const r = record('XX7', {}, [])
    expect(toLisMasterListEntry(r, '20261', 1, 'h').bill_type).toBe('B')
    expect((await buildLisBill(r, '20261', 1, 'h', SESSION, ids())).bill_type).toBe('B')
  })

  it('refers a bill to the committees a re-referral and a plain referral name, not only a first referral', async () => {
    const rec = record('SB9', {}, [
      ['2026-01-10', 'S Referred to Committee on Commerce and Labor', 'S02'],
      ['2026-02-23', 'S Reported from Commerce and Labor and rereferred to Finance and Appropriations (8-Y 5-N)', 'S2V1869'],
      ['2026-02-23', 'S Rereferred to Finance and Appropriations', ''],
      ['2026-02-27', 'S Referred from Finance and Appropriations and referred to Rules (Voice Vote)', ''],
      ['2026-02-27', 'S Referred to Rules', ''],
      ['2026-02-28', 'S Rereferred from Rules to Education and Health (Voice Vote)', ''],
      ['2026-02-28', 'S Rereferred to Education and Health', ''],
      // A re-referral can name the committee in full too (SB71 in the 2026 HISTORY.CSV).
      ['2026-03-02', 'S Rereferred to Committee for Courts of Justice', ''],
    ])
    const b = await buildLisBill(rec, '20261', 1, 'h', SESSION, ids())
    // One referral for each line that sends the bill to a committee, and none for the lines that say where it came from.
    expect(b.referrals.map(r => [r.date, r.chamber, r.name])).toEqual([
      ['2026-01-10', 'S', 'Commerce and Labor'],
      ['2026-02-23', 'S', 'Finance and Appropriations'],
      ['2026-02-27', 'S', 'Rules'],
      ['2026-02-28', 'S', 'Education and Health'],
      ['2026-03-02', 'S', 'Courts of Justice'],
    ])
    expect(lisCommitteeKeys(rec)).toEqual(
      ['S/commerce and labor', 'S/finance and appropriations', 'S/rules', 'S/education and health', 'S/courts of justice'])
    expect(vocabulary.statuses[lisStatus(record('SB9', {}, [['2026-01-14', 'H Referred to Rules', '']]), '20261')].label).toBe('In committee')
  })

  it('sets the committee a bill waits in from its latest referral', async () => {
    const pending = async (flags: Record<string, string>, history: [string, string, string][]) => {
      const b = await buildLisBill(record('HB5', flags, history), '20261', 1, 'h', SESSION, ids())
      return b.committee && { name: b.committee.name, chamber: b.committee.chamber, id: b.committee.committee_id, pending: b.pending_committee_id }
    }
    const first: [string, string, string][] = [['2026-01-10', 'H Prefiled and ordered printed', ''], ['2026-01-10', 'H Referred to Committee on Labor and Commerce', 'H14']]
    expect(await pending({}, first)).toMatchObject({ name: 'Labor and Commerce', chamber: 'H' })
    // The id is the committee's own, the one the referral carries.
    const b = await buildLisBill(record('HB5', {}, first), '20261', 1, 'h', SESSION, ids())
    expect(b.pending_committee_id).toBe(b.referrals[0].committee_id)
    expect(b.committee).toMatchObject({ committee_id: b.referrals[0].committee_id })

    // Reported to another committee: the one it was rereferred to, though the report line comes first.
    const moved = [...first,
      ['2026-01-20', 'H Reported from Labor and Commerce and referred to Appropriations (15-Y 7-N)', 'H14V2610034'],
      ['2026-01-20', 'H Referred to Committee on Appropriations', ''],
      ['2026-01-27', 'H Placed on Appropriations Agenda', '5242'],
    ] as [string, string, string][]
    expect(await pending({}, moved)).toMatchObject({ name: 'Appropriations', chamber: 'H' })
    // Rereferred in the other chamber after passing its own: it waits there.
    const senate = [...moved,
      ['2026-02-03', 'H Read third time and passed House (64-Y 34-N 0-A)', '2619916'],
      ['2026-02-04', 'S Referred to Committee on Commerce and Labor', 'S02'],
      ['2026-02-23', 'S Reported from Commerce and Labor and rereferred to Finance and Appropriations (8-Y 5-N)', 'S2V1869'],
      ['2026-02-23', 'S Rereferred to Finance and Appropriations', ''],
    ] as [string, string, string][]
    expect(await pending({ Passed_house: 'Y' }, senate)).toMatchObject({ name: 'Finance and Appropriations', chamber: 'S' })

    // Reported out to the floor: no committee holds it.
    expect(await pending({}, [...first, ['2026-01-20', 'H Reported from Labor and Commerce (15-Y 7-N)', 'H14V2610034']])).toBeNull()
    // Left, defeated, or continued in committee: it is not waiting there.
    expect(await pending({ Failed: 'Y' }, [...first, ['2026-02-10', 'H Left in Labor and Commerce', '']])).toBeNull()
    expect(await pending({ Carried_over: 'Y' }, [...first, ['2026-02-06', 'H Continued to next session in Labor and Commerce (Voice Vote)', '']])).toBeNull()
    // Passed both chambers: done with committees.
    expect(await pending({ Passed_house: 'Y', Passed_senate: 'Y', Passed: 'Y' }, senate)).toBeNull()
    // Recommitted by a floor motion after it was passed by for the day: it is back in that committee.
    const recommitted = [
      ...senate.slice(0, 4),
      ['2026-03-02', 'S Passed by for the day', ''],
      ['2026-03-03', 'S Motion to recommit to Education and Health agreed to', ''],
      ['2026-03-03', 'S Recommitted to Education and Health', ''],
    ] as [string, string, string][]
    expect(await pending({ Passed_house: 'Y' }, recommitted)).toMatchObject({ name: 'Education and Health', chamber: 'S' })
    const back = await buildLisBill(record('HB5', { Passed_house: 'Y' }, recommitted), '20261', 1, 'h', SESSION, ids())
    expect(back.referrals.at(-1)).toMatchObject({ name: 'Education and Health', chamber: 'S' })
    // And out again once the committee reports it.
    expect(await pending({ Passed_house: 'Y' }, [...recommitted, ['2026-03-05', 'S Reported from Education and Health with amendment (14-Y 0-N 1-A)', 'S1V9']])).toBeNull()
    // A bill with no referral has no pending committee.
    expect(await pending({}, [['2026-01-10', 'H Prefiled and ordered printed', '']])).toBeNull()
  })

  it('reads a bill\'s history in date order when finding its pending committee', async () => {
    // The file isn't in date order: the later day's lines come first. Within a day they keep the file's order, report first.
    const rec = record('HB5', {}, [
      ['2026-02-23', 'S Reported from Commerce and Labor and rereferred to Finance and Appropriations (8-Y 5-N)', 'S2V1869'],
      ['2026-02-23', 'S Rereferred to Finance and Appropriations', ''],
      ['2026-01-10', 'S Referred to Committee on Commerce and Labor', 'S02'],
    ])
    expect((await buildLisBill(rec, '20261', 1, 'h', SESSION, ids())).committee).toMatchObject({ name: 'Finance and Appropriations', chamber: 'S' })
  })

  it('keeps a vote\'s id apart for each bill on it, since a block vote carries many bills', async () => {
    const vote = 'H0056Y,H0108Y,H0124N'
    const history: [string, string, string][] = [['2026-02-17', 'H Read third time and passed House (2-Y 1-N 0-A)', 'SHARED']]
    const a = { ...record('HB5', {}, history), votes: { SHARED: vote } }
    const b = { ...record('HB6', {}, history), votes: { SHARED: vote } }
    // Ids come from the id table by the key the provider asks for, so a bill's key must name the bill.
    const table = new Map<string, number>()
    const mint = (key: string) => table.get(key) ?? (table.set(key, 3000000400 + table.size), table.get(key)!)
    const build = (rec: LisRecord) => buildLisBill(rec, '20261', 1, 'h', SESSION,
      { ...ids(), rollCall: refid => mint(lisRollCallKey('20261', rec.bill.Bill_id, refid)) })
    const [va, vb] = [(await build(a)).votes, (await build(b)).votes]
    expect(va).toHaveLength(1)
    expect(vb).toHaveLength(1)
    expect(va[0].roll_call_id).not.toBe(vb[0].roll_call_id)
    // Stable: the same bill and vote ask for the same id every time.
    expect(lisRollCallKey('20261', 'HB5', 'SHARED')).toBe('20261/HB5/SHARED')
    expect(mint(lisRollCallKey('20261', 'HB5', 'SHARED'))).toBe(va[0].roll_call_id)
  })

  it('leaves a voice vote out as a roll call, since no member has a recorded vote', async () => {
    // A block voice vote in the files: the Senate roll, every member "X" (not voting), and no count in the history line.
    const roll = (code: string) => ['S0019', 'S0062', 'S0067', 'S0068'].map(m => `${m}${code}`).join(',')
    const rec: LisRecord = {
      ...record('HB5', {}, [
        ['2026-03-03', 'S Constitutional reading dispensed (on 2nd reading) (40-Y 0-N 0-A)', 'SV866'],
        ['2026-03-03', 'S Passed by for the day  Block Vote (Voice Vote)', 'VSV1094'],
        ['2026-03-04', 'S Committee substitute agreed to (Voice Vote)', 'VSV1095'],
        ['2026-03-04', 'S Passed Senate (21-Y 19-N 0-A)', 'SV899'],
      ]),
      votes: { SV866: roll('Y'), VSV1094: roll('X'), VSV1095: roll('X'), SV899: 'S0019Y,S0062N,S0067N,S0068X' },
    }
    expect(lisVoteHasTally(rec.votes.VSV1094)).toBe(false)
    expect(lisVoteHasTally(rec.votes.SV866)).toBe(true)
    expect(lisVoteHasTally('S0019X,S0062A')).toBe(true)

    const b = await buildLisBill(rec, '20261', 1, 'h', SESSION, ids())
    // Only the counted votes are roll calls, and none is a 0-0 vote that failed.
    expect(b.votes.map(v => v.desc)).toEqual(['Constitutional reading dispensed (on 2nd reading) (40-Y 0-N 0-A)', 'Passed Senate (21-Y 19-N 0-A)'])
    expect(b.votes.every(v => v.yea + v.nay > 0 && v.member_votes!.length > 0)).toBe(true)
    // The voice votes are still in the history.
    expect(b.history.map(h => h.action)).toEqual(expect.arrayContaining(['Passed by for the day  Block Vote (Voice Vote)', 'Committee substitute agreed to (Voice Vote)']))
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
