import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, stubFetch } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { associationConfig } from '../../src/db/schema'
import { buildBillDetail } from '../../src/routes/billsApi/detail'
import { computeClaimSourceCounts } from '../../src/lib/claimSourceCounts'
import type { TenantQueueMessage } from '../../src/types'

// Claim sources from the analysis call, stored on the bill and pinned to the
// document the model read (#568). The model is stubbed at the SDK, so these run
// the real schema, the real response parsing, and the real write.

const geminiGenerateMock = vi.hoisted(() => vi.fn())
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent: geminiGenerateMock } }
  }),
  ServiceTier: { FLEX: 'flex', STANDARD: 'standard', PRIORITY: 'priority', UNSPECIFIED: 'unspecified' },
}))

const claimLinksEnabledMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/claimSources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/claimSources')>()
  return { ...actual, claimLinksEnabled: claimLinksEnabledMock }
})

// The durable cut-off count (#573) is the real one by default. A test makes it
// throw to show that counting can never fail an analysis.
const recordCutOffMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/claimSourceCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/claimSourceCounts')>()
  recordCutOffMock.mockImplementation(actual.recordClaimSourcesCutOff)
  return { ...actual, recordClaimSourcesCutOff: recordCutOffMock }
})

const BILL_ID = 'legiscan:9001'

// Invented bill. Two versions: the text endpoint serves 5001 (the one with a
// stored copy), while the newest by date is 5002, which is what
// last_ai_text_doc_id records. The claim sources must pin to 5001.
const centralBill = {
  billId: BILL_ID,
  sessionId: '2100',
  state: 'ZZ',
  number: 'HB 77',
  title: 'An Act Relating to Ballot Drop Boxes',
  abstract: 'Requires drop boxes in each county',
  status: 'introduced',
  statusDate: '2026-01-01',
  updatedAt: '2026-01-10T12:00:00Z',
  stateUrl: 'https://legislature.example/HB77',
  textHash: 'hash-5001',
  textR2Key: 'bills/legiscan-9001/texts/5001.html',
  texts: [
    { docId: '5001', note: 'Introduced', date: '2026-01-01', links: [{ url: 'https://legislature.example/5001.html', mediaType: 'text/html' }] },
    { docId: '5002', note: 'Amended', date: '2026-02-01', links: [{ url: 'https://legislature.example/5002.html', mediaType: 'text/html' }] },
  ],
  actions: [{ description: 'Introduced', date: '2026-01-10', chamber: 'lower', classification: [], order: 1 }],
  sponsors: [],
  votes: [],
  relatedBills: [],
}

const HTML_TEXT = { type: 'html', content: '<p>Section 1. Each county shall provide at least one drop box.</p>', docId: '5001', textHash: 'hash-5001' }
const PDF_TEXT = { type: 'pdf', content: btoa('%PDF fake'), docId: '5001', textHash: 'hash-5001' }

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' } as any
const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }

function central(text: unknown, bill: Record<string, unknown> = {}) {
  stubFetch(url => {
    if (url.includes('/text')) {
      return text === null
        ? new Response(JSON.stringify({ error: 'no text available' }), { status: 404 })
        : new Response(JSON.stringify(text), { status: 200 })
    }
    return new Response(JSON.stringify({ ...centralBill, ...bill }), { status: 200 })
  })
}

function model(payload: unknown) {
  geminiGenerateMock.mockResolvedValue({ text: JSON.stringify(payload) })
}

const analysis = { affectedCitations: [], summary: 'Requires a drop box in each county.', tags: ['Voting'], relevanceScore: 7 }
const sources = [{ claim: 'Requires a drop box in each county.', quote: 'Each county shall provide at least one drop box.' }]

// What the first of those resolves to: the claim is the whole summary, and the
// quote is exact in the document, after "Section 1. ".
const resolvedFirst = {
  ...sources[0],
  status: 'exact',
  claimAt: { start: 0, end: sources[0].claim.length },
  quoteAt: { start: 'Section 1. '.length, end: 'Section 1. '.length + sources[0].quote.length },
  matched: sources[0].quote,
}

