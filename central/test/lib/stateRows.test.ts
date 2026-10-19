import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'
import { PROVIDERS, getProvider } from '../../src/providers'
import { CALL_LOGGING, loadStateRows } from '../../src/lib/stateRows'

// 2026-10-14 11:30 in New York (EDT). Default LegiScan hours: full 5, 13, 23 and raw 7, 9, 11, 15, 17, 19, 21.
const NOW = new Date('2026-10-14T15:30:00Z')
const db = () => drizzle(env.DB, { schema })
const LIMS_STATE = getProvider('lims').states![0]
const MGA_STATE = getProvider('mga').states![0]
const LIS_STATE = getProvider('lis').states![0]

const E: any = { ...env, LIMS_API_KEY: 'test-api-key' }
const NO_KEY: any = { ...env, LIMS_API_KEY: undefined }

async function tenant(id: string, coverage: string[], active = true) {
  await db().insert(schema.tenants).values({ tenantId: id, name: `Team ${id}`, stateCoverage: JSON.stringify(coverage), active } as any)
}
async function session(sessionId: number, state: string, o: Record<string, unknown> = {}) {
  await db().insert(schema.sessions).values({
    sessionId, state, stateId: 1, yearStart: 2026, yearEnd: 2026, sessionTitle: `${state} 2026`, sessionName: `${state} 2026`, ...o,
  } as any)
}
async function owner(state: string, provider: string, o: Record<string, unknown> = {}) {
  await db().insert(schema.stateProviders).values({ state, provider, ...o } as any)
}
async function calls(rows: [string, string][]) {
  await db().insert(schema.apiCallLog).values(rows.map(([callType, loggedAt]) => ({ callType, params: '{}', loggedAt })) as any)
}
const rowFor = async (state: string, e: any = E) => (await loadStateRows(db(), e, NOW)).find(r => r.state === state)!

beforeEach(async () => { await clearDb() })

describe('loadStateRows: which states appear', () => {
  it('is empty when central holds no data', async () => {
    expect(await loadStateRows(db(), E, NOW)).toEqual([])
  })

  it('lists each state a tenant covers once, sorted, and never a wildcard row', async () => {
    await tenant('a', ['RI', 'NJ'])
    await tenant('b', ['RI'])
    await tenant('c', ['*'])
    const rows = await loadStateRows(db(), E, NOW)
    expect(rows.map(r => r.state)).toEqual(['NJ', 'RI'])
  })

  it('counts only active tenants covering the state', async () => {
    await tenant('a', ['RI'])
    await tenant('b', ['RI'])
    await tenant('c', ['RI'], false)
    expect((await rowFor('RI')).tenantCount).toBe(2)
  })

  it('lists a state that has an ownership row or sessions but no tenants', async () => {
    await owner(LIMS_STATE, 'lims')
    await session(1, 'WY')
    const rows = await loadStateRows(db(), E, NOW)
    expect(rows.map(r => r.state)).toEqual([LIMS_STATE, 'WY'].sort())
    expect(rows.every(r => r.tenantCount === 0)).toBe(true)
  })
})

