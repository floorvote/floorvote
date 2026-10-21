import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sessionRaw from '../fixtures/template/2026-sample.json?raw'

// TEMPLATE: the main-seam test every provider keeps (test/helpers/mainSeam.ts).
// The recorded feed goes in, with the network stubbed at fetch, and central's
// bill API and the notifications queued for tenants come out. Check only what
// an instance or an operator would see. test/cron/mga-provider.test.ts is a
// full one: every field that reaches the bill API, ETags, and each way the
// feed can fail closed.

// The template isn't in the registry, so this test adds it. A real provider
// is in src/providers/index.ts, and its test leaves this mock out.
vi.mock('../../src/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers')>()
  const { template } = await import('../../src/providers/template')
  const PROVIDERS = [...actual.PROVIDERS, template]
  const findProvider = (id: string | null | undefined) => PROVIDERS.find(p => p.id === id)
  return {
    ...actual,
    PROVIDERS,
    findProvider,
    getProvider: (id: string) => {
      const p = findProvider(id)
      if (!p) throw new Error(`unknown provider: ${id}`)
      return p
    },
  }
})
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { template } from '../../src/providers/template'
import { TEMPLATE_BASE } from '../../src/providers/template/client'
import { toLegacyHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral } from '../helpers/mainSeam'

const FILE_2026 = `${TEMPLATE_BASE}/2026/bills.json`

/** What the stubbed feed answers for the 2026 session file. A test replaces it to break the feed. */
let answer: () => Response
/** Every URL requested. */
let calls: string[]

const seam = mainSeam(template, { tenantId: 'zzteam' })

beforeEach(async () => {
  await resetCentral()
  answer = () => new Response(sessionRaw, { headers: { 'content-type': 'application/json' } })
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url === FILE_2026) return init?.method === 'HEAD' ? new Response(null) : answer()
    if (url.startsWith(TEMPLATE_BASE)) return new Response('not found', { status: 404 })
    throw new Error(`no network in this test: ${url}`)
  })
  await seam.addTenant('ZZ', ['library'])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the template provider at the main seam', () => {
  it('stays off until an operator claims the state', async () => {
    expect(await seam.sync()).toEqual([])
    expect(calls).toEqual([])
  })

  it('syncs a claimed state, and serves and sends its measures', async () => {
    expect((await seam.claim('ZZ')).status).toBe(200)
    const { run } = await seam.syncAndIngest()
    const hb1 = await seam.billIdOf('HB 1', '2026')
    // Only HB 1 matches the instance's keyword, so only it is ingested.
    expect(seam.queuedIds(run)).toEqual([hb1])

    expect(await seam.getJson(`/bills/${toLegacyHandle(hb1)}`)).toMatchObject({
      number: 'HB 1', state: 'ZZ', title: 'Public Library Hours Act',
      stateUrl: 'https://legislature.example/bills/2026/HB1',
    })
    const sent = seam.sentToTenant(run)
    expect(sent).toContainEqual(expect.objectContaining({ billId: toLegacyHandle(hb1) }))
  })

  it('fails closed on an answer the mapping doesn\'t read, writing nothing', async () => {
    await seam.claim('ZZ')
    answer = () => new Response(JSON.stringify([{ Number: 'HB 1' }]), { headers: { 'content-type': 'application/json' } })
    const run = seam.makeRun()
    await expect(seam.sync(run)).rejects.toThrow(/Template 2026/)
    expect(run.queue.sendBatch).not.toHaveBeenCalled()
    await expect(seam.billIdOf('HB 1')).rejects.toThrow()
  })
})