async function row() {
  return (await env.DB.prepare('SELECT * FROM bills WHERE external_id = ?').bind(BILL_ID).first()) as Record<string, unknown>
}
const lastSchema = () => geminiGenerateMock.mock.calls.at(-1)![0].config.responseSchema

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.clearAllMocks()
  geminiGenerateMock.mockReset()
  claimLinksEnabledMock.mockResolvedValue(true)
  const db = getDb(env.DB)
  await db.insert(associationConfig).values([
    { key: 'keywords', value: JSON.stringify(['ballot']) },
    { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }]) },
  ])
  central(HTML_TEXT)
  model({ ...analysis, claimSources: sources })
})

describe('storing claim sources from an analysis', () => {
  it('asks an HTML analysis for {claim, quote} items and stores them', async () => {
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(Object.keys(lastSchema().properties.claimSources.items.properties)).toEqual(['claim', 'quote'])
    const r = await row()
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(JSON.parse(r.claim_sources as string)).toEqual([resolvedFirst])
  })

  it('pins them to the document central served, not last_ai_text_doc_id', async () => {
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.claim_sources_doc_id).toBe('5001')
    expect(r.claim_sources_text_hash).toBe('hash-5001')
    expect(r.last_ai_text_doc_id).toBe('5002')
  })

  it('asks a PDF analysis for {claim, quote, page} items and stores the page', async () => {
    central(PDF_TEXT)
    model({ ...analysis, claimSources: [{ ...sources[0], page: 2 }, { claim: 'Requires', quote: 'drop box', page: 0 }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(Object.keys(lastSchema().properties.claimSources.items.properties)).toEqual(['claim', 'quote', 'page'])
    const r = await row()
    // A PDF's quote is never matched, since the instance has no PDF text.
    expect(JSON.parse(r.claim_sources as string)).toEqual([
      { ...sources[0], page: 2, status: 'unverified', claimAt: resolvedFirst.claimAt },
      { claim: 'Requires', quote: 'drop box', page: null, status: 'unverified', claimAt: { start: 0, end: 8 } },
    ])
    expect(r.claim_sources_doc_id).toBe('5001')
  })

  it.each([
    ['missing', {}],
    ['null', { claimSources: null }],
    ['malformed', { claimSources: 'see above' }],
    ['a list of junk', { claimSources: [null, 3, { claim: 1 }] }],
  ])('stores the summary, tags, and relevance with no claim sources when claimSources is %s', async (_label, extra) => {
    model({ ...analysis, ...extra })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(JSON.parse(r.tags as string)).toEqual(['Voting'])
    expect(r.relevance_score).toBe(7)
    expect(r.ai_processed_at).not.toBeNull()
    expect(JSON.parse(r.claim_sources as string)).toEqual([])
    expect(r.claim_sources_doc_id).toBe('5001')
  })

  it('with the setting off, does not ask and stores nothing', async () => {
    claimLinksEnabledMock.mockResolvedValue(false)
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(lastSchema().properties).not.toHaveProperty('claimSources')
    const r = await row()
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(r).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null })
  })

  it('does not ask when an older central sends no doc id, since nothing could be pinned', async () => {
    central({ type: 'html', content: HTML_TEXT.content })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(lastSchema().properties).not.toHaveProperty('claimSources')
    const r = await row()
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(r).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null })
  })

  it('stores a null hash beside the doc id when central has no hash for the document', async () => {
    central({ ...HTML_TEXT, textHash: null })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const r = await row()
    expect(r).toMatchObject({ claim_sources_doc_id: '5001', claim_sources_text_hash: null })
    expect(JSON.parse(r.claim_sources as string)).toEqual([resolvedFirst])
  })

  it('does not ask when the model reads only the title and abstract', async () => {
    central(null)
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(geminiGenerateMock).toHaveBeenCalled()
    expect(lastSchema().properties).not.toHaveProperty('claimSources')
    expect(await row()).toMatchObject({ claim_sources: null, claim_sources_doc_id: null })
  })
})

