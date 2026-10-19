import { describe, it, expect, beforeEach } from 'vitest'
import { clearDb, appFetch, stubFetch, seedUser, seedSession } from '../helpers'
import { MAX_SUBJECT_FILTERS as SHARED_MAX_SUBJECT_FILTERS } from '../../../shared/limits'
import { MAX_SUBJECT_FILTERS as API_MAX_SUBJECT_FILTERS } from '../../src/lib/billSubjects'

// The web picker stops at the same number this API rejects past (#692), so the
// number lives in shared/ and both sides import it. These tests pin the API
// half: the limit is the shared constant, and the list and the facets still
// answer 400 one past it. The API behavior itself did not change.

const CAP = SHARED_MAX_SUBJECT_FILTERS
const CAP_ERROR = { error: `Too many subject filters. The maximum is ${CAP}.` }
const query = (n: number) => {
  const qs = new URLSearchParams()
  for (let i = 0; i < n; i++) qs.append('subject', `UT:Subject ${i + 1}`)
  return qs.toString()
}

describe('subject filter cap', () => {
  let token: string

  beforeEach(async () => {
    stubFetch()
    await clearDb()
    token = await seedSession(await seedUser({ role: 'member', email: 'member@example.com' }))
  })

  const get = (path: string, qs: string) =>
    appFetch(`http://localhost/api/bills${path}?${qs}`, { headers: { Cookie: `session=${token}` } })

  it('is 40, defined once in shared/limits', () => {
    expect(CAP).toBe(40)
  })

  it('is the same constant the API reads', () => {
    expect(API_MAX_SUBJECT_FILTERS).toBe(CAP)
  })

  it('answers GET /bills with 400 one past the cap, naming the shared number', async () => {
    const res = await get('', query(CAP + 1))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(CAP_ERROR)
  })

  it('answers GET /bills/facets with 400 one past the cap, naming the shared number', async () => {
    const res = await get('/facets', query(CAP + 1))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(CAP_ERROR)
  })

  it('accepts exactly the cap on the list and on the facets', async () => {
    expect((await get('', query(CAP))).status).toBe(200)
    expect((await get('/facets', query(CAP))).status).toBe(200)
  })
})
