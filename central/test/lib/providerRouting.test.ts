import { describe, it, expect } from 'vitest'
import { PROVIDERS, getProvider, type Provider } from '../../src/providers'
import { ingestQueueFor } from '../../src/lib/providerRouting'
import type { Env } from '../../src/types'

/** A stand-in queue: only its identity matters to routing. */
const queue = (name: string) => ({ name }) as unknown as Queue
const SHARED = queue('shared')

/** An env with the shared queue and whichever provider queues are bound. */
const envWith = (bound: Partial<Pick<Env, 'LIMS_INGESTOR_QUEUE' | 'MGA_INGESTOR_QUEUE' | 'LIS_INGESTOR_QUEUE'>> = {}): Env =>
  ({ INGESTOR_QUEUE: SHARED, ...bound }) as unknown as Env

describe('ingestQueueFor', () => {
  const mgaQueue = queue('mga')
  const lisQueue = queue('lis')
  const limsQueue = queue('lims')

  it.each([
    ['mga', 'MGA_INGESTOR_QUEUE', mgaQueue],
    ['lis', 'LIS_INGESTOR_QUEUE', lisQueue],
    ['lims', 'LIMS_INGESTOR_QUEUE', limsQueue],
  ] as const)('gives %s its own queue when %s is bound', (id, binding, bound) => {
    expect(getProvider(id).ingestQueue).toBe(binding)
    expect(ingestQueueFor(getProvider(id), envWith({ [binding]: bound }))).toBe(bound)
  })

  it.each(['mga', 'lis', 'lims'])('gives %s the shared queue when its own is not bound', id => {
    expect(ingestQueueFor(getProvider(id), envWith())).toBe(SHARED)
  })

  it('never hands a provider another provider\'s queue', () => {
    // Only LIS and LIMS are bound: MGA still shares, and each of the others gets its own.
    const e = envWith({ LIS_INGESTOR_QUEUE: lisQueue, LIMS_INGESTOR_QUEUE: limsQueue })
    expect(ingestQueueFor(getProvider('mga'), e)).toBe(SHARED)
    expect(ingestQueueFor(getProvider('lis'), e)).toBe(lisQueue)
    expect(ingestQueueFor(getProvider('lims'), e)).toBe(limsQueue)
  })

  it('leaves LegiScan on the shared queue, whatever is bound', () => {
    const all = envWith({ MGA_INGESTOR_QUEUE: mgaQueue, LIS_INGESTOR_QUEUE: lisQueue, LIMS_INGESTOR_QUEUE: limsQueue })
    expect(getProvider('legiscan').ingestQueue).toBeUndefined()
    expect(ingestQueueFor(getProvider('legiscan'), all)).toBe(SHARED)
    expect(ingestQueueFor(getProvider('legiscan'), envWith())).toBe(SHARED)
  })

  it('leaves LIMS routing as it was, bound and unbound', () => {
    expect(ingestQueueFor(getProvider('lims'), envWith({ LIMS_INGESTOR_QUEUE: limsQueue }))).toBe(limsQueue)
    expect(ingestQueueFor(getProvider('lims'), envWith())).toBe(SHARED)
  })

  it('falls back to the shared queue for a provider that declares no queue, such as one added later', () => {
    const later = { ...getProvider('mga'), id: 'later', ingestQueue: undefined } as Provider
    const all = envWith({ MGA_INGESTOR_QUEUE: mgaQueue, LIS_INGESTOR_QUEUE: lisQueue, LIMS_INGESTOR_QUEUE: limsQueue })
    expect(ingestQueueFor(later, all)).toBe(SHARED)
    expect(ingestQueueFor(later, envWith())).toBe(SHARED)
  })

  it('falls back to the shared queue for a provider whose declared binding is missing from the env', () => {
    const later = { ...getProvider('mga'), id: 'later', ingestQueue: 'LATER_INGESTOR_QUEUE' } as unknown as Provider
    expect(ingestQueueFor(later, envWith())).toBe(SHARED)
  })

  it('gives every provider that declares a queue a binding of its own', () => {
    const bindings = PROVIDERS.flatMap(p => (p.ingestQueue ? [p.ingestQueue] : []))
    expect(new Set(bindings).size).toBe(bindings.length)
    expect(bindings).not.toContain('INGESTOR_QUEUE')
    expect([...bindings].sort()).toEqual(['LIMS_INGESTOR_QUEUE', 'LIS_INGESTOR_QUEUE', 'MGA_INGESTOR_QUEUE'])
  })
})