describe('re-analysis', () => {
  const second = [{ claim: 'Moves the deadline.', quote: 'no later than May 1' }]

  it('replaces the claim sources and their pin, rather than adding to them', async () => {
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    central({ ...HTML_TEXT, docId: '5003', textHash: 'hash-5003' }, { textHash: 'hash-5003', updatedAt: '2026-03-01T00:00:00Z' })
    model({ ...analysis, summary: 'Moves the deadline.', claimSources: second })
    await processCentralNotification({ ...msg, forceAI: true }, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.tenant_summary).toBe('Moves the deadline.')
    // The new quote is not in the new document.
    expect(JSON.parse(r.claim_sources as string)).toEqual([{ ...second[0], status: 'ungrounded', claimAt: { start: 0, end: 19 } }])
    expect(r).toMatchObject({ claim_sources_doc_id: '5003', claim_sources_text_hash: 'hash-5003' })
  })

  it('replaces them with an empty list when the new analysis returns none', async () => {
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    model({ ...analysis, claimSources: [] })
    await processCentralNotification({ ...msg, forceAI: true }, testEnv, getDb(env.DB))
    expect(JSON.parse((await row()).claim_sources as string)).toEqual([])
  })

  it('clears them when the setting is off for the new analysis, so none outlive their summary', async () => {
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    claimLinksEnabledMock.mockResolvedValue(false)
    model({ ...analysis, summary: 'A new summary.' })
    await processCentralNotification({ ...msg, forceAI: true }, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.tenant_summary).toBe('A new summary.')
    expect(r).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null })
  })

  it('leaves them and their pin alone when the new analysis is permanently skipped', async () => {
    central(PDF_TEXT)
    model({ ...analysis, claimSources: [{ ...sources[0], page: 1 }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    geminiGenerateMock.mockRejectedValue(Object.assign(new Error('The document exceeds the supported page limit of 1000'), { status: 400 }))
    central({ ...PDF_TEXT, docId: '5003', textHash: 'hash-5003' }, { textHash: 'hash-5003', updatedAt: '2026-03-01T00:00:00Z' })
    await processCentralNotification({ ...msg, forceAI: true }, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.ai_skip_reason).toBe('pdf_too_large')
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(JSON.parse(r.claim_sources as string)).toEqual([{ ...sources[0], page: 1, status: 'unverified', claimAt: resolvedFirst.claimAt }])
    expect(r).toMatchObject({ claim_sources_doc_id: '5001', claim_sources_text_hash: 'hash-5001' })
  })

  it('leaves them with their summary when the new analysis fails', async () => {
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    geminiGenerateMock.mockRejectedValue(new Error('upstream exploded'))
    await processCentralNotification({ ...msg, forceAI: true }, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.ai_error).toContain('upstream exploded')
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(JSON.parse(r.claim_sources as string)).toEqual([resolvedFirst])
    expect(r.claim_sources_doc_id).toBe('5001')
  })
})

describe('the shed retry and a cut-off response', () => {
  it('asks again at standard after a shed priority call, and stores what that call returns with the pin', async () => {
    geminiGenerateMock.mockRejectedValueOnce(Object.assign(new Error('model overloaded'), { status: 503 }))
    await processCentralNotification({ ...msg, interactive: true }, testEnv, getDb(env.DB))
    expect(geminiGenerateMock).toHaveBeenCalledTimes(2)
    const [first, second] = geminiGenerateMock.mock.calls.map(c => c[0].config)
    expect(first.serviceTier).toBe('priority')
    expect(second.serviceTier).toBe('standard')
    expect(first.responseSchema.properties).toHaveProperty('claimSources')
    expect(second.responseSchema.properties).toHaveProperty('claimSources')
    const r = await row()
    expect(JSON.parse(r.claim_sources as string)).toEqual([resolvedFirst])
    expect(r).toMatchObject({ claim_sources_doc_id: '5001', claim_sources_text_hash: 'hash-5001' })
  })

  it('stores the summary with no claim sources when the response is cut off inside them', async () => {
    const cut = JSON.stringify({ ...analysis, claimSources: [...sources, ...sources] }).slice(0, -25)
    geminiGenerateMock
      .mockResolvedValueOnce({ text: cut })
      .mockResolvedValueOnce({ text: JSON.stringify(analysis) })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(geminiGenerateMock).toHaveBeenCalledTimes(2)
    expect(geminiGenerateMock.mock.calls[1][0].config.responseSchema.properties).not.toHaveProperty('claimSources')
    const r = await row()
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(r.ai_processed_at).not.toBeNull()
    expect(r.ai_error).toBeNull()
    expect(r).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null })
  })
})

