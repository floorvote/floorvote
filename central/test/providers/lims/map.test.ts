import { describe, it, expect } from 'vitest'
import bulkRaw from '../../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../../fixtures/lims/details-B26-0400.json?raw'
import detailsHnRaw from '../../fixtures/lims/details-HN26-0171.json?raw'
import detailsReprogRaw from '../../fixtures/lims/details-REPROG26-0153.json?raw'
import membersRaw from '../../fixtures/lims/members-26.json?raw'
import {
  assignCommitteeIds, buildLimsBill, bulkHash, committeeKey, limsDate, limsStatusCode, personKey, referralParts, toMasterListEntry,
  councilPeriodName, indexPeople, effectiveChangeHash, limsMeasureStatus, limsDeadlines, type BuildContext, type LimsPerson,
} from '../../../src/providers/lims/map'
import { vocabulary } from '../../../src/providers/lims/vocabulary'
import { bulkRecordInventory, detailsInventory } from '../../../src/providers/lims/inventory'
import { limsBillId, limsPeopleId, limsSessionId, LIMS_DOC_ID_BASE } from '../../../src/providers/lims/ids'
import type { LimsBulkRecord, LimsCouncilMember, LimsLegislationDetails } from '../../../src/providers/lims/client'
import { inventoryProblems, unfedExtras } from '../../helpers/fieldInventory'

const bulk = JSON.parse(bulkRaw) as Record<string, LimsBulkRecord>
const d0400 = JSON.parse(details0400Raw) as LimsLegislationDetails
const dHn = JSON.parse(detailsHnRaw) as LimsLegislationDetails
const dReprog = JSON.parse(detailsReprogRaw) as LimsLegislationDetails
const members = JSON.parse(membersRaw) as LimsCouncilMember[]

const TODAY = '2026-09-28'
const people = indexPeople(members.map((m): LimsPerson => ({ peopleId: limsPeopleId(m.id), name: m.name, role: m.title })))
const ctx: BuildContext = {
  session: { session_id: limsSessionId(26), session_name: '2025-2026 Council Period 26', year_start: 2025, year_end: 2026 },
  people,
  today: TODAY,
}

async function build(number: string, details: LimsLegislationDetails | null) {
  const rec = bulk[number]
  return buildLimsBill(rec, details, limsBillId(number)!, await bulkHash(rec), ctx)
}

describe('the LIMS field inventories', () => {
  it('list every field of the recorded BulkData records', () => {
    expect(inventoryProblems(bulkRecordInventory, Object.values(bulk), vocabulary)).toEqual([])
  })

  it('list every field of the recorded LegislationDetails responses', () => {
    expect(inventoryProblems(detailsInventory, [d0400, dHn, dReprog], vocabulary)).toEqual([])
  })

  it('fail when LIMS sends a field nobody has decided about', () => {
    const details = { ...d0400, fiscalImpact: 'none', mayoralReview: { ...d0400.mayoralReview!, pocketVeto: null } }
    expect(inventoryProblems(detailsInventory, [details], vocabulary)).toEqual([
      'not in the inventory: fiscalImpact',
      'not in the inventory: mayoralReview.pocketVeto',
    ])
  })

  it('name a field for every extra the vocabulary declares, and the mapping sets no other', async () => {
    // The resolution number comes only from the bulk record's actResNumber,
    // which is listed as mapped, since it also sets an earlier period's status.
    expect(unfedExtras(vocabulary, bulkRecordInventory, detailsInventory)).toEqual(['resolutionNumber'])
    const b = await build('B26-0400', d0400)
    expect(Object.keys(b.extras!).sort()).toEqual(Object.keys(vocabulary.extras!).sort())
  })
})

