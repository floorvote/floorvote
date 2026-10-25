import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { eq } from 'drizzle-orm'
import { bills, billTexts, feedEvents, associationConfig, calendarEvents } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// A full delivery never puts an older provider version over a newer one. Each
// delivery reads central's copy when it runs, so when two deliveries of a bill
// overlap, the one that read the older copy (its AI call ran in between) can
// finish after the other stored a newer version. It must leave the newer fields, stamp, analysis,
// and child rows alone. Its `changes` are still recorded: central sends each sync's own changes, so
// the newer delivery's message doesn't carry the older one's, and nothing else would put them on the
// Feed.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({
      summary: 'Summary of the bill text',
      tags: ['Elections'],
      relevanceScore: 8,
    }),
  }
})

const BILL_ID = 'bill:906'
const V1 = '2026-05-21T00:00:00Z'
// A is the older version, B the newer one.
const A = '2026-06-02T08:30:00Z'
const B = '2026-06-09T16:45:00Z'

function centralBill(over: Record<string, unknown> = {}) {
  return {
    billId: BILL_ID,
    sessionId: 'ri:2026',
    sessionName: '2026 Regular Session',
    state: 'RI',
    number: 'HB 906',
    title: 'Election Administration Act',
    abstract: 'An act relating to election administration',
    status: 'introduced',
    statusDate: '2026-05-01',
    updatedAt: V1,
    stateUrl: 'https://state.example/HB906',
    textHash: 'hash-one',
    textR2Key: 'bills/906/ver-1.html',
    texts: [{ docId: 'doc-1', note: 'Introduced', date: '2026-05-01', links: [{ url: 'https://state.example/HB906.html', mediaType: 'text/html' }] }],
    actions: [{ description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 }],
    sponsors: [{ name: 'Jane Smith', party: 'D', role: 'Representative', primary: true, personId: 'p1', url: null }],
    votes: [],
    relatedBills: [],
    ...over,
  }
}

const versionA = () => centralBill({
  updatedAt: A,
  title: 'Election Administration Act, as amended in committee',
  status: 'in committee',
  textHash: 'hash-a',
  textR2Key: 'bills/906/ver-a.html',
  texts: [{ docId: 'doc-a', note: 'Committee draft', date: '2026-06-01', links: [{ url: 'https://state.example/HB906-a.html', mediaType: 'text/html' }] }],
  actions: [
    { description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 },
    { description: 'Referred to Judiciary', date: '2026-06-01', chamber: 'lower', classification: [], order: 2 },
  ],
})
const versionB = () => centralBill({
  updatedAt: B,
  title: 'Election Administration Act, as passed',
  status: 'passed',
  textHash: 'hash-b',
  textR2Key: 'bills/906/ver-b.html',
  texts: [{ docId: 'doc-b', note: 'Engrossed', date: '2026-06-08', links: [{ url: 'https://state.example/HB906-b.html', mediaType: 'text/html' }] }],
  actions: [
    { description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 },
    { description: 'Referred to Judiciary', date: '2026-06-01', chamber: 'lower', classification: [], order: 2 },
    { description: 'Passed House', date: '2026-06-08', chamber: 'lower', classification: [], order: 3 },
  ],
})

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }
// What central sends for a change it detected: the feed's bill_updated event comes from `changes`.
const changed: TenantQueueMessage = {
  tenantId: 'test-org',
  billId: BILL_ID,
  changes: [{ changeType: 'status_change', oldValue: 'introduced', newValue: 'changed', detail: null, detectedAt: '2026-06-09 17:00:00' }],
}

