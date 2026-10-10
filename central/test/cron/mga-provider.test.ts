import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import sampleRaw from '../fixtures/mga/2026RS-sample.json?raw'

// Maryland from the General Assembly's session file at the main seam (#300):
// the recorded file in, with the network stubbed at fetch, and central's bill
// API, its labels, and the notifications queued for tenants out.
vi.mock('../../src/lib/rateLimitedFetch', () => ({
  // Unpaced, so each request doesn't cost the test a second.
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
import { mga } from '../../src/providers/mga'
import { toHandle } from '../../src/lib/billHandle'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

const FILE = 'https://mgaleg.maryland.gov/2026RS/misc/billsmasterlist/legislation.json'
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
type Rec = Record<string, unknown>
const sample = () => JSON.parse(sampleRaw) as Rec[]

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })

/** What the stubbed MGA serves for the 2026 regular session's file, and its ETag. A test replaces them. */
let file: { answer: () => Response | Promise<Response>; etag: string | null }
/** Every request: method, URL, and its If-None-Match header. */
let calls: { method: string; url: string; ifNoneMatch: string | null }[]

function serve(records: Rec[], etag: string | null = '"v1"') {
  file = { etag, answer: () => json(records, etag ? { ETag: etag } : {}) }
}

function makeEnv() {
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    ingestor, tenantQueue,
    env: {
      ...(env as any),
      INGESTOR_QUEUE: ingestor,
      ADMIN_SECRET: 'test-secret',
      [tenantQueueBindingName('mdteam')]: tenantQueue,
    },
  }
}
type Run = ReturnType<typeof makeEnv>

const sentToTenant = (run: Run) => [
  ...run.tenantQueue.send.mock.calls.map(c => c[0]),
  ...run.tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
]
const queuedIds = (run: Run) => run.ingestor.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId as number))
const fileRequests = () => calls.filter(c => c.method === 'GET' && c.url === FILE)