describe('every recorded category', () => {
  it('maps to a status and bill type the vocabulary declares', async () => {
    const types = new Set(Object.keys(vocabulary.billTypes).map(t => t.toLowerCase()))
    const details: Record<string, LimsLegislationDetails> = { 'B26-0400': d0400, 'HN26-0171': dHn, 'REPROG26-0153': dReprog }
    const categories = new Set<string>()
    for (const number of Object.keys(bulk)) {
      const b = await build(number, details[number] ?? null)
      categories.add(bulk[number].legislationCategory)
      expect(vocabulary.statuses[b.status], `${number} status ${b.status}`).toBeDefined()
      expect(types.has(b.bill_type.toLowerCase()), `${number} type ${b.bill_type}`).toBe(true)
    }
    expect([...categories].sort()).toEqual(['Bill', 'Grant Budget Modification', 'Oversight Hearing/Roundtable Notice', 'Reprogramming', 'Resolution'])
  })
})

describe('extras', () => {
  it('carry the law and act numbers and the review dates, as YYYY-MM-DD', async () => {
    const b = await build('B26-0400', d0400)
    expect(Object.fromEntries(Object.entries(b.extras!).filter(([, v]) => v !== null))).toEqual({
      lawNumber: 'L26-0129',
      actNumber: 'A26-0309',
      sentToMayor: '2026-04-13',
      mayorDeadline: '2026-04-28',
      signedByMayor: '2026-04-24',
      enacted: '2026-04-24',
      sentToCongress: '2026-04-29',
      lawEffective: '2026-06-11',
    })
  })

  it('carry a withdrawal, a veto, expirations, and a projected law date', async () => {
    const b = await build('B26-0400', {
      ...d0400,
      withdrawnBy: 'Councilmember Parker ',
      withdrawnDate: '2026-02-01T00:00:00',
      mayoralReview: { ...d0400.mayoralReview!, vetoDate: '2026-04-20T00:00:00', expirationDate: '2026-07-23T00:00:00' },
      congressionalReview: { ...d0400.congressionalReview!, lawProjectedDate: '2026-06-10T00:00:00', expirationDate: '2027-01-21T00:00:00' },
    })
    expect(b.extras).toMatchObject({
      withdrawnBy: 'Councilmember Parker', withdrawnOn: '2026-02-01', vetoedByMayor: '2026-04-20',
      actExpires: '2026-07-23', projectedLawDate: '2026-06-10', lawExpires: '2027-01-21',
    })
  })

  it('fall back to the bulk record\'s numbers, and tell an act number from a resolution number', async () => {
    const act = await build('B26-0001', null)
    expect(act.extras).toMatchObject({ actNumber: 'A26-0003', resolutionNumber: null })
    const resolution = await buildLimsBill({ ...bulk['PR26-0808'], actResNumber: 'R26-0190' }, null, limsBillId('PR26-0808')!, 'h', ctx)
    expect(resolution.extras).toMatchObject({ actNumber: null, resolutionNumber: 'R26-0190' })
  })

  it('name who asked for a measure and the committees asked for comments', async () => {
    const b = await build('REPROG26-0153', dReprog)
    expect(b.extras).toMatchObject({ requestedBy: 'Mayor', commentCommittees: 'Youth Affairs' })
  })

  it('leave out values that aren\'t text', async () => {
    const odd = { ...d0400, withdrawnBy: 42, mayoralReview: { ...d0400.mayoralReview!, actNumber: { id: 1 }, signedDate: 'soon' } } as unknown as LimsLegislationDetails
    const b = await build('B26-0400', odd)
    expect(b.extras).toMatchObject({ withdrawnBy: null, actNumber: 'A26-0309', signedByMayor: null })
  })
})

describe('meeting videos', () => {
  it('attach to the history entries they record', async () => {
    const b = await build('B26-0400', d0400)
    expect(b.history.filter(h => h.video_url).map(h => [h.date, h.action])).toEqual([
      ['2025-11-13', 'Public Hearing on B26-0400 View Public Hearing Record'],
      ['2026-01-27', 'Committee Mark-up of B26-0400 by the Youth Affairs Committee'],
      ['2026-02-23', 'Committee Mark-up of B26-0400 by the Judiciary and Public Safety Committee'],
      ['2026-03-03', 'First Reading, CC'],
      ['2026-03-31', 'Final Reading, CC'],
    ])
    expect(b.history.find(h => h.date === '2025-11-13')?.video_url).toBe(d0400.committeeHearing![0].videoLink)
  })

  it('attach to nothing when no history entry records that meeting', async () => {
    const b = await build('B26-0400', { ...d0400, committeeHearing: [{ ...d0400.committeeHearing![0], hearingDate: '2025-11-14T00:00:00' }] })
    expect(b.history.some(h => h.date === '2025-11-13' && h.video_url)).toBe(false)
  })
})

