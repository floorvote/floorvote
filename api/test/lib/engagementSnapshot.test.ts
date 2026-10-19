import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { computeEngagementSnapshot } from '../../src/lib/engagementSnapshot'
import { clearDb } from '../helpers'

beforeEach(async () => {
  await clearDb()
})

describe('computeEngagementSnapshot', () => {
  it('returns a snapshot with computedAt, metrics, and resend', async () => {
    const db = getDb(env.DB)
    const snap = await computeEngagementSnapshot(db)
    expect(typeof snap.computedAt).toBe('string')
    expect(snap.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(snap.metrics).toBeDefined()
    expect(typeof snap.metrics.total_members).toBe('number')
    expect(snap.resend).toBeDefined()
    expect(typeof snap.resend.monthlyUsed).toBe('number')
  })
})
