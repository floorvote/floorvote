import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import migration0001 from '../../migrations-legiscan/0001_initial.sql?raw'
import migration0002 from '../../migrations-legiscan/0002_api_call_log_v2.sql?raw'
import migration0003 from '../../migrations-legiscan/0003_session_sync_log.sql?raw'
import migration0004 from '../../migrations-legiscan/0004_match_tracking.sql?raw'
import migration0005 from '../../migrations-legiscan/0005_bill_amendments_and_change_log.sql?raw'
import migration0006 from '../../migrations-legiscan/0006_texts_fetched_at.sql?raw'
import migration0013 from '../../migrations-legiscan/0013_tenants_queue_id.sql?raw'
import migration0016 from '../../migrations-legiscan/0016_bill_texts_fetch_error.sql?raw'

// Mock the LegiScan API surface. The processor calls getBill at the top of
// processLsBill. We don't want real network calls.
// getBillText must be mocked too: it is the fallback when a state's own link
// won't yield the document, and the real one would hit api.legiscan.com (and
// burn a quota call) from the test suite.
vi.mock('../../src/lib/legiscan', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/legiscan')>('../../src/lib/legiscan')
  return { ...actual, getBill: vi.fn(), getBillText: vi.fn() }
})

// Mock text downloads — these go to state legislature sites and we don't
// need to hit those in tests. R2 writes still happen via the real binding.
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { processLsIngestorQueue, validateTextPayload } from '../../src/queue/processor-legiscan'
import * as legiscan from '../../src/lib/legiscan'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map(s => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)
    .map(s => s + ';')
  return { name, queries }
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0002, '0002_api_call_log_v2'),
    parseMigration(migration0003, '0003_session_sync_log'),
    parseMigration(migration0004, '0004_match_tracking'),
    parseMigration(migration0005, '0005_bill_amendments_and_change_log'),
    parseMigration(migration0006, '0006_texts_fetched_at'),
    parseMigration(migration0013, '0013_tenants_queue_id'),
    parseMigration(migration0016, '0016_bill_texts_fetch_error'),
  ])
  fetchMock.mockReset()
  // Default: text downloads succeed with empty html so r2_key gets stamped.
  fetchMock.mockResolvedValue(
    new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  )
  vi.mocked(legiscan.getBill).mockReset()
})

// Helper: builds a complete LegiscanBill fixture with every child collection
// populated. We use this as the canonical "what getBill returns" payload.
function buildFixtureBill(overrides: Partial<any> = {}): any {
  return {
    bill_id: 9001,
    change_hash: 'hash-v1',
    session_id: 2154,
    state: 'WI',
    state_id: 50,
    bill_number: 'AB99',
    bill_type: 'B',
    bill_type_id: '1',
    body: 'A',
    body_id: 26,
    current_body: 'A',
    current_body_id: 26,
    title: 'Test bill',
    description: 'A test bill',
    status: 1,
    status_date: '2026-01-15',
    completed: 0,
    pending_committee_id: 0,
    url: 'https://legiscan.com/WI/bill/AB99/2025',
    state_link: 'https://docs.legis.wisconsin.gov/2025/proposals/ab99',
    session: { session_id: 2154, session_name: '2025-2026 Regular', year_start: 2025, year_end: 2026 },
    committee: { committee_id: 7001, chamber: 'A', chamber_id: 26, name: 'Elections' },
    referrals: [{ date: '2026-01-16', committee_id: 7001, chamber: 'A', chamber_id: 26, name: 'Elections' }],
    progress: [{ date: '2026-01-15', event: 1 }],
    sponsors: [
      { people_id: 5001, name: 'Sen Alpha', party: 'R', role: 'Senator', role_id: 2, district: '01', sponsor_type_id: 1, sponsor_order: 1 },
    ],
    history: [
      { date: '2026-01-15', action: 'Introduced', chamber: 'A', chamber_id: 26, importance: 1 },
    ],
    sasts: [{ type_id: 1, type: 'Same As', sast_bill_number: 'SB99', sast_bill_id: 9002 }],
    subjects: [{ subject_id: 100, subject_name: 'Elections' }],
    votes: [
      { roll_call_id: 800001, date: '2026-03-01', desc: 'Final passage', yea: 60, nay: 40, nv: 0, absent: 0, total: 100, passed: 1, chamber: 'A', chamber_id: 26, url: 'https://legiscan.com/rc/1', state_link: 'https://docs.legis.wi.gov/rc/1' },
    ],
    texts: [
      { doc_id: 1000, date: '2026-01-15', type: 'Introduced', type_id: 1, mime: 'text/html', mime_id: 1, url: 'u', state_link: 'https://docs.legis.wi.gov/ab99.html', text_size: 1024, text_hash: 'th', alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '' },
    ],
    calendar: [
      { type_id: 1, event_hash: 'ev1', type: 'Hearing', date: '2026-02-10', time: '10:00', location: 'Room 412', description: 'Public hearing' },
    ],
    amendments: [
      { amendment_id: 600001, adopted: 0, chamber: 'A', date: '2026-02-15', title: 'Amendment 1', description: 'first amendment', mime: 'application/pdf', url: 'au', state_link: 'asl', amendment_size: 500, amendment_hash: 'ah' },
    ],
    supplements: [
      { supplement_id: 700001, date: '2026-02-20', type_id: 1, type: 'Fiscal Note', title: 'Fiscal Note', description: 'AB99 estimate', mime: 'application/pdf', mime_id: 2, url: 'su', state_link: 'sl', supplement_size: 1000, supplement_hash: 'sh' },
    ],
    ...overrides,
  }
}