describe('loadStateRows: provider column', () => {
  it('shows a LegiScan-only central as LegiScan, with nothing marked as a problem', async () => {
    await tenant('a', ['RI', 'NJ'])
    await session(1, 'RI', { lastSyncedAt: '2026-10-14 09:00:00' })
    await session(2, 'NJ', { lastSyncedAt: '2026-10-14 09:00:00' })
    for (const r of await loadStateRows(db(), E, NOW)) {
      expect(r.provider).toMatchObject({ id: 'legiscan', name: 'LegiScan', since: null, sinceKind: 'default', undoAvailable: false, otherProviders: [] })
      expect(r.configured.warning).toBeNull()
      expect(r.configured.keyStatus).toBe('not_required')
      expect(r.configured.queue).toBe('default')
      expect(r.schedule.stale).toBe(false)
    }
  })

  it('shows the claim date for a claimed state', async () => {
    await tenant('a', [LIMS_STATE])
    await owner(LIMS_STATE, 'lims', { previousProvider: 'legiscan', claimedAt: '2026-09-01 12:00:00' })
    expect((await rowFor(LIMS_STATE)).provider).toMatchObject({
      id: 'lims', name: getProvider('lims').displayName, since: '2026-09-01T12:00:00.000Z', sinceKind: 'claim', undoAvailable: false,
    })
  })

  it('shows the cutover date and undo available while the latest cutover can be undone', async () => {
    await tenant('a', [LIMS_STATE])
    await owner(LIMS_STATE, 'lims', { previousProvider: 'legiscan', claimedAt: '2026-09-20 08:00:00' })
    await db().insert(schema.cutovers).values({ id: 'c1', state: LIMS_STATE, fromProvider: 'legiscan', toProvider: 'lims', createdAt: '2026-09-20 08:00:00' })
    expect((await rowFor(LIMS_STATE)).provider).toMatchObject({ since: '2026-09-20T08:00:00.000Z', sinceKind: 'cutover', undoAvailable: true })
  })

  it('does not offer undo for a cutover already undone', async () => {
    await owner(LIMS_STATE, 'legiscan', { previousProvider: 'lims', claimedAt: '2026-09-25 08:00:00' })
    await db().insert(schema.cutovers).values({
      id: 'c1', state: LIMS_STATE, fromProvider: 'legiscan', toProvider: 'lims', createdAt: '2026-09-20 08:00:00', undoneAt: '2026-09-25 08:00:00',
    })
    expect((await rowFor(LIMS_STATE)).provider).toMatchObject({ id: 'legiscan', sinceKind: 'claim', undoAvailable: false })
  })

  it('does not offer undo when the state has since moved on from the cutover target', async () => {
    await owner(MGA_STATE, 'mga', { previousProvider: 'lims', claimedAt: '2026-10-01 08:00:00' })
    await db().insert(schema.cutovers).values({ id: 'c1', state: MGA_STATE, fromProvider: 'legiscan', toProvider: 'lims', createdAt: '2026-09-20 08:00:00' })
    expect((await rowFor(MGA_STATE)).provider.undoAvailable).toBe(false)
  })

  it('does not offer undo when the cutover names a provider central does not know', async () => {
    await owner(LIMS_STATE, 'lims')
    await db().insert(schema.cutovers).values({ id: 'c1', state: LIMS_STATE, fromProvider: 'gone', toProvider: 'lims' })
    expect((await rowFor(LIMS_STATE)).provider.undoAvailable).toBe(false)
  })

  it('does not offer undo when the previous provider is no longer configured', async () => {
    await owner(LIS_STATE, 'mga')
    await db().insert(schema.cutovers).values({ id: 'c2', state: LIS_STATE, fromProvider: 'lims', toProvider: 'mga' })
    expect((await rowFor(LIS_STATE, NO_KEY)).provider.undoAvailable).toBe(false)
    expect((await rowFor(LIS_STATE, E)).provider.undoAvailable).toBe(true)
  })

  it('names a state served by two providers by its owner, and lists the other', async () => {
    await tenant('a', [LIMS_STATE])
    await owner(LIMS_STATE, 'lims', { previousProvider: 'legiscan' })
    await session(1, LIMS_STATE, { provider: 'legiscan', lastSyncedAt: '2026-10-01 05:00:00', fullSyncHoursEt: '[3]' })
    await session(2, LIMS_STATE, { provider: 'lims', lastSyncedAt: '2026-10-14 05:00:00' })
    const r = await rowFor(LIMS_STATE)
    expect(r.provider).toMatchObject({ id: 'lims', otherProviders: ['legiscan'] })
    // The schedule is the owner's, not the old provider's override.
    expect(r.schedule.override).toBe(false)
    expect(r.schedule.fullHours).toEqual([5, 13, 23])
    expect(r.schedule.lastRead).toBe('2026-10-14T05:00:00.000Z')
  })

  it('reports an owner central does not know without throwing', async () => {
    await owner('WY', 'retired-provider')
    const r = await rowFor('WY')
    expect(r.provider).toMatchObject({ id: 'retired-provider', name: 'retired-provider' })
    expect(r.configured.warning).not.toBeNull()
  })
})

