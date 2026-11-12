import { describe, it, expect, beforeAll, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { appFetch, seedUser, seedSession } from '../helpers'
import { seedFilterFixture } from './billFilterFixture'

// GET /bills/facets?omit= and ?only= (the costly facets on demand). On the largest instance one facets request cost
// about 1.2 s of D1 time, about 40% of it the subject facet (some 14,000 counts returned) and 225 ms more the
// committees, and a few page loads within ten seconds spent the database's budget so that every query failed (D1
// 7429). Those counts are used only by the Subject and Committee controls, so the page leaves them out of its load
// (omit) and asks for them when someone is about to use those controls (only). Either way a facet's counts are the
// ones the full response holds, under the same filter.

type Facets = Record<string, unknown> & { subjectStates?: string[]; hasCommittees?: boolean }

describe('GET /bills/facets, omit and only', () => {
  let token: string

  beforeAll(async () => {
    token = (await seedFilterFixture()).token
  })

  async function facets(qs = '', cookie = `session=${token}`) {
    const res = await appFetch(`http://localhost/api/bills/facets?${qs}`, { headers: { Cookie: cookie } })
    return { status: res.status, body: await res.json() as Facets }
  }

  /** The SQL a facets request prepares. */
  async function statementsFor(qs: string): Promise<string[]> {
    const seen: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => { seen.push(sql); return realPrepare(sql) })
    try {
      expect((await facets(qs)).status).toBe(200)
    } finally {
      spy.mockRestore()
    }
    return seen
  }

  const LAZY_KEYS = ['subject', 'committee', 'committeeInfo']
  const TENANT_KEYS = ['subjectStates', 'billStates', 'hasDrafts', 'hasCommittees']

  it('leaves the omitted facets out and keeps every other count as the full response has it', async () => {
    for (const filter of ['', 'state=NJ', 'status=Passed&match=any&tag=Energy']) {
      const full = (await facets(filter)).body
      const { status, body } = await facets(`${filter}&omit=subject,committee`)
      expect(status).toBe(200)
      for (const key of LAZY_KEYS) expect(body, `${filter}: ${key}`).not.toHaveProperty(key)
      const rest = Object.fromEntries(Object.entries(full).filter(([k]) => !LAZY_KEYS.includes(k)))
      expect(body, filter).toEqual(rest)
    }
  })

  it('prepares no subject or committee count when they are omitted', async () => {
    const sql = await statementsFor('omit=subject,committee')
    expect(sql.filter(s => /bill_subjects bs|bill_committees bc/.test(s))).toEqual([])
  })

  it('answers only the asked-for facets, with the counts the full response has under the same filter', async () => {
    for (const filter of ['', 'state=NJ', 'committee=301&committeeScope=current', 'subject=NJ:Elections']) {
      const full = (await facets(filter)).body
      const both = (await facets(`${filter}&only=subject,committee`)).body
      expect(Object.keys(both).sort(), filter).toEqual([...LAZY_KEYS, ...TENANT_KEYS].filter(k => k in both).sort())
      for (const key of LAZY_KEYS) expect(both[key], `${filter}: ${key}`).toEqual(full[key])
      expect(both.subjectStates).toEqual(full.subjectStates)

      const subject = (await facets(`${filter}&only=subject`)).body
      expect(subject.subject).toEqual(full.subject)
      expect(subject).not.toHaveProperty('committee')
      expect(subject).not.toHaveProperty('status')

      const committee = (await facets(`${filter}&only=committee`)).body
      expect(committee.committee).toEqual(full.committee)
      expect(committee.committeeInfo).toEqual(full.committeeInfo)
      expect(committee).not.toHaveProperty('subject')
    }
  })

  it('prepares only the asked-for facet\'s counts', async () => {
    const sql = await statementsFor('only=subject')
    expect(sql.some(s => /bill_subjects bs/.test(s))).toBe(true)
    expect(sql.filter(s => /bill_committees bc|"m"\."status" AS|json_each\("m"\."group_tags"\)/.test(s))).toEqual([])
  })

  it('says whether the tenant has any committee, whatever the filter and whatever is omitted', async () => {
    expect((await facets('omit=subject,committee')).body.hasCommittees).toBe(true)
    expect((await facets('state=XX&omit=subject,committee')).body.hasCommittees).toBe(true)
    expect((await facets('only=subject')).body.hasCommittees).toBe(true)
    await env.DB.prepare('DELETE FROM bill_committees').run()
    try {
      expect((await facets('omit=subject,committee')).body.hasCommittees).toBe(false)
    } finally {
      await seedFilterFixture().then(f => { token = f.token })
    }
  })

  it('keeps omit and only on the response for a list with nothing in it', async () => {
    // A member with no bills of their own, under My bills: the empty response, built from the same table.
    const member = await seedUser({ role: 'member', email: 'nobills@example.com' })
    const cookie = `session=${await seedSession(member)}`
    const omitted = (await facets('myBills=1&omit=subject,committee', cookie)).body
    for (const key of LAZY_KEYS) expect(omitted).not.toHaveProperty(key)
    expect(omitted).toHaveProperty('status')
    expect(omitted.hasCommittees).toBe(true)
    const only = (await facets('myBills=1&only=subject', cookie)).body
    expect(only.subject).toEqual({})
    expect(only).not.toHaveProperty('status')
  })

  it('refuses a facet name it does not know, and omit together with only', async () => {
    expect((await facets('omit=subjects')).status).toBe(400)
    expect((await facets('only=subject,nope')).status).toBe(400)
    expect((await facets('omit=subject&only=committee')).status).toBe(400)
  })
})
