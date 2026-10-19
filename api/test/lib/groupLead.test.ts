import { describe, it, expect } from 'vitest'
import { compareLead, pickLead, type LeadFields } from '../../src/lib/groupLead'

// A companion group's lead (see **Lead bill** in CONTEXT.md): the bill the
// group's list row is about and whose analysis the group shows. One rule picks
// it everywhere: the furthest along (status rank), then the newest bill text,
// then the natural bill number, then the id. Invented bills throughout.

function member(id: string, over: Partial<LeadFields> = {}): LeadFields {
  return { id, billNumber: id.toUpperCase(), statusRank: 100, newestTextDate: null, ...over }
}

const leadOf = (...members: LeadFields[]) => pickLead(members)?.id ?? null

describe('the lead of a companion group', () => {
  it('is the bill furthest along, even when another has a newer text', () => {
    expect(leadOf(
      member('a1', { statusRank: 100, newestTextDate: '2026-09-01' }),
      member('b2', { statusRank: 300, newestTextDate: '2026-01-01' }),
    )).toBe('b2')
  })

  it('is the bill with the newest text when they are equally far along', () => {
    expect(leadOf(
      member('a1', { newestTextDate: '2026-03-01' }),
      member('b2', { newestTextDate: '2026-06-15' }),
    )).toBe('b2')
  })

  it('puts a bill with no texts after one with texts', () => {
    expect(leadOf(
      member('a1', { newestTextDate: null }),
      member('b2', { newestTextDate: '2025-01-01' }),
    )).toBe('b2')
  })

  it('treats an empty text date as no text', () => {
    expect(leadOf(
      member('a1', { newestTextDate: '' }),
      member('b2', { newestTextDate: '2025-01-01' }),
    )).toBe('b2')
  })

  it('is the lower bill number when status and newest text tie, in natural order', () => {
    expect(leadOf(
      member('x', { billNumber: 'HB10', newestTextDate: '2026-02-02' }),
      member('y', { billNumber: 'HB9', newestTextDate: '2026-02-02' }),
    )).toBe('y')
  })

  it('compares the letters before the number first', () => {
    expect(leadOf(member('x', { billNumber: 'SB1' }), member('y', { billNumber: 'HB500' }))).toBe('y')
  })

  it('breaks a full tie by the smaller id', () => {
    expect(leadOf(member('b', { billNumber: 'HB1' }), member('a', { billNumber: 'HB1' }))).toBe('a')
  })

  it('picks the same lead whatever order the members come in', () => {
    const members = [
      member('a1', { statusRank: 200, newestTextDate: '2026-01-01' }),
      member('b2', { statusRank: 200, newestTextDate: '2026-05-01' }),
      member('c3', { statusRank: 100, newestTextDate: '2026-09-01' }),
    ]
    expect(leadOf(...members)).toBe('b2')
    expect(leadOf(...[...members].reverse())).toBe('b2')
    expect([...members].sort(compareLead).map(m => m.id)).toEqual(['b2', 'a1', 'c3'])
  })

  it('is no one for no members', () => {
    expect(pickLead([])).toBeNull()
  })
})
