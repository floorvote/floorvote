import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { processDeadLetterQueue } from '../../src/queue/deadLetters'

// Swap console.warn directly rather than vi.spyOn: this suite runs in the
// Workers pool, where the spy does not reliably attach to the global console.
let logged: string[] = []
const realWarn = console.warn

function msg(body: unknown, attempts = 4) {
  return { body, attempts, timestamp: new Date('2026-09-06T22:00:00Z'), ack: vi.fn(), retry: vi.fn() }
}
function batch(messages: ReturnType<typeof msg>[], queue = 'the-tracker-dlq') {
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() } as any
}

describe('processDeadLetterQueue', () => {
  beforeEach(() => { logged = []; console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) } })
  afterEach(() => { console.warn = realWarn })

  it('acks every message, so the queue actually drains', () => {
    const a = msg({ tenantId: 'ut', billId: 'legiscan:1' })
    const b = msg({ tenantId: 'ri', billId: 'legiscan:2' })
    processDeadLetterQueue(batch([a, b]))
    expect(a.ack).toHaveBeenCalledTimes(1)
    expect(b.ack).toHaveBeenCalledTimes(1)
    expect(a.retry).not.toHaveBeenCalled()
  })

  it('logs the tenant and bill, since the log line is the only surviving record', () => {
    const a = msg({ tenantId: 'ut', billId: 'legiscan:12345' })
    processDeadLetterQueue(batch([a]))
    expect(logged.join('\n')).toContain('ut/legiscan:12345')
    expect(logged.join('\n')).toContain('4 attempt(s)')
  })

  it('drains a message whose body is not the expected shape', () => {
    // Bodies come from seven tenants and several code paths; one odd shape must
    // not leave the queue undrainable.
    const weird = msg(null)
    const alsoWeird = msg({ tenantId: 42 })
    processDeadLetterQueue(batch([weird, alsoWeird]))
    expect(weird.ack).toHaveBeenCalledTimes(1)
    expect(alsoWeird.ack).toHaveBeenCalledTimes(1)
    expect(logged.join('\n')).toContain('unknown-tenant/unknown-bill')
  })

  it('reports how many it drained', () => {
    processDeadLetterQueue(batch([msg({}), msg({}), msg({})]))
    expect(logged.join('\n')).toContain('drained 3 message(s) from the-tracker-dlq')
  })
})
