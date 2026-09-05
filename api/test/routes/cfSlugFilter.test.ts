import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'

// Regression: `cf_` query keys are slug-form in the URL (and therefore in every
// stored view's query, since a view persists the URL's own search string), but
// the API used to resolve `cf_` keys only against custom_field_definitions.id.
// A saved view whose query held `cf_<slug>=...` matched nothing — 0 bills, a 0
// count in the views switcher, and (in the multi-cf-param race) sometimes every
// bill instead. See docs from the "cf_ params have two incompatible
// representations" investigation.
describe('GET /bills — cf_ filter accepts slug or id', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'a@e.com' })
    token = await seedSession(adminId)
  })

  async function makeBinaryField(name: string) {
    const res = await SELF.fetch('http://localhost/api/admin/custom-fields', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'binary' }),
    })
    expect(res.status).toBe(201)
    return await res.json() as { id: string; slug: string }
  }

  it('cf_<slug>=1 returns the same bills as cf_<id>=1', async () => {
    const { id: fieldId, slug } = await makeBinaryField('ACET is tracking')
    expect(slug).toBe('acet_is_tracking')

    const tracked = await seedBill({ billNumber: 'T1' })
    await seedBill({ billNumber: 'T2' }) // untouched — no value set

    await SELF.fetch(`http://localhost/api/bills/${tracked}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: '1' }),
    })

    const bySlug = await (await SELF.fetch(`http://localhost/api/bills?cf_${slug}=1`, { headers: { Cookie: `session=${token}` } })).json() as { bills: { billNumber: string }[] }
    const byId = await (await SELF.fetch(`http://localhost/api/bills?cf_${fieldId}=1`, { headers: { Cookie: `session=${token}` } })).json() as { bills: { billNumber: string }[] }

    expect(bySlug.bills.map(b => b.billNumber)).toEqual(['T1'])
    expect(byId.bills.map(b => b.billNumber)).toEqual(bySlug.bills.map(b => b.billNumber))
  })

  it('an unknown cf_ key matches nothing rather than being silently dropped', async () => {
    // No custom fields exist at all — a stale/garbled cf_ key must still
    // narrow to zero bills rather than the filter being ignored (which would
    // return every bill, unfiltered — the "sometimes all 83,000" symptom).
    await seedBill({ billNumber: 'U1' })
    await seedBill({ billNumber: 'U2' })

    const res = await (await SELF.fetch('http://localhost/api/bills?cf_does-not-exist=1', { headers: { Cookie: `session=${token}` } })).json() as { bills: unknown[] }
    expect(res.bills).toEqual([])
  })

  it('a saved view whose stored query uses the slug form reports a correct non-zero count', async () => {
    const { id: fieldId, slug } = await makeBinaryField('ACET is tracking')
    const tracked = await seedBill({ billNumber: 'V1', state: 'CA' })
    await seedBill({ billNumber: 'V2', state: 'CA' }) // no cf value — excluded

    await SELF.fetch(`http://localhost/api/bills/${tracked}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: '1' }),
    })

    // Mirrors what ViewSwitcher fetches for a view's count badge: the view's
    // stored query (slug form, since it was captured from the URL) plus pageSize=1.
    const storedViewQuery = `cf_${slug}=1&state=CA`
    const res = await (await SELF.fetch(`http://localhost/api/bills?${storedViewQuery}&pageSize=1`, { headers: { Cookie: `session=${token}` } })).json() as { pagination: { total: number } }
    expect(res.pagination.total).toBe(1)
  })
})
