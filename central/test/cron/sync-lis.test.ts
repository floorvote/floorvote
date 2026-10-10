import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import sampleRaw from '../fixtures/lis/20261-sample.json?raw'

vi.mock('../../src/providers/lis/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/lis/client')>('../../src/providers/lis/client')
  return { ...actual, getLisFile: vi.fn(), lisSessionExists: vi.fn() }
})
vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return { ...actual, getBill: vi.fn(), getBillText: vi.fn(), getSessionList: vi.fn().mockResolvedValue([]),
    getMasterListBySession: vi.fn().mockResolvedValue([]), getMasterListRaw: vi.fn().mockResolvedValue([]) }
})
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
vi.stubGlobal('fetch', vi.fn())

import { runSourceSync } from '../../src/cron/sync-sources'
import { processIngestorQueue } from '../../src/queue/processor'
import { lis as lisSource } from '../../src/providers/lis'
import * as lis from '../../src/providers/lis/client'
import * as legiscan from '../../src/providers/legiscan/client'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { nowDb } from '../../src/lib/dbTime'

// Real 2026 rows, served as this year's regular session.
const sample = JSON.parse(sampleRaw) as lis.LisFiles
const THIS_YEAR = Number(nowDb().slice(0, 4))
const CODE = `${THIS_YEAR}1`

function makeEnv(extra: Record<string, unknown> = {}) {
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    ingestor,
    env: { ...(env as any), LIS_STATES: 'VA', INGESTOR_QUEUE: ingestor, [tenantQueueBindingName('team')]: tenantQueue, ...extra },
  }
}

const queuedIds = (q: { sendBatch: ReturnType<typeof vi.fn> }) =>
  q.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId))

beforeEach(async () => {
  await setupLsDb()
  vi.clearAllMocks()
  vi.mocked(lis.lisSessionExists).mockImplementation(async code => code === CODE)
  vi.mocked(lis.getLisFile).mockImplementation(async (code, file) => (code === CODE ? sample[file] : ''))
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'team', name: 'Team', stateCoverage: '["VA"]', active: true })
  await db.insert(schema.keywordRegistry).values([{ tenantId: 'team', keyword: 'minimum wage' }])
})

describe('the Virginia sync', () => {
  it('stores a record per bill, writes the members as people, and queues the matched bills', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e, ingestor } = makeEnv()
    const reports = await runSourceSync(lisSource, e, db)

    const session = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionTag, CODE)).get()
    expect(session).toMatchObject({ state: 'VA', source: 'lis', sessionName: `${THIS_YEAR} Regular Session`, special: 0 })
    expect(reports).toEqual([expect.objectContaining({ records: 6 })])
    expect((await db.select().from(schema.sourceRecords).all()).length).toBe(6)

    const members = await db.select().from(schema.people).where(eq(schema.people.source, 'lis')).all()
    expect(members.length).toBeGreaterThan(100)
    expect(members.find(p => p.name === 'Jeion A. Ward')).toMatchObject({ role: 'Delegate', stateId: 46 })

    const hb1 = await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'HB1')).get()
    expect(hb1).toMatchObject({ source: 'lis', state: 'VA', status: 5 })
    expect(queuedIds(ingestor)).toEqual([hb1!.billId])
  })

  it('does nothing unless LIS_STATES names VA', async () => {
    const db = drizzle(env.DB, { schema })
    expect(await runSourceSync(lisSource, makeEnv({ LIS_STATES: '' }).env, db)).toEqual([])
    expect(lis.getLisFile).not.toHaveBeenCalled()
  })
})

describe('ingesting a Virginia bill', () => {
  it('builds it from the stored record, with per-member votes that resolve to names', async () => {
    const db = drizzle(env.DB, { schema })
    const { env: e } = makeEnv()
    await runSourceSync(lisSource, e, db)
    const hb1 = (await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'HB1')).get())!
    vi.mocked(lis.getLisFile).mockClear()

    const ack = vi.fn(); const retry = vi.fn()
    await processIngestorQueue({ messages: [{ body: { billId: hb1.billId }, ack, retry }] } as any, e, db)
    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
    expect(legiscan.getBill).not.toHaveBeenCalled()
    expect(lis.getLisFile).not.toHaveBeenCalled()

    const { app } = await import('../../src/index-legiscan')
    const res = await app.fetch(new Request(`http://central/api/bills/legiscan:${hb1.billId}`, {
      headers: { 'x-admin-secret': 'test-secret' },
    }), { ...e, ADMIN_SECRET: 'test-secret' })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      status: string; abstract: string
      sponsors: { name: string; url: string | null }[]
      votes: { id: string; counts: { option: string; value: number }[] }[]
      supplements: unknown[]
    }
    expect(body.status).toBe('Approved by the Governor')
    expect(body.abstract).toMatch(/^Minimum wage\./)
    expect(body.sponsors[0]).toMatchObject({ name: 'Jeion A. Ward', url: null })
    expect(body.supplements.length).toBeGreaterThan(0)
    const count = (v: typeof body.votes[0], o: string) => v.counts.find(c => c.option === o)?.value
    const floor = body.votes.find(v => count(v, 'yes') === 64 && count(v, 'no') === 34)!
    expect(floor).toBeDefined()

    // Per-member votes are stored, and every one resolves to a named member.
    const memberVotes = await db.select({ name: schema.people.name, vote: schema.rollCallVotes.voteId })
      .from(schema.rollCallVotes)
      .leftJoin(schema.people, eq(schema.people.peopleId, schema.rollCallVotes.peopleId))
      .where(eq(schema.rollCallVotes.rollCallId, Number(floor.id))).all()
    expect(memberVotes.length).toBe(100)  // the whole House: 64 yes, 34 no, 2 not voting
    expect(memberVotes.every(v => v.name)).toBe(true)
    expect(memberVotes).toContainEqual({ name: 'Jeion A. Ward', vote: 1 })
  })
})
