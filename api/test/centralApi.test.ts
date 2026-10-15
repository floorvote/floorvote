import { describe, it, expect, beforeEach } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'
import { CentralApi } from '../src/centralApi'
import { resetDb, applyMigrations, stubFetch } from './helpers'

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
