import { describe, it, expect, vi, beforeEach } from 'vitest'
import calendarRaw from '../../fixtures/lims/hearings-calendar.json?raw'
import { hearingsInventory } from '../../../src/providers/lims/inventory'
import { vocabulary } from '../../../src/providers/lims/vocabulary'
import { committeeKey } from '../../../src/providers/lims/map'
import { inventoryProblems } from '../../helpers/fieldInventory'
import { CALENDAR_KINDS } from '../../../../shared/calendarKinds'

vi.mock('../../../src/lib/rateLimitedFetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit | undefined, opts: { onRequest?: () => void }) => {
    const res = await fetch(url, init)
    opts.onRequest?.()
    return res
  },
}))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { getHearingsCalendar, hearingCommittee, hearingKind, limsBodyEvents, mapHearing, type LimsHearing } from '../../../src/providers/lims/hearings'
import { lims } from '../../../src/providers/lims'

// The DC Council's hearings calendar (#297), recorded from the live feed by
// @anotherpanacea for #217: one list of events per month.
const months = JSON.parse(calendarRaw) as Record<string, LimsHearing[]>
const events = Object.values(months).flat()
const byId = (id: number) => events.find(e => e.hearingId === id)!

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answer each month's POST with the recorded month, or what a test puts in `answers`. */
let answers: Record<string, () => Response>
beforeEach(() => {
  answers = Object.fromEntries(Object.entries(months).map(([month, list]) => [month, () => json(list)]))
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { month: string; year: string }
    const key = `${body.year}-${body.month.padStart(2, '0')}`
    return answers[key]?.() ?? json([])
  })
})

/** ctx.ids, minting one id per key in order. */
function mintIds() {
  const minted = new Map<string, number>()
  return {
    minted,
    ids: async (kind: string, keys: readonly string[]) => {
      expect(kind).toBe('committee')
      for (const k of keys) if (!minted.has(k)) minted.set(k, 3_000_000_000 + minted.size)
      return new Map(keys.map(k => [k, minted.get(k)!]))
    },
  }
}

describe('the hearings calendar field inventory', () => {
  it('lists every field of the recorded events', () => {
    expect(inventoryProblems(hearingsInventory, events, vocabulary)).toEqual([])
  })

  it('fails on a field the feed starts sending', () => {
    expect(inventoryProblems(hearingsInventory, [{ ...byId(2408), streamUrl: 'https://example.org' }])).toEqual(['not in the inventory: streamUrl'])
  })
})