describe('documents', () => {
  it('title a document LIMS gives no title from its file name', async () => {
    const b = await build('B26-0400', d0400)
    expect(b.supplements.filter(s => s.type === 'Other').map(s => s.title).sort())
      .toEqual(['Law Notice 26-129', 'REIA B26-0400 Statutory Neglect Print', 'Request to Agendize'])
  })

  it('keep the signed act from the Mayor\'s review when the history lacks it', async () => {
    const rec = { ...bulk['B26-0400'], legislationHistory: bulk['B26-0400'].legislationHistory.filter(h => !/Signed_Act/.test(h.downloadURL)) }
    const b = await buildLimsBill(rec, d0400, limsBillId('B26-0400')!, 'h', ctx)
    expect(b.texts.find(t => t.type === 'Signed Act')).toMatchObject({ date: '2026-04-24', state_link: d0400.mayoralReview!.signedAct })
  })
})

describe('lims-map helpers', () => {
  it('parses both LIMS date formats', () => {
    expect(limsDate('Oct 06, 2025')).toBe('2025-10-06')
    expect(limsDate('Jan 7, 2026')).toBe('2026-01-07')
    expect(limsDate('2025-11-13T00:00:00')).toBe('2025-11-13')
    expect(limsDate('')).toBeNull()
    expect(limsDate('sometime')).toBeNull()
  })

  it('matches Councilmember names across LIMS surfaces', () => {
    expect(personKey('Parker, Zachary')).toBe(personKey('Zachary Parker'))
    expect(personKey('Doni Crawford ')).toBe('doni crawford')
    expect(personKey('Mendelson, Phil')).toBe(personKey('Phil Mendelson'))
  })

  it('keeps DC statuses distinct and labelled', () => {
    expect(limsStatusCode('Official Law')).toBe(105)
    expect(limsStatusCode('Under Congressional Review ')).toBe(106)
    expect(limsStatusCode('')).toBe(100)
    expect(vocabulary.statuses[105].label).toBe('Official Law')
    expect(vocabulary.statuses[100].label).toBe('Not Applicable')
  })

  it('names Council Periods with a leading year span', () => {
    expect(councilPeriodName({ councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }))
      .toBe('2025-2026 Council Period 26')
  })

  it('hashes bulk records ignoring whitespace but not content', async () => {
    const rec = bulk['B26-0400']
    const h = await bulkHash(rec)
    expect(await bulkHash({ ...rec, title: `  ${rec.title}  ` })).toBe(h)
    const moved = { ...rec, legislationHistory: [...rec.legislationHistory, { ...rec.legislationHistory[0], actionDate: 'Oct 01, 2026' }] }
    expect(await bulkHash(moved)).not.toBe(h)
  })
})

describe('toMasterListEntry', () => {
  it('uses the latest past action, not a future-dated hearing', async () => {
    const rec = bulk['B26-0769']
    const e = toMasterListEntry(rec, limsBillId('B26-0769')!, 'h', null, TODAY)
    expect(e.bill_id).toBe(limsBillId('B26-0769'))
    expect(e.last_action_date! <= TODAY).toBe(true)
    expect(e.last_action).not.toMatch(/^Public Hearing on/)
    expect(e.url).toBeUndefined()
  })

  it('keeps a stored description and uses the committee for hearing notices', () => {
    expect(toMasterListEntry(bulk['B26-0400'], 1, 'h', 'Updates neglect', TODAY).description).toBe('Updates neglect')
    expect(toMasterListEntry(bulk['HN26-0171'], 1, 'h', null, TODAY).description).toBe('Committee on Health')
  })
})

