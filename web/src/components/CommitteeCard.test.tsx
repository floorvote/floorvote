import { describe, it, expect } from 'vitest'
import { matchCommittee } from './CommitteeCard'

const committees = [
  { name: 'Committee on Youth Affairs' }, { name: 'Committee of the Whole' },
  { name: 'Committee on the Judiciary and Public Safety' }, { name: 'Committee on Health' },
  { name: 'Committee of the Whole, Subcommittee on Local Business Development' },
]

describe('matchCommittee', () => {
  it('matches Council event titles to the committee holding them', () => {
    expect(matchCommittee(committees, "Youth Affairs roundtable: DYRS' Fifth Rulemaking")?.name).toBe('Committee on Youth Affairs')
    expect(matchCommittee(committees, 'Judiciary and Public Safety hearing: B26-0671')?.name).toBe('Committee on the Judiciary and Public Safety')
    expect(matchCommittee(committees, 'Committee of the Whole meeting: Regular Meeting')?.name).toBe('Committee of the Whole')
    expect(matchCommittee(committees, 'Legislative Meeting: Breakfast Meeting')).toBeNull()
  })
})
