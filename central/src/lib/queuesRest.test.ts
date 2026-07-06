import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  queuesRestEnabled,
  resolveQueueId,
  ensureQueue,
  publishMessage,
  publishBatch,
} from './queuesRest'

const ENV = { CF_QUEUES_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' }

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => impl(String(input), init))
}

afterEach(() => vi.restoreAllMocks())

describe('queuesRestEnabled', () => {
  it('requires both token and account id', () => {
    expect(queuesRestEnabled(ENV)).toBe(true)
    expect(queuesRestEnabled({ CF_ACCOUNT_ID: 'acct' })).toBe(false)
    expect(queuesRestEnabled({ CF_QUEUES_TOKEN: 'tok' })).toBe(false)
  })
})

describe('resolveQueueId', () => {
  it('finds a queue id by exact name', async () => {
    stubFetch(() => ok({ success: true, result: [
      { queue_id: 'aaa', queue_name: 'floorvote-ut-queue' },
      { queue_id: 'bbb', queue_name: 'floorvote-ri-queue' },
    ] }))
    expect(await resolveQueueId(ENV, 'floorvote-ri-queue')).toBe('bbb')
  })
  it('returns null when no queue matches', async () => {
    stubFetch(() => ok({ success: true, result: [{ queue_id: 'aaa', queue_name: 'other' }] }))
    expect(await resolveQueueId(ENV, 'floorvote-ri-queue')).toBeNull()
  })
  it('returns null (no network) when disabled', async () => {
    const spy = stubFetch(() => ok({ success: true, result: [] }))
    expect(await resolveQueueId({ CF_ACCOUNT_ID: 'acct' }, 'q')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('ensureQueue', () => {
  it('returns the existing id without creating', async () => {
    const spy = stubFetch((url) => {
      if (url.endsWith('/queues?per_page=100')) return ok({ success: true, result: [{ queue_id: 'eee', queue_name: 'q1' }] })
      throw new Error('should not POST create')
    })
    expect(await ensureQueue(ENV, 'q1')).toBe('eee')
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('creates the queue when missing and returns the new id', async () => {
    let created = false
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        created = true
        expect(JSON.parse(String(init.body))).toEqual({ queue_name: 'q2' })
        return ok({ success: true, result: { queue_id: 'new-id' } })
      }
      return ok({ success: true, result: [] }) // list: empty
    })
    expect(await ensureQueue(ENV, 'q2')).toBe('new-id')
    expect(created).toBe(true)
  })
})

describe('publishMessage', () => {
  it('POSTs a single {body} to the messages endpoint', async () => {
    let seen: { url: string; body: unknown } | null = null
    stubFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init!.body)) }
      return ok({ success: true, errors: [] })
    })
    await publishMessage(ENV, 'qid', { tenantId: 't', billId: 'legiscan:1' })
    expect(seen!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/queues/qid/messages')
    expect(seen!.body).toEqual({ body: { tenantId: 't', billId: 'legiscan:1' } })
  })
  it('throws on a non-success response', async () => {
    stubFetch(() => ok({ success: false, errors: [{ message: 'nope' }] }))
    await expect(publishMessage(ENV, 'qid', {})).rejects.toThrow()
  })
})

describe('publishBatch', () => {
  it('wraps bodies as {messages:[{body}]} on the /batch endpoint', async () => {
    let seen: { url: string; body: any } | null = null
    stubFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init!.body)) }
      return ok({ success: true, errors: [] })
    })
    await publishBatch(ENV, 'qid', [{ n: 1 }, { n: 2 }])
    expect(seen!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/queues/qid/messages/batch')
    expect(seen!.body).toEqual({ messages: [{ body: { n: 1 } }, { body: { n: 2 } }] })
  })
  it('chunks into batches of at most 100', async () => {
    let calls = 0
    const sizes: number[] = []
    stubFetch((_url, init) => {
      calls++
      sizes.push(JSON.parse(String(init!.body)).messages.length)
      return ok({ success: true, errors: [] })
    })
    await publishBatch(ENV, 'qid', Array.from({ length: 250 }, (_, i) => ({ i })))
    expect(calls).toBe(3)
    expect(sizes).toEqual([100, 100, 50])
  })
  it('does nothing for an empty list', async () => {
    const spy = stubFetch(() => ok({ success: true }))
    await publishBatch(ENV, 'qid', [])
    expect(spy).not.toHaveBeenCalled()
  })
})