async function central(method: string, path: string, run: Run, body?: unknown) {
  const { app } = await import('../../src/index-legiscan')
  return app.fetch(new Request(`http://central/api${path}`, {
    method,
    headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), run.env)
}

async function getJson(path: string, run = makeEnv()) {
  const res = await central('GET', path, run)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

async function claim(provider: string, run = makeEnv()) {
  return central('POST', '/admin/state-providers/MD', run, { provider })
}

async function billId(number: string): Promise<number> {
  const db = drizzle(env.DB, { schema })
  const row = await db.select().from(schema.bills).where(eq(schema.bills.billNumber, number)).get()
  if (!row) throw new Error(`no bill ${number}`)
  return row.billId
}

/** The hourly Maryland sync, then the ingest of every bill it queued. */
async function syncAndIngest(run = makeEnv()) {
  const db = drizzle(env.DB, { schema })
  await runSnapshotSync(mga, run.env, db)
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
  serve(sample())
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const ifNoneMatch = new Headers(init?.headers).get('If-None-Match')
    calls.push({ method, url, ifNoneMatch })
    if (url === FILE) {
      if (method === 'HEAD') return new Response(null, { status: 200 })
      if (file.etag && ifNoneMatch === file.etag) return new Response(null, { status: 304 })
      return file.answer()
    }
    if (url.endsWith('/legislation.json')) return new Response('not found', { status: 404 })
    if (url.startsWith('https://mgaleg.maryland.gov/2026RS/bills/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    throw new Error(`no network in this test: ${method} ${url}`)
  })
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'mdteam', name: 'MD Team', stateCoverage: '["MD"]', active: true })
  await db.insert(schema.keywordRegistry).values(['cost recovery', 'tax'].map(keyword => ({ tenantId: 'mdteam', keyword })))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Maryland from the General Assembly', () => {
  it('stays on LegiScan until Maryland is claimed', async () => {
    const run = makeEnv()
    expect(await runSnapshotSync(mga, run.env, drizzle(env.DB, { schema }))).toEqual([])
    expect(calls).toEqual([])
  })

  it('syncs Maryland from its session file once claimed, with no key and no LegiScan call', async () => {
    expect((await claim('mga')).status).toBe(200)
    const { run } = await syncAndIngest()
    // HB 1 and its cross-file SB 2 match "cost recovery", and HB 2 "tax".
    expect(queuedIds(run).sort()).toEqual([await billId('HB1'), await billId('SB2'), await billId('HB2')].sort())
    expect(calls.every(c => c.url.startsWith('https://mgaleg.maryland.gov/'))).toBe(true)

    const bill = await getJson(`/bills/${toHandle(await billId('HB1'))}`)
    expect(bill).toMatchObject({
      number: 'HB1', state: 'MD', status: 'Passed the House', statusStage: 'passed_one_chamber', statusRank: 301, billType: 'B',
      stateUrl: 'https://mgaleg.maryland.gov/mgawebsite/Legislation/Details/hb0001?ys=2026RS',
    })
    expect(bill.sponsors[0]).toMatchObject({ name: 'Crosby', primary: true })
    expect(bill.sponsors).toHaveLength(26)
    expect(bill.relatedBills).toEqual([expect.objectContaining({ identifier: 'SB2', sastBillId: await billId('SB2') })])

    // The fiscal and policy note is a supplement, and the readers are texts.
    expect(bill.supplements).toEqual([expect.objectContaining({
      type: 'Fiscal Note', title: 'Fiscal and Policy Note',
      stateLink: 'https://mgaleg.maryland.gov/2026RS/fnotes/bil_0001/hb0001.pdf',
    })])
    expect(bill.texts.map((t: any) => t.note)).toEqual(['First Reader', 'Third Reader'])

    // Subjects, without the printed index's cross-references.
    expect(bill.subjects).toEqual(expect.arrayContaining(['Utility Regulation', 'Contracts', 'Public Service Commission']))
    expect(bill.subjects.some((s: string) => s.includes('see also'))).toBe(false)

    // The extras panel, titled with the provider's name, in vocabulary order.
    expect(bill.extras).toEqual({ providerName: 'Maryland General Assembly', fields: [
      expect.objectContaining({ key: 'statutes', label: 'Statutes affected', display: 'text', value: 'Public Utilities § 4-504' }),
    ] })

    const full = sentToTenant(run).filter((m: any) => !m.stubOnly).map((m: any) => m.billId)
    expect(full).toEqual(expect.arrayContaining([toHandle(await billId('HB1')), toHandle(await billId('SB2')), toHandle(await billId('HB2'))]))
  })

  it('shows an enacted bill\'s chapter, and the emergency and constitutional amendment flags when set', async () => {
    const records = sample()
    const hb14 = records.find(r => r.BillNumber === 'HB0014')!
    hb14.Title = `${hb14.Title} (tax)`
    hb14.EmergencyBill = true
    hb14.ConstitutionalAmendment = true
    serve(records)
    await claim('mga')
    await syncAndIngest()

    const bill = await getJson(`/bills/${toHandle(await billId('HB14'))}`)
    expect(bill).toMatchObject({ status: 'Approved by the Governor', statusStage: 'enacted', statusRank: 702 })
    expect(bill.extras.fields.map((f: any) => [f.label, f.value])).toEqual([
      ['Chapter', 'Chapter 775 of 2026'],
      ['Statutes affected', 'Education § 7-424'],
      ['Emergency bill', 'Yes'],
      ['Constitutional amendment', 'Yes'],
      ['Between the chambers', 'Conference Committee Appointed'],
    ])

    // Maryland publishes sponsors by name only. Each name gets one id from the id table, on every bill it sponsors.
    const foley = bill.sponsors[0]
    expect(foley).toMatchObject({ name: 'Foley', primary: true })
    expect(Number(foley.personId)).toBeGreaterThan(3_000_000_000)
    const hb1 = await getJson(`/bills/${toHandle(await billId('HB1'))}`)
    expect(hb1.sponsors.find((s: any) => s.name === 'Foley').personId).toBe(foley.personId)
  })

  it('maps every record to a bill type and status Maryland\'s labels list, and a House resolution to a resolution', async () => {
    const records = sample()
    records.push({ ...records.find(r => r.BillNumber === 'HJ0005')!, BillNumber: 'HR0001', CrossfileBillNumber: '', ChapterNumber: '',
      PassedByMGA: false, Status: 'In the House - Adopted', ThirdReadingActionHouseOfOrigin: 'Adopted', ThirdReadingDateHouseOfOrigin: '2026-02-01' })
    serve(records)
    await claim('mga')
    await syncAndIngest()
    // Ingest the records no keyword matched too.
    const db = drizzle(env.DB, { schema })
    const messages = (await db.select({ id: schema.bills.billId }).from(schema.bills).all())
      .map(r => ({ body: { billId: r.id }, ack: vi.fn(), retry: vi.fn() }))
    await processIngestorQueue({ messages } as any, makeEnv().env, db)
    for (const m of messages) expect(m.retry).not.toHaveBeenCalled()

    const labels = await getJson('/bills/labels?state=MD')
    const types = new Set(labels.billTypes.map((t: any) => t.value.toLowerCase()))
    const statuses = new Set(labels.statuses.map((s: any) => s.label))
    for (const r of records) {
      const number = String(r.BillNumber).replace(/^([A-Z]+)0*/, '$1')
      const bill = await getJson(`/bills/${toHandle(await billId(number))}`)
      expect(types.has(String(bill.billType).toLowerCase()), `${number}: ${bill.billType}`).toBe(true)
      expect(statuses.has(bill.status), `${number}: ${bill.status}`).toBe(true)
    }
    expect(await getJson(`/bills/${toHandle(await billId('HR1'))}`)).toMatchObject({ billType: 'R', status: 'Adopted', supplements: [] })
  })
})

