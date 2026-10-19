import { describe, it, expect } from 'vitest'
import { inferReferrals, type CommitteeName } from '../../src/lib/committeeMatch'

// A bill new to central has no referrals until its first getBill, and an untracked
// bill never gets one, so a committee pick reads the masterlist's last action
// instead (#471): "Referred to Senate Judiciary" names the committee by name.
const COMMITTEES: CommitteeName[] = [
  { committeeId: 1, name: 'Judiciary', chamber: 'S' },
  { committeeId: 2, name: 'Judiciary', chamber: 'H' },
  { committeeId: 3, name: 'Health and Human Services', chamber: 'S' },
  { committeeId: 4, name: 'Health', chamber: 'S' },
]

describe('inferReferrals', () => {
  it('reads the committee a referral names, in the chamber the action names', () => {
    expect(inferReferrals('Referred to Senate Judiciary', 'HB 10', COMMITTEES)).toEqual([1])
  })

  it("takes the bill's own chamber when the action names none", () => {
    expect(inferReferrals('Introduced and referred to Judiciary', 'HB 10', COMMITTEES)).toEqual([2])
  })

  it('takes the longest committee name the action holds, not one inside it', () => {
    expect(inferReferrals('Referred to Health and Human Services', 'SB 4', COMMITTEES)).toEqual([3])
  })

  it('reads nothing from an action that refers the bill nowhere', () => {
    expect(inferReferrals('Judiciary hearing scheduled', 'SB 4', COMMITTEES)).toEqual([])
    expect(inferReferrals(null, 'SB 4', COMMITTEES)).toEqual([])
  })

  it('matches a name as whole words, ignoring case', () => {
    expect(inferReferrals('REFERRED TO SENATE JUDICIARY COMMITTEE', 'SB 4', COMMITTEES)).toEqual([1])
    expect(inferReferrals('Referred to Healthcare Workforce', 'SB 4', COMMITTEES)).toEqual([])
  })
})
