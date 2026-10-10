import { describe, it, expect } from 'vitest'
import { billMatchKey, comparableNumber, matchPeople, nameParts, type PersonFacts } from '../../src/lib/cutoverMatch'

// How a cutover matches bills and legislators across two providers. The main
// seam (test/cron/cutover.test.ts) runs DC from LegiScan to LIMS. These cover
// what that fixture can't: Maryland's names-only sponsors, Virginia's
// members with chambers and no districts, and ambiguity.

describe('bill matching', () => {
  it('compares numbers without padding or spaces', () => {
    expect(comparableNumber('HB0001')).toBe('HB1')
    expect(comparableNumber('hb 1')).toBe('HB1')
    expect(comparableNumber('B26-0400')).toBe('B26-400')
  })

  it('keys on the session year, whether the session is special, and the number', () => {
    expect(billMatchKey({ yearStart: 2026, special: 0 }, 'HB0001')).toBe(billMatchKey({ yearStart: 2026, special: 0 }, 'HB 1'))
    expect(billMatchKey({ yearStart: 2026, special: 1 }, 'HB1')).not.toBe(billMatchKey({ yearStart: 2026, special: 0 }, 'HB1'))
    expect(billMatchKey({ yearStart: 2025, special: 0 }, 'HB1')).not.toBe(billMatchKey({ yearStart: 2026, special: 0 }, 'HB1'))
  })
})

describe('reading names', () => {
  it('reads first and last names past titles, suffixes, and the comma form', () => {
    expect(nameParts({ id: 1, name: 'Robert C. White, Jr.' })).toEqual({ first: 'robert', last: 'white' })
    expect(nameParts({ id: 1, name: 'Delegate Long, J.' })).toEqual({ first: 'j', last: 'long' })
    expect(nameParts({ id: 1, name: 'Crosby' })).toEqual({ first: null, last: 'crosby' })
    expect(nameParts({ id: 1, name: 'Janeese Lewis George' })).toEqual({ first: 'janeese', last: 'george' })
    expect(nameParts({ id: 1, name: 'x', firstName: 'Janeese', lastName: 'Lewis-George' })).toEqual({ first: 'janeese', last: 'george' })
  })
})

describe('people matching', () => {
  const legiscan = (id: number, name: string, roleId: 1 | 2, district: string): PersonFacts =>
    ({ id, name, role: roleId === 1 ? 'Rep' : 'Sen', roleId, district })

  it('is strong only when the name, chamber, and district all agree, and a disagreeing district rules a pair out', () => {
    const result = matchPeople(
      [legiscan(1, 'Ann Lee', 1, 'HD-012'), legiscan(2, 'Bo Kim', 1, 'HD-003')],
      [{ id: 101, name: 'Ann Lee', roleId: 1, district: '12' }, { id: 102, name: 'Bo Kim', roleId: 1, district: '4' }],
    )
    expect(result.matched.map(m => [m.from.id, m.to.id, m.on, m.weak])).toEqual([[1, 101, ['name', 'chamber', 'district'], false]])
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([2])
  })

  it('matches Maryland\'s sponsors, named by title and last name, by name and chamber, and flags them weak', () => {
    const result = matchPeople(
      [legiscan(1, 'Wanika Fisher', 1, 'HD-47B'), legiscan(2, 'Malcolm Augustine', 2, 'SD-047'), legiscan(3, 'Ariana Kelly', 2, 'SD-016')],
      // As the MGA provider writes its sponsors: the name without the title, and the role.
      [{ id: -1, name: 'Fisher', role: 'Delegate', roleId: 1 }, { id: -2, name: 'Augustine', role: 'Senator', roleId: 2 }],
    )
    expect(result.matched.map(m => [m.from.id, m.to.id, m.name, m.on, m.weak])).toEqual([
      [1, -1, 'last', ['name', 'chamber'], true],
      [2, -2, 'last', ['name', 'chamber'], true],
    ])
  })

  it('matches Virginia\'s members, who have chambers and no districts, by name and chamber', () => {
    const result = matchPeople(
      [legiscan(1, 'John Smith', 2, 'SD-001'), legiscan(2, 'John Smith', 1, 'HD-010')],
      [{ id: 201, name: 'Smith, J.', role: 'Senator', roleId: 2 }],
    )
    expect(result.matched.map(m => [m.from.id, m.to.id, m.name, m.on])).toEqual([[1, 201, 'initial', ['name', 'chamber']]])
  })

  it('leaves a name with two equally good candidates unmatched', () => {
    const result = matchPeople(
      [legiscan(1, 'Pat Smith', 1, 'HD-001'), legiscan(2, 'Lee Smith', 1, 'HD-002')],
      [{ id: -1, name: 'Smith', role: 'Delegate', roleId: 1 }],
    )
    expect(result.matched).toEqual([])
    expect(result.ambiguous.map(a => [a.person.id, a.candidates.map(c => c.id)])).toEqual([[-1, [1, 2]]])
  })

  it('prefers whole names to initials, so two Whites stay apart', () => {
    const result = matchPeople(
      [{ id: 1, name: 'Robert White' }, { id: 2, name: 'Trayon White' }],
      [{ id: 11, name: 'Robert C. White, Jr.' }, { id: 12, name: 'Trayon White, Sr.' }],
    )
    expect(result.matched.map(m => [m.from.id, m.to.id, m.name, m.weak])).toEqual([[1, 11, 'full', true], [2, 12, 'full', true]])
  })
})
