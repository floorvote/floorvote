import { describe, it, expect } from 'vitest'
import sampleRaw from '../../fixtures/mga/2026RS-sample.json?raw'
import type { MgaRecord } from '../../../src/providers/mga/client'
import {
  buildMgaBill, mgaBillType, mgaDisplayNumber, mgaRecordHash, mgaSponsorNames, mgaStatus, mgaTextVersions,
  toMgaMasterListEntry, type MgaIds,
} from '../../../src/providers/mga/map'
import { vocabulary } from '../../../src/providers/mga/vocabulary'

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
}

describe('mgaStatus', () => {
  it('reads the stage from the structured fields, not the free-text Status', () => {
    expect(label(rec('SB0002'))).toBe('Introduced')
    expect(label(rec('HB0002'))).toBe('Introduced')
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
    expect(b.status).toBe(3)
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
    })])

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

  it('writes MGA numbers the way LegiScan does', () => {
    expect(mgaDisplayNumber('HB0001')).toBe('HB1')
    expect(mgaDisplayNumber('SJ0010')).toBe('SJ10')
  })
})