describe('LIMS referrals', () => {
  it('name a committee the same from LegislationDetails and from the BulkData sentence', async () => {
    const names = ['Committee on Youth Affairs', 'Committee on Judiciary and Public Safety']
    expect((await build('B26-0400', d0400)).referrals.map(r => r.name)).toEqual(names)
    expect((await build('B26-0400', null)).referrals.map(r => r.name)).toEqual(names)
    expect((await build('HN26-0171', null)).referrals.map(r => r.name)).toEqual(['Committee on Health'])
    expect((await build('HN26-0171', dHn)).referrals.map(r => r.name)).toEqual(['Committee on Health'])
  })

  it('keep a referral that follows a comments clause', () => {
    expect(referralParts('Committee on Health with comments from the Committee on Housing, and Committee on Transportation and the Environment'))
      .toEqual(['Committee on Health', 'Committee on Transportation and the Environment'])
    expect(referralParts('Retained by the Council with comments from the Committee of the Whole'))
      .toEqual(['Retained by the Council'])
  })

  it('leave out committees asked only for comments', async () => {
    expect((await build('GBM26-0061', null)).referrals.map(r => r.name)).toEqual(['Retained by the Council'])
    expect((await build('REPROG26-0153', null)).referrals.map(r => r.name)).toEqual(['Retained by the Council'])
  })

  it('split and complete each form LIMS writes', () => {
    expect(referralParts('Committee of the Whole')).toEqual(['Committee of the Whole'])
    expect(referralParts('Committee on Health, Committee on Housing, and the Committee of the Whole'))
      .toEqual(['Committee on Health', 'Committee on Housing', 'Committee of the Whole'])
    expect(referralParts('Special Committee on COVID-19 Pandemic Recovery'))
      .toEqual(['Special Committee on COVID-19 Pandemic Recovery'])
    expect(referralParts('Transportation and the Environment')).toEqual(['Committee on Transportation and the Environment'])
    expect(referralParts('Whole')).toEqual(['Committee of the Whole'])
    expect(referralParts('the Whole')).toEqual(['Committee of the Whole'])
    expect(referralParts('')).toEqual([])
    expect(referralParts(null)).toEqual([])
  })

  it('get one central id per committee, whatever the case or spacing, and none for "Retained by the Council"', async () => {
    const asked: string[][] = []
    const ids = async (kind: string, keys: readonly string[]) => {
      expect(kind).toBe('committee')
      asked.push([...keys])
      return new Map(keys.map(k => [k, k === 'committee on youth affairs' ? 3_000_000_001 : 3_000_000_002]))
    }
    const b = await build('B26-0400', { ...d0400, committeesReferredTo: ['Youth  AFFAIRS', 'Judiciary and Public Safety', 'Retained by the Council'] })
    await assignCommitteeIds(b, ids)
    expect(b.referrals.map(r => [r.name, r.committee_id])).toEqual([
      ['Committee on Youth AFFAIRS', 3_000_000_001],
      ['Committee on Judiciary and Public Safety', 3_000_000_002],
      ['Retained by the Council', 0],
    ])
    expect(asked).toEqual([['committee on youth affairs', 'committee on judiciary and public safety']])
    expect(committeeKey(' Committee on  Youth Affairs ')).toBe('committee on youth affairs')
  })
})

