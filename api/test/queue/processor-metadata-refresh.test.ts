import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { eq } from 'drizzle-orm'
import { bills, associationConfig } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// A metadata refresh (`metadataOnly`, queued by POST /admin/refresh-metadata)
// writes central's metadata but fetches no text and runs no AI. It must leave
// `providerUpdatedAt` as it was, so the regular delivery that follows still
// sees the bill as changed and runs the full path. Otherwise a refresh that
// reaches a bill before its regular delivery hides the bill's new text (#789).

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

const BILL_ID = 'legiscan:789'
const V1 = '2026-05-21T00:00:00Z'
const V2 = '2026-06-02T08:30:00Z'
const V3 = '2026-06-09T16:45:00Z'

function centralBill(over: Record<string, unknown> = {}) {
  return {
    billId: BILL_ID,
    sessionId: 'ri:2026',
    sessionName: '2026 Regular Session',
    state: 'RI',
    number: 'HB 789',
    title: 'Election Administration Act',
    abstract: 'An act relating to election administration',
    status: 'introduced',
    statusDate: '2026-05-01',
    updatedAt: V1,
    stateUrl: 'https://state.example/HB789',
    textHash: 'hash-one',
    textR2Key: 'bills/789/ver-1.html',
    texts: [{ docId: 'doc-1', note: 'Introduced', date: '2026-05-01', links: [{ url: 'https://state.example/HB789.html', mediaType: 'text/html' }] }],
    actions: [{ description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 }],
    sponsors: [{ name: 'Jane Smith', party: 'D', role: 'Representative', primary: true, personId: 'p1', url: null }],
    votes: [],
    relatedBills: [],
    ...over,
  }
}

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }
const regular: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
const refresh: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, metadataOnly: true }

let textFetches = 0
/** Central serves this version of the bill, and counts text fetches. */
function centralServes(bill: ReturnType<typeof centralBill>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/text')) {
      textFetches++
      return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: `<p>Text ${bill.textHash}</p>`, docId: 'doc-1', textHash: bill.textHash }) })
    }
    return Promise.resolve({ ok: true, json: async () => bill })
  }))
}
const deliver = (msg: TenantQueueMessage) => processCentralNotification(msg, testEnv as never, getDb(env.DB))
const row = () => getDb(env.DB).select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
async function analysisCalls() {
  const { processBill } = await import('../../src/lib/llm')
  return vi.mocked(processBill).mock.calls.length
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  textFetches = 0
  await getDb(env.DB).insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
})

