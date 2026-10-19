import { describe, it, expect, beforeAll } from 'vitest'
import { appFetch } from '../helpers'
import { seedFilterFixture } from './billFilterFixture'

// The Committee filter's counts (#471): each committee's bills under the other filters, as the bill list would
// total them, counted against the bills' current committees or against any referral as the scope says. Beside the
// counts, each committee's name, state, and chamber, which the menu groups and labels them by.

describe('the committee facet', () => {
  let token: string

  beforeAll(async () => {
    token = (await seedFilterFixture()).token
  })

  async function facets(qs = '') {
    const res = await appFetch(`http://localhost/api/bills/facets?${qs}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return await res.json() as { committee: Record<string, number>; committeeInfo: Record<string, unknown> }
  }

  it('counts each committee\'s bills by any referral', async () => {
    expect((await facets()).committee).toEqual({ 101: 2, 102: 1, 201: 1, 301: 1 })
  })

  it('counts only the bills a committee holds now under the current committee scope', async () => {
    expect((await facets('committeeScope=current')).committee).toEqual({ 101: 1, 201: 1, 301: 1 })
  })

  it('narrows the counts by the other filters, and leaves its own out', async () => {
    expect((await facets('state=NJ')).committee).toEqual({ 101: 2, 102: 1 })
    expect((await facets('committee=301')).committee).toEqual({ 101: 2, 102: 1, 201: 1, 301: 1 })
  })

  it('names each committee counted, with its state and chamber', async () => {
    expect((await facets('state=NJ')).committeeInfo).toEqual({
      101: { name: 'Judiciary', state: 'NJ', chamber: 'S' },
      102: { name: 'Rules', state: 'NJ', chamber: 'S' },
    })
  })

  it('names every committee picked, whatever the scope and the other filters leave out', async () => {
    // NJ Rules (102) holds no bill now and is in no TX bill, so it has no count here, but the menu and the chip
    // still need its name to show it picked.
    const body = await facets('committee=102&committeeScope=current&state=TX')
    expect(body.committee).toEqual({ 201: 1 })
    expect(body.committeeInfo).toEqual({
      102: { name: 'Rules', state: 'NJ', chamber: 'S' },
      201: { name: 'State Affairs', state: 'TX', chamber: 'H' },
    })
  })
})
