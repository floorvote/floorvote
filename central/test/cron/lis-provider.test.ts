import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import s2026Raw from '../fixtures/lis/20261-sample.json?raw'
import s2027Raw from '../fixtures/lis/20271-sample.json?raw'

// Virginia from the LIS public data files at the main seam (#301): the
// recorded files in, with the network stubbed at fetch, and central's bill
// API, its labels, and the notifications queued for tenants out.
vi.mock('../../src/lib/rateLimitedFetch', () => ({
  // Unpaced, so each request doesn't cost the test half a second.
  rateLimitedFetch: async (url: string, init: RequestInit | undefined, opts: { onRequest?: () => void }) => {
    const res = await fetch(url, init)
    opts.onRequest?.()
    return res
  },
}))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { processIngestorQueue } from '../../src/queue/processor'
import { lis } from '../../src/providers/lis'
import { LIS_FILES, LIS_FILES_BASE, type LisFile, type LisFiles } from '../../src/providers/lis/client'
import { toHandle } from '../../src/lib/billHandle'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

const s2026 = () => JSON.parse(s2026Raw) as LisFiles
const s2027 = () => JSON.parse(s2027Raw) as LisFiles

/** One served file: its body, ETag, and any headers a test adds. Null is a 404. */
type Served = { text: string; etag: string; headers?: Record<string, string>; status?: number } | null
/** What the stubbed LIS serves, by session code and file. A session left out is a 404 for every file. */
let sessions: Record<string, Partial<Record<LisFile, Served>>>
/** Every request: method, session, and file. */
let calls: { method: string; code: string; file: LisFile | undefined }[]

/** Serve a session's files, each with an ETag of its own. An empty fixture file is one the session doesn't publish. */
function serve(code: string, files: LisFiles, version = 'v1') {
  sessions[code] = Object.fromEntries((Object.keys(LIS_FILES) as LisFile[]).map(file =>
    [file, files[file] ? { text: files[file], etag: `"${code}-${file}-${version}"` } : null]))
}

function makeEnv() {
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    ingestor, tenantQueue,
    env: { ...(env as any), INGESTOR_QUEUE: ingestor, [tenantQueueBindingName('vateam')]: tenantQueue },
  }
}
type Run = ReturnType<typeof makeEnv>

const sentToTenant = (run: Run) => [
  ...run.tenantQueue.send.mock.calls.map(c => c[0]),
  ...run.tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
]
const queuedIds = (run: Run) => run.ingestor.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId as number))
const gets = (code = '20261') => calls.filter(c => c.method === 'GET' && c.code === code).map(c => c.file)
const heads = (code = '20261') => calls.filter(c => c.method === 'HEAD' && c.code === code).map(c => c.file)