describe('a metadata refresh leaves the stored provider version alone', () => {
  it('keeps the stored providerUpdatedAt when central has a newer version', async () => {
    centralServes(centralBill({ updatedAt: V1 }))
    await deliver(regular)
    expect((await row())!.providerUpdatedAt).toBe(V1)

    centralServes(centralBill({ updatedAt: V2, title: 'Election Administration Act, as amended' }))
    await deliver(refresh)
    expect((await row())!.providerUpdatedAt).toBe(V1)
  })

  it('keeps the stored version across several refreshes in a row', async () => {
    centralServes(centralBill({ updatedAt: V1 }))
    await deliver(regular)
    centralServes(centralBill({ updatedAt: V2 }))
    await deliver(refresh)
    centralServes(centralBill({ updatedAt: V3 }))
    await deliver(refresh)
    expect((await row())!.providerUpdatedAt).toBe(V1)
  })

  it('keeps an empty providerUpdatedAt empty, since the row was never delivered', async () => {
    await getDb(env.DB).insert(bills).values({
      id: 'b-never', externalId: BILL_ID, billNumber: 'HB 789', title: 'Old title', state: 'RI', status: 'introduced', session: '2026',
    })
    centralServes(centralBill({ updatedAt: V2 }))
    await deliver(refresh)
    const stored = await row()
    expect(stored!.title).toBe('Election Administration Act')
    expect(stored!.providerUpdatedAt).toBeNull()
  })

  it('stores no providerUpdatedAt when a refresh is the first delivery to create the bill', async () => {
    centralServes(centralBill({ updatedAt: V2 }))
    await deliver(refresh)
    const stored = await row()
    expect(stored).toBeDefined()
    expect(stored!.title).toBe('Election Administration Act')
    expect(stored!.providerUpdatedAt).toBeNull()
  })

  it('still updates the other fields a refresh covers', async () => {
    centralServes(centralBill({ updatedAt: V1 }))
    await deliver(regular)
    centralServes(centralBill({
      updatedAt: V2,
      title: 'Election Administration Act, as amended',
      abstract: 'A revised abstract',
      status: 'passed',
      statusStage: 'passed',
      statusRank: 401,
      stateUrl: 'https://state.example/HB789-v2',
      textR2Key: 'bills/789/ver-2.html',
      subjects: ['Election Law'],
      sponsors: [
        { name: 'Pat Doe', party: 'R', role: 'Representative', primary: true, personId: 'p2', url: null },
        { name: 'Jane Smith', party: 'D', role: 'Representative', primary: false, personId: 'p1', url: null },
      ],
      actions: [
        { description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 },
        { description: 'Passed the House', date: '2026-06-01', chamber: 'lower', classification: [], order: 2 },
      ],
    }))
    const before = await row()
    await deliver(refresh)
    const after = (await row())!
    expect(after.title).toBe('Election Administration Act, as amended')
    expect(after.status).toBe('passed')
    expect(after.abstract).toBe('A revised abstract')
    expect(after.stateUrl).toBe('https://state.example/HB789-v2')
    expect(after.textR2Key).toBe('bills/789/ver-2.html')
    expect(after.sponsor).toBe('Pat Doe')
    expect(after.sponsorParty).toBe('R')
    expect(JSON.parse(after.coSponsors!)).toEqual([{ name: 'Jane Smith', url: null, party: 'D' }])
    expect(after.lastAction).toBe('Passed the House')
    expect(JSON.parse(after.history!)).toHaveLength(2)
    expect(JSON.parse(after.subjects!)).toEqual(['Election Law'])
    expect(after.centralSyncedAt).not.toBeNull()
    expect(after.centralSyncedAt! >= before!.centralSyncedAt!).toBe(true)
    // And the version is the one thing it leaves.
    expect(after.providerUpdatedAt).toBe(V1)
  })

  it('leaves the analysis alone: no text fetch and no AI', async () => {
    centralServes(centralBill({ updatedAt: V1 }))
    await deliver(regular)
    const analyzed = await row()
    const fetchesBefore = textFetches
    const callsBefore = await analysisCalls()
    centralServes(centralBill({ updatedAt: V2, textHash: 'hash-two' }))
    await deliver(refresh)
    const after = (await row())!
    expect(textFetches).toBe(fetchesBefore)
    expect(await analysisCalls()).toBe(callsBefore)
    expect(after.tenantSummary).toBe(analyzed!.tenantSummary)
    expect(after.aiProcessedAt).toBe(analyzed!.aiProcessedAt)
    expect(after.lastAiTextHash).toBe('hash-one')
  })
})

