import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import { getProvider } from '../../src/providers'
import { loadStateRows } from '../../src/lib/stateRows'

// The last pass the States page shows carries its time, whether it finished or
// failed, and the error when it failed. A failed pass is the last pass, but it is
// not a read: a provider that fails every hour is still a state nobody has read.

const NOW = new Date('2026-10-14T15:30:00Z')
const db = () => drizzle(env.DB, { schema })
const LIMS_STATE = getProvider('lims').states![0]
const E: any = { ...env, LIMS_API_KEY: 'test-api-key' }

async function session(sessionId: number, state: string, provider: string, o: Record<string, unknown> = {}) {
  await db().insert(schema.sessions).values({
    sessionId, state, stateId: 1, yearStart: 2026, yearEnd: 2026, sessionTitle: `${state} 2026`, sessionName: `${state} 2026`, provider, ...o,
  } as any)
}
async function pass(sessionId: number, state: string, syncedAt: string, o: Record<string, unknown> = {}) {
  await db().insert(schema.sessionSyncLog).values({
    sessionId, state, sessionName: `${state} 2026`, syncedAt, billsChecked: 5, billsChanged: 1, billsQueued: 1, ...o,
  } as any)
}
const row = async (state: string) => (await loadStateRows(db(), E, NOW)).find(r => r.state === state)!

beforeEach(async () => {
  await setupLsDb()
  await db().insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims' } as any)
})

describe('loadStateRows: the last pass\'s time, status, and error', () => {
  it('carries the pass\'s time as ISO, with status ok and no error for a pass that finished', async () => {
    await session(1, 'RI', 'legiscan')
    await pass(1, 'RI', '2026-10-14 05:00:00', { billsChecked: 40, billsChanged: 7, billsQueued: 3 })
    expect((await row('RI')).schedule.lastPass).toEqual({
      at: '2026-10-14T05:00:00.000Z', status: 'ok', error: null, billsChecked: 40, billsChanged: 7, billsQueued: 3,
    })
  })

  it('carries a failed pass as failed with its error', async () => {
    await session(1, LIMS_STATE, 'lims')
    await pass(1, LIMS_STATE, '2026-10-14 05:00:00', { status: 'failed', error: 'Error: LIMS is down', billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    expect((await row(LIMS_STATE)).schedule.lastPass).toEqual({
      at: '2026-10-14T05:00:00.000Z', status: 'failed', error: 'Error: LIMS is down', billsChecked: 0, billsChanged: 0, billsQueued: 0,
    })
  })

  it('shows a failure newer than the last good pass', async () => {
    await session(1, LIMS_STATE, 'lims')
    await pass(1, LIMS_STATE, '2026-10-14 05:00:00', { billsChecked: 40 })
    await pass(1, LIMS_STATE, '2026-10-14 13:00:00', { status: 'failed', error: 'boom', billsChecked: 0 })
    expect((await row(LIMS_STATE)).schedule.lastPass).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('shows a good pass newer than the last failure', async () => {
    await session(1, LIMS_STATE, 'lims')
    await pass(1, LIMS_STATE, '2026-10-14 05:00:00', { status: 'failed', error: 'boom', billsChecked: 0 })
    await pass(1, LIMS_STATE, '2026-10-14 13:00:00', { billsChecked: 40 })
    expect((await row(LIMS_STATE)).schedule.lastPass).toMatchObject({ status: 'ok', error: null, billsChecked: 40 })
  })

  it('breaks a tie on the time between a failure and a pass by the later row', async () => {
    await session(1, LIMS_STATE, 'lims')
    await pass(1, LIMS_STATE, '2026-10-14 05:00:00', { billsChecked: 40 })
    await pass(1, LIMS_STATE, '2026-10-14 05:00:00', { status: 'failed', error: 'boom', billsChecked: 0 })
    expect((await row(LIMS_STATE)).schedule.lastPass).toMatchObject({ status: 'failed' })
  })

  it('shows the newest pass across sessions, a failed session\'s included', async () => {
    await session(1, LIMS_STATE, 'lims')
    await session(2, LIMS_STATE, 'lims', { yearStart: 2025, yearEnd: 2025 })
    await pass(1, LIMS_STATE, '2026-10-14 05:00:00', { billsChecked: 40 })
    await pass(2, LIMS_STATE, '2026-10-14 07:00:00', { status: 'failed', error: 'boom', billsChecked: 0 })
    expect((await row(LIMS_STATE)).schedule.lastPass).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('ignores a failed pass of a session the state\'s owner does not own', async () => {
    await session(1, LIMS_STATE, 'lims')
    await session(2, LIMS_STATE, 'legiscan')
    await pass(1, LIMS_STATE, '2026-10-14 05:00:00', { billsChecked: 40 })
    await pass(2, LIMS_STATE, '2026-10-14 13:00:00', { status: 'failed', error: 'old provider', billsChecked: 0 })
    expect((await row(LIMS_STATE)).schedule.lastPass).toMatchObject({ status: 'ok', billsChecked: 40 })
  })

  it('has no last pass for a state that has none, as before', async () => {
    await session(1, 'RI', 'legiscan')
    expect((await row('RI')).schedule.lastPass).toBeNull()
  })
})

describe('loadStateRows: a failed pass is not a read', () => {
  it('keeps the last read at the last session stamp and the state stale, when only failures are logged', async () => {
    await session(1, LIMS_STATE, 'lims', { lastSyncedAt: null })
    await pass(1, LIMS_STATE, '2026-10-14 13:00:00', { status: 'failed', error: 'boom', billsChecked: 0 })
    const r = await row(LIMS_STATE)
    expect(r.schedule.lastRead).toBeNull()
    expect(r.schedule.stale).toBe(true)
  })

  it('keeps the last read at the last good pass when a later one failed', async () => {
    await session(1, LIMS_STATE, 'lims', { lastSyncedAt: null })
    await pass(1, LIMS_STATE, '2026-10-12 05:00:00')
    await pass(1, LIMS_STATE, '2026-10-14 13:00:00', { status: 'failed', error: 'boom', billsChecked: 0 })
    const r = await row(LIMS_STATE)
    expect(r.schedule.lastRead).toBe('2026-10-12T05:00:00.000Z')
    // More than 48 hours before NOW.
    expect(r.schedule.stale).toBe(true)
  })

  it('still counts a pass that finished as a read', async () => {
    await session(1, LIMS_STATE, 'lims', { lastSyncedAt: null })
    await pass(1, LIMS_STATE, '2026-10-14 13:00:00')
    const r = await row(LIMS_STATE)
    expect(r.schedule.lastRead).toBe('2026-10-14T13:00:00.000Z')
    expect(r.schedule.stale).toBe(false)
  })

  it('counts a pass that finished with nothing as a read', async () => {
    await session(1, LIMS_STATE, 'lims', { lastSyncedAt: null })
    await pass(1, LIMS_STATE, '2026-10-14 13:00:00', { billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    expect((await row(LIMS_STATE)).schedule.lastRead).toBe('2026-10-14T13:00:00.000Z')
  })
})