// Build a mock MessageBatch that processLsIngestorQueue can iterate.
// The processor calls message.ack() on success; we need a mock that won't throw.
function makeBatch(billId: number, overrides: Record<string, unknown> = {}): MessageBatch<any> {
  const ack = vi.fn()
  const retry = vi.fn()
  return {
    messages: [
      {
        body: { billId, ...overrides },
        ack,
        retry,
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
      },
    ],
    queue: 'central-ingestor',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<any>
}

function makeEnv() {
  const ingestorSend = vi.fn().mockResolvedValue(undefined)
  const ingestorSendBatch = vi.fn().mockResolvedValue(undefined)
  return {
    ...(env as any),
    INGESTOR_QUEUE: { send: ingestorSend, sendBatch: ingestorSendBatch },
    LEGISCAN_API_KEY: 'test-key',
  }
}

describe('processLsBill: unified ingest path (post-F3 invariant)', () => {
  // This test exists to catch the §A1 regression: when an existing bill is
  // re-ingested with the SAME change_hash, the ingestor used to take a
  // "fast path" that wrote texts/supplements/amendments but NOT
  // history/sponsors/subjects/calendar/sasts/referrals/roll_calls. After
  // collapsing the paths, every getBill response must write every child
  // collection regardless of hash match.
  it('writes every child collection even when change_hash matches existing row', async () => {
    const db = drizzle(env.DB, { schema })
    // Seed a session and a bill with the SAME change_hash that getBill will return.
    await db.insert(schema.sessions).values({
      sessionId: 2154, state: 'WI', stateId: 50,
      yearStart: 2025, yearEnd: 2026,
      sessionName: '2025-2026 Regular', sessionTitle: '2025-2026 Regular', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    await db.insert(schema.bills).values({
      billId: 9001, changeHash: 'hash-v1',
      sessionId: 2154, state: 'WI', stateId: 50,
      billNumber: 'AB99', title: 'Test bill', status: 1,
    })

    const fixture = buildFixtureBill()
    vi.mocked(legiscan.getBill).mockResolvedValue(fixture)

    const batch = makeBatch(9001)
    await processLsIngestorQueue(batch, makeEnv(), db)

    // §A1 invariant: every child table has the expected rows.
    const historyRows = await db.select().from(schema.billHistory).where(eq(schema.billHistory.billId, 9001)).all()
    expect(historyRows.length, 'bill_history must be written').toBeGreaterThan(0)

    const sponsorRows = await db.select().from(schema.billSponsors).where(eq(schema.billSponsors.billId, 9001)).all()
    expect(sponsorRows.length, 'bill_sponsors must be written').toBeGreaterThan(0)

    const subjectRows = await db.select().from(schema.billSubjects).where(eq(schema.billSubjects.billId, 9001)).all()
    expect(subjectRows.length, 'bill_subjects must be written').toBeGreaterThan(0)

    const sastRows = await db.select().from(schema.billSasts).where(eq(schema.billSasts.billId, 9001)).all()
    expect(sastRows.length, 'bill_sasts must be written').toBeGreaterThan(0)

    const calendarRows = await db.select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, 9001)).all()
    expect(calendarRows.length, 'bill_calendar must be written').toBeGreaterThan(0)

    const referralRows = await db.select().from(schema.billReferrals).where(eq(schema.billReferrals.billId, 9001)).all()
    expect(referralRows.length, 'bill_referrals must be written').toBeGreaterThan(0)

    const supplementRows = await db.select().from(schema.billSupplements).where(eq(schema.billSupplements.billId, 9001)).all()
    expect(supplementRows.length, 'bill_supplements must be written').toBeGreaterThan(0)

    const amendmentRows = await db.select().from(schema.billAmendments).where(eq(schema.billAmendments.billId, 9001)).all()
    expect(amendmentRows.length, 'bill_amendments must be written').toBeGreaterThan(0)

    const textRows = await db.select().from(schema.billTexts).where(eq(schema.billTexts.billId, 9001)).all()
    expect(textRows.length, 'bill_texts must be written').toBeGreaterThan(0)

    // §B4 invariant: roll_calls must be written (new in this PR).
    const rollCallRows = await db.select().from(schema.rollCalls).where(eq(schema.rollCalls.billId, 9001)).all()
    expect(rollCallRows.length, 'roll_calls must be written').toBeGreaterThan(0)
  })

  it('upserts a people row from the getBill sponsor payload so names resolve without bulk seeding', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: 2154, state: 'WI', stateId: 50,
      yearStart: 2025, yearEnd: 2026,
      sessionName: '2025-2026 Regular', sessionTitle: '2025-2026 Regular', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    // No people row pre-seeded — the WI case. The sponsor name lives in the
    // getBill payload; ingest must persist it into `people` so the read-time
    // join in bills-legiscan resolves a name instead of falling back to the id.
    const fixture = buildFixtureBill()
    vi.mocked(legiscan.getBill).mockResolvedValue(fixture)

    await processLsIngestorQueue(makeBatch(9001), makeEnv(), db)

    const person = await db.select().from(schema.people).where(eq(schema.people.peopleId, 5001)).get()
    expect(person, 'people row must be created from the sponsor payload').toBeDefined()
    expect(person?.name).toBe('Sen Alpha')
    expect(person?.party).toBe('R')
    expect(person?.role).toBe('Senator')
    expect(person?.district).toBe('01')
  })

  it('does not clobber an existing people row bio_json on re-ingest', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: 2154, state: 'WI', stateId: 50,
      yearStart: 2025, yearEnd: 2026,
      sessionName: '2025-2026 Regular', sessionTitle: '2025-2026 Regular', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    // A richly-seeded person (e.g. from a bulk dataset) already exists with bio_json.
    await db.insert(schema.people).values({
      peopleId: 5001, name: 'Senator Alpha Beta', party: 'R', role: 'Senator',
      bioJson: JSON.stringify({ social: { biography: 'https://ballotpedia.org/Alpha_Beta' } }),
    })

    const fixture = buildFixtureBill()
    vi.mocked(legiscan.getBill).mockResolvedValue(fixture)

    await processLsIngestorQueue(makeBatch(9001), makeEnv(), db)

    const person = await db.select().from(schema.people).where(eq(schema.people.peopleId, 5001)).get()
    expect(person?.bioJson, 'bio_json must be preserved across re-ingest').toContain('ballotpedia.org')
    // Display fields still refresh from the latest payload.
    expect(person?.name).toBe('Sen Alpha')
  })

  it('writes bill_change_log rows when title changes between ingests', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: 2154, state: 'WI', stateId: 50,
      yearStart: 2025, yearEnd: 2026,
      sessionName: '2025-2026 Regular', sessionTitle: '2025-2026 Regular', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    await db.insert(schema.bills).values({
      billId: 9001, changeHash: 'hash-v0',
      sessionId: 2154, state: 'WI', stateId: 50,
      billNumber: 'AB99', title: 'Original title', status: 1,
    })

    const fixture = buildFixtureBill({ change_hash: 'hash-v1', title: 'Updated title' })
    vi.mocked(legiscan.getBill).mockResolvedValue(fixture)

    const batch = makeBatch(9001)
    await processLsIngestorQueue(batch, makeEnv(), db)

    const changeLogRows = await db.select().from(schema.billChangeLog).where(eq(schema.billChangeLog.billId, 9001)).all()
    const titleChanges = changeLogRows.filter(c => c.changeType === 'title_changed')
    expect(titleChanges.length).toBe(1)
    expect(titleChanges[0].oldValue).toBe('Original title')
    expect(titleChanges[0].newValue).toBe('Updated title')
  })

  it('writes nothing to bill_change_log when metadata is unchanged', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: 2154, state: 'WI', stateId: 50,
      yearStart: 2025, yearEnd: 2026,
      sessionName: '2025-2026 Regular', sessionTitle: '2025-2026 Regular', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    const fixture = buildFixtureBill()
    // Seed bill exactly matching the fixture's title/description/status — change detection
    // for these three fields should see no diff.
    await db.insert(schema.bills).values({
      billId: fixture.bill_id, changeHash: fixture.change_hash,
      sessionId: fixture.session_id, state: fixture.state, stateId: fixture.state_id,
      billNumber: fixture.bill_number, title: fixture.title, description: fixture.description,
      status: fixture.status,
    })

    vi.mocked(legiscan.getBill).mockResolvedValue(fixture)

    const batch = makeBatch(fixture.bill_id)
    await processLsIngestorQueue(batch, makeEnv(), db)

    const changeLogRows = await db.select().from(schema.billChangeLog).where(eq(schema.billChangeLog.billId, fixture.bill_id)).all()
    const metadataChanges = changeLogRows.filter(c =>
      c.changeType === 'status_change' || c.changeType === 'title_changed' || c.changeType === 'description_changed'
    )
    expect(metadataChanges.length).toBe(0)
  })

  it('writes all child rows for a brand-new bill (existingBillRow is null)', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: 2154, state: 'WI', stateId: 50,
      yearStart: 2025, yearEnd: 2026,
      sessionName: '2025-2026 Regular', sessionTitle: '2025-2026 Regular', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })
    // Note: no bills row pre-seeded. The processor must create it from the
    // getBill response and still write all child rows.

    const fixture = buildFixtureBill()
    vi.mocked(legiscan.getBill).mockResolvedValue(fixture)

    const batch = makeBatch(9001)
    await processLsIngestorQueue(batch, makeEnv(), db)

    const billRow = await db.select().from(schema.bills).where(eq(schema.bills.billId, 9001)).get()
    expect(billRow).toBeDefined()
    expect(billRow?.title).toBe('Test bill')

    const historyRows = await db.select().from(schema.billHistory).where(eq(schema.billHistory.billId, 9001)).all()
    expect(historyRows.length).toBe(1)
    const rollCallRows = await db.select().from(schema.rollCalls).where(eq(schema.rollCalls.billId, 9001)).all()
    expect(rollCallRows.length).toBe(1)
  })

  it('silently accepts messages still carrying forceFullIngest (queue in-flight during deploy)', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: 2154, state: 'WI', stateId: 50,
      yearStart: 2025, yearEnd: 2026,
      sessionName: '2025-2026 Regular', sessionTitle: '2025-2026 Regular', sessionTag: '',
      prefile: 0, sineDie: 0, prior: 0, special: 0,
    })

    const fixture = buildFixtureBill()
    vi.mocked(legiscan.getBill).mockResolvedValue(fixture)

    const batch = makeBatch(9001, { forceFullIngest: true } as any)
    await processLsIngestorQueue(batch, makeEnv(), db)

    // The processor should have ack'd, not retried — the extra field is silently ignored.
    expect(batch.messages[0].ack).toHaveBeenCalled()
    expect(batch.messages[0].retry).not.toHaveBeenCalled()

    const billRow = await db.select().from(schema.bills).where(eq(schema.bills.billId, 9001)).get()
    expect(billRow).toBeDefined()
    // Child writes also happened — the field didn't divert control flow somewhere weird.
    const historyRows = await db.select().from(schema.billHistory).where(eq(schema.billHistory.billId, 9001)).all()
    expect(historyRows.length).toBe(1)
  })
})

