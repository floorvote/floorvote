import { describe, it, expect } from 'vitest'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'
import detailsHnRaw from '../fixtures/lims/details-HN26-0171.json?raw'
import detailsReprogRaw from '../fixtures/lims/details-REPROG26-0153.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'
import {
  buildLimsBill, bulkHash, limsDate, limsStatusCode, LIMS_STATUS_LABELS, personKey, toMasterListEntry,
  councilPeriodName, indexPeople, type BuildContext, type LimsPerson,
} from '../../src/lib/lims-map'
import { limsBillId, limsPeopleId, isLimsDocId, limsSessionId } from '../../src/lib/lims-ids'
import type { LimsBulkRecord, LimsCouncilMember, LimsLegislationDetails } from '../../src/lib/lims'

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
    expect(LIMS_STATUS_LABELS[105]).toBe('Official Law')
    expect(LIMS_STATUS_LABELS[100]).toBe('Not Applicable')
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
      expect(isLimsDocId(t.doc_id)).toBe(true)
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

  it('puts the hearing and both mark-ups on the calendar', async () => {
    const b = await build('B26-0400', d0400)
    const hearings = b.calendar.filter(c => c.type_id === 1)
    const markups = b.calendar.filter(c => c.type_id === 3)
    expect(hearings.map(h => h.date)).toEqual(['2025-11-13'])
    expect(hearings[0].description).toBe('Public Hearing on B26-0400')
    expect(markups.map(m => m.date)).toEqual(['2026-01-27', '2026-02-23'])
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
  it('drops a hearing LIMS marks cancelled', async () => {
    const cancelled = {
      ...d0400,
      committeeHearing: d0400.committeeHearing!.map(h => ({ ...h, cancellationHearingNotice: 'https://lims.dccouncil.gov/downloads/LIMS/60460/Hearing_Cancellation_Notice/x.pdf?Id=1' })),
    }
    const b = await build('B26-0400', cancelled)
    expect(b.calendar.filter(c => c.type_id === 1)).toEqual([])
  })

  it('tells apart two entries with the same text', async () => {
    const rec = bulk['B26-0400']
    const twice = { ...rec, legislationHistory: [...rec.legislationHistory, { ...rec.legislationHistory[5], actionDate: 'Dec 01, 2025' }] }
    const b = await buildLimsBill(twice, d0400, limsBillId('B26-0400')!, await bulkHash(twice), ctx)
    const descs = b.calendar.filter(c => c.type_id === 1).map(c => c.description)
    expect(new Set(descs).size).toBe(descs.length)
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

  it('drops a hearing a bulk cancellation entry covers when details are unavailable', async () => {
    const rec = {
      ...bulk['PR26-0808'],
      legislationHistory: [
        { legislationNumber: 'PR26-0808', actionDate: 'Oct 10, 2026', actionDescription: 'Roundtable Canceled', downloadURL: '' },
        { legislationNumber: 'PR26-0808', actionDate: 'Oct 15, 2026', actionDescription: 'Roundtable on PR26-0808', downloadURL: '' },
      ],
    }
    const b = await buildLimsBill(rec, null, limsBillId('PR26-0808')!, await bulkHash(rec), ctx)
    expect(b.calendar).toEqual([])
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

  it('keeps the first hearing identity when a second same-text hearing appears', async () => {
    const rec = bulk['B26-0400']
    const before = await build('B26-0400', d0400)
    const twice = { ...rec, legislationHistory: [...rec.legislationHistory, { ...rec.legislationHistory[5], actionDate: 'Dec 01, 2025' }] }
    const after = await buildLimsBill(twice, d0400, limsBillId('B26-0400')!, await bulkHash(twice), ctx)
    const first = before.calendar.find(c => c.type_id === 1)!
    expect(after.calendar.find(c => c.date === first.date)?.description).toBe(first.description)
    expect(after.calendar.find(c => c.date === '2025-12-01')?.description).toBe('Public Hearing on B26-0400 (2)')
  })

  it('does not count a disapproval as passing', async () => {
    const actions = d0400.actions!.filter(a => a.voteDetails).slice(0, 1)
      .map(a => ({ ...a, voteDetails: { ...a.voteDetails!, voteResult: 'Disapproved' } }))
    const b = await build('B26-0400', { ...d0400, actions })
    expect(b.votes[0].passed).toBe(0)
  })
})
