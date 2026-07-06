import { describe, it, expect } from 'vitest'
import { getTenantQueue, tenantQueueBindingName } from '../../src/lib/tenantQueue'

describe('tenantQueueBindingName', () => {
  it('uppercases and converts dashes to underscores', () => {
    expect(tenantQueueBindingName('my-org')).toBe('TENANT_QUEUE_MY_ORG')
    expect(tenantQueueBindingName('ri')).toBe('TENANT_QUEUE_RI')
  })
})

describe('getTenantQueue', () => {
  it('resolves the binding for a configured tenant', () => {
    const queue = { send: () => {}, sendBatch: () => {} }
    const env = { TENANT_QUEUE_MY_ORG: queue }
    expect(getTenantQueue(env, 'my-org')).toBe(queue)
  })

  it('returns undefined when no binding is configured (the silent-drop case)', () => {
    expect(getTenantQueue({}, 'unconfigured')).toBeUndefined()
  })
})
