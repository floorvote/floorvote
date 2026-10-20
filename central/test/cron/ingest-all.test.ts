import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'

// A provider whose full ingest is cheap (Provider.ingestAll, #835) has every
// changed bill of its states fully ingested, tracked or not, and never-ingested
// bills drain at most `perPass` a pass. Driven through runSnapshotSync with the
// test-only example provider declaring it, against a migrated D1, with the
// ingest run for real between passes. The instance has no keywords, so no bill
// is tracked and every queued ingest is one ingestAll made.
vi.mock('../../src/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers')>()
  const { example } = await import('../providers/example')
  const PROVIDERS = [...actual.PROVIDERS, example]
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
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test') }))
/** Set to make the next ingest fail partway, after its bills upsert and before its calendar write. */
const failNextIngest = { on: false }
/** Bills whose every ingest fails at the same point (a provider that keeps failing them). */
const failingBills = new Set<number>()
vi.mock('../../src/lib/committees', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/committees')>('../../src/lib/committees')
  return {
    ...actual,
    upsertCommittees: vi.fn(async (...args: Parameters<typeof actual.upsertCommittees>) => {
      if (failNextIngest.on) {
        failNextIngest.on = false
        throw new Error('ingest killed partway')
      }
      if (failingBills.has(args[1].bill_id)) throw new Error(`ingest of ${args[1].bill_id} keeps failing`)
      return actual.upsertCommittees(...args)
    }),
  }
})

import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { processIngestorQueue } from '../../src/queue/processor'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { example, exampleFeed, type ExampleRecord } from '../providers/example'
import { PROVIDERS } from '../../src/providers'
import type { Provider } from '../../src/providers'
import migration0049 from '../../migrations/0049_bill_first_ingest_queued_at.sql?raw'

const rec = (n: number, Title = `Measure ${n} Act of 2026`): ExampleRecord => ({
  Number: `B26-${String(n).padStart(4, '0')}`, Title, Status: 'Introduced', Introduced: '2026-01-13',
  Page: `https://legislature.example/bills/${n}`,
  LawNumber: null, EffectiveDate: null, Packet: null, WithdrawnBy: null, InternalId: 0, Attachments: [],
})

/** The example provider declaring ingestAll, with its ingests on a queue of its own. */
const cheap = (perPass: number): Provider => ({ ...example, ingestAll: { perPass }, ingestQueue: 'LIMS_INGESTOR_QUEUE' })

/**
 * `cheap`, with two sessions in the state, as Virginia has. The feed's records
 * numbered B26- are the first session's, and S26- the second's.
 */
const cheapTwoSessions = (perPass: number): Provider => ({
  ...cheap(perPass),
  async listSessions(_state, ctx) {
    const ids = await ctx.ids('session', ['2026', '2026S'])
    return [
      { session_id: ids.get('2026')!, session_name: '2026 Session', session_tag: '2026', year_start: 2026, year_end: 2026, prior: 0, sine_die: 0 },
      { session_id: ids.get('2026S')!, session_name: '2026 Special Session', session_tag: '2026S', year_start: 2026, year_end: 2026, prior: 0, sine_die: 0 },
    ]
  },
  async snapshot(session, ctx) {
    const prefix = session.sessionTag === '2026S' ? 'S26-' : 'B26-'
    const records = exampleFeed.records.filter(r => r.Number.startsWith(prefix))
    const ids = await ctx.ids('bill', records.map(r => r.Number))
    return {
      records: records.map(r => ({ billId: ids.get(r.Number)!, nativeKey: r.Number, raw: r, hash: `${r.Number}:${r.Title}:${r.Status}` })),
    }
  },
})

const mockQueue = () => ({ sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) })
type MockQueue = ReturnType<typeof mockQueue>
const bodies = (q: MockQueue): any[] => [
  ...q.send.mock.calls.map((c: any) => c[0]),
  ...q.sendBatch.mock.calls.flatMap((c: any) => c[0].map((m: any) => m.body)),
]

/**
 * One hourly pass of `provider`, then the ingest of every bill it queued on
 * the provider's own queue (unless `ingest` is false). Returns the bill ids
 * queued there, what the shared queue got, the bill ids the instance was sent
 * as stubs, and the full messages it was sent. `fail` names bills whose
 * ingest runs and fails (a provider that keeps failing them).
 */
