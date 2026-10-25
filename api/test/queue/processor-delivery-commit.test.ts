import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { processCentralNotification } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { bills, feedEvents } from '../../src/db/schema'
import { processBill } from '../../src/lib/llm'
import { clearDb, seedBill, seedBillText, stubFetch } from '../helpers'
import type { TenantQueueMessage } from '../../src/types'

// A full delivery stores a bill version as one commit (#906): the bill row with
// its version stamp, its subjects, committees, and texts, and its feed events
// land together or not at all. Before, the bill row was written first, stamped
// with central's version, so a write that failed after it left the rest of the
// version missing and its redelivery took the early skip for an unchanged bill.
// Each failure here is a real D1 error, raised by a trigger, standing in for a
// transient one.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 'Moves the primary to June.', tags: [], relevanceScore: 7 }) }
})

const testEnv = { ...env, TENANT_ID: 'ri', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x' }
const HANDLE = 'bill:4710'
const OLD_VERSION = '2026-06-01T09:12:44Z'
const NEW_VERSION = '2026-06-05T14:03:27Z'

const textD1 = { docId: '3101', note: 'Introduced', date: '2026-05-01', textHash: 'h1', links: [{ url: 'https://ri.example/S2655.htm', mediaType: 'text/html' }] }
const textD2 = { docId: '3188', note: 'Committee Substitute', date: '2026-06-04', textHash: 'h2', links: [{ url: 'https://ri.example/S2655A.htm', mediaType: 'text/html' }] }

const centralBill = {
  billId: HANDLE, sessionId: 'ri:2026', sessionName: '2026 Regular Session', yearStart: 2026, yearEnd: 2026,
  state: 'RI', number: 'S 2655', title: 'Elections - Primary Date', abstract: 'Moves the state primary to June.',
  status: 'Introduced', statusDate: '2026-05-01', updatedAt: NEW_VERSION, stateUrl: null,
  textHash: 'h1', textR2Key: 'texts/3101.htm', textStatus: 'in_r2' as const, texts: [textD1],
  actions: [
    { description: 'Introduced, referred to Senate Rules', date: '2026-05-01', chamber: 'upper', classification: [], order: 1 },
    { description: 'Re-referred to Senate Judiciary', date: '2026-06-04', chamber: 'upper', classification: [], order: 2 },
  ],
  sponsors: [], votes: [], relatedBills: [],
  subjects: ['Elections', 'Primaries'],
  committee: { committeeId: '1021', name: 'Judiciary', chamber: 'S' },
  referrals: [
    { committeeId: '1030', name: 'Rules', chamber: 'S' },
    { committeeId: '1021', name: 'Judiciary', chamber: 'S' },
  ],
}

const changes = [{ changeType: 'action_added', oldValue: null, newValue: 'Re-referred to Senate Judiciary', detail: null, detectedAt: '2026-06-05T14:03:25Z' }]
const hearing = {
  events: [{ identityKey: '7781|judiciary', date: '2026-06-11', time: '15:30:00', location: 'Room 212', description: 'Senate Judiciary', eventHash: 'e1' }],
  changes: [{ changeType: 'hearing_added' as const, identityKey: '7781|judiciary', date: '2026-06-11', time: '15:30:00', location: 'Room 212', description: 'Senate Judiciary', eventHash: 'e1' }],
}

function serve(bill: Record<string, unknown>) {
  stubFetch((url) => new Response(JSON.stringify(
    url.includes('/text') ? { type: 'html', content: '<p>The primary is held in June.</p>', docId: '3101', textHash: 'h1' } : bill,
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

describe('processCentralNotification: a full delivery lands as one commit (#906)', () => {
  const db = () => getDb(env.DB)
  const deliver = (extra: Partial<TenantQueueMessage> = {}) =>
    processCentralNotification({ tenantId: 'ri', billId: HANDLE, forceMetadata: false, forceAI: false, ...extra } as TenantQueueMessage, testEnv as never, db())
  const ofType = (type: string) => db().select().from(feedEvents).where(eq(feedEvents.type, type as never)).all()
  const billRow = () => db().select().from(bills).where(eq(bills.externalId, HANDLE)).get()
  const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results
  const committees = () => rows(`SELECT committee_id AS id, is_current AS current FROM bill_committees ORDER BY committee_id`)
  const texts = () => rows(`SELECT doc_id AS docId FROM bill_texts ORDER BY doc_id`)
  const subjects = () => rows(`SELECT subject_name AS name FROM bill_subjects ORDER BY subject_name`)
  const failInsertsInto = (table: string, when = '1') => env.DB.prepare(
    `CREATE TRIGGER fail_906 BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'forced D1 failure'); END`,
  ).run()
  const stopFailing = () => env.DB.prepare('DROP TRIGGER IF EXISTS fail_906').run()

  beforeEach(async () => {
    await clearDb()
    vi.mocked(processBill).mockClear()
  })
  afterEach(stopFailing)

  /** An analyzed keyword bill at the old version: one text, referred to Rules, already read by the model. */
  async function seedTracked(): Promise<string> {
    const id = await seedBill({
      externalId: HANDLE, billNumber: 'S 2655', matchType: 'keyword', relevanceScore: 6,
      aiProcessedAt: '2026-06-01 09:13:02', providerUpdatedAt: OLD_VERSION, newMatchAt: '2026-05-01 10:00:00',
      textR2Key: 'texts/3101.htm', status: 'Introduced',
    })
    await env.DB.prepare(`UPDATE bills SET last_ai_text_hash = 'h1' WHERE id = ?`).bind(id).run()
    await seedBillText(id, { docId: '3101', textHash: 'h1', date: '2026-05-01' })
    await env.DB.prepare(`INSERT INTO bill_committees (bill_id, committee_id, state, name, chamber, is_current) VALUES (?, '1030', 'RI', 'Rules', 'S', 1)`).bind(id).run()
    return id
  }

  it('redoes a tracked bill\'s whole update, once, after a committee write fails', async () => {
    await seedTracked()
    serve({ ...centralBill, status: 'In Committee', texts: [textD1, textD2] })
    await failInsertsInto('bill_committees')

    await expect(deliver({ matchType: 'keyword', changes })).rejects.toThrow()

    // Nothing of the new version landed.
    expect((await billRow())!.providerUpdatedAt).toBe(OLD_VERSION)
    expect((await billRow())!.status).toBe('Introduced')
    expect(await committees()).toEqual([{ id: '1030', current: 1 }])
    expect(await texts()).toEqual([{ docId: '3101' }])
    expect(await ofType('bill_updated')).toEqual([])
    expect(await ofType('no_priority_updates')).toEqual([])

    await stopFailing()
    await deliver({ matchType: 'keyword', changes })

    expect((await billRow())!.providerUpdatedAt).toBe(NEW_VERSION)
    expect((await billRow())!.status).toBe('In Committee')
    expect(await committees()).toEqual([{ id: '1021', current: 1 }, { id: '1030', current: 0 }])
    expect(await texts()).toEqual([{ docId: '3101' }, { docId: '3188' }])
    expect(await subjects()).toEqual([{ name: 'Elections' }, { name: 'Primaries' }])
    const updated = await ofType('bill_updated')
    expect(updated).toHaveLength(1)
    expect(JSON.parse(updated[0].metadata)).toEqual({ changes })
    expect(await ofType('no_priority_updates')).toHaveLength(1)

    // The version is now stored: a third copy of the message is skipped and adds nothing.
    await deliver({ matchType: 'keyword', changes })
    expect(await ofType('bill_updated')).toHaveLength(1)
    // The text was unchanged throughout, so the model never ran.
    expect(processBill).not.toHaveBeenCalled()
  })

  it('records a new routine match on redelivery after a text write fails, with no bill row before', async () => {
    serve(centralBill)
    await failInsertsInto('bill_texts')

    await expect(deliver({ matchType: 'keyword', matchProvenance: 'routine', changes })).rejects.toThrow()

    expect(await billRow()).toBeUndefined()
    expect(await rows(`SELECT id FROM feed_events`)).toEqual([])

    await stopFailing()
    await deliver({ matchType: 'keyword', matchProvenance: 'routine', changes })

    const bill = (await billRow())!
    expect(bill.tenantSummary).toBe('Moves the primary to June.')
    expect(bill.newMatchAt).not.toBeNull()
    expect(bill.providerUpdatedAt).toBe(NEW_VERSION)
    expect(await texts()).toEqual([{ docId: '3101' }])
    const matched = await ofType('bill_matched')
    expect(matched).toHaveLength(1)
    expect(JSON.parse(matched[0].metadata)).toEqual({ matchProvenance: 'routine' })
    const row = await ofType('new_matches')
    expect(row).toHaveLength(1)
    expect(JSON.parse(row[0].metadata)).toEqual({ billIds: [bill.id] })
    // A bill that just arrived is a match, not an update.
    expect(await ofType('bill_updated')).toEqual([])
    // The analysis landed with nothing else, so the redelivery analyzed again.
    expect(processBill).toHaveBeenCalledTimes(2)
  })

  it('records a monitored bill\'s new match on redelivery after the match event fails, and no update', async () => {
    const id = await seedBill({ externalId: HANDLE, billNumber: 'S 2655', matchType: null, providerUpdatedAt: OLD_VERSION, status: 'Introduced' })
    await env.DB.prepare(`UPDATE bills SET fully_ingested_at = '2026-06-01 09:13:02' WHERE id = ?`).bind(id).run()
    serve({ ...centralBill, status: 'In Committee' })
    await failInsertsInto('feed_events', `NEW.type = 'bill_matched'`)

    await expect(deliver({ matchType: 'keyword', matchProvenance: 'routine', changes })).rejects.toThrow()

    const before = (await billRow())!
    expect(before.matchType).toBeNull()
    expect(before.aiProcessedAt).toBeNull()
    expect(before.providerUpdatedAt).toBe(OLD_VERSION)

    await stopFailing()
    await deliver({ matchType: 'keyword', matchProvenance: 'routine', changes })

    const after = (await billRow())!
    expect(after.matchType).toBe('keyword')
    expect(after.aiProcessedAt).not.toBeNull()
    expect(after.providerUpdatedAt).toBe(NEW_VERSION)
    expect(await ofType('bill_matched')).toHaveLength(1)
    expect(await ofType('new_matches')).toHaveLength(1)
    // Its first analysis is a match, as on a delivery that never failed: no update event.
    expect(await ofType('bill_updated')).toEqual([])
  })

  it('writes an update once when a hearing write fails after the version landed', async () => {
    await seedTracked()
    serve({ ...centralBill, status: 'In Committee' })
    await failInsertsInto('calendar_events')

    await expect(deliver({ matchType: 'keyword', changes, calendar: hearing })).rejects.toThrow()
    expect((await billRow())!.providerUpdatedAt).toBe(NEW_VERSION)
    expect(await ofType('bill_updated')).toHaveLength(1)

    await stopFailing()
    await deliver({ matchType: 'keyword', changes, calendar: hearing })

    // The redelivery takes the skip for a stored version, and still reconciles the hearing.
    expect(await ofType('bill_updated')).toHaveLength(1)
    expect(await ofType('hearing_added')).toHaveLength(1)
    expect(await rows(`SELECT uid FROM calendar_events`)).toHaveLength(1)
  })

  it('leaves no rows on a bill that does not exist when another delivery creates the bill mid-message', async () => {
    serve(centralBill)
    let otherId = ''
    vi.mocked(processBill).mockImplementationOnce(async () => {
      // Another delivery of the same new bill lands while the model works.
      otherId = await seedBill({ externalId: HANDLE, billNumber: 'S 2655', matchType: 'keyword', providerUpdatedAt: OLD_VERSION })
      return { summary: 'Moves the primary to June.', tags: [], relevanceScore: 7 } as never
    })

    await expect(deliver({ matchType: 'keyword', matchProvenance: 'routine' })).rejects.toThrow()
    expect(await rows(`SELECT bill_id FROM bill_texts WHERE bill_id != '${otherId}'`)).toEqual([])
    expect(await rows(`SELECT bill_id FROM bill_subjects WHERE bill_id != '${otherId}'`)).toEqual([])
    expect(await rows(`SELECT id FROM feed_events`)).toEqual([])

    await deliver({ matchType: 'keyword', matchProvenance: 'routine' })
    const bill = (await billRow())!
    expect(bill.id).toBe(otherId)
    expect(bill.providerUpdatedAt).toBe(NEW_VERSION)
    expect(await texts()).toEqual([{ docId: '3101' }])
    expect(await rows(`SELECT bill_id FROM bill_texts WHERE bill_id != '${otherId}'`)).toEqual([])
  })
})