describe('Maryland hearings on the calendar', () => {
  const calendarOf = (run: Run, handle: string) =>
    sentToTenant(run).filter((m: any) => m.billId === handle && m.calendar).map((m: any) => m.calendar)

  it('puts each committee hearing on the calendar, and a rescheduled hearing keeps its identity', async () => {
    const records = sample()
    const sb2 = records.find(r => r.BillNumber === 'SB0002')!
    sb2.HearingDateTimePrimaryHouseOfOrigin = '2026-10-06T13:00:00'
    serve(records)
    await claim('mga')
    const first = await syncAndIngest()
    const handle = toHandle(await billId('SB2'))

    const bill = await getJson(`/bills/${handle}`)
    expect(bill.calendar).toEqual([expect.objectContaining({
      typeId: 1, type: 'Hearing', date: '2026-10-06', time: '13:00', description: 'Senate Education, Energy, and the Environment hearing',
    })])
    const [added] = calendarOf(first.run, handle)
    expect(added.changes).toEqual([expect.objectContaining({ changeType: 'hearing_added', date: '2026-10-06' })])
    const identity = added.changes[0].identityKey

    // The committee moves the hearing: the same hearing, changed, not one cancelled and another added.
    sb2.HearingDateTimePrimaryHouseOfOrigin = '2026-10-08T15:00:00'
    serve(records, '"v2"')
    const second = await syncAndIngest()
    const [moved] = calendarOf(second.run, handle)
    expect(moved.changes).toEqual([expect.objectContaining({ changeType: 'hearing_changed', identityKey: identity, date: '2026-10-08', time: '15:00' })])
    expect(moved.events).toHaveLength(1)
  })

  it('gives a second committee\'s hearing on the same bill an identity of its own', async () => {
    const records = sample()
    const sb2 = records.find(r => r.BillNumber === 'SB0002')!
    sb2.HearingDateTimePrimaryHouseOfOrigin = '2026-10-06T13:00:00'
    sb2.CommitteeSecondaryOrigin = 'Budget and Taxation'
    sb2.HearingDateTimeSecondaryHouseOfOrigin = '2026-10-06T13:00:00'
    serve(records)
    await claim('mga')
    const { run } = await syncAndIngest()
    const [cal] = calendarOf(run, toHandle(await billId('SB2')))
    expect(cal.events.map((e: any) => e.description)).toEqual([
      'Senate Education, Energy, and the Environment hearing', 'Senate Budget and Taxation hearing',
    ])
    expect(new Set(cal.events.map((e: any) => e.identityKey)).size).toBe(2)
  })
})