async function pass(provider: Provider, opts: { ingest?: boolean; fail?: number[] } = {}) {
  const db = drizzle(env.DB, { schema })
  const own = mockQueue()
  const shared = mockQueue()
  const team = mockQueue()
  const e = {
    ...(env as any), ADMIN_SECRET: 'test-secret',
    INGESTOR_QUEUE: shared, LIMS_INGESTOR_QUEUE: own, [tenantQueueBindingName('team')]: team,
  }
  await runSnapshotSync(provider, e, db)
  const ingests = bodies(own).filter(b => b.calendarRecheck === undefined)
  if (opts.ingest !== false) {
    const messages = ingests.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
    for (const id of opts.fail ?? []) failingBills.add(id)
    try {
      await processIngestorQueue({ messages } as any, e, db)
    } finally {
      failingBills.clear()
    }
    // A failing bill's message runs out of retries here: it is not run again.
    for (const m of messages) expect(m.retry).toHaveBeenCalledTimes(opts.fail?.includes(m.body.billId) ? 1 : 0)
  }
  // What the ingests just sent the instance is full messages; stubs are what the pass sent before them.
  return {
    queued: ingests.map(b => b.billId as number).sort((a, b) => a - b),
    shared: bodies(shared).filter(b => b.calendarRecheck === undefined),
    stubbed: bodies(team).filter(b => b.stubOnly).map(b => Number(String(b.billId).split(':')[1])).sort((a, b) => a - b),
    ingestOrder: ingests.map(b => b.billId as number),
    bodies: ingests,
    full: bodies(team).filter(b => !b.stubOnly),
  }
}

function feed(records: ExampleRecord[]) {
  exampleFeed.records = structuredClone(records)
  exampleFeed.etag = undefined
  exampleFeed.partial = undefined
  exampleFeed.unchanged = undefined
  exampleFeed.hold = undefined
}

async function allBillIds(): Promise<number[]> {
  const rows = await env.DB.prepare(`SELECT bill_id FROM bills WHERE provider = 'example' ORDER BY bill_id`).all<{ bill_id: number }>()
  return rows.results.map(r => r.bill_id)
}

async function ingested(): Promise<number[]> {
  const rows = await env.DB.prepare(`SELECT bill_id FROM bills WHERE provider = 'example' AND texts_fetched_at IS NOT NULL ORDER BY bill_id`)
    .all<{ bill_id: number }>()
  return rows.results.map(r => r.bill_id)
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  feed([])
  exampleFeed.asked = []
  const db = drizzle(env.DB, { schema })
  // No keywords: nothing this instance holds is tracked.
  await db.insert(schema.tenants).values({ tenantId: 'team', name: 'Team', stateCoverage: '["ZZ"]', active: true })
  const { app } = await import('../../src/index')
  const claim = await app.fetch(new Request('http://central/api/admin/state-providers/ZZ', {
    method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'example' }),
  }), { ...(env as any), ADMIN_SECRET: 'test-secret' })
  expect(claim.status).toBe(200)
})

