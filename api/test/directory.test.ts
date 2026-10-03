import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from './helpers'
import { app } from '../src/index'

const DIRECTORY = {
  committees: [{ slug: 'committee-on-youth-affairs', name: 'Committee on Youth Affairs', url: 'https://dccouncil.gov/committees/committee-on-youth-affairs/',
    chair: { name: 'Ward 5 Councilmember Zachary Parker', url: null }, members: [],
    staff: [{ name: 'Allison Bailey', title: 'Legislative Assistant', email: 'abailey@dccouncil.gov', phone: '(202) 727-7774', url: null }], agencies: [] }],
  people: [], updatedAt: '2026-09-30 09:00:00',
}
const testEnv = { ...env, CENTRAL_API_URL: 'https://central.test' }

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(DIRECTORY), { status: 200 })))
})

describe('GET /api/directory', () => {
  it('serves the Council directory to signed-in members only', async () => {
    const cookie = `session=${await seedSession(await seedUser({ role: 'member', email: 'm@example.com' }))}`
    const res = await app.request('/api/directory', { headers: { Cookie: cookie } }, testEnv)
    expect(res.status).toBe(200)
    expect((await res.json() as any).committees[0].staff[0].email).toBe('abailey@dccouncil.gov')
    expect((await app.request('/api/directory', {}, testEnv)).status).toBe(401)
  })
})