// ── Bill-text fetch hardening ───────────────────────────────────────────────
//
// Indiana's iga.in.gov answers non-browser clients with its JavaScript app
// shell — HTTP 200, content-type text/html, ~691 bytes — even for a URL ending
// in .pdf. That payload was stored as the document, so all 40 Indiana keyword
// bills failed AI with "The document has no pages" while looking, in the
// database, exactly like bills that had never been processed.

const IN_APP_SHELL =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"/>'
  + '<title>Indiana General Assembly</title></head>'
  + '<body>You need to enable JavaScript to run this app.</body></html>'

/** Minimal byte string that passes a %PDF- magic check. */
const REAL_PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

function abuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

function toBase64(s: string): string {
  let out = ''
  for (const b of new TextEncoder().encode(s)) out += String.fromCharCode(b)
  return btoa(out)
}

describe('validateTextPayload', () => {
  it('rejects an HTML app shell served under a PDF mime', () => {
    // The exact Indiana failure.
    expect(validateTextPayload(abuf(IN_APP_SHELL), 'application/pdf', 180826))
      .toMatch(/expected a PDF/)
  })

  it('accepts real PDF bytes', () => {
    expect(validateTextPayload(abuf(REAL_PDF), 'application/pdf', null)).toBeNull()
  })

  it('rejects an empty body', () => {
    expect(validateTextPayload(new ArrayBuffer(0), 'text/html', null)).toMatch(/empty/)
  })

  it('rejects an HTML body far smaller than the declared size', () => {
    // Catches the same substitution for HTML documents, where there is no magic
    // number to check.
    expect(validateTextPayload(abuf('<html>blocked</html>'), 'text/html', 200000))
      .toMatch(/far smaller/)
  })

  it('ignores the size ratio when the declared size is small', () => {
    // Short documents legitimately vary in size, so the ratio only carries
    // signal once the declared size is big enough to be a real document.
    expect(validateTextPayload(abuf('<html></html>'), 'text/html', 1024)).toBeNull()
  })

  it('accepts an HTML document of roughly the declared size', () => {
    const doc = '<html>' + 'x'.repeat(20000) + '</html>'
    expect(validateTextPayload(abuf(doc), 'text/html', 20000)).toBeNull()
  })
})

