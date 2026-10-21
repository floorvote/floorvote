import { describe, it, expect, vi, afterEach } from 'vitest'
import { deliverToTenant, deliverBatchToTenant } from '../../src/lib/tenantDelivery'
import { toHandle } from '../../src/lib/billHandle'

// Release 2 of the neutral handle rename (#305). Every message central queues
// to an instance leaves through tenantDelivery, so that is where a handle takes
// the form the instance reads: `bill:<n>` for an instance whose CentralApi
// binding reports neutral handles, `legiscan:<n>` for every other one, whatever
// form the caller built. An instance that predates release 1 and receives
// `bill:<n>` would insert a duplicate bill and churn its calendar UIDs.

afterEach(() => vi.restoreAllMocks())

const HTTP_ENV = { CF_QUEUES_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' }
const CAPABLE = { capabilities: async () => ({ neutralHandles: true }) }
const RELEASE_1 = { deliveryProbe: async () => ({ probe: null }) }

/** An env with tenant `ri`'s queue binding and, optionally, its CentralApi binding. */
function bound(rpc?: object) {
  const send = vi.fn(async (_body: unknown) => {})
  const sendBatch = vi.fn(async (_batch: { body: unknown }[]) => {})
  return { env: { TENANT_QUEUE_RI: { send, sendBatch }, ...(rpc ? { TENANT_RI: rpc } : {}) }, send, sendBatch }
}

const notification = (handle: string) => ({ tenantId: 'ri', billId: handle, forceMetadata: true })

describe('deliverToTenant sends each instance the handle form it reads', () => {
  it.each([
    ['no CentralApi binding', undefined],
    ['a release-1 binding with no capabilities method', RELEASE_1],
    ['a binding whose capabilities call fails', { capabilities: async () => { throw new Error('down') } }],
    ['a binding that reports no neutral handles', { capabilities: async () => ({ neutralHandles: false }) }],
  ])('sends the legacy handle to an instance with %s', async (_, rpc) => {
    const { env, send } = bound(rpc)
    await deliverToTenant(env, 'ri', null, notification(toHandle(501)))
    expect(send).toHaveBeenCalledWith({ tenantId: 'ri', billId: 'legiscan:501', forceMetadata: true })
  })

  it('sends the neutral handle to an instance that reports it', async () => {
    const { env, send } = bound(CAPABLE)
    await deliverToTenant(env, 'ri', null, notification(toHandle(501)))
    expect(send).toHaveBeenCalledWith({ tenantId: 'ri', billId: 'bill:501', forceMetadata: true })
  })

  it('rewrites a legacy handle a caller built to the neutral form for a capable instance', async () => {
    const { env, send } = bound(CAPABLE)
    await deliverToTenant(env, 'ri', null, notification('legiscan:501'))
    expect(send.mock.calls[0][0]).toMatchObject({ billId: 'bill:501' })
  })

  it('keeps every other field of the message, the probe nonce and calendar included', async () => {
    const { env, send } = bound()
    const calendar = { events: [{ identityKey: '1|x', kind: 'hearing' }], changes: [] }
    await deliverToTenant(env, 'ri', null, { tenantId: 'ri', billId: 'bill:7', probe: 'nonce-1', calendar, changes: [{ changeType: 'status' }] })
    expect(send).toHaveBeenCalledWith({ tenantId: 'ri', billId: 'legiscan:7', probe: 'nonce-1', calendar, changes: [{ changeType: 'status' }] })
  })

  it.each([
    ['a malformed handle', 'bill:12abc'],
    ['a handle with id zero', 'legiscan:0'],
    ['a bare id', '501'],
    ['an ocd-bill id', 'ocd-bill/abc'],
  ])('leaves %s as it is', async (_, value) => {
    const { env, send } = bound(CAPABLE)
    await deliverToTenant(env, 'ri', null, notification(value))
    expect(send.mock.calls[0][0]).toMatchObject({ billId: value })
  })

  it('leaves a message with no billId as it is', async () => {
    const { env, send } = bound(CAPABLE)
    await deliverToTenant(env, 'ri', null, { hi: 1 })
    expect(send).toHaveBeenCalledWith({ hi: 1 })
  })

  it('sends the legacy handle down the HTTP fallback too, to an instance with no binding', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await deliverToTenant(HTTP_ENV, 'newtenant', 'qid-1', { tenantId: 'newtenant', billId: 'bill:9' })
    expect(JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body))).toEqual({ body: { tenantId: 'newtenant', billId: 'legiscan:9' } })
  })

  it('sends the neutral handle down the HTTP fallback to a capable instance with an RPC binding but no queue binding', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await deliverToTenant({ ...HTTP_ENV, TENANT_NEWTENANT: CAPABLE }, 'newtenant', 'qid-1', { tenantId: 'newtenant', billId: 'legiscan:9' })
    expect(JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body))).toEqual({ body: { tenantId: 'newtenant', billId: 'bill:9' } })
  })
})

describe('deliverBatchToTenant sends each instance the handle form it reads', () => {
  const bodies = (n: number) => Array.from({ length: n }, (_, i) => notification(toHandle(1000 + i)))

  it('sends legacy handles in every chunk to an instance that does not report neutral handles', async () => {
    const { env, sendBatch } = bound(RELEASE_1)
    await deliverBatchToTenant(env, 'ri', null, bodies(150))
    const sent = sendBatch.mock.calls.flatMap(c => c[0].map(m => (m.body as { billId: string }).billId))
    expect(sent).toHaveLength(150)
    expect(sent.every(h => /^legiscan:\d+$/.test(h))).toBe(true)
    expect(sent[0]).toBe('legiscan:1000')
  })

  it('sends neutral handles in every chunk to a capable instance, and asks it once', async () => {
    const capabilities = vi.fn(async () => ({ neutralHandles: true }))
    const { env, sendBatch } = bound({ capabilities })
    await deliverBatchToTenant(env, 'ri', null, bodies(150))
    const sent = sendBatch.mock.calls.flatMap(c => c[0].map(m => (m.body as { billId: string }).billId))
    expect(sent.every(h => /^bill:\d+$/.test(h))).toBe(true)
    expect(sent[149]).toBe('bill:1149')
    expect(capabilities).toHaveBeenCalledTimes(1)
  })

  it('sends legacy handles in an HTTP batch to an instance with no binding', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await deliverBatchToTenant(HTTP_ENV, 'newtenant', 'qid-9', [{ tenantId: 'newtenant', billId: 'bill:1' }, { tenantId: 'newtenant', billId: 'bill:2' }])
    const payload = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body)) as { messages: { body: { billId: string } }[] }
    expect(payload.messages.map(m => m.body.billId)).toEqual(['legiscan:1', 'legiscan:2'])
  })

  it('does not ask the instance about an empty batch', async () => {
    const capabilities = vi.fn(async () => ({ neutralHandles: true }))
    const { env } = bound({ capabilities })
    expect(await deliverBatchToTenant(env, 'ri', null, [])).toBe('noop')
    expect(capabilities).not.toHaveBeenCalled()
  })
})
