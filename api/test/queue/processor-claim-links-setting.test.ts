import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, stubFetch, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { app } from '../../src/index'
import { processCentralNotification } from '../../src/queue/processor'
import { associationConfig } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// The claim links setting (#570) against the real analysis pipeline. Unlike
// processor-claim-sources.test.ts, nothing here mocks claimLinksEnabled: the
// setting is flipped through the admin API and read back by the processor.

const geminiGenerateMock = vi.hoisted(() => vi.fn())
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent: geminiGenerateMock } }
  }),
  ServiceTier: { FLEX: 'flex', STANDARD: 'standard', PRIORITY: 'priority', UNSPECIFIED: 'unspecified' },
}))
vi.mock('../../src/cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

const BILL_ID = 'legiscan:9101'

const centralBill = {
  billId: BILL_ID,
  sessionId: '2100',
  state: 'ZZ',
  number: 'HB 88',
  title: 'An Act Relating to Early Voting Hours',
  abstract: 'Sets minimum early voting hours',
  status: 'introduced',
  statusDate: '2026-01-01',
  updatedAt: '2026-01-10T12:00:00Z',
  stateUrl: 'https://legislature.example/HB88',
  textHash: 'hash-6001',
  textR2Key: 'bills/legiscan-9101/texts/6001.html',
  texts: [
    { docId: '6001', note: 'Introduced', date: '2026-01-01', links: [{ url: 'https://legislature.example/6001.html', mediaType: 'text/html' }] },
  ],
  actions: [{ description: 'Introduced', date: '2026-01-10', chamber: 'lower', classification: [], order: 1 }],
  sponsors: [],
  votes: [],
  relatedBills: [],
}
const HTML_TEXT = { type: 'html', content: '<p>Section 1. Polls shall open at least eight hours each early voting day.</p>', docId: '6001', textHash: 'hash-6001' }

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' } as any
const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }

const analysis = { affectedCitations: [], summary: 'Sets minimum early voting hours.', tags: ['Voting'], relevanceScore: 6 }
const sources = [{ claim: 'Sets minimum early voting hours.', quote: 'Polls shall open at least eight hours each early voting day.' }]

const row = async () => (await env.DB.prepare('SELECT * FROM bills WHERE external_id = ?').bind(BILL_ID).first()) as Record<string, unknown>
const lastSchema = () => geminiGenerateMock.mock.calls.at(-1)![0].config.responseSchema

async function setClaimLinks(cookie: string, enabled: boolean) {
  const res = await app.request('/api/admin/claim-links', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ enabled }),
  }, env)
  return res.status
}

async function analyze(opts: { force?: boolean } = {}) {
  await processCentralNotification({ ...msg, ...(opts.force ? { forceAI: true } : {}) }, testEnv, getDb(env.DB))
}

describe('claim links setting, through the analysis pipeline', () => {
  let adminCookie: string
  let memberCookie: string

  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    geminiGenerateMock.mockReset()
    await getDb(env.DB).insert(associationConfig).values([
      { key: 'keywords', value: JSON.stringify(['voting']) },
      { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }]) },
    ])
    adminCookie = `session=${await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))}`
    memberCookie = `session=${await seedSession(await seedUser({ role: 'member', email: 'member@example.com' }))}`
    stubFetch(url => url.includes('/text')
      ? new Response(JSON.stringify(HTML_TEXT), { status: 200 })
      : new Response(JSON.stringify(centralBill), { status: 200 }))
    geminiGenerateMock.mockResolvedValue({ text: JSON.stringify({ ...analysis, claimSources: sources }) })
  })

  it('asks for claim sources and stores them on an instance nobody has configured', async () => {
    await analyze()
    expect(lastSchema().properties).toHaveProperty('claimSources')
    const r = await row()
    expect(JSON.parse(r.claim_sources as string)).toHaveLength(1)
    expect(r.claim_sources_doc_id).toBe('6001')
  })

  it('asks for claim sources on an existing instance that has AI settings and no claim links row', async () => {
    await getDb(env.DB).insert(associationConfig).values([
      { key: 'ai_context', value: JSON.stringify('You advise county clerks.') },
      { key: 'relevance_question', value: JSON.stringify('How much does this change polling hours?') },
    ])
    await analyze()
    expect(lastSchema().properties).toHaveProperty('claimSources')
  })

  it('with the setting off, the analysis schema has no claimSources and nothing is stored', async () => {
    expect(await setClaimLinks(adminCookie, false)).toBe(200)
    await analyze()
    expect(lastSchema().properties).not.toHaveProperty('claimSources')
    const r = await row()
    expect(r.tenant_summary).toBe('Sets minimum early voting hours.')
    expect(r).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null })
  })

  it('a re-analysis with the setting off writes null claim sources over links an earlier analysis stored', async () => {
    await analyze()
    expect(JSON.parse((await row()).claim_sources as string)).toHaveLength(1)
    await setClaimLinks(adminCookie, false)
    geminiGenerateMock.mockResolvedValue({ text: JSON.stringify({ ...analysis, summary: 'A newer summary.' }) })
    await analyze({ force: true })
    const r = await row()
    expect(r.tenant_summary).toBe('A newer summary.')
    expect(r).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null })
  })

  it('turning it off changes no stored claim sources, so turning it back on shows them again', async () => {
    await analyze()
    const before = await row()
    await setClaimLinks(adminCookie, false)
    expect(await row()).toMatchObject({
      claim_sources: before.claim_sources,
      claim_sources_doc_id: before.claim_sources_doc_id,
      claim_sources_text_hash: before.claim_sources_text_hash,
    })
    await setClaimLinks(adminCookie, true)
    expect(await row()).toMatchObject({
      claim_sources: before.claim_sources,
      claim_sources_doc_id: before.claim_sources_doc_id,
      claim_sources_text_hash: before.claim_sources_text_hash,
    })
  })

  it('turned back on, new analyses ask for claim sources again and store them', async () => {
    await setClaimLinks(adminCookie, false)
    await analyze()
    expect((await row()).claim_sources).toBeNull()
    await setClaimLinks(adminCookie, true)
    await analyze({ force: true })
    expect(lastSchema().properties).toHaveProperty('claimSources')
    expect(JSON.parse((await row()).claim_sources as string)).toHaveLength(1)
  })

  it('a member cannot turn it off, so the next analysis still asks', async () => {
    expect(await setClaimLinks(memberCookie, false)).toBe(403)
    await analyze()
    expect(lastSchema().properties).toHaveProperty('claimSources')
  })

  it('does not change the prompt or the rest of the schema when off, only drops claimSources', async () => {
    await analyze()
    const onSchema = lastSchema()
    const onPrompt = geminiGenerateMock.mock.calls.at(-1)![0].contents
    await setClaimLinks(adminCookie, false)
    await analyze({ force: true })
    const offSchema = lastSchema()
    const offPrompt = geminiGenerateMock.mock.calls.at(-1)![0].contents
    expect(offPrompt).toEqual(onPrompt)
    const { claimSources: _dropped, ...onRest } = onSchema.properties
    expect(offSchema.properties).toEqual(onRest)
  })
})
