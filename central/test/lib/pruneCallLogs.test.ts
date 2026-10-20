import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'
import { CALL_LOG_RETENTION_DAYS, pruneCallLogs } from '../../src/lib/pruneCallLogs'
import { legiscanCallsThisMonth } from '../../src/lib/legiscanBudget'
import { loadStateRows } from '../../src/lib/stateRows'
import { app } from '../../src/index'

// 2026-10-14 15:30:00 UTC. The cutoff is that moment CALL_LOG_RETENTION_DAYS back.
const NOW = new Date('2026-10-14T15:30:00Z')
const db = () => drizzle(env.DB, { schema })
const at = (offsetSeconds: number) => new Date(NOW.getTime() - CALL_LOG_RETENTION_DAYS * 86_400_000 + offsetSeconds * 1000)
  .toISOString().slice(0, 19).replace('T', ' ')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')

async function calls(rows: [string, string][]) {
  await db().insert(schema.apiCallLog).values(rows.map(([callType, loggedAt]) => ({ callType, params: '{}', loggedAt })) as any)
}
async function ticks(rows: [string, number, string][]) {
  await db().insert(schema.sessionSyncLog).values(rows.map(([state, sessionId, syncedAt]) => ({
    state, sessionId, sessionName: `${state} 2026`, syncedAt, billsChecked: 3, billsChanged: 1, billsQueued: 1,
  })) as any)
}
// n rows, each a second apart, all well past the cutoff.
const oldSecond = (i: number) => new Date(NOW.getTime() - (CALL_LOG_RETENTION_DAYS + 30) * 86_400_000 - i * 1000).toISOString().slice(0, 19).replace('T', ' ')
const callTimes = async () => (await db().select().from(schema.apiCallLog).all()).map(r => r.loggedAt).sort()
const tickTimes = async () => (await db().select().from(schema.sessionSyncLog).all()).map(r => r.syncedAt).sort()

beforeEach(async () => { await clearDb() })

