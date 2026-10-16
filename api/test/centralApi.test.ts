import { describe, it, expect, beforeEach } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'
import { CentralApi } from '../src/centralApi'
import { resetDb, applyMigrations, stubFetch, seedBill } from './helpers'

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

describe('CentralApi RPC entrypoint', () => {
  it('engagementStats() returns a snapshot with metrics', async () => {
    const entry = new CentralApi(createExecutionContext(), env)
    const snap = await entry.engagementStats()
    expect(snap.metrics).toHaveProperty('total_members')
    expect(typeof snap.computedAt).toBe('string')
  })

  it('claimSourceCounts() reads the stored claim sources by status, for operators only (#573)', async () => {
    const id = await seedBill({ aiProcessedAt: '2026-02-01T00:00:00.000Z' })
    const items = [
      { claim: 'a', quote: 'x', status: 'exact', claimAt: { start: 0, end: 1 } },
      { claim: 'b', quote: 'y', status: 'unverified', page: 2, claimAt: { start: 0, end: 1 } },
    ]
    await env.DB.prepare('UPDATE bills SET claim_sources = ?, claim_sources_doc_id = ? WHERE id = ?').bind(JSON.stringify(items), '5001', id).run()
    const entry = new CentralApi(createExecutionContext(), env)
    const counts = await entry.claimSourceCounts()
    expect(typeof counts.computedAt).toBe('string')
    expect(counts.items).toEqual({ exact: 1, normalized: 0, fuzzy: 0, anchored: 0, ungrounded: 0, unverified: 1, total: 2 })
    expect(counts.analyses).toEqual({ withClaimSources: 1, emptyList: 0, noList: 0 })
    expect(counts.cutOffRetries).toBe(0)
  })

  it('claimSourceCounts() carries no claim text, quotes, or bill ids', async () => {
    const id = await seedBill({ aiProcessedAt: '2026-02-01T00:00:00.000Z' })
    const items = [{ claim: 'Secret claim text.', quote: 'Secret quote text', status: 'exact', claimAt: { start: 0, end: 1 } }]
    await env.DB.prepare('UPDATE bills SET claim_sources = ? WHERE id = ?').bind(JSON.stringify(items), id).run()
    const entry = new CentralApi(createExecutionContext(), env)
    const counts = await entry.claimSourceCounts()
    expect(counts.items.exact).toBe(1)
    const json = JSON.stringify(counts)
    expect(json).not.toContain('Secret')
    expect(json).not.toContain(id)
  })

  it('forceRegister() resolves to a boolean', async () => {
    const central = stubFetch()
    const entry = new CentralApi(createExecutionContext(), env)
    const ok = await entry.forceRegister()
    expect(ok).toBe(true)
    expect(central.mock.calls.map(c => c[0])).toEqual(['https://central.test/api/tenants/register'])
  })

  it('sendSampleEmail() rejects an invalid type without sending', async () => {
    const entry = new CentralApi(createExecutionContext(), env)
    const r = await entry.sendSampleEmail('a@b.com', 'not-a-real-type')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid type')
  })
})
