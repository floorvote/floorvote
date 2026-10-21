import { describe, it, expect, vi } from 'vitest'
import { HANDLE_FORM_TTL_MS, sendsNeutralHandles } from '../../src/lib/tenantHandles'

// Release 2 of the neutral handle rename (#305): central sends `bill:<n>` only
// to an instance that says, over its CentralApi binding, that it reads it. An
// instance that predates release 1 would store `bill:<n>` as a second bill and
// build new calendar UIDs from it, so anything short of a clear yes is legacy.
// The answer is cached briefly, since an instance can be rolled back.

const T0 = 1_800_000_000_000

/** A CentralApi binding for tenant `ri` with the given RPC surface. */
const envWith = (rpc: object | undefined) => (rpc ? { TENANT_RI: rpc } : {})

describe('sendsNeutralHandles', () => {
  it('is false for an instance central has no RPC binding for', async () => {
    expect(await sendsNeutralHandles(envWith(undefined), 'ri', T0)).toBe(false)
  })

  it('is false for an instance whose binding has no capabilities method (release 1 or older)', async () => {
    expect(await sendsNeutralHandles(envWith({ deliveryProbe: async () => ({ probe: null }) }), 'ri', T0)).toBe(false)
  })

  it('is true for an instance that reports neutral handles', async () => {
    expect(await sendsNeutralHandles(envWith({ capabilities: async () => ({ neutralHandles: true }) }), 'ri', T0)).toBe(true)
  })

  it.each([
    ['reports neutral handles false', { neutralHandles: false }],
    ['reports no neutral-handles field', {}],
    ['reports a truthy non-boolean', { neutralHandles: 'yes' }],
    ['answers null', null],
    ['answers undefined', undefined],
  ])('is false for an instance that %s', async (_, answer) => {
    expect(await sendsNeutralHandles(envWith({ capabilities: async () => answer }), 'ri', T0)).toBe(false)
  })

  it('is false when the capability call throws (the method is missing, or the instance is down)', async () => {
    const capabilities = vi.fn(async () => { throw new Error('The RPC receiver does not implement the method "capabilities".') })
    expect(await sendsNeutralHandles(envWith({ capabilities }), 'ri', T0)).toBe(false)
    expect(capabilities).toHaveBeenCalledTimes(1)
  })

  it('looks the binding up by the tenant id', async () => {
    const env = { TENANT_NEW_ORG: { capabilities: async () => ({ neutralHandles: true }) } }
    expect(await sendsNeutralHandles(env, 'new-org', T0)).toBe(true)
    expect(await sendsNeutralHandles(env, 'ri', T0)).toBe(false)
  })

  it('asks the instance once while its answer is fresh', async () => {
    const capabilities = vi.fn(async () => ({ neutralHandles: true }))
    const env = envWith({ capabilities })
    for (let i = 0; i < 5; i++) expect(await sendsNeutralHandles(env, 'ri', T0 + i * 1000)).toBe(true)
    expect(capabilities).toHaveBeenCalledTimes(1)
  })

  it('caches a no too, so an older instance is not asked on every message', async () => {
    const capabilities = vi.fn(async () => { throw new Error('no such method') })
    const env = envWith({ capabilities })
    for (let i = 0; i < 5; i++) expect(await sendsNeutralHandles(env, 'ri', T0 + i)).toBe(false)
    expect(capabilities).toHaveBeenCalledTimes(1)
  })

  it('drops to legacy once the cache expires after the instance is rolled back', async () => {
    let rolledBack = false
    const capabilities = vi.fn(async () => {
      if (rolledBack) throw new Error('The RPC receiver does not implement the method "capabilities".')
      return { neutralHandles: true }
    })
    const env = envWith({ capabilities })
    expect(await sendsNeutralHandles(env, 'ri', T0)).toBe(true)
    rolledBack = true
    // Still fresh: the cached yes stands.
    expect(await sendsNeutralHandles(env, 'ri', T0 + HANDLE_FORM_TTL_MS - 1)).toBe(true)
    // Expired: asked again, and the rolled-back instance gets legacy.
    expect(await sendsNeutralHandles(env, 'ri', T0 + HANDLE_FORM_TTL_MS)).toBe(false)
    expect(capabilities).toHaveBeenCalledTimes(2)
  })

  it('picks up an instance that gains the capability once its cached no expires', async () => {
    let upgraded = false
    const capabilities = vi.fn(async () => ({ neutralHandles: upgraded }))
    const env = envWith({ capabilities })
    expect(await sendsNeutralHandles(env, 'ri', T0)).toBe(false)
    upgraded = true
    expect(await sendsNeutralHandles(env, 'ri', T0 + HANDLE_FORM_TTL_MS)).toBe(true)
  })

  it('keeps no answer for longer than a few minutes', () => {
    expect(HANDLE_FORM_TTL_MS).toBeGreaterThan(0)
    expect(HANDLE_FORM_TTL_MS).toBeLessThanOrEqual(5 * 60_000)
  })
})