/** Central serves this version of the bill. */
function centralServes(bill: ReturnType<typeof centralBill>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/text')) {
      return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: `<p>Text ${bill.textHash}</p>`, docId: bill.texts[0].docId, textHash: bill.textHash }) })
    }
    return Promise.resolve({ ok: true, json: async () => bill })
  }))
}
// Each sync's message carries only that sync's changes, stamped with when central detected them.
const changedToA: TenantQueueMessage = {
  tenantId: 'test-org',
  billId: BILL_ID,
  changes: [{ changeType: 'action_added', oldValue: null, newValue: 'Referred to Judiciary', detail: null, detectedAt: '2026-06-02 08:31:00' }],
}
const changedToB: TenantQueueMessage = {
  tenantId: 'test-org',
  billId: BILL_ID,
  changes: [{ changeType: 'action_added', oldValue: null, newValue: 'Passed House', detail: null, detectedAt: '2026-06-09 16:46:00' }],
}
const deliver = (msg: TenantQueueMessage) => processCentralNotification(msg, testEnv as never, getDb(env.DB))
const row = () => getDb(env.DB).select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
const events = () => getDb(env.DB).select({ type: feedEvents.type }).from(feedEvents).all()
const ofType = (type: string) => getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.type, type as never)).all()
const updates = async () => (await ofType('bill_updated')).map(e => JSON.parse(e.metadata!).changes)
const rowsOf = async (q: string) => (await env.DB.prepare(q).all()).results
const textDocs = async () => (await getDb(env.DB).select({ docId: billTexts.docId }).from(billTexts).all()).map(t => t.docId).sort()
async function processBillMock() {
  const { processBill } = await import('../../src/lib/llm')
  return vi.mocked(processBill)
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  await getDb(env.DB).insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
})

describe('a full delivery never stores an older provider version', () => {
  it('keeps version B when version A, which is older, is delivered after it', async () => {
    centralServes(versionB())
    await deliver(changed)
    const afterB = await row()
    expect(afterB!.providerUpdatedAt).toBe(B)
    const eventsAfterB = await events()
    const analysesAfterB = (await processBillMock()).mock.calls.length

    centralServes(versionA())
    await deliver(changedToA)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe(B)
    expect(stored!.title).toBe('Election Administration Act, as passed')
    expect(stored!.status).toBe('passed')
    expect(stored!.lastAction).toBe('Passed House')
    expect(stored!.textR2Key).toBe('bills/906/ver-b.html')
    expect(stored!.lastAiTextHash).toBe('hash-b')
    expect(stored!.centralSyncedAt).toBe(afterB!.centralSyncedAt)
    expect(await textDocs()).toEqual(['doc-b'])
    // A's own changes still reach the Feed, once, and the older text is not analyzed.
    // B arrived as a new bill, so the only update is A's.
    expect(eventsAfterB.filter(e => e.type === 'bill_updated')).toEqual([])
    expect(await updates()).toEqual([changedToA.changes])
    expect((await processBillMock()).mock.calls.length).toBe(analysesAfterB)
  })

  it('writes nothing when B is stored while A is being analyzed', async () => {
    centralServes(centralBill())
    await deliver({ tenantId: 'test-org', billId: BILL_ID })
    const eventsBefore = await events()

    // A's analysis runs while another delivery stores B: the check before the
    // analysis passed, so only the write itself can refuse A.
    const processBill = await processBillMock()
    processBill.mockImplementationOnce(async () => {
      await getDb(env.DB).update(bills)
        .set({ providerUpdatedAt: B, title: 'Election Administration Act, as passed', tenantSummary: 'Summary of B' })
        .where(eq(bills.externalId, BILL_ID))
      return { summary: 'Summary of A', tags: ['Elections'], relevanceScore: 3 } as never
    })
    centralServes(versionA())
    await expect(deliver(changedToA)).resolves.toBeUndefined()
    expect(processBill).toHaveBeenCalledTimes(2)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe(B)
    expect(stored!.title).toBe('Election Administration Act, as passed')
    expect(stored!.tenantSummary).toBe('Summary of B')
    expect(stored!.lastAiTextHash).toBe('hash-one')
    // A's texts were never synced, so the first version's stay.
    expect(await textDocs()).toEqual(['doc-1'])
    // Only A's update event, with its no-priority row, is new.
    expect((await events()).map(e => e.type).sort()).toEqual([...eventsBefore.map(e => e.type), 'bill_updated', 'no_priority_updates'].sort())
    expect(await updates()).toEqual([changedToA.changes])
    expect(await ofType('no_priority_updates')).toHaveLength(1)
  })

  it('compares the versions as times, across the ISO and space formats', async () => {
    // Same day, B in the space format central writes now, A in ISO. As strings
    // '2026-06-09 16:45:00' sorts before '2026-06-09T08:30:00Z'.
    centralServes(centralBill({ ...versionB(), updatedAt: '2026-06-09 16:45:00' }))
    await deliver(changed)
    const eventsAfterB = await events()

    centralServes(centralBill({ ...versionA(), updatedAt: '2026-06-09T08:30:00Z' }))
    await deliver(changedToA)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe('2026-06-09 16:45:00')
    expect(stored!.title).toBe('Election Administration Act, as passed')
    // B arrived as a new bill, so the only update is A's.
    expect(eventsAfterB.filter(e => e.type === 'bill_updated')).toEqual([])
    expect(await updates()).toEqual([changedToA.changes])
  })

  it('still stores a newer version, in either format', async () => {
    centralServes(centralBill({ ...versionA(), updatedAt: '2026-06-09T08:30:00Z' }))
    await deliver(changed)

    centralServes(centralBill({ ...versionB(), updatedAt: '2026-06-09 16:45:00' }))
    await deliver(changed)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe('2026-06-09 16:45:00')
    expect(stored!.title).toBe('Election Administration Act, as passed')
    expect((await events()).filter(e => e.type === 'bill_updated')).toHaveLength(1)
  })

  it('lets a stamp it cannot read be overwritten, as before', async () => {
    await getDb(env.DB).insert(bills).values({
      id: 'b-odd', externalId: BILL_ID, billNumber: 'HB 906', title: 'Old title', state: 'RI', status: 'introduced', session: '2026',
      providerUpdatedAt: 'not a time',
    })
    centralServes(versionA())
    await deliver(changed)
    expect((await row())!.providerUpdatedAt).toBe(A)
  })
})

