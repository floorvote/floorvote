import { describe, it, expect } from 'vitest'
import { personRow } from '../../src/lib/people'

describe('personRow and the Bioguide id', () => {
  it('leaves the id undefined when the record carries none, so an upsert keeps a stored one', () => {
    expect(personRow({ people_id: 1, name: 'A' }, null).bioguideId).toBeUndefined()
  })

  it('carries an explicit null, so an upsert clears the stored id', () => {
    expect(personRow({ people_id: 1, name: 'A', bioguide_id: null }, null).bioguideId).toBeNull()
  })

  it('carries a new id', () => {
    expect(personRow({ people_id: 1, name: 'A', bioguide_id: 'T000001' }, null).bioguideId).toBe('T000001')
  })

  it('still turns every other absent field into null, so the row replaces the stored one', () => {
    const row = personRow({ people_id: 1 }, 50)
    expect(row).toMatchObject({
      peopleId: 1, name: '1', stateId: 50, personHash: null, partyId: null, party: null, roleId: null, role: null,
      firstName: null, middleName: null, lastName: null, suffix: null, nickname: null, district: null,
      ftmEid: null, votesmartId: null, opensecretsId: null, knowwhoPid: null, ballotpedia: null,
    })
  })
})
