import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { sessions, bills, billTenants, billTexts, tenants, stateProviders } from '../../src/db/schema'
import type { SyncEntry } from '../../src/providers/types'
import { clearDb } from '../helpers/migrations'

// #801: a bill an instance asked for through fetch-bills (a pulled lead of a
// companion group, say) is one no instance tracks, so the sync sends it only
// stubs and central keeps the texts it fetched when it was asked. While the
// request is recent the sync ingests the bill whenever its change hash moves,
// within the budget untracked bills' fetches share (lib/stubRefresh.ts).

vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return { ...actual, getBill: vi.fn(), getBillText: vi.fn() }
})
vi.mock('../../src/lib/queuesRest', () => ({
  publishBatch: vi.fn().mockResolvedValue(undefined),
  publishMessage: vi.fn().mockResolvedValue(undefined),
  queuesRestEnabled: () => true,
}))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { app } from '../../src/index'
import { applyMasterList } from '../../src/cron/sync'
import { processIngestorQueue } from '../../src/queue/processor'
import { FETCH_REQUEST_DAYS } from '../../src/lib/fetchRequests'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import { toHandle } from '../../src/lib/billHandle'
import * as legiscan from '../../src/providers/legiscan/client'

const db = () => drizzle(env.DB, { schema })
const SESSION = { sessionId: 9200, state: 'DC', sessionName: 'Test', provider: 'legiscan' }
const TENANT = 't-req'
const dbTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')
const daysAgo = (n: number) => dbTime(new Date(Date.now() - n * 86400_000))

const entry = (billId: number, hash: string): SyncEntry => ({
  bill_id: billId, number: `B${billId}`, change_hash: hash, title: `Bill ${billId}`, description: 'nothing relevant',
  status: 1, status_date: '2026-05-20', last_action: 'Referred', last_action_date: '2026-05-20', url: 'https://example.com',
})

/** A bill central holds, current at change `old`, with one text, linked untracked to the tenant. */
async function seedHeld(billId: number, requestedAt: string | null, provider = 'legiscan') {
  await db().insert(bills).values({
    billId, changeHash: 'old', detailHash: 'old', sessionId: SESSION.sessionId, state: 'DC', stateId: 0,
    provider, billNumber: `B${billId}`, title: `Bill ${billId}`, status: 1,
  })
  await db().insert(billTexts).values({ docId: billId * 100 + 1, billId, date: '2026-01-15', type: 'Introduced', r2Key: `texts/${billId}-1.html` })
  await db().insert(billTenants).values({ billId, tenantId: TENANT, matchType: null, fetchRequestedAt: requestedAt })
}

async function pass(list: SyncEntry[], session = SESSION) {
  const send = vi.fn().mockResolvedValue(undefined)
  const sendBatch = vi.fn().mockResolvedValue(undefined)
  const queue = { send, sendBatch } as unknown as Queue
  await applyMasterList(session, list, [{ tenantId: TENANT, stateCoverage: '["DC"]', queueId: null }], { ...(env as any) }, db(), queue)
  const messages = [...send.mock.calls.map(c => c[0]), ...sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))]
  return messages as Array<{ billId: number } & Record<string, unknown>>
}

async function setBudget(limit: number, used: number) {
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('legiscan_monthly_limit', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(limit)).run()
  for (let i = 0; i < used; i++) {
    await db().insert(schema.apiCallLog).values({ callType: 'getBill', params: `{"id":${i}}`, loggedAt: dbTime(new Date()) })
  }
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('<html>' + 'x'.repeat(2000) + '</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
  await db().insert(sessions).values({
    sessionId: SESSION.sessionId, state: 'DC', stateId: 0, yearStart: 2025, yearEnd: 2026, sessionTitle: 'Test', sessionName: 'Test',
  })
  await db().insert(tenants).values({ tenantId: TENANT, name: TENANT, stateCoverage: '["DC"]', active: true })
})

