import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'
import { getProvider } from '../../src/providers'
import { loadStateRows } from '../../src/lib/stateRows'

// "Last pass" on the States page is the newest logged pass among the sessions of
// the provider that owns the state. These pin which pass that is, so the query
// that finds it can change how it reads the log without changing the answer.

const NOW = new Date('2026-10-14T15:30:00Z')
const db = () => drizzle(env.DB, { schema })
const LIMS_STATE = getProvider('lims').states![0]
const E: any = { ...env, LIMS_API_KEY: 'test-api-key' }

async function session(sessionId: number, state: string, provider: string) {
  await db().insert(schema.sessions).values({
    sessionId, state, stateId: 1, yearStart: 2026, yearEnd: 2026, sessionTitle: `${state} 2026`, sessionName: `${state} 2026`, provider,
  } as any)
}
async function pass(sessionId: number, state: string, syncedAt: string, checked: number) {
  await db().insert(schema.sessionSyncLog).values({
    sessionId, state, sessionName: `${state} 2026`, syncedAt, billsChecked: checked, billsChanged: 0, billsQueued: 0,
  } as any)
}
const lastPass = async (state: string) =>
  (await loadStateRows(db(), E, NOW)).find(r => r.state === state)!.schedule.lastPass

beforeEach(async () => { await clearDb() })

describe('loadStateRows: which logged pass is the last pass', () => {
  it('is the newest pass across the owner\'s sessions in the state', async () => {
    await session(1, 'RI', 'legiscan')
    await session(2, 'RI', 'legiscan')
    await pass(1, 'RI', '2026-10-14 05:00:00', 11)
    await pass(2, 'RI', '2026-10-14 07:00:00', 22)
    await pass(1, 'RI', '2026-10-13 05:00:00', 33)
    expect(await lastPass('RI')).toMatchObject({ billsChecked: 22 })
  })

  it('breaks a tie on the time by the later row', async () => {
    await session(1, 'RI', 'legiscan')
    await session(2, 'RI', 'legiscan')
    await pass(1, 'RI', '2026-10-14 05:00:00', 11)
    await pass(2, 'RI', '2026-10-14 05:00:00', 22)
    expect(await lastPass('RI')).toMatchObject({ billsChecked: 22 })
  })

  it('keeps each state\'s pass to itself', async () => {
    await session(1, 'RI', 'legiscan')
    await session(2, 'NJ', 'legiscan')
    await pass(1, 'RI', '2026-10-14 05:00:00', 11)
    await pass(2, 'NJ', '2026-10-13 05:00:00', 22)
    expect(await lastPass('RI')).toMatchObject({ billsChecked: 11 })
    expect(await lastPass('NJ')).toMatchObject({ billsChecked: 22 })
  })

  it('ignores passes of a session the state\'s owner does not own, even when newer', async () => {
    await db().insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims' } as any)
    await session(1, LIMS_STATE, 'lims')
    await session(2, LIMS_STATE, 'legiscan')
    await pass(1, LIMS_STATE, '2026-10-13 05:00:00', 11)
    await pass(2, LIMS_STATE, '2026-10-14 05:00:00', 22)
    expect(await lastPass(LIMS_STATE)).toMatchObject({ billsChecked: 11 })
  })

  it('is null when only another provider\'s sessions logged a pass', async () => {
    await db().insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims' } as any)
    await session(1, LIMS_STATE, 'lims')
    await session(2, LIMS_STATE, 'legiscan')
    await pass(2, LIMS_STATE, '2026-10-14 05:00:00', 22)
    expect(await lastPass(LIMS_STATE)).toBeNull()
  })

  it('is null for a session that never logged a pass, and counts a LegiScan session of a state with no ownership row', async () => {
    await session(1, 'RI', 'legiscan')
    await session(2, 'NJ', 'legiscan')
    await pass(2, 'NJ', '2026-10-14 05:00:00', 5)
    expect(await lastPass('RI')).toBeNull()
    expect(await lastPass('NJ')).toMatchObject({ billsChecked: 5 })
  })

  it('reads an older session\'s pass when it is the newest the state has', async () => {
    await session(1, 'RI', 'legiscan')
    await session(2, 'RI', 'legiscan')
    await pass(1, 'RI', '2026-09-01 05:00:00', 11)
    expect(await lastPass('RI')).toMatchObject({ billsChecked: 11 })
  })
})
