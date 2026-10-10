import { describe, it, expect } from 'vitest'
import sampleRaw from '../../fixtures/mga/2026RS-sample.json?raw'
import type { MgaRecord } from '../../../src/providers/mga/client'
import {
  assignMgaCommitteeIds, buildMgaBill, MGA_STATUS, mgaCommitteeKey, mgaPersonKey, mgaBillType, mgaDisplayNumber, mgaDocKeys, mgaRecordHash, mgaSponsorNames, mgaStatus, mgaTextVersions,
  toMgaMasterListEntry, type MgaIds,
} from '../../../src/providers/mga/map'
import { vocabulary } from '../../../src/providers/mga/vocabulary'
import { recordInventory } from '../../../src/providers/mga/inventory'
import { inventoryProblems, unfedExtras } from '../../helpers/fieldInventory'

// Real records from https://mgaleg.maryland.gov/2026RS/misc/billsmasterlist/legislation.json
const sample = new Map((JSON.parse(sampleRaw) as MgaRecord[]).map(r => [r.BillNumber, r]))
const rec = (n: string) => structuredClone(sample.get(n)!)
const label = (r: MgaRecord) => vocabulary.statuses[mgaStatus(r)].label

const SESSION = { session_id: 3000000001, session_name: '2026 Regular Session', year_start: 2026, year_end: 2026 }
const counter = (base: number) => { const m = new Map<string, number>(); return (k: string) => m.get(k) ?? (m.set(k, base + m.size), base + m.size - 1) }
const ids: MgaIds = {
  bill: n => (n === 'SB0002' ? 3000000102 : undefined),
  person: counter(3000000200),
  doc: counter(3000000300),
  subject: counter(3000000400),
}

describe('the MGA field inventory', () => {
  it('lists every field of the recorded records', () => {
    expect(inventoryProblems(recordInventory, [...sample.values()], vocabulary)).toEqual([])
  })

  it('fails when the MGA sends a field nobody has decided about', () => {
    const r = { ...rec('HB0001'), FiscalNoteUrl: 'https://mgaleg.maryland.gov/2026RS/fnotes/bil_0001/hb0001.pdf' }
    expect(inventoryProblems(recordInventory, [r], vocabulary)).toEqual(['not in the inventory: FiscalNoteUrl'])
  })

  it('feeds every extra but the chapter, which the status reads too', () => {
    // ChapterNumber is listed as mapped, since it also decides the status.
    expect(unfedExtras(vocabulary, recordInventory)).toEqual(['chapter'])
  })
})

describe('mgaStatus', () => {
  it('reads the stage from the structured fields, not the free-text Status', () => {
    expect(label(rec('SB0002'))).toBe('In committee')
    expect(label(rec('HB0002'))).toBe('In committee')
    expect(label(rec('HB0001'))).toBe('Passed the House')
    expect(label(rec('HB0014'))).toBe('Approved by the Governor')
    expect(label(rec('HJ0005'))).toBe('Adopted')
    expect(label(rec('HB0039'))).toBe('Withdrawn')
  })

  it('names how an act became law, and a veto', () => {
    const r = rec('HB0014')
    r.Status = 'Enacted under Article II, Section 17(c) of the Maryland Constitution - Chapter 12'
    expect(label(r)).toBe("Enacted without the Governor's signature")
    r.Status = 'Gubernatorial Veto Override (Legislative date: 12/16/2026) - Chapter 2'
    expect(label(r)).toBe("Enacted over the Governor's veto")
    r.Status = 'Assigned a chapter number, enactment subject to constitutional referendum - Chapter 9'
    expect(label(r)).toBe('Enacted, subject to referendum')
    r.Status = 'Vetoed by the Governor (Policy)'
    r.ChapterNumber = ''
    expect(label(r)).toBe('Vetoed by the Governor')
    r.Status = 'Returned Passed'
    expect(label(r)).toBe('Passed the General Assembly')
  })

  it('calls a passed bill back on the floor over a veto vetoed', () => {
    const r = rec('HB0014')
    r.ChapterNumber = ''
    r.Status = 'In the House - Motion Special Order vote on veto until next session (Delegate Moon) Adopted'
    expect(label(r)).toBe('Vetoed by the Governor')
    r.Status = 'In the Senate - Motion Postpone Indefinitely (Senator King) Adopted'
    expect(label(r)).toBe('Vetoed by the Governor')
  })

  it('reads a committee report, a failed vote, and a resolution\'s adoption from the structured fields', () => {
    const reported = rec('SB0002')
    reported.ReportDateHouseOfOrigin = '2026-02-10'
    reported.ReportActionHouseOfOrigin = 'Favorable with Amendments'
    expect(label(reported)).toBe('Reported favorably')

    const failed = rec('HB0001')
    failed.ThirdReadingActionOppositeHouse = 'Failed'
    expect(label(failed)).toBe('Failed')

    // A joint resolution's number sits in the chapter field, and a resolution is done once its chamber adopts it.
    const jr = rec('HJ0005')
    jr.Status = 'Passed Enrolled'
    expect(label(jr)).toBe('Adopted')
    const hr = { ...rec('SB0002'), BillNumber: 'HR0004', Status: 'In the House - Adopted', ThirdReadingActionHouseOfOrigin: 'Adopted' }
    expect(label(hr)).toBe('Adopted')
    // The same reading action on a bill means nothing on its own.
    expect(label({ ...hr, BillNumber: 'HB0004' })).toBe('In committee')
  })

  it('reads a resolution\'s adoption from the status text when the reading fields are empty', () => {
    const hr = { ...rec('SB0002'), BillNumber: 'SR0002', Status: 'In the Senate - Adopted' }
    expect(label(hr)).toBe('Adopted')
  })

  it('reads Withdrawn only as an action of its own, not inside another action\'s text', () => {
    const r = rec('HB0001')
    r.Status = 'In the Senate - Third Reading Passed (Amendment 123456/1 Withdrawn)'
    expect(label(r)).toBe('Passed the House')
    r.Status = 'In the House - Withdrawn by Sponsor'
    expect(label(r)).toBe('Withdrawn')
  })

  it('writes Maryland\'s own codes, never LegiScan\'s', () => {
    for (const code of Object.values(MGA_STATUS)) {
      expect(code).toBeGreaterThan(200)
      expect(vocabulary.statuses[code], String(code)).toBeDefined()
    }
    expect(Object.keys(vocabulary.statuses).map(Number).sort((a, b) => a - b)).toEqual(Object.values(MGA_STATUS))
  })

  it('calls a bill with no first reading pre-filed', () => {
    const r = rec('HB0002')
    r.FirstReadingDateHouseOfOrigin = null
    expect(label(r)).toBe('Pre-filed')
  })
})