describe('a provider that declares ingestAll', () => {
  it('queues every changed bill already fully ingested, past perPass, and stubs none of them', async () => {
    const records = [1, 2, 3].map(n => rec(n))
    feed(records)
    await pass(cheap(10))
    const ids = await allBillIds()
    expect(await ingested()).toEqual(ids)

    feed(records.map(r => ({ ...r, Title: `${r.Title}, as amended` })))
    const { queued, stubbed, shared, full } = await pass(cheap(1))
    expect(queued).toEqual(ids)
    expect(stubbed).toEqual([])
    expect(shared).toEqual([])
    // Each arrives as the ingest's full message, untracked.
    for (const id of ids) {
      expect(full).toContainEqual(expect.objectContaining({ tenantId: 'team', billId: `legiscan:${id}`, matchType: null }))
    }
  })

  it('queues exactly perPass never-ingested bills a pass, and the rest on later passes, until none remain', async () => {
    feed([1, 2, 3, 4, 5].map(n => rec(n)))
    const counts: number[] = []
    const seen = new Set<number>()
    for (let i = 0; i < 4; i++) {
      const { queued } = await pass(cheap(2))
      counts.push(queued.length)
      for (const id of queued) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
    expect(counts).toEqual([2, 2, 1, 0])
    expect([...seen].sort((a, b) => a - b)).toEqual(await allBillIds())
    expect(await ingested()).toEqual(await allBillIds())
  })

  it('queues at most perPass on a new session\'s first pass, and stubs the rest', async () => {
    feed([1, 2, 3, 4, 5].map(n => rec(n)))
    const { queued, stubbed } = await pass(cheap(2), { ingest: false })
    const ids = await allBillIds()
    expect(ids).toHaveLength(5)
    expect(queued).toHaveLength(2)
    // A bill queued for its ingest gets the full message from it, not a stub.
    expect(stubbed).toEqual(ids.filter(id => !queued.includes(id)))
  })

  it('sends its ingests to the provider\'s own queue, none to the shared one', async () => {
    feed([1, 2, 3].map(n => rec(n)))
    const { queued, shared } = await pass(cheap(10), { ingest: false })
    expect(queued).toEqual(await allBillIds())
    expect(shared).toEqual([])
  })

  it('queues a tracked bill\'s ingest ahead of the backfill', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.keywordRegistry).values({ tenantId: 'team', keyword: 'library' })
    feed([rec(1), rec(2), rec(3, 'Library Hours Act of 2026')])
    const { ingestOrder } = await pass(cheap(10), { ingest: false })
    const tracked = (await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'B26-0003')).get())!.billId
    expect(ingestOrder).toHaveLength(3)
    expect(ingestOrder[0]).toBe(tracked)
  })
})

describe('a never-ingested bill', () => {
  it('gets a quiet first ingest: its backlog of actions and past hearings reaches instances as data, not as changes', async () => {
    const meeting = { Id: 'm1', Date: '2026-01-20', Title: 'Committee hearing', Removed: false }
    const records = [{ ...rec(1), Meetings: [meeting] }]
    feed(records)
    // perPass 0: the first pass only stubs it.
    await pass(cheap(0))
    expect(await ingested()).toEqual([])

    const { queued, full, bodies: sent } = await pass(cheap(10))
    const [id] = await allBillIds()
    expect(queued).toEqual([id])
    const msg = full.find(m => m.billId === `legiscan:${id}`)
    expect(msg).toMatchObject({ matchType: null })
    expect(msg.changes).toBeUndefined()
    expect(msg.calendar?.changes ?? []).toEqual([])
    expect(msg.calendar?.events).toHaveLength(1)
    const logged = await env.DB.prepare('SELECT COUNT(*) AS n FROM bill_change_log WHERE bill_id = ?').bind(id).first<{ n: number }>()
    expect(logged!.n).toBe(0)
    // Queued by the provider, as a first full ingest.
    expect(sent[0]).toMatchObject({ billId: id, queuedBy: 'example', firstFullIngest: true })
  })

  it('stays quiet when its first ingest fails partway and is retried', async () => {
    const meeting = { Id: 'm1', Date: '2026-01-20', Title: 'Committee hearing', Removed: false }
    feed([{ ...rec(1), Meetings: [meeting] }])
    await pass(cheap(0))
    const { bodies: sent } = await pass(cheap(10), { ingest: false })
    const [id] = await allBillIds()

    const team = mockQueue()
    const e = { ...(env as any), [tenantQueueBindingName('team')]: team }
    const db = drizzle(env.DB, { schema })
    failNextIngest.on = true
    const first = sent.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
    await processIngestorQueue({ messages: first } as any, e, db)
    expect(first[0].retry).toHaveBeenCalled()
    // The failed attempt leaves the bill not yet fully ingested.
    expect(await ingested()).toEqual([])

    const retry = sent.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
    await processIngestorQueue({ messages: retry } as any, e, db)
    expect(retry[0].retry).not.toHaveBeenCalled()
    const msg = bodies(team).find(m => m.billId === `legiscan:${id}` && !m.stubOnly)
    expect(msg.changes).toBeUndefined()
    expect(msg.calendar?.changes ?? []).toEqual([])
    const logged = await env.DB.prepare('SELECT COUNT(*) AS n FROM bill_change_log WHERE bill_id = ?').bind(id).first<{ n: number }>()
    expect(logged!.n).toBe(0)
    expect(await ingested()).toEqual([id])
  })

  it('leaves a tracked bill\'s first ingest to its match, loud, even while it waits', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.keywordRegistry).values({ tenantId: 'team', keyword: 'library' })
    feed([rec(1, 'Library Hours Act of 2026')])
    // The match's ingest is queued and hasn't landed by the next pass.
    const matched = await pass(cheap(10), { ingest: false })
    expect(matched.bodies).toHaveLength(1)
    expect(matched.bodies[0].firstFullIngest).toBeUndefined()
    const next = await pass(cheap(10), { ingest: false })
    expect(next.queued).toEqual([])
  })

  it('reports changes as usual once it has had its first ingest', async () => {
    feed([rec(1)])
    await pass(cheap(10))
    const meeting = { Id: 'm1', Date: '2026-01-20', Title: 'Committee hearing', Removed: false }
    feed([{ ...rec(1), Status: 'Enacted', Meetings: [meeting] }])
    const { full, bodies: sent } = await pass(cheap(10))
    expect(sent[0].firstFullIngest).toBeUndefined()
    expect(full[0].changes?.map((c: any) => c.changeType)).toContain('status_change')
  })

  it('whose ingest keeps failing goes behind untried bills, then back to stubs after three passes', async () => {
    feed([1, 2, 3, 4].map(n => rec(n)))
    const ids = (await pass(cheap(0))).stubbed
    expect(ids).toHaveLength(4)
    const [a, b, c, d] = ids
    const passes = []
    for (let i = 0; i < 6; i++) passes.push(await pass(cheap(2), { fail: [a] }))
    expect(passes.map(p => p.queued)).toEqual([[a, b], [c, d], [a], [a], [], []])
    // Given up on, it gets a stub again, so instances hold its current status.
    expect(passes[4].stubbed).toEqual([a])
    expect(passes[5].stubbed).toEqual([])
    expect(await ingested()).toEqual([b, c, d])

    // A later change reaches instances as a stub, not as an ingest.
    feed([{ ...rec(1), Status: 'Enacted' }, rec(2), rec(3), rec(4)])
    const changed = await pass(cheap(2), { fail: [a] })
    expect(changed.queued).toEqual([])
    expect(changed.stubbed).toEqual([a])
  })
})