describe('buildLimsBill: B26-0400 (bill with full history, details and votes)', () => {
  it('keeps the full bulk history and LegiScan-compatible identity', async () => {
    const b = await build('B26-0400', d0400)
    expect(b.history).toHaveLength(16)
    expect(b.bill_id).toBe(1_012_600_400)
    expect(b.state).toBe('DC')
    expect(b.url).toBe('')
    expect(b.state_link).toBe('https://lims.dccouncil.gov/Legislation/B26-0400')
    expect(b.status).toBe(limsStatusCode('Official Law'))
    expect(b.change_hash).toBe(await bulkHash(bulk['B26-0400']))
    expect(b.description).toMatch(/neglect/i)
  })

  it('maps texts with LIMS doc ids and a non-empty hash (tenants skip AI without one)', async () => {
    const b = await build('B26-0400', d0400)
    const types = b.texts.map(t => t.type)
    expect(types).toEqual(expect.arrayContaining(['Introduced', 'Committee Print', 'Engrossed', 'Enrolled', 'Signed Act']))
    for (const t of b.texts) {
      expect(t.doc_id).toBeGreaterThan(LIMS_DOC_ID_BASE)
      expect(t.text_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(t.state_link).toMatch(/^https:\/\/lims\.dccouncil\.gov\/downloads\//)
    }
    expect(new Set(b.texts.map(t => t.doc_id)).size).toBe(b.texts.length)
  })

  it('files committee reports, hearing records and memos as supplements', async () => {
    const b = await build('B26-0400', d0400)
    const report = b.supplements.find(s => s.type === 'Committee Report')
    expect(report?.type_id).toBe(2)
    expect(b.supplements.some(s => /Hearing Notice/i.test(s.type))).toBe(true)
    expect(b.supplements.some(s => /Memorandum/i.test(s.type))).toBe(true)
  })

  it('puts the hearing, both mark-ups, and the Mayor\'s deadline on the calendar', async () => {
    const b = await build('B26-0400', d0400)
    const hearings = b.calendar.filter(c => c.type_id === 1)
    const markups = b.calendar.filter(c => c.type_id === 3)
    expect(hearings.map(h => h.date)).toEqual(['2025-11-13'])
    expect(hearings[0].description).toBe('Public Hearing on B26-0400')
    expect(markups.map(m => m.date)).toEqual(['2026-01-27', '2026-02-23'])
    expect(b.calendar.filter(c => c.type_id === 10).map(c => [c.type, c.date, c.description])).toEqual([['Deadline', '2026-04-28', "Mayor's response due"]])
    // Every entry's type is one the vocabulary declares, so core can name its kind.
    for (const c of b.calendar) expect(vocabulary.eventTypes[c.type_id], c.description).toBeDefined()
  })

  it('records Councilmember votes with per-member rows', async () => {
    const b = await build('B26-0400', d0400)
    expect(b.votes.length).toBeGreaterThan(0)
    const v = b.votes[0]
    expect(v.member_votes!.length).toBe(v.total)
    expect(v.yea + v.nay + v.nv + v.absent).toBe(v.total)
    expect(v.member_votes!.filter(m => m.people_id !== null).length).toBeGreaterThan(v.total - 2)
    expect(v.passed).toBe(1)
  })

  it('resolves sponsors to Councilmember people ids', async () => {
    const b = await build('B26-0400', d0400)
    expect(b.sponsors.map(s => [s.name, s.sponsor_type_id])).toEqual([['Zachary Parker', 1], ['Anita Bonds', 2]])
  })
})

describe('buildLimsBill: other categories', () => {
  it('makes an oversight hearing notice a calendar item', async () => {
    const b = await build('HN26-0171', dHn)
    expect(b.calendar).toHaveLength(1)
    expect(b.calendar[0]).toMatchObject({ type_id: 1, date: '2026-10-02', location: 'Committee on Health' })
    expect(b.calendar[0].description).toMatch(/Department of Behavioral Health/)
    expect(b.status).toBe(100)
    expect(b.bill_type).toBe('Oversight Hearing/Roundtable Notice')
  })

  it('maps a reprogramming with its request letter and committee', async () => {
    const b = await build('REPROG26-0153', dReprog)
    expect(b.texts.map(t => t.type)).toEqual(['Introduced'])
    expect(b.supplements.some(s => /Memorandum/i.test(s.type))).toBe(true)
    expect(b.referrals.map(r => r.name)).toEqual(['Retained by the Council'])
    expect(b.sponsors[0]?.name).toBe('Phil Mendelson')
  })

  it('builds from bulk alone when details are unavailable', async () => {
    const b = await build('GBM26-0061', null)
    expect(b.history.length).toBe(2)
    expect(b.texts).toHaveLength(1)
    expect(b.sponsors).toEqual([])
  })
})

describe('buildLimsBill: calendar edge cases', () => {
  const CANCELLATION = 'https://lims.dccouncil.gov/downloads/LIMS/60460/Hearing_Cancellation_Notice/x.pdf?Id=1'

  it('marks a hearing LIMS cancelled as cancelled, under its usual text', async () => {
    const cancelled = { ...d0400, committeeHearing: d0400.committeeHearing!.map(h => ({ ...h, cancellationHearingNotice: CANCELLATION })) }
    const b = await build('B26-0400', cancelled)
    expect(b.calendar.filter(c => c.type_id === 1).map(c => [c.date, c.description, c.cancelled])).toEqual([
      ['2025-11-13', 'Public Hearing on B26-0400', true],
    ])
  })

  it('still marks a cancelled hearing that has left the history, from its notice', async () => {
    const rec = { ...bulk['B26-0400'], legislationHistory: bulk['B26-0400'].legislationHistory.filter(h => !/^Public Hearing/.test(h.actionDescription ?? '')) }
    const cancelled = { ...d0400, committeeHearing: d0400.committeeHearing!.map(h => ({ ...h, cancellationHearingNotice: CANCELLATION })) }
    const b = await buildLimsBill(rec, cancelled, limsBillId('B26-0400')!, await bulkHash(rec), ctx)
    expect(b.calendar.filter(c => c.type_id === 1).map(c => [c.date, c.description, c.cancelled])).toEqual([
      ['2025-11-13', 'Public Hearing on B26-0400', true],
    ])
  })

  it('lists two hearings with the same text by their days, numbering neither', async () => {
    const rec = bulk['B26-0400']
    const twice = { ...rec, legislationHistory: [...rec.legislationHistory, { ...rec.legislationHistory[5], actionDate: 'Dec 01, 2025' }] }
    const b = await buildLimsBill(twice, d0400, limsBillId('B26-0400')!, await bulkHash(twice), ctx)
    expect(b.calendar.filter(c => c.type_id === 1).map(c => [c.date, c.description])).toEqual([
      ['2025-11-13', 'Public Hearing on B26-0400'],
      ['2025-12-01', 'Public Hearing on B26-0400'],
    ])
  })
})

describe('deadlines', () => {
  const hist = (n: string, rows: [string, string][]) => rows.map(([actionDate, actionDescription]) => ({ legislationNumber: n, actionDate, actionDescription, downloadURL: '' }))

  it('reads the Mayor\'s due date and an emergency act\'s expiration from the history when details lack them', () => {
    const rec = { legislationSubCategory: 'Emergency Bill', projectedLawDate: null, legislationHistory: hist('B26-0001', [
      ['Jan 23, 2025', 'Transmitted to Mayor, Response Due on Feb 06, 2025'],
      ['Feb 03, 2025', 'Signed by the Mayor and Enacted with Act Number A26-0003, Expires on May 04, 2025'],
      ['Feb 07, 2025', 'Act A26-0003 Published in DC Register Vol 72 and Page 001133, Expires on May 04, 2025'],
    ]) }
    expect(limsDeadlines(rec, null)).toEqual([
      { date: '2025-02-06', description: "Mayor's response due" },
      { date: '2025-05-04', description: 'Emergency act expires' },
    ])
  })

  it('prefers the bulk projected law date to the history, and names a temporary law\'s expiration', () => {
    const rec = { legislationSubCategory: 'Temporary Bill', projectedLawDate: 'Nov 14, 2026', legislationHistory: hist('B26-0174', [
      ['Sep 01, 2026', 'Transmitted to Congress, Projected Law Date is Nov 13, 2026'],
      ['Nov 20, 2026', 'Law L26-0100, Effective from Nov 14, 2026 Published in DC Register Vol 73 and Page 000001, Expires on Jun 27, 2027'],
    ]) }
    expect(limsDeadlines(rec, null)).toEqual([
      { date: '2026-11-14', description: 'Congressional review ends' },
      { date: '2027-06-27', description: 'Temporary law expires' },
    ])
  })

  it('takes the dates the details response\'s reviews state over the history', () => {
    const rec = { legislationSubCategory: 'Temporary Bill', projectedLawDate: null, legislationHistory: hist('B26-0174', [
      ['Sep 01, 2026', 'Transmitted to Mayor, Response Due on Sep 15, 2026'],
    ]) }
    const details = {
      mayoralReview: { ...d0400.mayoralReview!, responseDueDate: '2026-09-16T00:00:00', expirationDate: null },
      congressionalReview: { ...d0400.congressionalReview!, lawProjectedDate: '2026-11-20T00:00:00', expirationDate: '2027-07-01T00:00:00' },
    }
    expect(limsDeadlines(rec, details)).toEqual([
      { date: '2026-09-16', description: "Mayor's response due" },
      { date: '2026-11-20', description: 'Congressional review ends' },
      { date: '2027-07-01', description: 'Temporary law expires' },
    ])
  })

  it('keeps the latest restated date, and finds none for a bill without deadlines', () => {
    const rec = { legislationSubCategory: 'Permanent Bill', projectedLawDate: null, legislationHistory: hist('B26-0400', [
      ['Mar 01, 2026', 'Transmitted to Mayor, Response Due on Mar 15, 2026'],
      ['Mar 20, 2026', 'Transmitted to Mayor, Response Due on Apr 03, 2026'],
    ]) }
    expect(limsDeadlines(rec, null)).toEqual([{ date: '2026-04-03', description: "Mayor's response due" }])
    expect(limsDeadlines({ ...rec, legislationHistory: [] }, null)).toEqual([])
  })
})

describe('review fixes', () => {
  it('puts roundtables and other hearing wordings on the calendar, but not notices or cancellations', async () => {
    const rec = {
      ...bulk['PR26-0808'],
      legislationHistory: [
        { legislationNumber: 'PR26-0808', actionDate: 'Oct 01, 2026', actionDescription: 'Notice of Roundtable filed in the Office of Secretary', downloadURL: '' },
        { legislationNumber: 'PR26-0808', actionDate: 'Oct 15, 2026', actionDescription: 'Roundtable on PR26-0808', downloadURL: '' },
        { legislationNumber: 'PR26-0808', actionDate: 'Oct 16, 2026', actionDescription: 'Oversight Hearing on PR26-0808', downloadURL: '' },
        { legislationNumber: 'PR26-0808', actionDate: 'Oct 17, 2026', actionDescription: 'Roundtable Meeting - PR26-0808', downloadURL: '' },
      ],
    }
    const b = await buildLimsBill(rec, null, limsBillId('PR26-0808')!, await bulkHash(rec), ctx)
    expect(b.calendar.map(c => [c.date, c.description])).toEqual([
      ['2026-10-15', 'Roundtable on PR26-0808'],
      ['2026-10-16', 'Oversight Hearing on PR26-0808'],
      ['2026-10-17', 'Roundtable Meeting - PR26-0808'],
    ])
  })

  it('keeps a rescheduled hearing that follows a bulk cancellation (PR26-0264 pattern)', async () => {
    const rec = {
      ...bulk['PR26-0808'],
      legislationHistory: [
        { legislationNumber: 'PR26-0808', actionDate: 'Sep 18, 2025', actionDescription: 'Cancellation Notice of Roundtable filed in the Office of Secretary', downloadURL: '' },
        { legislationNumber: 'PR26-0808', actionDate: 'Sep 19, 2025', actionDescription: 'Roundtable Canceled', downloadURL: '' },
        { legislationNumber: 'PR26-0808', actionDate: 'Sep 26, 2025', actionDescription: 'Roundtable on PR26-0808 View Roundtable Record', downloadURL: '' },
      ],
    }
    const withDetails = { ...dReprog, committeeHearing: [] }
    for (const d of [null, withDetails]) {
      const b = await buildLimsBill(rec, d, limsBillId('PR26-0808')!, await bulkHash(rec), ctx)
      expect(b.calendar.map(c => [c.date, c.description])).toEqual([['2025-09-26', 'Roundtable on PR26-0808']])
    }
  })

  it('matches Councilmembers whose names carry Jr./Sr. or a middle initial', () => {
    expect(personKey('White, Robert C. Jr.')).toBe(personKey('Robert C. White, Jr.'))
    expect(personKey('White, Trayon Sr.')).toBe(personKey('Trayon White, Sr.'))
    expect(personKey('Kenyan R.  McDuffie')).toBe('kenyan r mcduffie')
  })

  it('resolves sponsor and voter names through the people index', async () => {
    const d = {
      ...d0400,
      introducers: [{ memberName: 'White, Robert C. Jr.', memberTitle: 'Councilmember' }],
      coIntroducers: [{ memberName: 'McDuffie, Kenyan', memberTitle: 'Councilmember' }],
      coSponsors: null,
    }
    const b = await build('B26-0400', d)
    expect(b.sponsors.map(s => s.name)).toEqual(['Robert C. White, Jr.', 'Kenyan R.  McDuffie'])
    const white = b.votes.flatMap(v => v.member_votes!).filter(m => m.people_id === limsPeopleId(members.find(x => x.name.startsWith('Robert'))!.id))
    expect(white.length).toBeGreaterThan(0)
  })

  it('leaves the first hearing as it was when a second same-text hearing appears', async () => {
    const rec = bulk['B26-0400']
    const before = await build('B26-0400', d0400)
    const twice = { ...rec, legislationHistory: [...rec.legislationHistory, { ...rec.legislationHistory[5], actionDate: 'Dec 01, 2025' }] }
    const after = await buildLimsBill(twice, d0400, limsBillId('B26-0400')!, await bulkHash(twice), ctx)
    const first = before.calendar.find(c => c.type_id === 1)!
    expect(after.calendar.find(c => c.date === first.date)).toEqual(first)
  })

  it('does not count a disapproval as passing', async () => {
    const actions = d0400.actions!.filter(a => a.voteDetails).slice(0, 1)
      .map(a => ({ ...a, voteDetails: { ...a.voteDetails!, voteResult: 'Disapproved' } }))
    const b = await build('B26-0400', { ...d0400, actions })
    expect(b.votes[0].passed).toBe(0)
  })
})

describe('effectiveChangeHash', () => {
  it('moves when a future-dated entry passes, and only then', async () => {
    const rec = bulk['B26-0769']   // last entry: Public Hearing on Oct 23, 2026
    const h = await bulkHash(rec)
    const sep28 = await effectiveChangeHash(rec, h, '2026-09-28')
    expect(await effectiveChangeHash(rec, h, '2026-09-29')).toBe(sep28)
    expect(await effectiveChangeHash(rec, h, '2026-10-23')).not.toBe(sep28)
  })

  it('is the plain bulk hash when nothing is future-dated', async () => {
    const rec = bulk['B26-0400']
    const h = await bulkHash(rec)
    expect(await effectiveChangeHash(rec, h, '2026-09-28')).toBe(h)
  })
})

describe('limsMeasureStatus', () => {
  const base = { status: '', lawNumber: null, actResNumber: null }
  it('uses the stated status when there is one', () => {
    expect(limsMeasureStatus({ ...base, status: 'Under Council Review' })).toBe(limsStatusCode('Under Council Review'))
    expect(limsMeasureStatus({ ...base, status: '' }, 'Tabled')).toBe(limsStatusCode('Tabled'))
  })
  it('infers a blank or Not Applicable status from law, act, and resolution numbers (earlier periods)', () => {
    expect(limsMeasureStatus({ ...base, lawNumber: 'L25-0175', actResNumber: 'A25-0415' })).toBe(limsStatusCode('Official Law'))
    expect(limsMeasureStatus({ ...base, actResNumber: 'A25-0400' }, 'Not Applicable')).toBe(limsStatusCode('Enacted'))
    expect(limsMeasureStatus({ ...base, actResNumber: 'R25-0100' })).toBe(limsStatusCode('Approved'))
    expect(limsMeasureStatus(base)).toBe(100)
  })
})
