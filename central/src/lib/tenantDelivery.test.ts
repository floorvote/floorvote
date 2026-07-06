import { describe, it, expect, vi, afterEach } from 'vitest'
import { deliverToTenant, deliverBatchToTenant } from './tenantDelivery'

afterEach(() => vi.restoreAllMocks())

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// A fake producer binding under the conventional name TENANT_QUEUE_<ID>.
function withBinding(tenantId: string) {
  const send = vi.fn(async (_body: unknown) => {})
  const sendBatch = vi.fn(async (_batch: { body: unknown }[]) => {})
  const key = `TENANT_QUEUE_${tenantId.toUpperCase().replace(/-/g, '_')}`
  return { env: { [key]: { send, sendBatch } }, send, sendBatch }
}

const HTTP_ENV = { CF_QUEUES_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' }

describe('deliverToTenant (single)', () => {
  it('uses the static binding when present (existing tenants unchanged)', async () => {
    const { env, send } = withBinding('ri')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const outcome = await deliverToTenant({ ...env, ...HTTP_ENV }, 'ri', 'qid', { hi: 1 })
    expect(outcome).toBe('binding')
    expect(send).toHaveBeenCalledWith({ hi: 1 })
    expect(fetchSpy).not.toHaveBeenCalled() // never touches HTTP when bound
  })

  it('HTTP-publishes when there is no binding but a queueId + token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ success: true }))
    const outcome = await deliverToTenant(HTTP_ENV, 'newtenant', 'qid-123', { hi: 2 })
    expect(outcome).toBe('http')
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('/queues/qid-123/messages')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ body: { hi: 2 } })
  })

  it('drops (returns "dropped") when neither a binding nor a queueId exists', async () => {
    const outcome = await deliverToTenant(HTTP_ENV, 'newtenant', null, { hi: 3 })
    expect(outcome).toBe('dropped')
  })

  it('drops when a queueId exists but the REST token is unset', async () => {
    const outcome = await deliverToTenant({}, 'newtenant', 'qid', { hi: 4 })
    expect(outcome).toBe('dropped')
  })
})

describe('deliverBatchToTenant', () => {
  it('uses the binding sendBatch, wrapping each body, chunked at 100', async () => {
    const { env, sendBatch } = withBinding('ri')
    const bodies = Array.from({ length: 150 }, (_, i) => ({ i }))
    const outcome = await deliverBatchToTenant({ ...env, ...HTTP_ENV }, 'ri', 'qid', bodies)
    expect(outcome).toBe('binding')
    expect(sendBatch).toHaveBeenCalledTimes(2)
    expect(sendBatch.mock.calls[0][0]).toHaveLength(100)
    expect(sendBatch.mock.calls[0][0][0]).toEqual({ body: { i: 0 } })
    expect(sendBatch.mock.calls[1][0]).toHaveLength(50)
  })

  it('HTTP batch-publishes when unbound with a queueId + token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ success: true }))
    const outcome = await deliverBatchToTenant(HTTP_ENV, 'newtenant', 'qid-9', [{ a: 1 }, { a: 2 }])
    expect(outcome).toBe('http')
    expect(String(spy.mock.calls[0][0])).toContain('/queues/qid-9/messages/batch')
  })

  it('is a no-op for an empty batch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const outcome = await deliverBatchToTenant(HTTP_ENV, 'newtenant', 'qid', [])
    expect(outcome).toBe('noop')
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops when unbound with no queueId', async () => {
    const outcome = await deliverBatchToTenant(HTTP_ENV, 'newtenant', null, [{ a: 1 }])
    expect(outcome).toBe('dropped')
  })
})