describe('mgaRecordHash', () => {
  it('ignores the file timestamp, which moves on every regeneration', async () => {
    const a = rec('HB0001')
    const b = { ...a, StatusCurrentAsOf: '2027-01-01T00:00:00' }
    expect(await mgaRecordHash(b)).toBe(await mgaRecordHash(a))
    expect(await mgaRecordHash({ ...a, Status: 'In the Senate - Hearing 3/01 at 1:00 p.m.' })).not.toBe(await mgaRecordHash(a))
  })
})

describe('toMgaMasterListEntry', () => {
  it('keeps the free-text Status as the last action, and leaves a Governor outcome undated', () => {
    const e = toMgaMasterListEntry(rec('HB0001'), '2026RS', 1, 'h', null)
    expect(e.number).toBe('HB1')
    expect(e.last_action).toBe('In the Senate - First Reading Education, Energy, and the Environment')
    expect(e.last_action_date).toBe('2026-02-07')
    expect(e.state_link).toBe('https://mgaleg.maryland.gov/mgawebsite/Legislation/Details/hb0001?ys=2026RS')

    const enacted = toMgaMasterListEntry(rec('HB0014'), '2026RS', 2, 'h', null)
    expect(enacted.last_action).toBe('Approved by the Governor - Chapter 775')
    expect(enacted.last_action_date).toBeUndefined()
  })
})