async function central(method: string, path: string, run: Run, body?: unknown) {
  const { app } = await import('../../src/index-legiscan')
  return app.fetch(new Request(`http://central/api${path}`, {
    method,
    headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { ...run.env, ADMIN_SECRET: 'test-secret' })
}

async function getJson(path: string, run = makeEnv()) {
  const res = await central('GET', path, run)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

async function claim(provider: string, run = makeEnv()) {
  return central('POST', '/admin/state-providers/VA', run, { provider })
}

/** The central id of a bill by number, in a session (by its tag). */
async function billId(number: string, code = '20261'): Promise<number> {
  const db = drizzle(env.DB, { schema })
  const rows = await db.select({ billId: schema.bills.billId, tag: schema.sessions.sessionTag }).from(schema.bills)
    .innerJoin(schema.sessions, eq(schema.sessions.sessionId, schema.bills.sessionId))
    .where(eq(schema.bills.billNumber, number)).all()
  const row = rows.find(r => r.tag === code)
  if (!row) throw new Error(`no bill ${number} in ${code}`)
  return row.billId
}

/** The hourly Virginia sync, then the ingest of every bill it queued. */
async function syncAndIngest(run = makeEnv()) {
  const db = drizzle(env.DB, { schema })
  await runSnapshotSync(lis, run.env, db)
  const messages = queuedIds(run).map(id => ({ body: { billId: id }, ack: vi.fn(), retry: vi.fn() }))
  if (messages.length > 0) await processIngestorQueue({ messages } as any, run.env, db)
  for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
  return { run, messages }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))   // 5 ET
  await setupLsDb()
  vi.clearAllMocks()
  sessions = {}
  serve('20261', s2026())
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (!url.startsWith(`${LIS_FILES_BASE}/`)) throw new Error(`no network in this test: ${method} ${url}`)
    const [code, name] = url.slice(LIS_FILES_BASE.length + 1).split('/')
    const file = (Object.keys(LIS_FILES) as LisFile[]).find(f => LIS_FILES[f] === name)
    calls.push({ method, code, file })
    const served = file ? sessions[code]?.[file] : null
    if (!served) return new Response('<Error><Code>BlobNotFound</Code></Error>', { status: 404 })
    const headers = { ETag: served.etag, ...served.headers }
    if (served.status) return new Response('server error', { status: served.status })
    return new Response(method === 'HEAD' ? null : served.text, { headers })
  })
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'vateam', name: 'VA Team', stateCoverage: '["VA"]', active: true })
  await db.insert(schema.keywordRegistry).values(['minimum wage', 'daylight', 'procurement'].map(keyword => ({ tenantId: 'vateam', keyword })))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Virginia from the LIS data files', () => {
  it('stays on LegiScan until Virginia is claimed', async () => {
    expect(await runSnapshotSync(lis, makeEnv().env, drizzle(env.DB, { schema }))).toEqual([])
    expect(calls).toEqual([])
  })

  it('syncs Virginia once claimed, with no key, no LegiScan call, and per-member votes', async () => {
    expect((await claim('lis')).status).toBe(200)
    const { run } = await syncAndIngest()
    expect(queuedIds(run).sort()).toEqual([await billId('HB1'), await billId('HB9'), await billId('HB61')].sort())

    const bill = await getJson(`/bills/${toHandle(await billId('HB1'))}`)
    expect(bill).toMatchObject({
      number: 'HB1', state: 'VA', status: 'Approved by the Governor', statusStage: 'enacted', statusRank: 702, billType: 'B',
      stateUrl: 'https://lis.virginia.gov/bill-details/20261/HB1', texts: [],
    })
    // The latest summary is the description, as plain text.
    expect(bill.abstract).toMatch(/^Minimum wage\. Increases the minimum wage/)
    expect(bill.abstract).not.toMatch(/[<>]/)
    expect(bill.sponsors[0]).toMatchObject({ name: 'Jeion A. Ward', primary: true })

    // Every member's vote, named, on the floor vote.
    const count = (v: any, o: string) => v.counts.find((c: any) => c.option === o)?.value
    const floor = bill.votes.find((v: any) => count(v, 'yes') === 64 && count(v, 'no') === 34)
    expect(floor.legislatorVotes).toHaveLength(100)
    expect(floor.legislatorVotes).toContainEqual(expect.objectContaining({ name: 'Jeion A. Ward', vote: 'Yea' }))
    expect(floor.legislatorVotes.every((v: any) => v.name !== v.personId)).toBe(true)

    // Fiscal impact statements are supplements.
    expect(bill.supplements.length).toBeGreaterThan(0)
    expect(bill.supplements.every((s: any) => s.type === 'Fiscal Note' && /^https:\/\/lis\.blob\.core\.windows\.net\/files\/\d+\.PDF$/.test(s.stateLink))).toBe(true)

    // Extras under the provider's name: the chapter, and the earlier summary.
    expect(bill.extras.providerName).toBe('Virginia General Assembly')
    expect(bill.extras.fields.map((f: any) => [f.key, f.label])).toEqual([
      ['chapter', 'Chapter'], ['summaryIntroduced', 'Summary as introduced'],
    ])
    expect(bill.extras.fields[0].value).toBe('Chapter 350 of the 2026 Acts of Assembly')
    expect(bill.extras.fields[1].value).toMatch(/^Minimum wage\./)

    // Referrals point at committees rows, one per chamber and name.
    expect(bill.referrals[0]).toMatchObject({ name: 'Labor and Commerce', chamber: 'H' })
    expect(Number(bill.referrals[0].committeeId)).toBeGreaterThan(3_000_000_000)
    const db = drizzle(env.DB, { schema })
    const committee = await db.select().from(schema.committees).where(eq(schema.committees.committeeId, Number(bill.referrals[0].committeeId))).get()
    expect(committee).toMatchObject({ provider: 'lis', state: 'VA', name: 'Labor and Commerce', chamber: 'H' })

    expect(calls.length).toBeGreaterThan(0)
    const full = sentToTenant(run).filter((m: any) => !m.stubOnly).map((m: any) => m.billId)
    expect(full).toEqual(expect.arrayContaining([toHandle(await billId('HB1')), toHandle(await billId('HB61'))]))
  })

  it('maps every bill to a bill type and status Virginia\'s labels list', async () => {
    await claim('lis')
    await syncAndIngest()
    const db = drizzle(env.DB, { schema })
    const messages = (await db.select({ id: schema.bills.billId }).from(schema.bills).all())
      .map(r => ({ body: { billId: r.id }, ack: vi.fn(), retry: vi.fn() }))
    await processIngestorQueue({ messages } as any, makeEnv().env, db)
    for (const m of messages) expect(m.retry).not.toHaveBeenCalled()

    const labels = await getJson('/bills/labels?state=VA')
    const types = new Set(labels.billTypes.map((t: any) => t.value.toLowerCase()))
    const statuses = new Set(labels.statuses.map((s: any) => s.label))
    const seen = []
    for (const number of ['HB1', 'HB9', 'HB61', 'HB133', 'HB447', 'HR1']) {
      const bill = await getJson(`/bills/${toHandle(await billId(number))}`)
      expect(types.has(String(bill.billType).toLowerCase()), `${number}: ${bill.billType}`).toBe(true)
      expect(statuses.has(bill.status), `${number}: ${bill.status}`).toBe(true)
      seen.push(bill.status)
    }
    expect(seen).toEqual(['Approved by the Governor', 'Continued to next session', 'Vetoed by the Governor', 'Failed', 'Continued to next session', 'Agreed to'])
  })
})