describe('reading the session file with its ETag', () => {
  it('asks with the last ETag, and changes nothing when the file hasn\'t changed', async () => {
    await claim('mga')
    await syncAndIngest()
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual([null])
    const before = await getJson(`/bills/${toHandle(await billId('HB1'))}`)

    calls = []
    const run = makeEnv()
    const reports = await runSnapshotSync(mga, run.env, drizzle(env.DB, { schema }))
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual(['"v1"'])
    // The stored records stand in for the file, and nothing in them changed.
    expect(reports).toEqual([expect.objectContaining({ records: sample().length, queued: 0 })])
    expect(queuedIds(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(await billId('HB1'))}`)).toEqual(before)
  })

  it('links an instance that newly covers Maryland when the file hasn\'t changed', async () => {
    await claim('mga')
    await syncAndIngest()
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values({ tenantId: 'second', name: 'Second', stateCoverage: '["MD"]', active: true })
    await db.insert(schema.keywordRegistry).values({ tenantId: 'second', keyword: 'tax' })

    calls = []
    const run = makeEnv()
    const secondQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
    run.env[tenantQueueBindingName('second')] = secondQueue
    await runSnapshotSync(mga, run.env, db)
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual(['"v1"'])

    const links = await db.select().from(schema.billTenants).where(eq(schema.billTenants.tenantId, 'second')).all()
    expect(links).toHaveLength(sample().length)
    const hb2 = await billId('HB2')
    expect(links.find(l => l.billId === hb2)?.matchType).toBe('keyword')
    // HB 2 is tracked there now, and the other bills reach it as monitor stubs.
    expect(queuedIds(run)).toEqual([await billId('HB2')])
    const stubs = secondQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)).filter((m: any) => m.stubOnly)
    expect(stubs).toHaveLength(sample().length - 1)
  })

  it('re-queues a changed bill whose ingest failed when the file hasn\'t changed since', async () => {
    await claim('mga')
    await syncAndIngest()
    const changed = sample()
    changed.find(r => r.BillNumber === 'SB0002')!.Status = 'In the Senate - Favorable Report by Finance'
    serve(changed, '"v2"')
    // The pass queues SB 2, and its ingest never lands.
    const failed = makeEnv()
    await runSnapshotSync(mga, failed.env, drizzle(env.DB, { schema }))
    expect(queuedIds(failed)).toEqual([await billId('SB2')])

    calls = []
    const run = makeEnv()
    await runSnapshotSync(mga, run.env, drizzle(env.DB, { schema }))
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual(['"v2"'])
    expect(queuedIds(run)).toEqual([await billId('SB2')])
  })

  it('reads a changed file in full, and asks with its new ETag next time', async () => {
    await claim('mga')
    await syncAndIngest()

    const changed = sample()
    changed.find(r => r.BillNumber === 'SB0002')!.Status = 'In the Senate - Favorable Report by Finance'
    serve(changed, '"v2"')
    calls = []
    const run = makeEnv()
    await runSnapshotSync(mga, run.env, drizzle(env.DB, { schema }))
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual(['"v1"'])
    expect(queuedIds(run)).toEqual([await billId('SB2')])

    calls = []
    await runSnapshotSync(mga, makeEnv().env, drizzle(env.DB, { schema }))
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual(['"v2"'])
  })

  it('reads in full on a forced run, and after Maryland is claimed again', async () => {
    await claim('mga')
    await syncAndIngest()

    calls = []
    expect((await central('POST', '/admin/providers/mga/sync', makeEnv())).status).toBe(200)
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual([null])

    // Back to LegiScan and then to the MGA again: the first pass after the claim reads in full.
    const db = drizzle(env.DB, { schema })
    await db.delete(schema.billTenants)
    expect((await claim('legiscan')).status).toBe(200)
    expect((await claim('mga')).status).toBe(200)
    calls = []
    await runSnapshotSync(mga, makeEnv().env, db)
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual([null])
  })

  it('keeps asking in full while the file comes without an ETag', async () => {
    serve(sample(), null)
    await claim('mga')
    await syncAndIngest()
    calls = []
    await runSnapshotSync(mga, makeEnv().env, drizzle(env.DB, { schema }))
    expect(fileRequests().map(c => c.ifNoneMatch)).toEqual([null])
  })

  it('stores no ETag from a pass that lost Maryland to a claim midway', async () => {
    await claim('mga')
    const db = drizzle(env.DB, { schema })
    const run = makeEnv()
    file.answer = async () => {
      // Instances hold no Maryland bills yet, so the claim goes through mid-pass.
      expect((await claim('legiscan', run)).status).toBe(200)
      return json(sample(), { ETag: '"v1"' })
    }
    await runSnapshotSync(mga, run.env, db)
    expect(queuedIds(run)).toEqual([])
    expect((await db.select().from(schema.sessions).where(eq(schema.sessions.provider, 'mga')).all()).map(s => s.snapshotEtag))
      .toEqual([null])
  })
})

describe('Maryland fails closed', () => {
  /** A synced and ingested Maryland, and what central serves for it. */
  async function baseline() {
    await claim('mga')
    await syncAndIngest()
    // A fresh read each time, so a broken answer is never skipped as unchanged.
    await drizzle(env.DB, { schema }).update(schema.sessions).set({ snapshotEtag: null })
    return {
      bill: await getJson(`/bills/${toHandle(await billId('HB1'))}`),
      sessions: await getJson('/bills/sessions?state=MD'),
    }
  }

  const without = (key: string) => () => json(sample().map(r => {
    const { [key]: _gone, ...rest } = r
    return rest
  }))

  it.each([
    ['an HTTP error', () => new Response('busy', { status: 503 })],
    ['a body that isn\'t JSON', () => new Response('<html>Down for maintenance</html>', { headers: { 'content-type': 'text/html' } })],
    ['a truncated file', () => new Response(sampleRaw.slice(0, 5000), { headers: { 'content-type': 'application/json' } })],
    ['an object instead of a list', () => json({ Message: 'An error has occurred.' })],
    ['a record without its bill number', () => json([{ ...sample()[0], BillNumber: undefined }, ...sample().slice(1)])],
    ['a record without its sponsors', without('Sponsors')],
    ['a record without its status', without('Status')],
    ['a record without its hearing times', without('HearingDateTimePrimaryHouseOfOrigin')],
    ['sponsors that aren\'t a list', () => json(sample().map(r => ({ ...r, Sponsors: 'Delegate Crosby' })))],
    ['a subject without its code', () => json(sample().map(r => ({ ...r, BroadSubjects: [{ Name: 'Utility Regulation' }] })))],
    ['a statute without its sections', () => json(sample().map(r => ({ ...r, Statutes: [{ Article: { Code: 'gpu', Title: 'Public Utilities' } }] })))],
    ['a flag that isn\'t true or false', () => json(sample().map(r => ({ ...r, EmergencyBill: 'N' })))],
  ] as [string, () => Response][])('changes nothing when the session file answers with %s', async (_what, answer) => {
    const before = await baseline()
    file.answer = answer
    const run = makeEnv()
    await expect(runSnapshotSync(mga, run.env, drizzle(env.DB, { schema }))).rejects.toThrow(/MGA/)
    expect(queuedIds(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(await billId('HB1'))}`)).toEqual(before.bill)
  })

  it.each([
    ['an empty list', () => json([])],
    ['no file', () => new Response('not found', { status: 404 })],
  ] as [string, () => Response][])('reads %s as nothing new, never as bills removed', async (_what, answer) => {
    const before = await baseline()
    file.answer = answer
    const run = makeEnv()
    await runSnapshotSync(mga, run.env, drizzle(env.DB, { schema }))
    expect(queuedIds(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(await billId('HB1'))}`)).toEqual(before.bill)
    expect(await getJson('/bills/sessions?state=MD')).toEqual(before.sessions)
  })

  it('changes nothing when the session list can\'t be read', async () => {
    const before = await baseline()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input), ifNoneMatch: null })
      return new Response('busy', { status: 503 })
    })
    const run = makeEnv()
    await expect(runSnapshotSync(mga, run.env, drizzle(env.DB, { schema }))).rejects.toThrow(/MGA/)
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson('/bills/sessions?state=MD')).toEqual(before.sessions)
    expect(await getJson(`/bills/${toHandle(await billId('HB1'))}`)).toEqual(before.bill)
  })
})
