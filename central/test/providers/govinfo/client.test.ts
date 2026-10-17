import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The roll call cache: what a bill's ingest reads is kept for the next bill's,
// within ten minutes and within 128 roll calls (client.ts).
vi.mock('../../../src/lib/rateLimitedFetch', () => import('../../helpers/unpacedFetch'))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { clearRollCallCaches, fetchRollCall } from '../../../src/providers/govinfo/client'
import type { RecordedVote } from '../../../src/providers/govinfo/rollcalls'
import { houseUrl, rollCallFiles } from '../../helpers/govinfoRollCalls'

const vote = (roll: number): RecordedVote => ({ chamber: 'H', congress: 119, session: 1, roll, url: houseUrl(2025, roll) })
let asked: Map<string, number>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))
  clearRollCallCaches()
  asked = new Map()
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    asked.set(url, (asked.get(url) ?? 0) + 1)
    const roll = Number(/roll(\d+)\.xml$/.exec(url)![1])
    return new Response(rollCallFiles.get('house-2025-roll028.xml')!.replace('<rollcall-num>28</rollcall-num>', `<rollcall-num>${roll}</rollcall-num>`), { status: 200 })
  })
})

afterEach(() => { vi.useRealTimers() })

const times = (roll: number) => asked.get(houseUrl(2025, roll)) ?? 0

describe('the roll call cache', () => {
  it('reads a roll call once, and hands the same votes to the next ask', async () => {
    const a = await fetchRollCall(vote(5))
    const b = await fetchRollCall(vote(5))
    expect(times(5)).toBe(1)
    expect(b).toBe(a)
    expect(a.roll).toBe(5)
  })

  it('reads a roll call again once ten minutes have gone', async () => {
    await fetchRollCall(vote(5))
    vi.setSystemTime(new Date('2026-09-28T09:09:59Z'))
    await fetchRollCall(vote(5))
    expect(times(5)).toBe(1)
    vi.setSystemTime(new Date('2026-09-28T09:10:01Z'))
    await fetchRollCall(vote(5))
    expect(times(5)).toBe(2)
  })

  it('holds 128 roll calls and lets go of the one asked for longest ago', async () => {
    for (let n = 1; n <= 128; n++) await fetchRollCall(vote(n))
    // Asked again, so roll call 1 is the newest and 2 the oldest.
    await fetchRollCall(vote(1))
    await fetchRollCall(vote(129))
    await fetchRollCall(vote(1))
    expect(times(1)).toBe(1)
    await fetchRollCall(vote(128))
    expect(times(128)).toBe(1)
    await fetchRollCall(vote(2))
    expect(times(2)).toBe(2)
    expect(times(129)).toBe(1)
  })

  it('keeps a plain copy of the votes, holding no part of the file\'s text', async () => {
    const rc = await fetchRollCall(vote(7))
    expect(JSON.parse(JSON.stringify(rc))).toEqual(rc)
    expect(Object.getPrototypeOf(rc)).toBe(Object.prototype)
  })

  it('keeps nothing after clearRollCallCaches', async () => {
    await fetchRollCall(vote(5))
    clearRollCallCaches()
    await fetchRollCall(vote(5))
    expect(times(5)).toBe(2)
  })
})
