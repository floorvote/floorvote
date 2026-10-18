import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, stubFetch } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { associationConfig } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// Central sends each document's text hash with its text list (#603), and the
// instance stores it in `bill_texts.text_hash`, which is what a claim source's
// pin is compared with. The model is stubbed at the SDK; the schema and the
// write are real. Invented bill and documents.

const geminiGenerateMock = vi.hoisted(() => vi.fn())
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent: geminiGenerateMock } }
  }),
  ServiceTier: { FLEX: 'flex', STANDARD: 'standard', PRIORITY: 'priority', UNSPECIFIED: 'unspecified' },
}))

const BILL_ID = 'legiscan:9100'
const link = (id: string) => [{ url: `https://legislature.example/${id}.html`, mediaType: 'text/html' }]

const centralBill = {
  billId: BILL_ID,
  sessionId: '2100',
  state: 'ZZ',
  number: 'HB 88',
  title: 'An Act Relating to Ballot Drop Boxes',
  abstract: 'Requires drop boxes in each county',
  status: 'introduced',
  statusDate: '2026-01-01',
  updatedAt: '2026-01-10T12:00:00Z',
  stateUrl: 'https://legislature.example/HB88',
  textHash: 'hash-6001-v1',
  textR2Key: 'bills/legiscan-9100/texts/6001.html',
  texts: [
    { docId: '6001', note: 'Introduced', date: '2026-01-01', textHash: 'hash-6001-v1', links: link('6001') },
    { docId: '6002', note: 'Amended', date: '2026-02-01', textHash: 'hash-6002-v1', links: link('6002') },
  ],
  actions: [{ description: 'Introduced', date: '2026-01-10', chamber: 'lower', classification: [], order: 1 }],
  sponsors: [],
  votes: [],
  relatedBills: [],
}

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' } as any
const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }

function central(bill: Record<string, unknown>) {
  stubFetch(url => url.includes('/text')
    ? new Response(JSON.stringify({ type: 'html', content: '<p>Each county shall provide a drop box.</p>', docId: '6001', textHash: 'hash-6001-v1' }), { status: 200 })
    : new Response(JSON.stringify(bill), { status: 200 }))
}

async function hashes(): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT doc_id, text_hash FROM bill_texts ORDER BY doc_id').all<{ doc_id: string; text_hash: string }>()
  return Object.fromEntries(results.map(r => [r.doc_id, r.text_hash]))
}

const withTexts = (texts: unknown[]) => ({ ...centralBill, texts })
// A text change reaches an instance with a bill whose provider timestamp moved, as a new version does.
const later = (texts: unknown[]) => ({ ...centralBill, updatedAt: '2026-01-20T12:00:00Z', texts })
const withoutHashes = () => withTexts(centralBill.texts.map(({ textHash: _h, ...t }) => t))

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.clearAllMocks()
  geminiGenerateMock.mockReset()
  geminiGenerateMock.mockResolvedValue({ text: JSON.stringify({ affectedCitations: [], summary: 'Requires drop boxes.', tags: ['Voting'], relevanceScore: 7 }) })
  await getDb(env.DB).insert(associationConfig).values([
    { key: 'keywords', value: JSON.stringify(['ballot']) },
    { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }]) },
  ])
})

describe('bill_texts.text_hash from a central notification', () => {
  it('stores the hash central sent for each document', async () => {
    central(centralBill)
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await hashes()).toEqual({ '6001': 'hash-6001-v1', '6002': 'hash-6002-v1' })
  })

  it('stores the new hash when a document changes under the same doc id', async () => {
    central(centralBill)
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    central(later([
      centralBill.texts[0],
      { ...centralBill.texts[1], textHash: 'hash-6002-v2' },
    ]))
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await hashes()).toEqual({ '6001': 'hash-6001-v1', '6002': 'hash-6002-v2' })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bill_texts').first<{ n: number }>())!.n).toBe(2)
  })

  it('leaves the hash alone when the text is unchanged under the same doc id', async () => {
    central(centralBill)
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await hashes()).toEqual({ '6001': 'hash-6001-v1', '6002': 'hash-6002-v1' })
  })

  it('stores the hash of a document new to the bill, beside the ones it had', async () => {
    central(centralBill)
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    central(later([
      ...centralBill.texts,
      { docId: '6003', note: 'Enrolled', date: '2026-03-01', textHash: 'hash-6003-v1', links: link('6003') },
    ]))
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await hashes()).toEqual({ '6001': 'hash-6001-v1', '6002': 'hash-6002-v1', '6003': 'hash-6003-v1' })
  })

  describe('from a central older than the per-document hash', () => {
    it('stores an empty hash for a new document, as before', async () => {
      central(withoutHashes())
      await processCentralNotification(msg, testEnv, getDb(env.DB))
      expect(await hashes()).toEqual({ '6001': '', '6002': '' })
    })

    it('still stores the rest of the text list', async () => {
      central(withoutHashes())
      await processCentralNotification(msg, testEnv, getDb(env.DB))
      const { results } = await env.DB.prepare('SELECT doc_id, type, date, state_link FROM bill_texts ORDER BY doc_id').all()
      expect(results).toEqual([
        { doc_id: '6001', type: 'Introduced', date: '2026-01-01', state_link: 'https://legislature.example/6001.html' },
        { doc_id: '6002', type: 'Amended', date: '2026-02-01', state_link: 'https://legislature.example/6002.html' },
      ])
    })

    it('does not wipe a hash it already stored, so an empty hash is never a change', async () => {
      central(centralBill)
      await processCentralNotification(msg, testEnv, getDb(env.DB))
      central(withoutHashes())
      await processCentralNotification(msg, testEnv, getDb(env.DB))
      expect(await hashes()).toEqual({ '6001': 'hash-6001-v1', '6002': 'hash-6002-v1' })
    })

    it.each([['an empty string', ''], ['null', null], ['a number', 42]])('reads %s as no hash', async (_label, value) => {
      central(withTexts(centralBill.texts.map(t => ({ ...t, textHash: value }))))
      await processCentralNotification(msg, testEnv, getDb(env.DB))
      expect(await hashes()).toEqual({ '6001': '', '6002': '' })
    })
  })
})
