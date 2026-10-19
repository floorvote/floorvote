import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

beforeEach(async () => { await clearDb() })

describe('dash routes skeleton', () => {
  it('returns 401 on unknown protected route without auth', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/__nope'), env as any)
    expect(res.status).toBe(401)
  })
})
