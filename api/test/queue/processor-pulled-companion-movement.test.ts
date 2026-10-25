import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { processCentralNotification } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { bills, feedEvents } from '../../src/db/schema'
import { groupByHand } from '../../src/lib/companionGroups'
import { clearDb, seedBill, seedSession, seedUser } from '../helpers'

// A pulled companion's legislative movement reaches the Feed through its group
// (#945). In a LegiScan state central sends an untracked bill only stubs
// (central/src/cron/sync.ts), which carry no change records, so the stub path
// reads the movement from the bill's stored status and last action. The rows
// the feed resolves are covered in api/test/routes/feed.noPriorityRow.test.ts.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 's', tags: [], relevanceScore: 7 }) }
})

const testEnv = { ...env, TENANT_ID: 'ri', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x' }

const STORED = { status: 'Introduced', lastAction: 'Introduced, referred to Judiciary', lastActionDate: '2026-06-01', providerUpdatedAt: '2026-06-01T00:00:00Z' }
const VOTE = { date: '2026-06-03', description: 'Committee recommends passage', chamber: 'H' }

function centralBillJson(handle: string, number: string, more: { updatedAt?: string; status?: string; actions?: Array<typeof VOTE> } = {}) {
  return {
    billId: handle, sessionId: 'ri:2026', sessionName: '2026 Regular Session', yearStart: 2026, yearEnd: 2026,
    state: 'RI', number, title: 'Mail ballot processing', abstract: null, status: more.status ?? 'Introduced', statusDate: '2026-06-01',
    updatedAt: more.updatedAt ?? '2026-06-03T00:00:00Z', stateUrl: null, textHash: null, textR2Key: null, textStatus: 'no_texts', texts: [],
    actions: more.actions ?? [{ date: '2026-06-01', description: STORED.lastAction, chamber: 'H' }, VOTE],
    sponsors: [], votes: [], relatedBills: [],
  }
}

type FeedEventBody = { id: string; type: string; billId: string | null; billGroupKey: string | null; noPriorityCard?: boolean; metadata: Record<string, unknown> }

describe('processCentralNotification: a stub delivery of a pulled companion', () => {
  const db = () => getDb(env.DB)
  let cookie: string
  // SB 100 is tracked and analyzed. HB 200 is its identical companion, with no match type and no analysis.
  const TRACKED = 'legiscan:100'
  const PULLED = 'legiscan:200'

  function serve(handle: string, number: string, more: Parameters<typeof centralBillJson>[2] = {}) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(centralBillJson(handle, number, more)), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))
  }
  // What central sends a bill no instance tracks when it changes: a stub, with no match type and no changes.
  const stub = (handle: string) =>
    processCentralNotification({ tenantId: 'ri', billId: handle, stubOnly: true } as never, testEnv as never, db())
  const eventsOf = (billId: string) => db().select().from(feedEvents).where(eq(feedEvents.billId, billId)).all()
  const rows = () => db().select().from(feedEvents).where(eq(feedEvents.type, 'no_priority_updates' as never)).all()
  async function feed() {
    const res = await SELF.fetch('http://localhost/api/feed', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return (await res.json() as { events: FeedEventBody[] }).events
  }

  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    const adminId = await seedUser({ role: 'admin', email: 'ada@example.com' })
    cookie = `session=${await seedSession(adminId)}`
    // Ids sort a < b, so the group's key is the tracked bill's id.
    await seedBill({ id: 'a-tracked', externalId: TRACKED, billNumber: 'SB 100', matchType: 'keyword', relevanceScore: 7, aiProcessedAt: '2026-06-01T00:00:00Z', ...STORED })
    await seedBill({ id: 'b-pulled', externalId: PULLED, billNumber: 'HB 200', matchType: null, ...STORED })
    // Grouped by hand, so the group survives the processor's reconciliation of companions against central's links.
    await groupByHand(db(), 'a-tracked', 'b-pulled', adminId)
  })

  it('writes a bill_updated for its new status and action, with the day\'s row, in one batch at one time', async () => {
    serve(PULLED, 'HB 200', { status: 'Engrossed' })
    await stub(PULLED)

    const written = await eventsOf('b-pulled')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ type: 'bill_updated', userId: 'system', suppressed: false })
    expect(JSON.parse(written[0].metadata)).toEqual({ changes: [
      { changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null },
      { changeType: 'action_added', oldValue: null, newValue: VOTE.description, detail: VOTE.date },
    ] })
    const [row] = await rows()
    expect(row).toMatchObject({ billId: null, userId: 'system', createdAt: written[0].createdAt })
    // The stub's own data landed with them.
    expect(await db().select({ status: bills.status, lastAction: bills.lastAction, providerUpdatedAt: bills.providerUpdatedAt }).from(bills).where(eq(bills.id, 'b-pulled')).get())
      .toEqual({ status: 'Engrossed', lastAction: VOTE.description, providerUpdatedAt: '2026-06-03T00:00:00Z' })
  })

  it('shows the movement on GET /feed as the group\'s lone card when it is the day\'s only entry', async () => {
    serve(PULLED, 'HB 200')
    await stub(PULLED)

    const shown = await feed()
    expect(shown.map((e) => e.type)).toEqual(['bill_updated'])
    expect(shown[0]).toMatchObject({ billId: 'b-pulled', billGroupKey: 'a-tracked', noPriorityCard: true })
  })

  it('shows the movement as the group\'s one entry in the day\'s row beside another bill\'s, and lists it under the group', async () => {
    serve(PULLED, 'HB 200')
    await stub(PULLED)
    const other = await seedBill({ billNumber: 'H 7', matchType: 'keyword', relevanceScore: 5, aiProcessedAt: '2026-06-01T00:00:00Z' })
    await db().insert(feedEvents).values({ id: 'other-update', type: 'bill_updated', billId: other, userId: 'system', metadata: '{"changes":[]}', createdAt: (await rows())[0].createdAt })

    const shown = await feed()
    const row = shown.find((e) => e.type === 'no_priority_updates')!
    expect(row.metadata).toMatchObject({ count: 2 })
    expect(shown.filter((e) => e.billId !== null)).toEqual([])
    const res = await SELF.fetch(`http://localhost/api/feed/events/${row.id}/bills`, { headers: { Cookie: cookie } })
    const listed = await res.json() as { entries: Array<{ key: string; bills: Array<{ id: string }>; events: Array<{ billId: string; type: string }> }> }
    expect(listed.entries[0]).toMatchObject({ key: 'group:a-tracked', bills: [{ id: 'b-pulled' }], events: [{ billId: 'b-pulled', type: 'bill_updated' }] })
  })

  it('writes the event once when the same stub is delivered again', async () => {
    serve(PULLED, 'HB 200')
    await stub(PULLED)
    await stub(PULLED)
    expect(await eventsOf('b-pulled')).toHaveLength(1)
    expect(await rows()).toHaveLength(1)
  })

  it('writes the event once when the first delivery fails at the feed write, leaving the bill as it was', async () => {
    serve(PULLED, 'HB 200')
    await env.DB.exec(`CREATE TRIGGER fail_update BEFORE INSERT ON feed_events WHEN NEW.type = 'bill_updated' BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    await expect(stub(PULLED)).rejects.toThrow()
    expect(await db().select({ lastAction: bills.lastAction, providerUpdatedAt: bills.providerUpdatedAt }).from(bills).where(eq(bills.id, 'b-pulled')).get())
      .toEqual({ lastAction: STORED.lastAction, providerUpdatedAt: STORED.providerUpdatedAt })
    expect(await rows()).toHaveLength(0)

    await env.DB.exec('DROP TRIGGER fail_update')
    await stub(PULLED)
    await stub(PULLED)
    expect(await eventsOf('b-pulled')).toHaveLength(1)
    expect(await rows()).toHaveLength(1)
  })

  it('writes nothing for a stub of the version already stored, though its status label changed (a resend after a vocabulary change)', async () => {
    serve(PULLED, 'HB 200', { updatedAt: STORED.providerUpdatedAt, status: 'Pending' })
    await stub(PULLED)
    expect(await eventsOf('b-pulled')).toHaveLength(0)
    expect((await db().select({ status: bills.status }).from(bills).where(eq(bills.id, 'b-pulled')).get())?.status).toBe('Pending')
  })

  it('writes nothing for a new version with no new status or action', async () => {
    serve(PULLED, 'HB 200', { actions: [{ date: '2026-06-01', description: STORED.lastAction, chamber: 'H' }] })
    await stub(PULLED)
    expect(await eventsOf('b-pulled')).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it('writes nothing for an ungrouped monitored bill, though its status and action changed', async () => {
    await seedBill({ id: 'c-lone', externalId: 'legiscan:300', billNumber: 'HB 300', matchType: null, ...STORED })
    serve('legiscan:300', 'HB 300', { status: 'Engrossed' })
    await stub('legiscan:300')
    expect(await eventsOf('c-lone')).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
    expect((await db().select({ lastAction: bills.lastAction }).from(bills).where(eq(bills.id, 'c-lone')).get())?.lastAction).toBe(VOTE.description)
  })

  it('writes nothing for a bill whose group has no tracked bill', async () => {
    await db().update(bills).set({ matchType: null }).where(eq(bills.id, 'a-tracked'))
    serve(PULLED, 'HB 200')
    await stub(PULLED)
    expect(await eventsOf('b-pulled')).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it('writes a full delivery\'s changes for a pulled companion not analyzed yet', async () => {
    serve(PULLED, 'HB 200')
    const changes = [{ changeType: 'action_added', oldValue: null, newValue: VOTE.description, detail: VOTE.date, detectedAt: '2026-06-03T00:00:00Z' }]
    await processCentralNotification({ tenantId: 'ri', billId: PULLED, matchType: null, changes } as never, testEnv as never, db())

    const written = await eventsOf('b-pulled')
    expect(written.map((e) => e.type)).toEqual(['bill_updated'])
    expect(JSON.parse(written[0].metadata)).toEqual({ changes })
    expect(await rows()).toHaveLength(1)
  })
})