describe('downloadTextToR2: bot-wall handling', () => {
  const pdfText = {
    doc_id: 1000, date: '2026-01-15', type: 'Introduced', type_id: 1,
    mime: 'application/pdf', mime_id: 2, url: 'u',
    state_link: 'https://iga.in.gov/pdf-documents/124/2026/house/bills/HB1022/HB1022.01.INTR.pdf',
    text_size: 180826, text_hash: 'th',
    alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '',
  }

  it('falls back to getBillText when the state link returns an app shell', async () => {
    const db = drizzle(env.DB, { schema })
    vi.mocked(legiscan.getBill).mockResolvedValue(buildFixtureBill({ texts: [pdfText] }))
    // The state site: 200 OK, but HTML instead of the PDF.
    fetchMock.mockResolvedValue(new Response(IN_APP_SHELL, {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    vi.mocked(legiscan.getBillText).mockResolvedValue({
      doc_id: 1000, bill_id: 9001, date: '2026-01-15', type: 'Introduced', type_id: 1,
      mime: 'application/pdf', mime_id: 2, text_size: REAL_PDF.length, text_hash: 'th',
      doc: toBase64(REAL_PDF),
    } as any)

    await processLsIngestorQueue(makeBatch(9001), makeEnv(), db)

    const row = await db.select().from(schema.billTexts).where(eq(schema.billTexts.docId, 1000)).get()
    expect(legiscan.getBillText).toHaveBeenCalledWith(1000, 'test-key')
    expect(row!.r2Key, 'the fallback document should be stored').toBeTruthy()
    expect(row!.fetchError, 'a recovered fetch is not a failure').toBeNull()
  })

  it('records fetch_error and no r2_key when both sources fail', async () => {
    const db = drizzle(env.DB, { schema })
    vi.mocked(legiscan.getBill).mockResolvedValue(buildFixtureBill({ texts: [pdfText] }))
    fetchMock.mockResolvedValue(new Response(IN_APP_SHELL, {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    vi.mocked(legiscan.getBillText).mockRejectedValue(new Error('LegiScan HTTP 403'))

    await processLsIngestorQueue(makeBatch(9001), makeEnv(), db)

    const row = await db.select().from(schema.billTexts).where(eq(schema.billTexts.docId, 1000)).get()
    // Storing nothing is deliberate: an r2_key here would be sticky, because the
    // download path only retries texts WHERE r2_key IS NULL.
    expect(row!.r2Key).toBeNull()
    expect(row!.fetchError).toMatch(/expected a PDF/)
    expect(row!.fetchError).toMatch(/403/)
    expect(row!.fetchAttemptedAt).toBeTruthy()
  })
})