/** Each bill's first-ingest bookkeeping, by bill id. */
async function firstIngestRows(): Promise<Map<number, { tries: number | null; queuedAt: string | null }>> {
  const rows = await env.DB.prepare(`SELECT bill_id, first_ingest_tries, first_ingest_queued_at FROM bills WHERE provider = 'example'`)
    .all<{ bill_id: number; first_ingest_tries: number | null; first_ingest_queued_at: string | null }>()
  return new Map(rows.results.map(r => [r.bill_id, { tries: r.first_ingest_tries, queuedAt: r.first_ingest_queued_at }]))
}

describe('a first full ingest still waiting in the queue (#835 follow-up)', () => {
  it('is neither queued again nor counted as a try, nor given up on, however many passes it waits', async () => {
    feed([rec(1)])
    const first = await pass(cheap(10), { ingest: false })
    const [id] = await allBillIds()
    expect(first.queued).toEqual([id])
    for (let i = 0; i < 5; i++) {
      const later = await pass(cheap(10), { ingest: false })
      expect(later.queued).toEqual([])
      // Its ingest will send the full bill, so it gets no stub while it waits.
      expect(later.stubbed).toEqual([])
    }
    expect((await firstIngestRows()).get(id)!.tries ?? 0).toBe(0)

    // The message the first pass queued lands its ingest.
    const db = drizzle(env.DB, { schema })
    const e = { ...(env as any), [tenantQueueBindingName('team')]: mockQueue() }
    const messages = first.bodies.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
    await processIngestorQueue({ messages } as any, e, db)
    expect(await ingested()).toEqual([id])
  })

  it('counts against perPass, so the queue never holds more than perPass first ingests of the provider', async () => {
    feed([1, 2, 3, 4, 5].map(n => rec(n)))
    const counts: number[] = []
    for (let i = 0; i < 3; i++) counts.push((await pass(cheap(2), { ingest: false })).queued.length)
    expect(counts).toEqual([2, 0, 0])
  })

  it('is queued again once its message has waited a day, as one lost from the queue', async () => {
    feed([rec(1)])
    await pass(cheap(10), { ingest: false })
    const [id] = await allBillIds()
    await env.DB.prepare(`UPDATE bills SET first_ingest_queued_at = datetime('now', '-25 hours') WHERE bill_id = ?`).bind(id).run()
    const { queued } = await pass(cheap(10), { ingest: false })
    expect(queued).toEqual([id])
    // It never ran, so it has used no try.
    expect((await firstIngestRows()).get(id)!.tries ?? 0).toBe(0)
  })

  it('that runs after an earlier copy landed is skipped without a provider call', async () => {
    feed([rec(1)])
    const first = await pass(cheap(10), { ingest: false })
    const [id] = await allBillIds()
    const db = drizzle(env.DB, { schema })
    const team = mockQueue()
    const e = { ...(env as any), [tenantQueueBindingName('team')]: team }
    await processIngestorQueue({ messages: first.bodies.map(body => ({ body, ack: vi.fn(), retry: vi.fn() })) } as any, e, db)
    expect(await ingested()).toEqual([id])
    const sentBefore = bodies(team).length

    // A duplicate, as a pass before this fix queued while the first one waited,
    // of a bill a pass has stamped as waiting again since (a match's ingest landed it).
    await env.DB.prepare(`UPDATE bills SET first_ingest_queued_at = datetime('now') WHERE bill_id = ?`).bind(id).run()
    const fetchMeasure = vi.spyOn(example, 'fetchMeasure')
    const dup = first.bodies.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
    await processIngestorQueue({ messages: dup } as any, e, db)
    expect(dup[0].ack).toHaveBeenCalled()
    expect(fetchMeasure).not.toHaveBeenCalled()
    expect(bodies(team)).toHaveLength(sentBefore)
    fetchMeasure.mockRestore()
    // It holds no slot in the provider's budget.
    expect((await firstIngestRows()).get(id)!.queuedAt).toBeNull()
  })
})

