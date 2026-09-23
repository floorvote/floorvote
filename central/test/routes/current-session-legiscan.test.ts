import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

const AUTH = { 'x-admin-secret': 'sek', 'content-type': 'application/json' }
const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => { await setupLsDb() })

describe('GET /tenants/current-session/:state', () => {
  it('returns the newest regular session for the state', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values([
      {
        sessionId: 1, state: 'UT', stateId: 41, yearStart: 2023, yearEnd: 2024,
        sineDie: 1, special: 0, sessionTitle: 'Regular Session',
        sessionName: 'Utah 2023-2024 Regular Session',
      },
      {
        sessionId: 2, state: 'UT', stateId: 41, yearStart: 2025, yearEnd: 2026,
        sineDie: 0, special: 0, sessionTitle: 'Regular Session',
        sessionName: 'Utah 2025-2026 Regular Session',
      },
      {
        sessionId: 3, state: 'UT', stateId: 41, yearStart: 2026, yearEnd: 2026,
        sineDie: 0, special: 1, sessionTitle: 'Special Session',
        sessionName: 'Utah 2026 Special Session',
      },
    ])

    const res = await app.fetch(
      new Request('http://central/api/tenants/current-session/UT', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ yearStart: 2025, yearEnd: 2026, sineDie: false })
  })

  it('reports sineDie when the newest regular session has adjourned', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values([
      {
        sessionId: 1, state: 'UT', stateId: 41, yearStart: 2025, yearEnd: 2026,
        sineDie: 1, special: 0, sessionTitle: 'Regular Session',
        sessionName: 'Utah 2025-2026 Regular Session',
      },
    ])

    const res = await app.fetch(
      new Request('http://central/api/tenants/current-session/UT', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ yearStart: 2025, yearEnd: 2026, sineDie: true })
  })

  it('404s for a state with no sessions', async () => {
    const res = await app.fetch(
      new Request('http://central/api/tenants/current-session/ZZ', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no session for state' })
  })

  it('returns 401 without admin secret', async () => {
    const res = await app.fetch(
      new Request('http://central/api/tenants/current-session/UT'),
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })
})