describe('pruneCallLogs: retention window', () => {
  it('keeps the logs for longer than the longest window anything reads (the Budget page\'s 90 days)', () => {
    expect(CALL_LOG_RETENTION_DAYS).toBeGreaterThanOrEqual(90 + 14)
  })

  it('does nothing on empty tables', async () => {
    expect(await pruneCallLogs(db(), NOW)).toEqual({ apiCallLog: 0, sessionSyncLog: 0 })
    expect(await callTimes()).toEqual([])
    expect(await tickTimes()).toEqual([])
  })

  it('deletes api_call_log rows older than the cutoff and keeps newer ones', async () => {
    await calls([['getBill', daysAgo(400)], ['lims:Members', daysAgo(200)], ['getBill', daysAgo(10)], ['getBill', daysAgo(0)]])
    expect(await pruneCallLogs(db(), NOW)).toMatchObject({ apiCallLog: 2 })
    expect(await callTimes()).toEqual([daysAgo(10), daysAgo(0)].sort())
  })

  it('deletes session_sync_log rows older than the cutoff and keeps newer ones', async () => {
    await ticks([['RI', 1, daysAgo(400)], ['RI', 1, daysAgo(200)], ['RI', 1, daysAgo(10)], ['NJ', 2, daysAgo(0)]])
    expect(await pruneCallLogs(db(), NOW)).toMatchObject({ sessionSyncLog: 2 })
    expect(await tickTimes()).toEqual([daysAgo(10), daysAgo(0)].sort())
  })

  it('keeps a row exactly at the cutoff and one second inside, and deletes one second past it', async () => {
    await calls([['getBill', at(-1)], ['getBill', at(0)], ['getBill', at(1)]])
    await ticks([['RI', 1, at(-1)], ['RI', 1, at(0)], ['RI', 1, at(1)]])
    await pruneCallLogs(db(), NOW)
    expect(await callTimes()).toEqual([at(0), at(1)])
    expect(await tickTimes()).toEqual([at(0), at(1)])
  })

  it('prunes both tables in one run, and reports what each lost', async () => {
    await calls([['getBill', daysAgo(300)], ['getBill', daysAgo(1)]])
    await ticks([['RI', 1, daysAgo(300)], ['RI', 1, daysAgo(300)], ['RI', 1, daysAgo(1)]])
    expect(await pruneCallLogs(db(), NOW)).toEqual({ apiCallLog: 1, sessionSyncLog: 2 })
  })

  it('removes rows stored in the older ISO format once they are well past the cutoff, and never early', async () => {
    const iso = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
    await calls([['getBill', iso(CALL_LOG_RETENTION_DAYS + 5)], ['getBill', iso(CALL_LOG_RETENTION_DAYS - 5)]])
    await pruneCallLogs(db(), NOW)
    expect(await callTimes()).toEqual([iso(CALL_LOG_RETENTION_DAYS - 5)])
  })

  it('is idempotent: a second run right after deletes nothing', async () => {
    await calls([['getBill', daysAgo(300)], ['getBill', daysAgo(1)]])
    await pruneCallLogs(db(), NOW)
    expect(await pruneCallLogs(db(), NOW)).toEqual({ apiCallLog: 0, sessionSyncLog: 0 })
    expect(await callTimes()).toEqual([daysAgo(1)])
  })

  it('works through a backlog bigger than one delete batch, across both tables', async () => {
    for (let i = 0; i < 6; i++) {
      await env.DB.batch(Array.from({ length: 80 }, (_, j) => env.DB.prepare(
        `INSERT INTO api_call_log (logged_at, call_type, params) VALUES (?, 'getBill', '{}')`).bind(oldSecond(i * 80 + j))))
      await env.DB.batch(Array.from({ length: 80 }, (_, j) => env.DB.prepare(
        `INSERT INTO session_sync_log (synced_at, state, session_id, session_name) VALUES (?, 'RI', 1, 'RI 2026')`).bind(oldSecond(i * 80 + j))))
    }
    await calls([['getBill', daysAgo(1)]])
    await ticks([['RI', 1, daysAgo(1)]])
    const r = await pruneCallLogs(db(), NOW, { batchSize: 100 })
    expect(r).toEqual({ apiCallLog: 480, sessionSyncLog: 480 })
    expect(await callTimes()).toEqual([daysAgo(1)])
    expect(await tickTimes()).toEqual([daysAgo(1)])
  })

  it('stops after its batch limit, leaves the rest for the next run, and never touches rows inside the window', async () => {
    await env.DB.batch(Array.from({ length: 90 }, (_, i) => env.DB.prepare(
      `INSERT INTO api_call_log (logged_at, call_type, params) VALUES (?, 'getBill', '{}')`).bind(oldSecond(i))))
    await calls([['getBill', daysAgo(1)]])
    expect(await pruneCallLogs(db(), NOW, { batchSize: 25, maxBatches: 2 })).toEqual({ apiCallLog: 50, sessionSyncLog: 0 })
    expect((await callTimes()).length).toBe(41)
    expect(await pruneCallLogs(db(), NOW, { batchSize: 25, maxBatches: 2 })).toEqual({ apiCallLog: 40, sessionSyncLog: 0 })
    expect(await callTimes()).toEqual([daysAgo(1)])
  })

  it('deletes an exact multiple of the batch size without looping forever', async () => {
    await env.DB.batch(Array.from({ length: 50 }, (_, i) => env.DB.prepare(
      `INSERT INTO api_call_log (logged_at, call_type, params) VALUES (?, 'getBill', '{}')`).bind(oldSecond(i))))
    expect(await pruneCallLogs(db(), NOW, { batchSize: 25 })).toEqual({ apiCallLog: 50, sessionSyncLog: 0 })
  })

  it('deletes a burst of rows sharing one second together, even past the batch size, and still every older row', async () => {
    const burst = oldSecond(0)
    await env.DB.batch([
      ...Array.from({ length: 60 }, () => env.DB.prepare(
        `INSERT INTO api_call_log (logged_at, call_type, params) VALUES (?, 'getBill', '{}')`).bind(burst)),
      ...Array.from({ length: 10 }, (_, i) => env.DB.prepare(
        `INSERT INTO api_call_log (logged_at, call_type, params) VALUES (?, 'getBill', '{}')`).bind(oldSecond(100 + i))),
    ])
    await calls([['getBill', daysAgo(1)]])
    expect(await pruneCallLogs(db(), NOW, { batchSize: 25 })).toEqual({ apiCallLog: 70, sessionSyncLog: 0 })
    expect(await callTimes()).toEqual([daysAgo(1)])
  })

  it('leaves other tables alone', async () => {
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('k', 'v')`).run()
    await env.DB.prepare(`INSERT INTO bill_change_log (bill_id, change_type, detected_at) VALUES (1, 'status', ?)`).bind(daysAgo(300)).run()
    const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n
    const before = [await count('settings'), await count('bill_change_log')]
    await calls([['getBill', daysAgo(300)]])
    await pruneCallLogs(db(), NOW)
    expect([await count('settings'), await count('bill_change_log')]).toEqual(before)
  })
})

describe('pruneCallLogs: what readers see inside the window', () => {
  async function seedWindow() {
    await env.DB.prepare(`INSERT INTO tenants (tenant_id, name, state_coverage, active) VALUES ('a', 'Team a', '["RI"]', 1)`).run()
    await env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name, provider)
      VALUES (1, 1, 'RI', 2026, 2026, '', 'Regular', 'RI 2026', 'legiscan')`).run()
    // Inside the window: this month's calls, calls back to 100 days ago, and passes over the same span.
    await calls([['getBill', '2026-10-02 05:00:00'], ['getBill', '2026-10-09 05:00:00'], ['lims:Members', '2026-10-10 05:00:00'],
      ['getBill', daysAgo(30)], ['getBill', daysAgo(95)], ['getBill', daysAgo(CALL_LOG_RETENTION_DAYS - 1)]])
    await ticks([['RI', 1, daysAgo(60)], ['RI', 1, '2026-10-13 23:00:00'], ['RI', 1, '2026-10-14 05:00:00'], ['RI', 1, daysAgo(CALL_LOG_RETENTION_DAYS - 1)]])
  }
  async function seedOutside() {
    await calls([['getBill', daysAgo(CALL_LOG_RETENTION_DAYS + 1)], ['getBill', daysAgo(400)], ['lims:Members', daysAgo(250)]])
    await ticks([['RI', 1, daysAgo(CALL_LOG_RETENTION_DAYS + 1)], ['RI', 1, daysAgo(500)]])
  }
  const stateRowsOf = async () => JSON.parse(JSON.stringify(await loadStateRows(db(), { ...env, LIMS_API_KEY: 'k' } as any, NOW)))

  it('leaves the States rows exactly as they were', async () => {
    await seedWindow()
    await seedOutside()
    const before = await stateRowsOf()
    const r = await pruneCallLogs(db(), NOW)
    expect(r.apiCallLog + r.sessionSyncLog).toBe(5)
    expect(await stateRowsOf()).toEqual(before)
    const ri = before.find((x: any) => x.state === 'RI')
    expect(ri.schedule.lastPass).toMatchObject({ billsChecked: 3 })
  })

  it('leaves the Budget count of this month\'s LegiScan calls unchanged', async () => {
    await seedWindow()
    await seedOutside()
    const before = await legiscanCallsThisMonth(db(), NOW)
    expect(before).toBe(2)
    await pruneCallLogs(db(), NOW)
    expect(await legiscanCallsThisMonth(db(), NOW)).toBe(before)
  })

  it('leaves the Budget page\'s 90-day series (the longest window read) unchanged', async () => {
    await seedWindow()
    await seedOutside()
    const start = daysAgo(89).slice(0, 10) + ' 00:00:00'
    const series = async () => (await env.DB.prepare(
      `SELECT substr(logged_at, 1, 10) AS d, COUNT(*) AS n FROM api_call_log WHERE logged_at >= ? AND call_type NOT LIKE '%:%' GROUP BY d ORDER BY d`)
      .bind(start).all()).results
    const before = await series()
    expect(before.length).toBeGreaterThan(0)
    await pruneCallLogs(db(), NOW)
    expect(await series()).toEqual(before)
  })
})

