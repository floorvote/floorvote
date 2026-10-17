import { describe, it, expect } from 'vitest'
import { measureWithCarriedPeople } from '../../src/lib/carriedIds'
import type { CentralMeasure, MeasurePerson } from '../../src/providers'

// A cutover keeps each legislator's person id. A measure's sponsors, the people
// it names (the members who voted on it), and its member votes all come under
// the kept id, so a voter a cutover carried over isn't added a second time.

const person = (people_id: number): MeasurePerson => ({ people_id, name: `Member ${people_id}`, party: 'D', role: 'Rep', role_id: 1, district: '' })

const measure = (over: Partial<CentralMeasure>): CentralMeasure => ({
  sponsors: [], votes: [], ...over,
}) as CentralMeasure

describe('a measure under the person ids a cutover kept', () => {
  const carried = new Map([[101, 7], [102, 8]])

  it('gives the people it names their kept ids, and leaves the rest alone', () => {
    const out = measureWithCarriedPeople(measure({ people: [person(101), person(103), person(102)] }), carried)
    expect(out.people!.map(p => p.people_id)).toEqual([7, 103, 8])
    expect(out.people![0]).toMatchObject({ name: 'Member 101', role: 'Rep' })
  })

  it('moves a voter\'s member vote, a sponsor, and the person row to the same kept id', () => {
    const out = measureWithCarriedPeople(measure({
      people: [person(101)],
      sponsors: [{ people_id: 101 } as any],
      votes: [{ member_votes: [{ people_id: 101, vote_id: 1, vote_text: 'Yea' }, { people_id: null, vote_id: 2, vote_text: 'Nay' }] } as any],
    }), carried)
    expect(out.people![0].people_id).toBe(7)
    expect(out.sponsors[0].people_id).toBe(7)
    expect(out.votes[0].member_votes).toEqual([{ people_id: 7, vote_id: 1, vote_text: 'Yea' }, { people_id: null, vote_id: 2, vote_text: 'Nay' }])
  })

  it('has no people when the measure names none, and is the measure itself when nothing was carried', () => {
    expect(measureWithCarriedPeople(measure({}), carried).people).toBeUndefined()
    const m = measure({ people: [person(101)] })
    expect(measureWithCarriedPeople(m, new Map())).toBe(m)
  })
})
