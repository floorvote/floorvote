import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { app } from '../../src/index'
import { customFieldDefinitions, billCustomFieldValues } from '../../src/db/schema'

// Law under test: while a custom-field filter is active, every OTHER facet's
// count for a value equals the list total with that value added to the filter.
// The facet query and the list query must therefore match a custom field's
// stored value the same way. A multi-select field stores a JSON array, so the
// list matches individual array elements; a facet that compared the raw array
// string would drop every other facet's counts to zero.

type Facets = {
  status: Record<string, number>
  priority: Record<string, number>
  field: Record<string, Record<string, number>>
}

describe('facet counts under an active custom-field filter', () => {
  let token: string
  const MULTI = 'cf-multi'
  const SINGLE = 'cf-single'
  const TEXT = 'cf-text'
  const SLUGS: Record<string, string> = { [MULTI]: 'areas', [SINGLE]: 'stage', [TEXT]: 'owner' }

  beforeAll(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)
    const db = getDb(env.DB)

    await db.insert(customFieldDefinitions).values([
      { id: MULTI, name: 'Areas', slug: SLUGS[MULTI], type: 'dropdown', options: JSON.stringify(['a', 'b', 'c']), multiple: true },
      { id: SINGLE, name: 'Stage', slug: SLUGS[SINGLE], type: 'dropdown', options: JSON.stringify(['x', 'y']), multiple: false },
      { id: TEXT, name: 'Owner', slug: SLUGS[TEXT], type: 'text', multiple: false },
    ])

    // Every status/priority value appears with and without each filter value, so
    // the law cannot hold vacuously.
    const fixtures: Array<{ n: string; status: string; priority: 'high' | 'low'; multi?: string[]; single?: string; text?: string }> = [
      { n: 'B1', status: 'Passed',     priority: 'high', multi: ['a'],      single: 'x', text: 'ann' },
      { n: 'B2', status: 'Passed',     priority: 'low',  multi: ['a', 'b'], single: 'y', text: 'bob' },
      { n: 'B3', status: 'Introduced', priority: 'high', multi: ['b'],      single: 'x', text: 'ann' },
      { n: 'B4', status: 'Introduced', priority: 'low',  multi: ['a', 'c'], single: 'y', text: 'bob' },
      { n: 'B5', status: 'Passed',     priority: 'high', multi: ['c'],      single: 'x', text: 'bob' },
      { n: 'B6', status: 'Introduced', priority: 'high',                    single: 'y', text: 'ann' },
    ]
    for (const f of fixtures) {
      const id = await seedBill({ billNumber: f.n, status: f.status, priority: f.priority })
      const rows = [
        f.multi && { fieldId: MULTI, value: JSON.stringify(f.multi) },
        f.single && { fieldId: SINGLE, value: f.single },
        f.text && { fieldId: TEXT, value: f.text },
      ].filter(Boolean) as Array<{ fieldId: string; value: string }>
      for (const r of rows) await db.insert(billCustomFieldValues).values({ billId: id, setBy: userId, ...r })
    }
  })

  const toQs = (pairs: Array<[string, string]>) => new URLSearchParams(pairs).toString()
  async function total(pairs: Array<[string, string]>) {
    const res = await app.request(`/api/bills?${toQs([...pairs, ['pageSize', '50']])}`, { headers: { Cookie: `session=${token}` } }, env)
    return ((await res.json()) as { bills: unknown[] }).bills.length
  }
  async function facets(pairs: Array<[string, string]>) {
    const res = await app.request(`/api/bills/facets?${toQs(pairs)}`, { headers: { Cookie: `session=${token}` } }, env)
    return (await res.json()) as Facets
  }

  // `active` is a list of [fieldId, value]; `naming` picks how the URL names the field.
  const filters: Array<{ label: string; active: Array<[string, string]> }> = [
    { label: 'multi-select, one value', active: [[MULTI, 'a']] },
    { label: 'multi-select, two values', active: [[MULTI, 'a'], [MULTI, 'b']] },
    { label: 'single-select', active: [[SINGLE, 'x']] },
    { label: 'text', active: [[TEXT, 'ann']] },
  ]
  const naming: Array<{ label: string; keyOf: (id: string) => string }> = [
    { label: 'field id', keyOf: id => id },
    { label: 'field slug', keyOf: id => SLUGS[id] },
  ]

  for (const f of filters) {
    for (const n of naming) {
      it(`${f.label} filter (by ${n.label}): other facets equal the total after picking the value`, async () => {
        const base = f.active.map(([id, v]) => [`field.${n.keyOf(id)}`, v] as [string, string])
        const activeFieldIds = new Set(f.active.map(([id]) => id))
        const got = await facets(base)
        let checked = 0

        for (const dim of ['status', 'priority'] as const) {
          for (const [value, count] of Object.entries(got[dim])) {
            expect(count, `${dim}=${value}`).toBe(await total([...base, [dim, value]]))
            checked++
          }
        }
        // Another custom field's options are an "other facet" too.
        for (const other of [MULTI, SINGLE, TEXT].filter(id => !activeFieldIds.has(id))) {
          for (const [value, count] of Object.entries(got.field[other] ?? {})) {
            if (value === '__any__') continue
            expect(count, `cf ${other}=${value}`).toBe(await total([...base, [`field.${other}`, value]]))
            checked++
          }
        }
        // Guard against the law passing vacuously on an empty facet map.
        expect(checked).toBeGreaterThan(4)
        expect(got.status.Passed ?? 0).toBeGreaterThan(0)
      })
    }
  }
})