describe('pruneCallLogs: a session\'s newest pass is kept', () => {
  const sessionRow = (sessionId: number, state: string) => env.DB.prepare(
    `INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name, provider)
     VALUES (?, 1, ?, 2026, 2026, '', 'Regular', ?, 'legiscan')`).bind(sessionId, state, `${state} 2026`).run()
  const syncStates = async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/sync/states', { headers: { Authorization: 'Bearer sek' } }), { ...env, ADMIN_SECRET: 'sek' } as any)
    return (await res.json() as any).data.states as { state: string; lastSyncedAt: string | null }[]
  }

  it('keeps the only pass of a state whose last pass is 200 days old, on the States page and the Sync page', async () => {
    await sessionRow(1, 'RI')
    await ticks([['RI', 1, daysAgo(200)]])
    const r = await pruneCallLogs(db(), NOW)
    expect(r.sessionSyncLog).toBe(0)
    expect(await tickTimes()).toEqual([daysAgo(200)])
    const ri = (await loadStateRows(db(), { ...env, LIMS_API_KEY: 'k' } as any, NOW)).find(x => x.state === 'RI')!
    expect(ri.schedule.lastPass).toMatchObject({ billsChecked: 3 })
    expect((await syncStates()).find(x => x.state === 'RI')!.lastSyncedAt).toBe(daysAgo(200))
  })

  it('with an old and a new pass of one session, deletes only the old one', async () => {
    await ticks([['RI', 1, daysAgo(300)], ['RI', 1, daysAgo(200)], ['RI', 1, daysAgo(1)]])
    expect(await pruneCallLogs(db(), NOW)).toMatchObject({ sessionSyncLog: 2 })
    expect(await tickTimes()).toEqual([daysAgo(1)])
  })

  it('keeps each session\'s newest pass independently, and a tie goes to the later row', async () => {
    await ticks([['RI', 1, daysAgo(300)], ['RI', 1, daysAgo(250)], ['NJ', 2, daysAgo(400)],
      ['NJ', 3, daysAgo(210)], ['NJ', 3, daysAgo(210)]])
    await pruneCallLogs(db(), NOW)
    const rows = (await db().select().from(schema.sessionSyncLog).all()).sort((a, b) => a.id - b.id)
    expect(rows.map(r => [r.sessionId, r.syncedAt])).toEqual([[1, daysAgo(250)], [2, daysAgo(400)], [3, daysAgo(210)]])
    expect(rows[2].id).toBe(Math.max(...rows.map(r => r.id)))
  })

  it('still prunes past a batch made only of kept rows', async () => {
    // Four stale sessions each hold their one newest pass, older than all the deletable rows' batch boundary.
    await ticks([['A', 10, daysAgo(900)], ['A', 11, daysAgo(899)], ['A', 12, daysAgo(898)], ['A', 13, daysAgo(897)]])
    await env.DB.batch(Array.from({ length: 30 }, (_, i) => env.DB.prepare(
      `INSERT INTO session_sync_log (synced_at, state, session_id, session_name) VALUES (?, 'RI', 1, 'RI 2026')`).bind(oldSecond(i))))
    await ticks([['RI', 1, daysAgo(1)]])
    expect(await pruneCallLogs(db(), NOW, { batchSize: 4 })).toMatchObject({ sessionSyncLog: 30 })
    expect((await tickTimes()).length).toBe(5)
  })
})
