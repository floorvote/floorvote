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

  it('leaves out every new person one candidate would fit, whatever their order', () => {
    const old = [legiscan(1, 'Pat Smith', 1, 'HD-001')]
    const sponsors = [{ id: -1, name: 'Smith', role: 'Delegate', roleId: 1 }, { id: -2, name: 'Smith', role: 'Delegate', roleId: 1, district: '1' }]
    for (const order of [sponsors, [...sponsors].reverse()]) {
      const result = matchPeople(old, order)
      expect(result.matched).toEqual([])
      expect(result.ambiguous.map(a => a.person.id).sort((a, b) => a - b)).toEqual([-2, -1])
    }
  })

  it('leaves an ambiguous name\'s candidates out of the looser tiers too', () => {
    // The unplaced Pat Smith could be either, so the senator named only "Smith" isn't guessed at.
    const result = matchPeople(
      [legiscan(1, 'Pat Smith', 2, 'SD-001'), legiscan(2, 'Pat Smith', 1, 'HD-002')],
      [{ id: -1, name: 'Pat Smith' }, { id: -2, name: 'Smith', role: 'Senator', roleId: 2 }],
    )
    expect(result.matched).toEqual([])
    expect(result.ambiguous.map(a => [a.person.id, a.candidates.map(c => c.id)])).toEqual([[-1, [1, 2]]])
    expect(result.unmatchedTo.map(p => p.id)).toEqual([-2])
    // Still reported unmatched, so the operator's counts add up.
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([1, 2])
  })

  it('prefers whole names to initials, so two Whites stay apart', () => {
    const result = matchPeople(
      [{ id: 1, name: 'Robert White' }, { id: 2, name: 'Trayon White' }],
      [{ id: 11, name: 'Robert C. White, Jr.' }, { id: 12, name: 'Trayon White, Sr.' }],
    )
    expect(result.matched.map(m => [m.from.id, m.to.id, m.name, m.weak])).toEqual([[1, 11, 'full', true], [2, 12, 'full', true]])
  })
})

