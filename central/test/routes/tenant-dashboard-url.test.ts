import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

// An instance learns where central's admin dashboard lives from the same answer
// that carries its capabilities and attribution (#538), so a superadmin's
// Profile note can link there with nothing for an operator to set.

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => {
  await clearDb()
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

  // An explicit null, not a missing key: it tells the instance to forget the
  // address, where a missing key (an older central) leaves it alone.
  it('says it has none, with an explicit null, when the address is unset', async () => {
    const body = await bodyEvents({ ...TEST_ENV, ADMIN_APP_URL: undefined })
    expect(body).toHaveProperty('dashboardUrl', null)
  })

  it('says it has none when the address is empty', async () => {
    const body = await bodyEvents({ ...TEST_ENV, ADMIN_APP_URL: '' })
    expect(body).toHaveProperty('dashboardUrl', null)
  })

  it('says it has none when the address is not an http(s) URL', async () => {
    for (const bad of ['javascript:alert(1)', 'ftp://admin.example.com', '/relative', 'not a url']) {
      const body = await bodyEvents({ ...TEST_ENV, ADMIN_APP_URL: bad })
      expect(body, bad).toHaveProperty('dashboardUrl', null)
    }
  })
})
