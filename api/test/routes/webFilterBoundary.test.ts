import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { appFetch } from '../helpers'
import { getDb } from '../../src/db/client'
import { billCustomFieldValues } from '../../src/db/schema'
import { serializeBillFilter } from '../../../shared/billFilter'
import { billsQueryFromSearch, billsApiParams, billsFacetParams } from '../../../web/src/pages/BillList/billsQuery'
import { ALL, AREAS_ID, AREAS_SLUG, CASES, FIELD_ID, FIELD_SLUG, seedFilterFixture } from './billFilterFixture'

// The boundary between the web and the API. For each filter in the fixture's cases, the web reads the filter from
// the Bills page URL and writes what it sends: the list request, the facets request, and the bulk request's
// filter. This test sends exactly those strings to GET /bills, GET /bills/facets, and POST /bills/bulk, and checks
// that the list selects the bills the case names, the bulk edit selects the same ones, and the facets count them.
// So a filter the web writes in a form the API does not read, or reads under another name, fails here.

const DEFS = [
  { id: FIELD_ID, slug: FIELD_SLUG },
  { id: AREAS_ID, slug: AREAS_SLUG },
]

describe('what the web serializes is what the API reads', () => {
  let token: string
  const numberOf = new Map<string, string>()

  const get = (path: string) => appFetch(`http://localhost/api${path}`, { headers: { Cookie: `session=${token}` } })
  const post = (path: string, body: object) => appFetch(`http://localhost/api/bills${path}`, {
    method: 'POST', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  // The web, from the page URL. A custom field in the URL is named by its slug, and the web holds it by its id.
  const web = (urlSearch: string) => {
    const query = billsQueryFromSearch(new URLSearchParams(urlSearch), DEFS)
    return {
      list: `/bills?${billsApiParams(query, 1, 200)}`,
      facets: `/bills/facets?${billsFacetParams(query.filter)}`,
      bulkFilter: serializeBillFilter(query.filter),
    }
  }

  const listed = async (path: string): Promise<{ numbers: string[]; total: number }> => {
    const res = await get(path)
    expect(res.status, path).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string }>; pagination: { total: number } }
    return { numbers: body.bills.map(b => b.billNumber).sort(), total: body.pagination.total }
  }
  const facetsOf = async (path: string) => {
    const res = await get(path)
    expect(res.status, path).toBe(200)
    return await res.json() as { status: Record<string, number>; myBillsCount: number; unvotedCount: number; newMatchesCount: number; draftCount: number }
  }
  // POST /bulk marks the bills it selects, with a field no filter reads.
  const marked = async (filter: string): Promise<string[]> => {
    const db = getDb(env.DB)
    const res = await post('/bulk', { filter, customFields: [{ fieldId: 'f-mark', value: '1' }] })
    expect(res.status).toBe(200)
    const rows = await db.select().from(billCustomFieldValues).where(eq(billCustomFieldValues.fieldId, 'f-mark')).all()
    await db.delete(billCustomFieldValues).where(eq(billCustomFieldValues.fieldId, 'f-mark'))
    expect(rows.length).toBe(((await res.json()) as { updated: number }).updated)
    return rows.map(r => numberOf.get(r.billId)!).sort()
  }

  beforeAll(async () => {
    const seeded = await seedFilterFixture()
    token = seeded.token
    for (const [id, number] of seeded.numberOf) numberOf.set(id, number)
  })

  // The web drops session (it has no control for it), so the API-only session case is not one the web sends.
  describe.each(CASES.filter(c => c.name !== 'session'))('$name', ({ qs, expected }) => {
    it('selects the same bills on GET /bills and POST /bills/bulk as the case names', async () => {
      const sent = web(qs)
      const list = await listed(sent.list)
      expect(list.numbers).toEqual(expected)
      expect(list.total).toBe(expected.length)
      expect(await marked(sent.bulkFilter)).toEqual(expected)
    })

    it('counts them on GET /bills/facets, as it counts the same filter spelled in the URL', async () => {
      const sent = web(qs)
      const counted = await facetsOf(sent.facets)
      expect(counted).toEqual(await facetsOf(`/bills/facets?${qs}`))
      // A facet leaves out its own filter, so the status counts are the bills' only when no status is picked.
      // Under match=any the other filters add bills to the count instead of narrowing it.
      const params = new URLSearchParams(qs)
      if (!params.has('status') && params.get('match') !== 'any') {
        expect(Object.values(counted.status).reduce((a, b) => a + b, 0)).toBe(expected.length)
      }
    })
  })

  it('sends no session from a /bills?session= URL to the list, the facets, or bulk', async () => {
    const sent = web('session=S26')
    expect(sent.list).not.toContain('session')
    expect(sent.facets).not.toContain('session')
    expect(sent.bulkFilter).toBe('')
    expect((await listed(sent.list)).numbers).toEqual(ALL)
    expect(await marked(sent.bulkFilter)).toEqual(ALL)
  })

  it('keeps a custom field in the request by its id, so a list and the prefetch of it share a cache entry', () => {
    expect(web(`cf_${FIELD_SLUG}=Labor`).list).toContain(`cf_${FIELD_ID}=Labor`)
    expect(web(`cf_${FIELD_SLUG}=Labor`).facets).toContain(`cf_${FIELD_ID}=Labor`)
    expect(web(`cf_${FIELD_SLUG}=Labor`).bulkFilter).toBe(`cf_${FIELD_ID}=Labor`)
    expect(web(`cf_${FIELD_ID}=Labor`).list).toBe(web(`cf_${FIELD_SLUG}=Labor`).list)
  })
})