describe('buildMgaBill', () => {
  it('builds history, texts, the fiscal note, hearings, sponsors and the cross-file', async () => {
    const b = await buildMgaBill(rec('HB0001'), '2026RS', 3000000101, 'hash', SESSION, ids)
    expect(b.bill_number).toBe('HB1')
    expect(b.state).toBe('MD')
    expect(b.status).toBe(MGA_STATUS.passedHouse)
    expect(b.body).toBe('H')
    expect(b.current_body).toBe('S')

    expect(b.history.map(h => `${h.date} ${h.chamber} ${h.action}`)).toEqual([
      '2026-01-14 H First Reading Environment and Transportation',
      '2026-02-02 H Favorable with Amendments Report by Environment and Transportation',
      '2026-02-05 H Second Reading Passed with Amendments',
      '2026-02-06 H Third Reading Passed',
      '2026-02-07 S First Reading Education, Energy, and the Environment',
    ])

    expect(mgaTextVersions(rec('HB0001'))).toEqual(['F', 'T'])
    expect(b.texts.map(t => [t.type, t.state_link])).toEqual([
      ['First Reader', 'https://mgaleg.maryland.gov/2026RS/bills/hb/hb0001F.pdf'],
      ['Third Reader', 'https://mgaleg.maryland.gov/2026RS/bills/hb/hb0001T.pdf'],
    ])
    expect(new Set(b.texts.map(t => t.doc_id)).size).toBe(2)
    expect(b.supplements[0]).toMatchObject({
      type: 'Fiscal Note', state_link: 'https://mgaleg.maryland.gov/2026RS/fnotes/bil_0001/hb0001.pdf',
    })

    expect(b.calendar).toEqual([expect.objectContaining({
      type: 'Hearing', date: '2026-01-28', time: '15:00', description: 'House Environment and Transportation hearing',
      event_id: '2026RS/HB0001/H/primary',
    })])
    expect(b.calendar[0].cancelled).toBeUndefined()

    expect(b.sponsors[0]).toMatchObject({ name: 'Crosby', role: 'Delegate', sponsor_type_id: 1, sponsor_order: 1 })
    expect(b.sponsors.slice(1).every(s => s.sponsor_type_id === 2)).toBe(true)
    expect(b.sasts).toEqual([{ type_id: 1, type: 'Cross-filed', sast_bill_number: 'SB2', sast_bill_id: 3000000102 }])
    expect(b.referrals.map(r => `${r.chamber} ${r.name}`)).toEqual(['H Environment and Transportation', 'S Education, Energy, and the Environment'])
    expect(b.subjects.length).toBeGreaterThan(5)
  })

  it('keeps a committee or officer sponsor whole', async () => {
    const b = await buildMgaBill(rec('HB0218'), '2026RS', 3000000103, 'hash', SESSION, ids)
    expect(b.sponsors[0]).toMatchObject({ name: 'Chair, Environment and Transportation Committee', role: '' })
  })

  it('leaves out the parts of a by-request attribution', () => {
    // HB 224 (2026): "Chair, Appropriations Committee (By Request - Departmental - Human Services)".
    const r = rec('HB0218')
    r.SponsorPrimary = 'Chair, Appropriations Committee'
    r.Sponsors = [{ Name: 'Chair, Appropriations Committee' }, { Name: 'Human Services' }, { Name: 'Departmental' }, { Name: 'Delegate Moon' }]
    expect(mgaSponsorNames(r)).toEqual(['Chair, Appropriations Committee', 'Delegate Moon'])
  })

  it('files a joint resolution as JR and an enacted bill through its enrolled text', async () => {
    expect((await buildMgaBill(rec('HJ0005'), '2026RS', 1, 'h', SESSION, ids)).bill_type).toBe('JR')
    const enacted = await buildMgaBill(rec('HB0014'), '2026RS', 2, 'h', SESSION, ids)
    expect(enacted.texts.map(t => t.type)).toEqual(['First Reader', 'Third Reader', 'Enrolled'])
    expect(enacted.calendar.map(c => `${c.date} ${c.time} ${c.description.split(' ')[0]}`)).toEqual([
      '2026-01-29 13:00 House', '2026-04-01 13:00 Senate',
    ])
  })

  it('types House and Senate resolutions as resolutions, and joint resolutions as joint', async () => {
    // The port typed "HS" (no such prefix) as a resolution, so every House resolution was a bill.
    expect(mgaBillType('HR0001')).toEqual({ type: 'R', typeId: '2' })
    expect(mgaBillType('SR0003')).toEqual({ type: 'R', typeId: '2' })
    expect(mgaBillType('HJ0005')).toEqual({ type: 'JR', typeId: '3' })
    expect(mgaBillType('SB0002')).toEqual({ type: 'B', typeId: '1' })
    const hr = { ...rec('HJ0005'), BillNumber: 'HR0001', CrossfileBillNumber: '', ChapterNumber: '' }
    expect((await buildMgaBill(hr, '2026RS', 1, 'h', SESSION, ids)).bill_type).toBe('R')
  })

  it('sets the chapter, statutes, flags, and the step between chambers as extras', async () => {
    const enacted = await buildMgaBill(rec('HB0014'), '2026RS', 2, 'h', SESSION, ids)
    expect(enacted.extras).toEqual({
      chapter: 'Chapter 775 of 2026',
      statutes: 'Education § 7-424',
      emergency: null,
      constitutionalAmendment: null,
      chamberInteraction: 'Conference Committee Appointed',
    })
    expect((await buildMgaBill(rec('HJ0005'), '2026RS', 1, 'h', SESSION, ids)).extras)
      .toMatchObject({ chapter: 'Joint Resolution 3 of 2026', statutes: null })

    const r = rec('HB0001')
    r.EmergencyBill = true
    r.ConstitutionalAmendment = true
    r.Statutes = [
      { Article: { Code: 'gpu', Title: 'Public Utilities' }, Sections: [{ Section: '4-504' }, { Section: '7-306' }] },
      { Article: { Code: 'gtg', Title: 'Tax - General' }, Sections: [{ Section: '10-207' }] },
    ]
    expect((await buildMgaBill(r, '2026RS', 1, 'h', SESSION, ids)).extras).toMatchObject({
      statutes: 'Public Utilities §§ 4-504, 7-306\nTax - General § 10-207',
      emergency: 'Yes',
      constitutionalAmendment: 'Yes',
      chamberInteraction: null,
    })
  })

  it('names subjects without the index\'s cross-references, broad ones first, each once', async () => {
    const b = await buildMgaBill(rec('HB0001'), '2026RS', 1, 'h', SESSION, ids)
    expect(b.subjects.map(s => s.subject_name)).toEqual([
      'Utility Regulation', 'Committees and Commissions', 'Contracts', 'Plans and Proposals', 'Publications',
      'Public Service Commission', 'Salaries and Compensation', 'Standards and Best Practices', 'Time', 'Utilities',
      'Work, Labor, and Employment',
    ])
    // Ids come from the id table, by kind and code.
    expect(b.subjects[0].subject_id).toBe(ids.subject('broad/c5'))
    expect(b.subjects[1].subject_id).toBe(ids.subject('narrow/commitco'))
  })

  it('gives a bill and a joint resolution a fiscal and policy note, and a resolution none', async () => {
    expect((await buildMgaBill(rec('HJ0005'), '2026RS', 1, 'h', SESSION, ids)).supplements.map(s => s.state_link))
      .toEqual(['https://mgaleg.maryland.gov/2026RS/fnotes/bil_0005/hj0005.pdf'])
    const hr = { ...rec('HJ0005'), BillNumber: 'HR0001', CrossfileBillNumber: '', ChapterNumber: '' }
    expect((await buildMgaBill(hr, '2026RS', 1, 'h', SESSION, ids)).supplements).toEqual([])
    expect(mgaDocKeys('2026RS', hr)).toEqual(['2026RS/HR0001F'])
  })

  it('names the committee a bill waits in, and gives each committee one id per chamber', async () => {
    const mint = counter(3000000500)
    const idTable = async (_kind: string, keys: readonly string[]) => new Map(keys.map(k => [k, mint(k)]))

    // HB 1 passed the House and had its first reading in the Senate: it waits in the Senate committee.
    const hb1 = await buildMgaBill(rec('HB0001'), '2026RS', 1, 'h', SESSION, ids)
    await assignMgaCommitteeIds(hb1, idTable)
    const senate = mint(mgaCommitteeKey('S', 'Education, Energy, and the Environment'))
    expect(hb1.committee).toEqual({ committee_id: senate, chamber: 'S', chamber_id: 0, name: 'Education, Energy, and the Environment' })
    expect(hb1.pending_committee_id).toBe(senate)
    expect(hb1.referrals.map(r => r.committee_id)).toEqual([mint(mgaCommitteeKey('H', 'Environment and Transportation')), senate])

    // Each chamber has a Rules committee, and they're different committees.
    expect(mgaCommitteeKey('H', 'Rules and Executive Nominations')).not.toBe(mgaCommitteeKey('S', 'Rules and Executive Nominations'))
    expect(mgaCommitteeKey('H', ' Ways  and Means')).toBe(mgaCommitteeKey('H', 'ways and means'))

    // SB 2 waits in its own chamber's committee. An enacted bill waits in none.
    const sb2 = await buildMgaBill(rec('SB0002'), '2026RS', 2, 'h', SESSION, ids)
    expect(sb2.committee).toMatchObject({ chamber: 'S', name: 'Education, Energy, and the Environment' })
    const enacted = await buildMgaBill(rec('HB0014'), '2026RS', 3, 'h', SESSION, ids)
    expect(enacted.committee).toBeNull()
    await assignMgaCommitteeIds(enacted, idTable)
    expect(enacted.pending_committee_id).toBe(0)
  })

  it('keeps two hearings whose committees aren\'t named apart', async () => {
    const r = rec('SB0002')
    r.CommitteePrimaryOrigin = ''
    r.HearingDateTimeSecondaryHouseOfOrigin = '2026-02-05T13:00:00'
    const b = await buildMgaBill(r, '2026RS', 1, 'h', SESSION, ids)
    expect(b.calendar.map(c => [c.event_id, c.description])).toEqual([
      ['2026RS/SB0002/S/primary', 'Senate committee hearing'], ['2026RS/SB0002/S/secondary', 'Senate second committee hearing'],
    ])
  })

  it('keys a member by name, and an office by session too', () => {
    expect(mgaPersonKey('2026RS', 'Delegate Long, J.')).toBe('Delegate Long, J.')
    expect(mgaPersonKey('2026RS', 'Speaker')).toBe('2026RS/Speaker')
    expect(mgaPersonKey('2027RS', 'Chair, Appropriations Committee')).toBe('2027RS/Chair, Appropriations Committee')
  })

  it('writes MGA numbers the way LegiScan does', () => {
    expect(mgaDisplayNumber('HB0001')).toBe('HB1')
    expect(mgaDisplayNumber('SJ0010')).toBe('SJ10')
  })
})