describe('a carried-over bill', () => {
  it('is a new bill in its new session, linked to the one it continues', async () => {
    serve('20271', s2027())
    await claim('lis')
    await syncAndIngest()

    const old = await billId('HB9', '20261')
    const carried = await billId('HB9', '20271')
    expect(carried).not.toBe(old)
    const bill = await getJson(`/bills/${toHandle(carried)}`)
    expect(bill).toMatchObject({ status: 'Continued from last session', statusStage: 'in_committee' })
    expect(bill.relatedBills).toEqual([expect.objectContaining({ identifier: 'HB9', sastBillId: old, relationType: 'carry-over' })])
    expect(await getJson(`/bills/${toHandle(old)}`)).toMatchObject({ status: 'Continued to next session', relatedBills: [] })
  })

  it('links nothing when central never synced the session it came from, and mints no id for it', async () => {
    sessions = {}
    serve('20271', s2027())
    await claim('lis')
    await syncAndIngest()

    const bill = await getJson(`/bills/${toHandle(await billId('HB9', '20271'))}`)
    expect(bill.relatedBills).toEqual([])
    const db = drizzle(env.DB, { schema })
    const keys = (await db.select().from(schema.providerIds).where(eq(schema.providerIds.kind, 'bill')).all()).map(r => r.nativeKey)
    expect(keys.sort()).toEqual(['20271/HB1532', '20271/HB9'])
  })

  it('syncs a session that has no votes, fiscal impact statements, or dockets yet', async () => {
    // 2027's prefile files: HB9's history holds 2026's votes and statements, which stay in 2026's files.
    sessions = {}
    serve('20271', s2027())
    await claim('lis')
    await syncAndIngest()
    expect(gets('20271').sort()).toEqual(Object.keys(LIS_FILES).sort())
    expect(await billId('HB1532', '20271')).toBeGreaterThan(3_000_000_000)
  })
})