describe('migration 0049', () => {
  it('holds back the bills an earlier pass already queued, so the first pass after it queues none of them again', async () => {
    feed([1, 2, 3].map(n => rec(n)))
    await pass(cheap(0))
    const [a, b, c] = await allBillIds()
    // As the old code left them: a and b queued and counted at queue time, their messages still waiting.
    await env.DB.prepare(`UPDATE bills SET first_ingest_queued_at = NULL, first_ingest_tries = 2 WHERE bill_id IN (?, ?)`).bind(a, b).run()
    // The migration's data statements (the column and index exist already here).
    const statements = migration0049.split(';').map(q => q.trim()).filter(q => /^\s*(--[^\n]*\n\s*)*UPDATE/i.test(q))
    expect(statements).toHaveLength(1)
    await env.DB.prepare(statements[0]).run()

    // Two still wait, so a perPass of 3 leaves one slot: c.
    const { queued } = await pass(cheap(3), { ingest: false })
    expect(queued).toEqual([c])
    const rows = await firstIngestRows()
    expect(rows.get(a)!.tries).toBeNull()
    expect(rows.get(a)!.queuedAt).not.toBeNull()
  })
})

describe('perPass', () => {
  it('is one budget across all of a provider\'s sessions in a pass', async () => {
    feed([
      ...[1, 2, 3].map(n => rec(n)),
      ...[1, 2, 3].map(n => ({ ...rec(n), Number: `S26-${String(n).padStart(4, '0')}` })),
    ])
    const { queued } = await pass(cheapTwoSessions(4), { ingest: false })
    expect(await allBillIds()).toHaveLength(6)
    expect(queued).toHaveLength(4)
  })
})

describe('the providers that declare ingestAll', () => {
  it('are Maryland and Virginia at 500 a pass and DC at 200, and LegiScan declares nothing', () => {
    const declared = Object.fromEntries(PROVIDERS.filter(p => p.ingestAll).map(p => [p.id, p.ingestAll!.perPass]))
    expect(declared).toEqual({ mga: 500, lis: 500, lims: 200 })
  })
})