// Congress's members carry a Bioguide id in both LegiScan's data and
// Congress's own, so a cutover matches them on it when both records have one.
// Invented people and ids throughout.
describe('people matching by Bioguide id', () => {
  const person = (id: number, name: string, bioguideId: string | null, roleId?: 1 | 2, district?: string): PersonFacts =>
    ({ id, name, bioguideId, ...(roleId ? { role: roleId === 1 ? 'Rep' : 'Sen', roleId } : {}), ...(district !== undefined ? { district } : {}) })
  const summary = (result: ReturnType<typeof matchPeople>) => result.matched.map(m => [m.from.id, m.to.id, m.name, m.on, m.weak])

  it('matches the same Bioguide id strongly, whatever the names say', () => {
    const result = matchPeople(
      [person(1, 'Bob Smith', 'X000001', 1, 'HD-005')],
      [person(101, 'Robert J. Smith Jr.', 'X000001', 1, '5')],
    )
    expect(summary(result)).toEqual([[1, 101, null, ['bioguide'], false]])
    expect(result.unmatchedFrom).toEqual([])
    expect(result.unmatchedTo).toEqual([])
  })

  it('matches on the Bioguide id alone, with no chamber or district check', () => {
    // A member who moved from the House to the Senate, as each provider last saw them.
    const result = matchPeople([person(1, 'Ann Lee', 'X000002', 1, 'HD-003')], [person(101, 'Ann Lee', 'X000002', 2, '7')])
    expect(summary(result)).toEqual([[1, 101, null, ['bioguide'], false]])
  })

  it('matches two at-large members whose districts are spelled differently', () => {
    const result = matchPeople(
      [person(1, 'Cal Ward', 'X000003', 1, '0'), person(2, 'Dot Wynn', 'X000004', 1, '0')],
      [person(101, 'Cal Ward', 'X000003', 1, 'AL'), person(102, 'Dot Wynn', 'X000004', 1, 'AL')],
    )
    expect(summary(result)).toEqual([[1, 101, null, ['bioguide'], false], [2, 102, null, ['bioguide'], false]])
  })

  it('doesn\'t match matching names whose Bioguide ids differ', () => {
    const result = matchPeople([person(1, 'Dee Park', 'X000005', 1, 'HD-002')], [person(101, 'Dee Park', 'X000006', 1, '2')])
    expect(result.matched).toEqual([])
    expect(result.ambiguous).toEqual([])
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([1])
    expect(result.unmatchedTo.map(p => p.id)).toEqual([101])
  })

  it('doesn\'t let a different Bioguide id make a name ambiguous', () => {
    // Without the ids, two Eve Harts would fit the new one, and she'd match no one.
    const result = matchPeople(
      [person(1, 'Eve Hart', 'X000007', 1, 'HD-004'), person(2, 'Eve Hart', null, 1, 'HD-004')],
      [person(101, 'Eve Hart', 'X000008', 1, '4')],
    )
    expect(summary(result)).toEqual([[2, 101, 'full', ['name', 'chamber', 'district'], false]])
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([1])
  })

  it('falls back to names, chamber, and district when one side has no Bioguide id, either way round', () => {
    const result = matchPeople(
      [person(1, 'Fay Moss', 'X000009', 1, 'HD-006'), person(2, 'Gus Lin', null, 2, 'SD-001'), person(3, 'Bob Smith', 'X000010', 1, 'HD-008')],
      [person(101, 'Fay Moss', null, 1, '6'), person(102, 'Gus Lin', 'X000011', 2, '1'), person(103, 'Robert Smith', 'X000010', 1, '8')],
    )
    expect(summary(result)).toEqual([
      [3, 103, null, ['bioguide'], false],
      [1, 101, 'full', ['name', 'chamber', 'district'], false],
      [2, 102, 'full', ['name', 'chamber', 'district'], false],
    ])
  })

  it('still rules out a name match whose district disagrees when one side has no Bioguide id', () => {
    const result = matchPeople([person(1, 'Hal Ito', 'X000012', 1, 'HD-001'), person(2, 'Ike Roe', 'X000013', 1, 'HD-002')],
      [person(101, 'Hal Ito', null, 1, '9'), person(102, 'Ike Roe', 'X000013', 1, '2')])
    expect(summary(result)).toEqual([[2, 102, null, ['bioguide'], false]])
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([1])
    expect(result.unmatchedTo.map(p => p.id)).toEqual([101])
  })

  it('matches no one by a Bioguide id two old people share, and reports them ambiguous', () => {
    // Two rows for one member: the name and district alone would pick the first.
    const result = matchPeople(
      [person(1, 'Gil Ross', 'X000014', 1, 'HD-001'), person(2, 'Gil Ross', 'X000014', 1, 'HD-009')],
      [person(101, 'Gil Ross', 'X000014', 1, '1')],
    )
    expect(result.matched).toEqual([])
    expect(result.ambiguous.map(a => [a.person.id, a.candidates.map(c => c.id)])).toEqual([[101, [1, 2]]])
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([1, 2])
    expect(result.unmatchedTo).toEqual([])
    expect(result.sharedBioguide.map(s => [s.side, s.bioguideId, s.people.map(p => p.id)])).toEqual([['old', 'X000014', [1, 2]]])
  })

  it('matches no one by a Bioguide id two new people share, and reports them ambiguous', () => {
    const result = matchPeople(
      [person(1, 'Joy Ames', 'X000015', 1, 'HD-004')],
      [person(101, 'Joy Ames', 'X000015', 1, '4'), person(102, 'Joyce Ames', 'X000015', 1, '8')],
    )
    expect(result.matched).toEqual([])
    expect(result.ambiguous.map(a => [a.person.id, a.candidates.map(c => c.id)])).toEqual([[101, [1]], [102, [1]]])
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([1])
    expect(result.unmatchedTo).toEqual([])
    expect(result.sharedBioguide.map(s => [s.side, s.bioguideId, s.people.map(p => p.id)])).toEqual([['new', 'X000015', [101, 102]]])
  })

  it('still name-matches people who share a Bioguide id the other side lacks, and flags the id', () => {
    // The id can't tell them apart, but the other side has no id to contest, so the names and districts decide, as before.
    const result = matchPeople(
      [person(1, 'Kim Orr', 'X000016', 1, 'HD-003'), person(2, 'Kim Orr', 'X000016', 1, 'HD-005')],
      [person(101, 'Kim Orr', null, 1, '3')],
    )
    expect(summary(result)).toEqual([[1, 101, 'full', ['name', 'chamber', 'district'], false]])
    expect(result.unmatchedFrom.map(p => p.id)).toEqual([2])
    expect(result.unmatchedTo).toEqual([])
    expect(result.sharedBioguide.map(s => [s.side, s.bioguideId, s.people.map(p => p.id)])).toEqual([['old', 'X000016', [1, 2]]])
  })

  it('still name-matches new people who share a Bioguide id the old side lacks', () => {
    const result = matchPeople(
      [person(1, 'Liv Tate', null, 2, 'SD-002')],
      [person(101, 'Liv Tate', 'X000022', 2, '2'), person(102, 'Olive Tate', 'X000022', 2, '6')],
    )
    expect(summary(result)).toEqual([[1, 101, 'full', ['name', 'chamber', 'district'], false]])
    expect(result.unmatchedTo.map(p => p.id)).toEqual([102])
    expect(result.sharedBioguide.map(s => [s.side, s.bioguideId, s.people.map(p => p.id)])).toEqual([['new', 'X000022', [101, 102]]])
  })

  it('compares Bioguide ids without case or spaces, and treats a blank one as none', () => {
    const result = matchPeople(
      [person(1, 'Lou Vance', ' x000017 ', 1, 'HD-001'), person(2, 'Mo Reyes', '', 1, 'HD-002'), person(3, 'Ned Cole', '', 1, 'HD-003')],
      [person(101, 'Louis Vance', 'X000017', 1, '1'), person(102, 'Mo Reyes', '', 1, '2'), person(103, 'Ned Cole', '  ', 1, '3')],
    )
    expect(summary(result)).toEqual([
      [1, 101, null, ['bioguide'], false],
      [2, 102, 'full', ['name', 'chamber', 'district'], false],
      [3, 103, 'full', ['name', 'chamber', 'district'], false],
    ])
    expect(result.sharedBioguide).toEqual([])
  })

  it('takes a person a Bioguide id matched out of the name comparisons', () => {
    // Without it, two Jo Kims would fit the old one, and she'd match no one.
    const result = matchPeople(
      [person(1, 'Jo Kim', 'X000018', 1, 'HD-001')],
      [person(101, 'Jo Kim', 'X000018', 1, '1'), person(102, 'Jo Kim', null, 1, '1')],
    )
    expect(summary(result)).toEqual([[1, 101, null, ['bioguide'], false]])
    expect(result.ambiguous).toEqual([])
    expect(result.unmatchedTo.map(p => p.id)).toEqual([102])
  })

  it('matches the same way whatever order people are listed in', () => {
    const old = [person(1, 'Pia Shaw', 'X000019', 1, 'HD-001'), person(2, 'Pia Shaw', 'X000019', 1, 'HD-002'), person(3, 'Rex Dunn', 'X000020', 2, 'SD-001'), person(4, 'Sal Ruiz', null, 1, 'HD-004')]
    const next = [person(101, 'Pia Shaw', 'X000019', 1, '1'), person(102, 'Rex A. Dunn', 'X000020', 2, '1'), person(103, 'Sal Ruiz', 'X000021', 1, '4')]
    const outcome = (result: ReturnType<typeof matchPeople>) => ({
      matched: result.matched.map(m => [m.from.id, m.to.id, m.on]).sort(),
      ambiguous: result.ambiguous.map(a => [a.person.id, a.candidates.map(c => c.id).sort()]).sort(),
      unmatchedFrom: result.unmatchedFrom.map(p => p.id).sort(),
      unmatchedTo: result.unmatchedTo.map(p => p.id).sort(),
    })
    const forward = outcome(matchPeople(old, next))
    expect(forward).toEqual({ matched: [[3, 102, ['bioguide']], [4, 103, ['name', 'chamber', 'district']]], ambiguous: [[101, [1, 2]]], unmatchedFrom: [1, 2], unmatchedTo: [] })
    expect(outcome(matchPeople([...old].reverse(), [...next].reverse()))).toEqual(forward)
  })
})