describe('an older delivery that finishes last', () => {
  // A and B as central sends them: each version's subjects and committee, and
  // each sync's own calendar changes. A added the hearing; B moved it.
  const fullA = () => centralBill({
    ...versionA(),
    subjects: ['Elections', 'Voting'],
    committee: { committeeId: 'c-judiciary', name: 'Judiciary', chamber: 'H' },
    referrals: [{ committeeId: 'c-judiciary', name: 'Judiciary', chamber: 'H' }],
  })
  const fullB = () => centralBill({
    ...versionB(),
    subjects: ['Elections', 'Ballots'],
    committee: { committeeId: 'c-finance', name: 'Finance', chamber: 'H' },
    referrals: [
      { committeeId: 'c-judiciary', name: 'Judiciary', chamber: 'H' },
      { committeeId: 'c-finance', name: 'Finance', chamber: 'H' },
    ],
  })
  const hearingIn = (location: string, eventHash: string) =>
    ({ identityKey: 'h-judiciary', date: '2026-06-05', time: '10:00:00', location, description: 'House Judiciary', eventHash })
  const messageA: TenantQueueMessage = {
    ...changedToA,
    matchType: 'keyword',
    calendar: { events: [hearingIn('Room 1', 'e-a')], changes: [{ changeType: 'hearing_added', ...hearingIn('Room 1', 'e-a') }] },
  }
  const messageB: TenantQueueMessage = {
    ...changedToB,
    matchType: 'keyword',
    calendar: { events: [hearingIn('Room 2', 'e-b')], changes: [{ changeType: 'hearing_changed', ...hearingIn('Room 2', 'e-b') }] },
  }
  const subjectNames = async () => (await rowsOf('SELECT subject_name AS name FROM bill_subjects ORDER BY subject_name')).map(r => r.name)
  const committeeRows = () => rowsOf('SELECT committee_id AS id, is_current AS current FROM bill_committees ORDER BY committee_id')

  /** The bill at its first version, analyzed and tracked; then A starts, and B is delivered in full while A's analysis runs. */
  async function overlap(a: TenantQueueMessage = messageA, b: TenantQueueMessage = messageB) {
    centralServes(centralBill())
    await deliver({ tenantId: 'test-org', billId: BILL_ID, matchType: 'keyword' })
    const processBill = await processBillMock()
    processBill.mockImplementationOnce(async () => {
      centralServes(fullB())
      await deliver(b)
      return { summary: 'Summary of A', tags: [], relevanceScore: 3 } as never
    })
    centralServes(fullA())
    await deliver(a)
  }

  it('keeps all of B, its children included, and records A\'s update and hearing once', async () => {
    await overlap()

    const stored = (await row())!
    expect(stored.providerUpdatedAt).toBe(B)
    expect(stored.title).toBe('Election Administration Act, as passed')
    expect(stored.tenantSummary).toBe('Summary of the bill text')
    expect(stored.lastAiTextHash).toBe('hash-b')
    // B's child rows, not A's. (The first version's text can outlive B's sync here: B dropped only
    // texts stored before it read central, and in a test that is the same second.)
    expect(await textDocs()).toContain('doc-b')
    expect(await textDocs()).not.toContain('doc-a')
    expect(await subjectNames()).toEqual(['Ballots', 'Elections'])
    expect(await committeeRows()).toEqual([{ id: 'c-finance', current: 1 }, { id: 'c-judiciary', current: 0 }])
    // B's hearing as B stored it.
    const hearings = await getDb(env.DB).select().from(calendarEvents).all()
    expect(hearings).toHaveLength(1)
    expect(hearings[0].location).toBe('Room 2')

    // Each sync's changes reach the Feed once: B's as it committed, A's after.
    expect(await updates()).toEqual([changedToB.changes, changedToA.changes])
    expect((await ofType('hearing_changed')).map(e => JSON.parse(e.metadata!).location)).toEqual(['Room 2'])
    expect((await ofType('hearing_added')).map(e => JSON.parse(e.metadata!).location)).toEqual(['Room 1'])
    expect(await ofType('no_priority_updates')).toHaveLength(1)
  })

  it('adds nothing when A\'s message is delivered again after it was found stale', async () => {
    await overlap({ ...messageA, calendar: undefined }, { ...messageB, calendar: undefined })
    const before = await events()
    expect(await updates()).toEqual([changedToB.changes, changedToA.changes])

    // The redelivery reads central again, which by now serves B.
    centralServes(fullB())
    await deliver({ ...messageA, calendar: undefined })

    expect(await events()).toEqual(before)
    expect((await row())!.providerUpdatedAt).toBe(B)
  })

  it('records no update for a bill the Feed does not follow', async () => {
    await getDb(env.DB).delete(associationConfig)
    centralServes(versionB())
    await deliver({ tenantId: 'test-org', billId: BILL_ID })
    expect((await row())!.matchType).toBeNull()

    centralServes(versionA())
    await deliver(changedToA)

    expect((await row())!.providerUpdatedAt).toBe(B)
    expect(await events()).toEqual([])
  })

  it('keeps the match provenance A declared when the bill has not recorded its match', async () => {
    // A bill central sends without text: it matches, but nothing is analyzed, so no match is recorded yet.
    const noText = { texts: [], textHash: null, textR2Key: null }
    await getDb(env.DB).delete(associationConfig)
    centralServes(centralBill(noText))
    await deliver({ tenantId: 'test-org', billId: BILL_ID })

    centralServes(centralBill({ ...versionB(), ...noText }))
    await deliver({ tenantId: 'test-org', billId: BILL_ID, matchType: 'keyword' })
    expect((await row())!.newMatchAt).toBeNull()
    expect((await row())!.matchProvenance).toBeNull()

    // A brought the match, and declared it routine.
    centralServes(centralBill({ ...versionA(), ...noText }))
    await deliver({ tenantId: 'test-org', billId: BILL_ID, matchType: 'keyword', matchProvenance: 'routine' })

    const stored = (await row())!
    expect(stored.providerUpdatedAt).toBe(B)
    expect(stored.matchProvenance).toBe('routine')
  })

  it('leaves a provenance the bill already holds', async () => {
    const noText = { texts: [], textHash: null, textR2Key: null }
    await getDb(env.DB).delete(associationConfig)
    centralServes(centralBill({ ...versionB(), ...noText }))
    await deliver({ tenantId: 'test-org', billId: BILL_ID, matchType: 'keyword', matchProvenance: 'bulk' })

    centralServes(centralBill({ ...versionA(), ...noText }))
    await deliver({ tenantId: 'test-org', billId: BILL_ID, matchType: 'keyword', matchProvenance: 'routine' })

    expect((await row())!.matchProvenance).toBe('bulk')
  })

  it('is stale, not an error, when another delivery creates the bill at a newer version mid-message', async () => {
    const processBill = await processBillMock()
    processBill.mockImplementationOnce(async () => {
      await getDb(env.DB).insert(bills).values({
        id: 'b-other', externalId: BILL_ID, billNumber: 'HB 906', title: 'Election Administration Act, as passed', state: 'RI',
        status: 'passed', session: '2026', providerUpdatedAt: B,
      })
      return { summary: 'Summary of A', tags: [], relevanceScore: 3 } as never
    })
    centralServes(versionA())
    await expect(deliver(changedToA)).resolves.toBeUndefined()

    const stored = (await row())!
    expect(stored.id).toBe('b-other')
    expect(stored.providerUpdatedAt).toBe(B)
    expect(await textDocs()).toEqual([])
    // A bill new to this delivery has no update to record.
    expect(await events()).toEqual([])
  })
})
