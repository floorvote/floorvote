import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

// 0025 rebuilt bill_custom_field_values without the (field_id, value) index 0021
// made, so the date-field calendar query (lib/dateFieldEvents.ts), which runs on
// every calendar load, dashboard stats call, and feed poll, scanned the whole
// table. 0098 restores it. The test captures the SQL the calendar route really
// prepares and reads the plan for it.
describe('bill_custom_field_values (field_id, value) index', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('serves the date-field query by a search, not a scan of the values table', async () => {
    const token = await seedSession(await seedUser({ email: 'a@b.com' }))

    const prepared: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      prepared.push(sql)
      return realPrepare(sql)
    })
    const res = await SELF.fetch('http://localhost/api/calendar/events', { headers: { Cookie: `session=${token}` } })
    spy.mockRestore()
    expect(res.status).toBe(200)

    const dateFieldSql = prepared.find((s) => /from "bill_custom_field_values"/i.test(s) && /custom_field_definitions/i.test(s))
    expect(dateFieldSql, `no date-field query captured among:\n${prepared.join('\n')}`).toBeDefined()

    // EXPLAIN needs a value for every placeholder, and the plan doesn't depend on them, so bind 'x' to all.
    const params = (dateFieldSql!.match(/\?/g) ?? []).map(() => 'x')
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${dateFieldSql}`)
      .bind(...params)
      .all<{ detail: string }>()
    const plan = results.map((r) => r.detail).join('\n')

    expect(plan, `plan:\n${plan}`).not.toMatch(/SCAN bill_custom_field_values/)
    expect(plan).toContain('idx_bill_cf_values_field_value')
  })
})