describe('counting a recovered cut-off (#573)', () => {
  const cutOffThenRecover = () => {
    const cut = JSON.stringify({ ...analysis, claimSources: [...sources, ...sources] }).slice(0, -25)
    geminiGenerateMock
      .mockResolvedValueOnce({ text: cut })
      .mockResolvedValueOnce({ text: JSON.stringify(analysis) })
  }
  const stored = async () => (await env.DB.prepare(`SELECT value FROM association_config WHERE key = 'claim_sources_cutoff_retries'`).first<{ value: string }>())?.value ?? null

  it('adds one to the instance count each time the retry without claim sources is what stored the summary', async () => {
    cutOffThenRecover()
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await stored()).toBe('1')
    expect((await computeClaimSourceCounts(getDb(env.DB))).cutOffRetries).toBe(1)
  })

  it('counts a second recovered cut-off on another analysis', async () => {
    cutOffThenRecover()
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    cutOffThenRecover()
    await processCentralNotification({ ...msg, forceAI: true }, testEnv, getDb(env.DB))
    expect(await stored()).toBe('2')
  })

  it('counts nothing for an analysis whose claim sources parsed', async () => {
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await stored()).toBeNull()
  })

  it('counts nothing when the setting is off and claim sources are not asked for', async () => {
    claimLinksEnabledMock.mockResolvedValue(false)
    model(analysis)
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await stored()).toBeNull()
  })

  it('counts nothing for an analysis that failed even after the retry', async () => {
    const cut = JSON.stringify({ ...analysis, claimSources: sources }).slice(0, -25)
    geminiGenerateMock.mockResolvedValue({ text: cut })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await stored()).toBeNull()
  })

  it('still stores the analysis when the count cannot be written', async () => {
    recordCutOffMock.mockRejectedValueOnce(new Error('database is locked'))
    cutOffThenRecover()
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.tenant_summary).toBe('Requires a drop box in each county.')
    expect(r.ai_processed_at).not.toBeNull()
    expect(r.ai_error).toBeNull()
  })
})

describe('what the bill detail carries', () => {
  it('carries stored claim sources only in `claimSources`, and is otherwise the same with or without them', async () => {
    const db = getDb(env.DB)
    await processCentralNotification(msg, testEnv, db)
    const id = (await row()).id as string
    const user = { id: 'u1', role: 'admin' as const }
    stubFetch(() => new Response('{}', { status: 404 }))
    const withSources = await buildBillDetail(db, id, user, testEnv) as Record<string, unknown>
    await env.DB.prepare('UPDATE bills SET claim_sources = NULL, claim_sources_doc_id = NULL, claim_sources_text_hash = NULL WHERE id = ?').bind(id).run()
    const without = await buildBillDetail(db, id, user, testEnv) as Record<string, unknown>
    // The claim fields are the instance's setting (#570) and, for the page's
    // links, the shown analysis's claim sources (#571). Nothing else of what is
    // stored leaks into the detail.
    expect(withSources.claimSources).not.toBeNull()
    expect(without.claimSources).toBeNull()
    const { claimLinksEnabled, claimSources: _with, ...rest } = withSources
    const { claimSources: _without, ...restWithout } = without
    expect(claimLinksEnabled).toBe(true)
    expect({ claimLinksEnabled, ...rest }).toEqual(restWithout)
    expect(JSON.stringify(rest)).not.toMatch(/claim/i)
  })
})
