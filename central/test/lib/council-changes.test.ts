import { describe, it, expect } from 'vitest'
import { diffCommittees, diffTerms, directoryKey, isCurrentMember, linkCommittees, periodMembers, reconcileSeated, rosterSignature, seatNote } from '../../src/lib/council-changes'

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

describe('seated status from the Council\'s page', () => {
  const today = '2026-09-30'
  // Trayon White: expelled 2025-02-04, re-elected; LIMS still ends his term at the expulsion.
  const trayon = { termStart: '2025-01-02', termEnd: '2025-02-04' }

  it('the Council\'s page decides when known; the LIMS term decides otherwise', () => {
    expect(isCurrentMember({ ...trayon, seated: null }, today)).toBe(false)
    expect(isCurrentMember({ ...trayon, seated: 1 }, today)).toBe(true)
    expect(isCurrentMember({ termStart: '2025-01-02', termEnd: '2029-01-02', seated: 0 }, today)).toBe(false)
    expect(isCurrentMember({ termStart: '2025-01-02', termEnd: '2029-01-02' }, today)).toBe(true)
  })

  it('notes where the two disagree', () => {
    expect(seatNote({ ...trayon, seated: 1 }, today)).toBe('Listed as serving on dccouncil.gov. LIMS shows the term ending 2025-02-04.')
    expect(seatNote({ ...trayon, seated: 0 }, today)).toBeNull()
    expect(seatNote({ ...trayon, seated: null }, today)).toBeNull()
    expect(seatNote({ termStart: '2025-01-02', termEnd: '2029-01-02', seated: 0 }, today)).toMatch(/^Not listed/)
  })

  const council = [
    'Phil Mendelson', 'Brianne K. Nadeau', 'Brooke Pinto', 'Matthew Frumin', 'Janeese Lewis George', 'Zachary Parker',
    'Charles Allen', 'Wendell Felder', 'Trayon White, Sr.', 'Anita Bonds', 'Christina Henderson', 'Robert C. White, Jr.', 'Elissa Silverman',
  ]
  const listed = council.map(n => ({ name: n === 'Phil Mendelson' ? 'Chairman Phil Mendelson' : `Ward 8 Councilmember ${n}` }))
  const period = (seated: number | null) => council.map((name, i) => ({
    peopleId: 1_000_000_190 + i, name, termStart: '2025-01-02',
    termEnd: name === 'Trayon White, Sr.' ? '2025-02-04' : '2029-01-02', seated,
  }))

  it('links the page to the current members; the first check reports no changes', () => {
    const r = reconcileSeated([...listed, { name: 'Ward 9 Councilmember Nobody Known' }], period(null), today)!
    expect(r.seatedIds.size).toBe(13)
    expect(r.unlinked).toEqual(['Ward 9 Councilmember Nobody Known'])
    expect(r.changes).toEqual([])
  })

  it('reports a member newly listed, or no longer listed, after the baseline', () => {
    const stored = period(1).map(m => m.name === 'Trayon White, Sr.' ? { ...m, seated: 0 } : m)
    const r = reconcileSeated(listed.filter(l => !/Anita Bonds/.test(l.name)), stored, today)!
    expect(r.changes).toEqual([
      { kind: 'member_listed', committee: null, person: 'Trayon White, Sr.', detail: 'Listed as serving on dccouncil.gov. LIMS shows the term ending 2025-02-04.' },
      { kind: 'member_unlisted', committee: null, person: 'Anita Bonds', detail: expect.stringMatching(/^Not listed/) },
    ])
  })

  it('keeps the stored status when the page links too few names', () => {
    expect(reconcileSeated(listed.slice(0, 9), period(1), today)).toBeNull()
  })
})

describe('periodMembers', () => {
  it('drops the previous period\'s terms and keeps each person\'s latest record', () => {
    const all = [
      { name: 'Trayon White, Sr.', termStart: '2021-01-02', termEnd: '2025-01-01' },
      { name: 'Trayon White, Sr.', termStart: '2025-01-02', termEnd: '2025-02-04' },
      { name: 'Vincent C. Gray', termStart: '2021-01-02', termEnd: '2025-01-01' },
      { name: 'Robert C. White, Jr.', termStart: '2025-01-02', termEnd: '2029-01-02' },
      // A later period's record for the same person, whose old term ends on the new one's first day.
      { name: 'Robert C. White, Jr.', termStart: '2029-01-02', termEnd: '2033-01-02' },
    ]
    expect(periodMembers(all, 2025).map(m => `${m.name} ${m.termStart}`)).toEqual(['Trayon White, Sr. 2025-01-02', 'Robert C. White, Jr. 2029-01-02'])
    expect(periodMembers(all, null)).toHaveLength(3)
  })
})