describe('mapping the hearings calendar', () => {
  it('maps an event as #217 did, under the UID and hash the fork already issued', async () => {
    const { event, committee } = await mapHearing(byId(2408))
    expect(event).toEqual({
      event_id: '2408',
      kind: 'hearing',
      type: 'Roundtable',
      date: '2026-10-01',
      time: '10:00',
      timezone: 'America/New_York',
      joint_with: null,
      location: 'Room 123 (Track C)',
      title: 'Housing roundtable',
      agenda: [{ topic: 'Improving Housing Conditions and Strengthening Landlord Accountability in the District', bill_number: null }],
      url: 'https://lims.dccouncil.gov/Hearings/hearings/2408',
      // What #217's sync stored as the event's hash, over the same values, so
      // instances that took this event from a fork keep their ICS sequence.
      event_hash: '78a22f7cd5a0a207615d710558b8f192',
    })
    expect(committee).toBe('Committee on Housing')
    expect(lims.bodyEventUid!('2408')).toBe('council-2408@lims.dccouncil.gov')
  })

  it('names the committee as LIMS referrals do, and none for a meeting of the whole Council', () => {
    expect(hearingCommittee('Health')).toBe('Committee on Health')
    expect(hearingCommittee('Transportation and the Environment')).toBe('Committee on Transportation and the Environment')
    expect(hearingCommittee('Committee of the Whole')).toBe('Committee of the Whole')
    expect(hearingCommittee('Legislative Meeting')).toBeNull()
  })

  it('gives every recorded type a kind', async () => {
    expect(hearingKind('Performance Oversight Hearing')).toBe('hearing')
    expect(hearingKind('Roundtable')).toBe('hearing')
    expect(hearingKind('Joint Hearing')).toBe('hearing')
    expect(hearingKind('Committee Mark-up')).toBe('markup')
    expect(hearingKind('Meeting')).toBe('meeting')
    for (const h of events) expect(CALENDAR_KINDS).toContain((await mapHearing(h)).event.kind)
  })

  it('titles a legislative meeting by itself, and keeps agenda bill numbers', async () => {
    expect((await mapHearing(byId(2045))).event).toMatchObject({ title: 'Legislative Meeting', kind: 'meeting', agenda: [{ topic: 'Legislative Meeting', bill_number: null }] })
    expect((await mapHearing(byId(2405))).event.agenda).toEqual([{ topic: 'Soccer Stadium Redevelopment and Maintenance Act of 2026', bill_number: 'B26-0769' }])
    expect((await mapHearing(byId(2420))).event).toMatchObject({ joint_with: 'Joint with Facilities', title: 'Committee of the Whole joint hearing' })
  })

  it('leaves the time out at midnight, and changes the hash when anything shown changes', async () => {
    const base = await mapHearing(byId(2408))
    expect((await mapHearing({ ...byId(2408), hearingDateTime: '2026-10-01T00:00:00' })).event.time).toBeNull()
    for (const change of [{ location: 'Room 500 (Track A)' }, { hearingDateTime: '2026-10-01T11:00:00' }, { topics: [] }]) {
      expect((await mapHearing({ ...byId(2408), ...change })).event.event_hash).not.toBe(base.event.event_hash)
    }
    // A witness signing up isn't a change to the event.
    expect((await mapHearing({ ...byId(2408), witnessesCount: 29 } as LimsHearing)).event.event_hash).toBe(base.event.event_hash)
  })

  it('reads one month per call, and gives each committee the id its referrals get', async () => {
    const { ids, minted } = mintIds()
    const logged: unknown[] = []
    const list = await limsBodyEvents({ from: '2026-10-01', to: '2026-10-31' }, ids, (type, params) => logged.push([type, params]))
    expect(list).toHaveLength(20)
    expect(logged).toEqual([['lims:HearingsCalendar', { year: 2026, month: 10 }]])
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ month: '10', year: '2026', committeeId: 0, searchText: '' })
    const health = list.find(e => e.event_id === '2428')!
    expect(health.committee).toEqual({ committee_id: minted.get(committeeKey('Committee on Health')), name: 'Committee on Health', chamber: 'C' })
    expect(list.find(e => e.event_id === '2045')!.committee).toBeNull()
  })
})

describe('the hearings calendar fails closed', () => {
  const read = () => getHearingsCalendar(10, 2026)

  it('on an HTTP error', async () => {
    answers['2026-10'] = () => new Response('busy', { status: 503 })
    await expect(read()).rejects.toThrow('HTTP 503')
  })

  it('on a body that isn\'t JSON', async () => {
    answers['2026-10'] = () => new Response('<html>maintenance</html>', { status: 200 })
    await expect(read()).rejects.toThrow('isn\'t JSON')
  })

  it('on a body that isn\'t a list of events', async () => {
    answers['2026-10'] = () => json({ hearings: months['2026-10'] })
    await expect(read()).rejects.toThrow('not a list')
    answers['2026-10'] = () => json([{ ...byId(2408), hearingDateTime: null }])
    await expect(read()).rejects.toThrow('without its id and date')
  })

  it('on a key the mapping reads gone missing, rather than reading it as empty', async () => {
    const { location: _gone, ...noLocation } = byId(2408)
    answers['2026-10'] = () => json([noLocation])
    await expect(read()).rejects.toThrow('location of event 2408')
    answers['2026-10'] = () => json([{ ...byId(2405), topics: [{ topic: 'Soccer' }] }])
    await expect(read()).rejects.toThrow('a topic of event 2405')
  })

  it('and reads an empty month as empty', async () => {
    answers['2026-10'] = () => json([])
    await expect(read()).resolves.toEqual([])
  })
})
