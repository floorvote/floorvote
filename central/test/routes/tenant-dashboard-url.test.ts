import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

// An instance learns where central's admin dashboard lives from the same answer
// that carries its capabilities and attribution (#538), so a superadmin's
// Profile note can link there with nothing for an operator to set.

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => {
  await setupLsDb()
  await drizzle(env.DB, { schema }).insert(schema.tenants).values({ tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true })
})

async function bodyEvents(e: any) {
  const res = await app.fetch(
    new Request('http://central/api/tenants/ri/body-events?from=2026-10-01&to=2026-10-31', { headers: { 'x-admin-secret': 'sek' } }),
    e,
  )
  expect(res.status).toBe(200)
  return res.json() as Promise<Record<string, unknown>>
}

describe('GET /api/tenants/:id/body-events dashboard address', () => {
  it('names central\'s dashboard, from the address central already has for it', async () => {
    const body = await bodyEvents({ ...TEST_ENV, ADMIN_APP_URL: 'https://admin.example.com' })
    expect(body.dashboardUrl).toBe('https://admin.example.com')
  })

  it('drops a trailing slash, so the instance can append a path', async () => {
    const body = await bodyEvents({ ...TEST_ENV, ADMIN_APP_URL: 'https://admin.example.com/' })
    expect(body.dashboardUrl).toBe('https://admin.example.com')
  })

  it('names nothing when central has no dashboard address', async () => {
    const body = await bodyEvents({ ...TEST_ENV, ADMIN_APP_URL: undefined })
    expect(body).not.toHaveProperty('dashboardUrl')
  })

  it('names nothing when the address is not an http(s) URL', async () => {
    const body = await bodyEvents({ ...TEST_ENV, ADMIN_APP_URL: 'javascript:alert(1)' })
    expect(body).not.toHaveProperty('dashboardUrl')
  })
})