describe('loadStateRows: configured column', () => {
  it('warns when the owner needs a key and has none', async () => {
    await tenant('a', [LIMS_STATE])
    await owner(LIMS_STATE, 'lims')
    const r = await rowFor(LIMS_STATE, NO_KEY)
    expect(r.configured.keyStatus).toBe('missing')
    expect(r.configured.warning).toMatch(/isn't configured/)
  })

  it('does not warn when the key is set, and never carries the key', async () => {
    await tenant('a', [LIMS_STATE])
    await owner(LIMS_STATE, 'lims')
    const r = await rowFor(LIMS_STATE)
    expect(r.configured.keyStatus).toBe('set')
    expect(r.configured.warning).toBeNull()
    expect(JSON.stringify(await loadStateRows(db(), E, NOW))).not.toContain('test-api-key')
  })

  it('does not warn for a provider that needs no key', async () => {
    await owner(MGA_STATE, 'mga')
    const r = await rowFor(MGA_STATE, NO_KEY)
    expect(r.configured.keyStatus).toBe('not_required')
    expect(r.configured.warning).toBeNull()
  })

  it('shows an own ingest queue when the binding exists, and the shared one when it does not', async () => {
    await owner(MGA_STATE, 'mga')
    await owner(LIMS_STATE, 'lims')
    await owner(LIS_STATE, 'lis')
    const bound: any = { ...E, MGA_INGESTOR_QUEUE: {} }
    expect((await rowFor(MGA_STATE, bound)).configured.queue).toBe('own')
    expect((await rowFor(MGA_STATE, E)).configured.queue).toBe('shared')
    expect((await rowFor(LIMS_STATE, bound)).configured.queue).toBe('shared')
    expect((await rowFor(LIS_STATE, { ...E, LIS_INGESTOR_QUEUE: {} })).configured.queue).toBe('own')
  })
})

describe('loadStateRows: schedule column', () => {
  it('shows default hours, last read, next read, and the last pass counts', async () => {
    await tenant('a', ['RI'])
    await session(1, 'RI', { lastSyncedAt: '2026-10-14 05:00:00' })
    await db().insert(schema.sessionSyncLog).values([
      { sessionId: 1, state: 'RI', sessionName: 'RI 2026', syncedAt: '2026-10-13 23:00:00', billsChecked: 5, billsChanged: 1, billsQueued: 1 },
      { sessionId: 1, state: 'RI', sessionName: 'RI 2026', syncedAt: '2026-10-14 05:00:00', billsChecked: 40, billsChanged: 7, billsQueued: 3 },
    ])
    const r = await rowFor('RI')
    expect(r.schedule).toMatchObject({
      fullHours: [5, 13, 23], rawHours: [7, 9, 11, 15, 17, 19, 21], override: false,
      lastRead: '2026-10-14T05:00:00.000Z',
      // 13:00 ET is the next full pass after 11:30 ET.
      nextRead: '2026-10-14T17:00:00.000Z',
      stale: false,
      lastPass: { billsChecked: 40, billsChanged: 7, billsQueued: 3 },
    })
  })

  it('marks a per-session override and uses its hours', async () => {
    await tenant('a', ['RI'])
    await session(1, 'RI', { lastSyncedAt: '2026-10-14 05:00:00', fullSyncHoursEt: '[12]', rawSyncHoursEt: '[14]' })
    const r = await rowFor('RI')
    expect(r.schedule).toMatchObject({ fullHours: [12], rawHours: [14], override: true, nextRead: '2026-10-14T16:00:00.000Z' })
  })

  it('merges two active sessions hours, and flags an override if either has one', async () => {
    await session(1, 'RI', { fullSyncHoursEt: '[12]' })
    await session(2, 'RI', { yearStart: 2025, yearEnd: 2025 })
    const r = await rowFor('RI')
    expect(r.schedule.fullHours).toEqual([5, 12, 13, 23])
    expect(r.schedule.override).toBe(true)
  })

  it('reads only the full pass hours for a snapshot provider', async () => {
    await owner(MGA_STATE, 'mga')
    await session(1, MGA_STATE, { provider: 'mga', fullSyncHoursEt: '[5]', rawSyncHoursEt: '[12]' })
    const r = await rowFor(MGA_STATE)
    expect(r.schedule.rawHours).toBeNull()
    // Not 12:00 ET (raw), so the next 5:00 ET: 09:00Z the next day.
    expect(r.schedule.nextRead).toBe('2026-10-15T09:00:00.000Z')
  })

  it('has no last read or next read for a state with no session, and is stale', async () => {
    await tenant('a', ['RI'])
    const r = await rowFor('RI')
    expect(r.schedule).toMatchObject({ lastRead: null, nextRead: null, stale: true, lastPass: null, override: false })
  })

  it('marks a provider with no recent sync as stale, and a recent one as not', async () => {
    await tenant('a', [LIMS_STATE, 'RI'])
    await owner(LIMS_STATE, 'lims')
    await session(1, LIMS_STATE, { provider: 'lims', lastSyncedAt: '2026-10-10 05:00:00' })
    await session(2, 'RI', { lastSyncedAt: '2026-10-13 15:31:00' })
    expect((await rowFor(LIMS_STATE)).schedule.stale).toBe(true)
    expect((await rowFor('RI')).schedule.stale).toBe(false)
  })

  it('has no next read when sessions are disabled or concluded', async () => {
    await session(1, 'RI', { syncEnabled: false, lastSyncedAt: '2026-10-14 05:00:00' })
    await session(2, 'NJ', { sineDie: 1, lastSyncedAt: '2026-10-14 05:00:00' })
    expect((await rowFor('RI')).schedule.nextRead).toBeNull()
    expect((await rowFor('NJ')).schedule.nextRead).toBeNull()
  })

  it('reads a malformed hours override as the defaults', async () => {
    await session(1, 'RI', { fullSyncHoursEt: 'not json' })
    expect((await rowFor('RI')).schedule.fullHours).toEqual([5, 13, 23])
  })
})

describe('loadStateRows: after a cutover', () => {
  it('counts the state\'s moved bills still waiting for their first ingest', async () => {
    await owner(LIMS_STATE, 'lims')
    await tenant('a', ['RI'])
    await session(1, LIMS_STATE, { provider: 'lims' })
    const bill = (billId: number, state: string, carriedFrom: string | null) =>
      ({ billId, sessionId: 1, state, stateId: 1, billNumber: `B${billId}`, changeHash: 'h', title: 't', carriedFrom }) as any
    await db().insert(schema.bills).values([
      bill(1, LIMS_STATE, 'legiscan'), bill(2, LIMS_STATE, 'legiscan'), bill(3, LIMS_STATE, null), bill(4, 'RI', 'legiscan'),
    ])
    expect((await rowFor(LIMS_STATE)).waitingFirstIngest).toBe(2)
    expect((await rowFor('RI')).waitingFirstIngest).toBe(1)
  })

  it('is zero when none are waiting', async () => {
    await owner(LIMS_STATE, 'lims')
    expect((await rowFor(LIMS_STATE)).waitingFirstIngest).toBe(0)
  })
})

describe('loadStateRows: calls column', () => {
  const THIS_MONTH = '2026-10-03 10:00:00'
  const LAST_MONTH = '2026-09-30 23:59:59'

  it('counts this month\'s LegiScan calls (no colon), fully logged', async () => {
    await tenant('a', ['RI'])
    await calls([['getBill', THIS_MONTH], ['getBill', THIS_MONTH], ['getBill', LAST_MONTH], ['lims:Members', THIS_MONTH]])
    expect((await rowFor('RI')).calls).toEqual({ provider: 'legiscan', count: 2, coverage: 'full' })
  })

  it('counts LIMS calls by prefix, fully logged, apart from LegiScan\'s and LIS\'s', async () => {
    await owner(LIMS_STATE, 'lims')
    await calls([['lims:Members', THIS_MONTH], ['lims:BulkData', THIS_MONTH], ['lims:BulkData', LAST_MONTH], ['getBill', THIS_MONTH], ['lis:getlegislationtextlistasync', THIS_MONTH]])
    expect((await rowFor(LIMS_STATE)).calls).toEqual({ provider: 'lims', count: 2, coverage: 'full' })
  })

  it('marks Virginia partial, with the calls it does log', async () => {
    await owner(LIS_STATE, 'lis')
    await calls([['lis:getlegislationtextlistasync', THIS_MONTH], ['lis:getlegislationtextbyidasync', THIS_MONTH]])
    expect((await rowFor(LIS_STATE)).calls).toEqual({ provider: 'lis', count: 2, coverage: 'partial' })
  })

  it('marks Maryland not recorded', async () => {
    await owner(MGA_STATE, 'mga')
    expect((await rowFor(MGA_STATE)).calls).toEqual({ provider: 'mga', count: 0, coverage: 'none' })
  })

  it('counts a provider whose id is a prefix of another\'s separately', async () => {
    await owner(MGA_STATE, 'mga')
    await calls([['mgaextra:x', THIS_MONTH]])
    expect((await rowFor(MGA_STATE)).calls.count).toBe(0)
  })

  it('has a logging entry for every provider the registry holds', () => {
    for (const p of PROVIDERS) expect(CALL_LOGGING[p.id], p.id).toBeDefined()
  })
})

describe('loadStateRows: capabilities column', () => {
  it('shows the owner\'s capabilities and the calendar events central holds for the state', async () => {
    await owner(LIMS_STATE, 'lims')
    await session(1, LIMS_STATE, { provider: 'lims' })
    await db().insert(schema.bills).values({ billId: 1, sessionId: 1, state: LIMS_STATE, stateId: 1, billNumber: 'B1', changeHash: 'h', title: 't' } as any)
    await db().insert(schema.billCalendar).values([
      { id: 'e1', billId: 1, date: '2026-11-01' }, { id: 'e2', billId: 1, date: '2026-11-02' }, { id: 'e3', billId: 1, date: '2026-11-03', cancelledAt: '2026-10-01 00:00:00' },
    ] as any)
    const body = (eventId: string, state: string, cancelledAt: string | null = null) =>
      ({ provider: 'lims', eventId, state, kind: 'hearing', date: '2026-11-01', title: 'Hearing', eventHash: 'h', cancelledAt }) as any
    await db().insert(schema.bodyEvents).values([body('x1', LIMS_STATE), body('x2', LIMS_STATE, '2026-10-02 00:00:00'), body('x3', 'RI')])
    const r = await rowFor(LIMS_STATE)
    expect(r.capabilities.bodyEvents).toBe(true)
    expect(r.capabilities.calendarEvents).toEqual({ bill: 2, body: 1 })
  })

  it('shows no body events for a provider without them, and zero calendar events', async () => {
    await tenant('a', ['RI'])
    const r = await rowFor('RI')
    expect(r.capabilities.bodyEvents).toBe(false)
    expect(r.capabilities.deadlines).toBe(true)
    expect(r.capabilities.calendarEvents).toEqual({ bill: 0, body: 0 })
  })
})
