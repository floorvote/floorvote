import { describe, it, expect } from 'vitest'
import { diffCommittees, diffTerms, directoryKey, isCurrentMember, linkCommittees, rosterSignature } from '../../src/lib/council-changes'

const members = [
  { peopleId: 1000000194, name: 'Zachary Parker', role: 'Councilmember' },
  { peopleId: 1000000195, name: 'Brooke Pinto', role: 'Councilmember' },
  { peopleId: 1000000198, name: 'Robert C. White, Jr.', role: 'Councilmember' },
  { peopleId: 1000000199, name: 'Trayon White, Sr.', role: 'Councilmember' },
]
const roster = (chair: string | null, names: string[], staff: [string, string | null][] = []) => ({
  name: 'Committee on Youth Affairs', chair: chair ? { name: chair } : null,
  members: names.map(name => ({ name })), staff: staff.map(([name, title]) => ({ name, title })),
})

describe('linking dccouncil.gov names to LIMS members', () => {
  it('strips the seat and matches the person, keeping the two Whites apart', () => {
    expect(directoryKey('At-Large Councilmember Robert C. White, Jr.')).toBe(directoryKey('Robert C. White, Jr.'))
    const [c] = linkCommittees([{
      slug: 'youth', name: 'Committee on Youth Affairs', url: 'https://dccouncil.gov/committees/youth/', agencies: [], staff: [],
      chair: { name: 'Ward 5 Councilmember Zachary Parker', url: null },
      members: [{ name: 'At-Large Councilmember Robert C. White, Jr.', url: null }, { name: 'Ward 8 Councilmember Someone New', url: null }],
    }], members)
    expect(c.chair?.peopleId).toBe(1000000194)
    expect(c.members.map(m => m.peopleId)).toEqual([1000000198, null])
  })
})

describe('committee changes', () => {
  it('reports a new chair, members joining and leaving, and staff changes', () => {
    const before = new Map([['youth', roster('Ward 5 Councilmember Zachary Parker', ['Ward 2 Councilmember Brooke Pinto'], [['Thomas Franco', 'Committee Director']])]])
    const after = new Map([['youth', roster('Ward 2 Councilmember Brooke Pinto', ['Ward 5 Councilmember Zachary Parker', 'At-Large Councilmember Robert C. White, Jr.'], [['Thomas Franco', 'Chief of Staff'], ['Allison Bailey', 'Legislative Assistant']])]])
    const changes = diffCommittees(before, after, [])
    expect(changes.map(c => [c.kind, c.person])).toEqual([
      ['chair_changed', 'Ward 2 Councilmember Brooke Pinto'],
      ['member_added', 'Ward 5 Councilmember Zachary Parker'],
      ['member_added', 'At-Large Councilmember Robert C. White, Jr.'],
      ['staff_title', 'Thomas Franco'],
      ['staff_added', 'Allison Bailey'],
    ])
    expect(changes[0].detail).toBe('Previously chaired by Ward 5 Councilmember Zachary Parker.')
  })

  it('reports committees created and dissolved, and nothing for an unchanged roster', () => {
    const r = roster('Ward 5 Councilmember Zachary Parker', [])
    expect(diffCommittees(new Map([['youth', r]]), new Map([['youth', r]]), [])).toEqual([])
    expect(diffCommittees(new Map([['gone', r]]), new Map([['youth', r]]), ['gone']).map(c => c.kind)).toEqual(['committee_added', 'committee_removed'])
  })

  it('gives rosters a signature that ignores member order', () => {
    expect(rosterSignature(roster('A', ['B', 'C']))).toBe(rosterSignature(roster('A', ['C', 'B'])))
    expect(rosterSignature(roster('A', ['B']))).not.toBe(rosterSignature(roster('B', ['A'])))
  })
})

describe('seat changes from LIMS terms', () => {
  const t = (peopleId: number, name: string, termStart: string, termEnd: string) => ({ peopleId, name, termStart, termEnd })
  it('reports a member leaving early and a new member, but nothing on the first run', () => {
    const before = new Map([[1, t(1, 'Kenyan R. McDuffie', '2023-01-02', '2027-01-01')]])
    const after = [t(1, 'Kenyan R. McDuffie', '2023-01-02', '2026-01-05'), t(2, 'Doni Crawford', '2026-01-20', '2026-07-17')]
    expect(diffTerms(before, after, '2026-01-21').map(c => [c.kind, c.person])).toEqual([['member_left', 'Kenyan R. McDuffie'], ['member_joined', 'Doni Crawford']])
    expect(diffTerms(null, after, '2026-01-21')).toEqual([])
  })

  it('tells a current member from a former one', () => {
    expect(isCurrentMember({ termStart: '2023-01-02', termEnd: '2026-01-05' }, '2026-09-30')).toBe(false)
    expect(isCurrentMember({ termStart: '2026-07-15', termEnd: '2026-12-31' }, '2026-09-30')).toBe(true)
    expect(isCurrentMember({ termStart: '2027-01-02', termEnd: '2031-01-02' }, '2026-09-30')).toBe(false)
  })
})