describe('failing closed', () => {
  /** A good pass, then the bill API's answer for HB1, to check a failed pass changes nothing. */
  async function firstPass() {
    await claim('lis')
    await syncAndIngest()
    return getJson(`/bills/${toHandle(await billId('HB1'))}`)
  }

  /**
   * A scheduled pass after the files changed (each gets a new ETag, so the
   * pass reads them all), which must fail without writing or sending anything.
   */
  async function failingPass(message: RegExp | string) {
    for (const served of Object.values(sessions['20261'])) if (served) served.etag = `${served.etag}+`
    const db = drizzle(env.DB, { schema })
    const recordsBefore = await db.select().from(schema.providerRecords).all()
    const run = makeEnv()
    await expect(runSnapshotSync(lis, run.env, db)).rejects.toThrow(message)
    expect(queuedIds(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
    expect(await db.select().from(schema.providerRecords).all()).toEqual(recordsBefore)
  }

  const required: LisFile[] = ['history', 'sponsors', 'summaries', 'members', 'committees']
  it.each(required)('fails when %s is missing, rather than rebuilding bills without it', async file => {
    const before = await firstPass()
    sessions['20261'][file] = null
    await failingPass(`LIS 20261: ${LIS_FILES[file]} is missing`)
    expect(await getJson(`/bills/${toHandle(await billId('HB1'))}`)).toEqual(before)
  })

  it('fails on the first pass too, storing nothing', async () => {
    sessions['20261'].sponsors = null
    await claim('lis')
    await failingPass('Sponsors.csv is missing')
    expect(await drizzle(env.DB, { schema }).select().from(schema.bills).all()).toEqual([])
  })

  it('fails when votes are missing but this session\'s history records counted votes', async () => {
    await firstPass()
    sessions['20261'].votes = null
    await failingPass('VOTE.CSV is missing, though the last pass read it')
    // Even with no stored ETags to remember it by (after a claim), the history says it should be there.
    await drizzle(env.DB, { schema }).update(schema.sessions).set({ snapshotEtag: null })
    await failingPass('VOTE.CSV is missing, though this session\'s history records counted votes')
  })

  it('fails when fiscal impact statements are missing but the history records them', async () => {
    await claim('lis')
    sessions['20261'].fiscal = null
    await failingPass('FiscalImpactStatements.csv is missing, though this session\'s history records fiscal impact statements')
  })

  it('fails when a docket file the last pass read goes missing', async () => {
    await firstPass()
    sessions['20261'].dockets = null
    await failingPass('DOCKET.CSV is missing, though the last pass read it')
  })

  it('fails on an empty file the session must publish', async () => {
    await firstPass()
    sessions['20261'].history = { text: '', etag: '"empty"' }
    await failingPass('HISTORY.CSV is missing')
  })

  it('fails on a download shorter than its Content-Length', async () => {
    await firstPass()
    const votes = sessions['20261'].votes!
    votes.headers = { 'Content-Length': String(new TextEncoder().encode(votes.text).byteLength + 500) }
    await failingPass(/20261\/VOTE\.CSV: got \d+ bytes of \d+, so the file is truncated/)
  })

  it('fails on a file that stops mid-row', async () => {
    await firstPass()
    const history = sessions['20261'].history!
    history.text = history.text.slice(0, history.text.length - 20)
    await failingPass('20261/HISTORY.CSV: the file doesn\'t end with a line break, so it is truncated')
    // Cut mid-row but ending with a line break, the row is short a field.
    history.text = `${history.text.slice(0, history.text.lastIndexOf('","'))}"\n`
    await failingPass(/LIS 20261 history: line \d+ has \d fields, not the header's 4/)
  })

  it('fails on a quote that never closes, a renamed column, and an HTTP error', async () => {
    await firstPass()
    const sponsors = sessions['20261'].sponsors!
    const good = sponsors.text
    sponsors.text = `${good}"Jeion A. Ward","H0173","HB2","1 - Chief Patron\n`
    await failingPass(/LIS 20261 sponsors: a quote opened on line \d+ never closes/)
    sponsors.text = good.replace('"PATRON_TYPE"', '"PATRON_KIND"')
    await failingPass('LIS 20261 sponsors: the header has no PATRON_TYPE')
    sponsors.text = good
    sponsors.status = 503
    await failingPass('LIS HTTP 503 for 20261/Sponsors.csv')
  })
})

describe('reading the files with their ETags', () => {
  it('checks every file\'s ETag first, and reads none when nothing changed', async () => {
    await claim('lis')
    await syncAndIngest()
    expect(heads().filter(f => f !== 'bills')).toEqual([])
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
    const before = await getJson(`/bills/${toHandle(await billId('HB1'))}`)

    calls = []
    await runSnapshotSync(lis, makeEnv().env, drizzle(env.DB, { schema }))
    // At 5 ET the session list refreshes too, which checks BILLS.CSV once more.
    expect([...new Set(heads())].sort()).toEqual(Object.keys(LIS_FILES).sort())
    expect(gets()).toEqual([])
    expect(await getJson(`/bills/${toHandle(await billId('HB1'))}`)).toEqual(before)
  })

  it('reads every file when one changed, and checks against the new ETags next time', async () => {
    await claim('lis')
    await syncAndIngest()

    const files = s2026()
    files.bills = files.bills.replace('Minimum wage; increases', 'Minimum wage; raises')
    serve('20261', files)
    sessions['20261'].bills!.etag = '"20261-bills-v2"'
    calls = []
    const { run } = await syncAndIngest()
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
    expect(queuedIds(run)).toEqual([await billId('HB1')])
    expect((await getJson(`/bills/${toHandle(await billId('HB1'))}`)).title).toMatch(/^Minimum wage; raises/)

    calls = []
    await runSnapshotSync(lis, makeEnv().env, drizzle(env.DB, { schema }))
    expect(gets()).toEqual([])
  })

  it('reads every file when one appears or goes, or is served without an ETag', async () => {
    await claim('lis')
    await syncAndIngest()

    sessions['20261'].subdockets = null
    calls = []
    // A subdocket file the last pass read can't go missing: the pass reads, then fails closed.
    await expect(runSnapshotSync(lis, makeEnv().env, drizzle(env.DB, { schema }))).rejects.toThrow('SUBDOCKET.CSV is missing')
    expect(gets()).toContain('bills')

    serve('20261', s2026())
    calls = []
    await syncAndIngest()
    sessions['20261'].members!.etag = ''
    calls = []
    await runSnapshotSync(lis, makeEnv().env, drizzle(env.DB, { schema }))
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
  })

  it('reads in full on a forced run, and after Virginia is claimed again', async () => {
    await claim('lis')
    await syncAndIngest()

    calls = []
    expect((await central('POST', '/admin/providers/lis/sync', makeEnv())).status).toBe(200)
    expect(heads().filter(f => f !== 'bills')).toEqual([])
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())

    const db = drizzle(env.DB, { schema })
    await db.delete(schema.billTenants)
    expect((await claim('legiscan')).status).toBe(200)
    expect((await claim('lis')).status).toBe(200)
    calls = []
    await runSnapshotSync(lis, makeEnv().env, db)
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
  })
})