describe('the sync ingests a bill an instance asked for, which no instance tracks', () => {
  it('ingests it when its change hash moves, and the instance is sent the bill with its new text', async () => {
    await seedHeld(70, daysAgo(1))
    const messages = await pass([entry(70, 'new')])
    expect(messages).toContainEqual({ billId: 70, queuedBy: 'legiscan' })

    // The ingest the pass queued: the provider has a second text now.
    const text = (docId: number, date: string) => ({
      doc_id: docId, date, type: 'Amended', type_id: 2, mime: 'text/html', mime_id: 1, url: 'u',
      state_link: `https://example.com/${docId}.html`, text_size: 2000, text_hash: `th${docId}`,
      alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '',
    })
    vi.mocked(legiscan.getBill).mockResolvedValue({
      bill_id: 70, change_hash: 'new', session_id: SESSION.sessionId, state: 'DC', state_id: 0, bill_number: 'B70',
      bill_type: 'B', bill_type_id: '1', body: 'H', body_id: 1, current_body: 'H', current_body_id: 1,
      title: 'Bill 70', description: 'nothing relevant', status: 1, status_date: '2026-05-20', completed: 0,
      pending_committee_id: 0, url: 'https://example.com', state_link: 'https://example.com/70',
      session: { session_id: SESSION.sessionId, session_name: 'Test', year_start: 2025, year_end: 2026 },
      progress: [], referrals: [], sponsors: [], subjects: [], votes: [], calendar: [], amendments: [], supplements: [], sasts: [],
      history: [{ date: '2026-05-20', action: 'Referred', chamber: 'H', chamber_id: 1, importance: 0 }],
      texts: [text(7001, '2026-01-15'), text(7002, '2026-05-20')],
    } as any)
    const tenantQueue = { send: vi.fn().mockResolvedValue(undefined), sendBatch: vi.fn().mockResolvedValue(undefined) }
    const ingest = messages.find(m => m.billId === 70)!
    const batch = {
      messages: [{ body: ingest, ack: vi.fn(), retry: vi.fn(), id: 'm1', timestamp: new Date(), attempts: 1 }],
      queue: 'central-legiscan-ingestor', ackAll: vi.fn(), retryAll: vi.fn(),
    } as unknown as MessageBatch<any>
    await processIngestorQueue(batch, {
      ...(env as any), LEGISCAN_API_KEY: 'test-key',
      INGESTOR_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
      [tenantQueueBindingName(TENANT)]: tenantQueue,
    }, db())

    const newText = await db().select().from(billTexts).where(eq(billTexts.docId, 7002)).get()
    expect(newText?.r2Key).toBeTruthy()
    expect(tenantQueue.send).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, billId: toHandle(70), matchType: null }))
  })

  it('ingests nothing for a bill whose request is older than the request window', async () => {
    await seedHeld(70, daysAgo(FETCH_REQUEST_DAYS - 1))
    await seedHeld(71, daysAgo(FETCH_REQUEST_DAYS + 1))
    const messages = await pass([entry(70, 'new'), entry(71, 'new')])
    expect(messages.map(m => m.billId)).toEqual([70])
  })

  it('ingests a requested bill once per change, not again on a pass that finds it unchanged', async () => {
    await seedHeld(70, daysAgo(1))
    expect((await pass([entry(70, 'new')])).filter(m => m.billId === 70)).toHaveLength(1)
    expect((await pass([entry(70, 'new')])).filter(m => m.billId === 70)).toEqual([])
  })

  it('spends only the budget untracked bills share: with room for one call, one of two requested bills is ingested', async () => {
    // A limit of 4 leaves a floor of 1 call, and a fetch spends 1, so 2 may be used: 2 are, before the pass.
    // Each refresh queued counts against the budget until it lands, so the second finds none left.
    await setBudget(4, 2)
    await seedHeld(70, daysAgo(1))
    await seedHeld(71, daysAgo(1))
    const messages = await pass([entry(70, 'new'), entry(71, 'new')])
    expect(messages.filter(m => m.billId === 70 || m.billId === 71)).toHaveLength(1)
  })

  it('ingests a requested bill of a provider whose fetches are unmetered without spending the budget', async () => {
    await db().insert(stateProviders).values({ state: 'DC', provider: 'lims' })
    await setBudget(4, 4)
    await seedHeld(70, daysAgo(1), 'lims')
    const messages = await pass([entry(70, 'new')], { ...SESSION, provider: 'lims' })
    expect(messages.filter(m => m.billId === 70)).toHaveLength(1)
  })
})

// An instance renews its request for a pulled lead while the lead is grouped
// (POST /tenants/renew-fetch-requests, from api/src/lib/companionAnalysis.ts).
// Renewing stamps the request and fetches nothing for a bill that is current,
// so it costs no provider call and no delivery.
describe('an instance renews its request for a bill that leads its group', () => {
  async function renew(billIds: number[], tenant = TENANT) {
    const ingest = { send: vi.fn().mockResolvedValue(undefined), sendBatch: vi.fn().mockResolvedValue(undefined) }
    const res = await app.fetch(new Request(`http://central/api/tenants/renew-fetch-requests/${tenant}`, {
      method: 'POST', headers: { 'x-admin-secret': 'sek', 'content-type': 'application/json' }, body: JSON.stringify({ billIds }),
    }), { ...(env as any), ADMIN_SECRET: 'sek', INGESTOR_QUEUE: ingest })
    expect(res.status).toBe(200)
    return [...ingest.send.mock.calls.map(c => c[0]), ...ingest.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))]
  }
  const requestedAt = async (billId: number) =>
    (await db().select({ at: billTenants.fetchRequestedAt }).from(billTenants).where(eq(billTenants.billId, billId)).get())?.at ?? null

  it('keeps a bill whose first ask is past the request window getting its new texts', async () => {
    await seedHeld(70, daysAgo(FETCH_REQUEST_DAYS + 1))
    await renew([70])
    const messages = await pass([entry(70, 'new')])
    expect(messages).toContainEqual({ billId: 70, queuedBy: 'legiscan' })
  })

  it('fetches a bill never asked for whose change hash moved while central kept only its stub', async () => {
    // A lead pulled before #801: its link has no request, and the sync moved its change hash without ingesting it.
    await seedHeld(70, null)
    await db().update(bills).set({ changeHash: 'new' }).where(eq(bills.billId, 70))
    expect(await renew([70])).toEqual([{ billId: 70, queuedBy: 'legiscan' }])
  })

  it('stamps the request on a current bill and spends no provider call, queuing nothing', async () => {
    await seedHeld(70, null)
    expect(await renew([70])).toEqual([])
    expect(legiscan.getBill).not.toHaveBeenCalled()
    expect(await requestedAt(70)).not.toBeNull()
  })

  it("stamps only the asking instance's own links", async () => {
    await seedHeld(70, null)
    await db().insert(tenants).values({ tenantId: 't-other', name: 't-other', stateCoverage: '["DC"]', active: true })
    await renew([70], 't-other')
    expect(await requestedAt(70)).toBeNull()
  })
})