describe('the regular delivery after a metadata refresh', () => {
  it('runs the full path and re-analyzes when the text changed while the refresh was draining', async () => {
    centralServes(centralBill({ updatedAt: V1, textHash: 'hash-one' }))
    await deliver(regular)
    expect(await analysisCalls()).toBe(1)

    // Central gets a new text. The refresh reaches the bill first.
    const v2 = centralBill({ updatedAt: V2, textHash: 'hash-two', textR2Key: 'bills/789/ver-2.html' })
    centralServes(v2)
    await deliver(refresh)
    expect(await analysisCalls()).toBe(1)

    // Then the bill's regular delivery arrives for the same central version.
    const fetchesBefore = textFetches
    await deliver(regular)
    const after = (await row())!
    expect(textFetches).toBeGreaterThan(fetchesBefore)
    expect(await analysisCalls()).toBe(2)
    expect(after.lastAiTextHash).toBe('hash-two')
    expect(after.providerUpdatedAt).toBe(V2)
  })

  it('runs the full path but does not re-analyze when the text hash is unchanged', async () => {
    centralServes(centralBill({ updatedAt: V1, textHash: 'hash-one' }))
    await deliver(regular)
    expect(await analysisCalls()).toBe(1)

    // A new provider version with the same text (a status change, say).
    centralServes(centralBill({ updatedAt: V2, textHash: 'hash-one', status: 'passed', statusStage: 'passed', statusRank: 401 }))
    await deliver(refresh)
    const fetchesBefore = textFetches
    await deliver(regular)
    const after = (await row())!
    // The full path ran: the version caught up, and nothing was skipped.
    expect(after.providerUpdatedAt).toBe(V2)
    expect(after.status).toBe('passed')
    // The AI's own dedup by text hash still holds.
    expect(await analysisCalls()).toBe(1)
    expect(after.lastAiTextHash).toBe('hash-one')
    // Dedup by hash also skips the text fetch.
    expect(textFetches).toBe(fetchesBefore)
  })

  it('still runs the full path after several refreshes in a row', async () => {
    centralServes(centralBill({ updatedAt: V1, textHash: 'hash-one' }))
    await deliver(regular)
    centralServes(centralBill({ updatedAt: V2, textHash: 'hash-two' }))
    await deliver(refresh)
    await deliver(refresh)
    centralServes(centralBill({ updatedAt: V3, textHash: 'hash-three' }))
    await deliver(refresh)
    await deliver(regular)
    expect(await analysisCalls()).toBe(2)
    const after = (await row())!
    expect(after.lastAiTextHash).toBe('hash-three')
    expect(after.providerUpdatedAt).toBe(V3)
  })

  it('analyzes a bill a refresh created before any regular delivery reached it', async () => {
    centralServes(centralBill({ updatedAt: V2 }))
    await deliver(refresh)
    expect(await analysisCalls()).toBe(0)
    await deliver(regular)
    expect(await analysisCalls()).toBe(1)
    const after = (await row())!
    expect(after.aiProcessedAt).not.toBeNull()
    expect(after.providerUpdatedAt).toBe(V2)
  })

  it('is skipped on a repeat once it has caught up, as an unchanged bill is', async () => {
    centralServes(centralBill({ updatedAt: V1, textHash: 'hash-one' }))
    await deliver(regular)
    centralServes(centralBill({ updatedAt: V2, textHash: 'hash-two' }))
    await deliver(refresh)
    await deliver(regular)
    const fetchesBefore = textFetches
    const callsBefore = await analysisCalls()
    await deliver(regular)
    expect(textFetches).toBe(fetchesBefore)
    expect(await analysisCalls()).toBe(callsBefore)
  })
})

describe('an unchanged bill is still skipped', () => {
  it('skips a regular delivery with the same updatedAt, an analysis present, and no refresh between', async () => {
    centralServes(centralBill({ updatedAt: V1 }))
    await deliver(regular)
    const fetchesBefore = textFetches
    const callsBefore = await analysisCalls()
    await deliver(regular)
    expect(textFetches).toBe(fetchesBefore)
    expect(await analysisCalls()).toBe(callsBefore)
    expect((await row())!.providerUpdatedAt).toBe(V1)
  })

  it('skips the regular delivery after a refresh that found no new version', async () => {
    centralServes(centralBill({ updatedAt: V1 }))
    await deliver(regular)
    await deliver(refresh)
    const fetchesBefore = textFetches
    const callsBefore = await analysisCalls()
    await deliver(regular)
    expect(textFetches).toBe(fetchesBefore)
    expect(await analysisCalls()).toBe(callsBefore)
  })

  it('refreshes the other fields of an unchanged bill without touching its version', async () => {
    centralServes(centralBill({ updatedAt: V1 }))
    await deliver(regular)
    centralServes(centralBill({ updatedAt: V1, title: 'Election Administration Act (corrected)' }))
    await deliver(refresh)
    const after = (await row())!
    expect(after.title).toBe('Election Administration Act (corrected)')
    expect(after.providerUpdatedAt).toBe(V1)
  })
})
