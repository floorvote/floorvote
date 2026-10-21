import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { clearDb, stubFetch, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { associationConfig, bills } from '../../src/db/schema'
import { loadTeamValuesOf } from '../../src/lib/teamFields'
import { readClaimSources, type ResolvedClaimSource } from '../../src/lib/claimSources'
import { resolveClaimSources } from '../../src/lib/claimResolution'
import { billHtmlToText } from '../../src/lib/billText'
import type { TenantQueueMessage } from '../../src/types'

// Resolving claim sources as the analysis stores them (#569), and reading them
// back through the bill whose analysis a page shows. The model is stubbed at
// the SDK, so these run the real schema, parsing, resolution, and write.

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

// Resolution runs for real. This only lets a test make it fail once.
const resolveMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/claimResolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/claimResolution')>()
  resolveMock.mockImplementation(actual.resolveClaimSources)
  return { ...actual, resolveClaimSources: resolveMock }
})

const centralBill = {
  billId: 'bill:9001',
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
  ],
  actions: [{ description: 'Introduced', date: '2026-01-10', chamber: 'lower', classification: [], order: 1 }],
  sponsors: [],
  votes: [],
  relatedBills: [],
}

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' } as any
const msg: TenantQueueMessage = { tenantId: 'test-org', billId: 'bill:9001' }

const analysis = { affectedCitations: [], summary: 'Requires a drop box in each county.', tags: ['Voting'], relevanceScore: 7 }
const QUOTE = 'Each county shall provide at least one drop box.'

function model(payload: unknown) {
  geminiGenerateMock.mockResolvedValue({ text: JSON.stringify(payload) })
}

function central(html: string, docId = '5001') {
  stubFetch(url => {
    if (url.includes('/text')) {
      return new Response(JSON.stringify({ type: 'html', content: html, docId, textHash: `hash-${docId}` }), { status: 200 })
    }
    return new Response(JSON.stringify(centralBill), { status: 200 })
  })
}

async function row() {
  return (await env.DB.prepare('SELECT * FROM bills WHERE external_id = ?').bind('bill:9001').first()) as Record<string, unknown>
}
const stored = async () => JSON.parse((await row()).claim_sources as string) as ResolvedClaimSource[]

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  geminiGenerateMock.mockReset()
  claimLinksEnabledMock.mockResolvedValue(true)
  await getDb(env.DB).insert(associationConfig).values([
    { key: 'keywords', value: JSON.stringify(['ballot']) },
    { key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }]) },
  ])
})

describe('resolving each claim source as it is stored', () => {
  const html = `<p>Section 1. ${QUOTE} Fees are waived.</p>`

  it('records how each quote resolved against the document the model read, and where', async () => {
    central(html)
    model({ ...analysis, summary: 'Requires a drop box in each county. Waives fees.', claimSources: [
      { claim: 'Requires a drop box in each county.', quote: QUOTE },
      { claim: 'Waives fees.', quote: 'Fees are waived.' },
    ] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const items = await stored()
    const doc = billHtmlToText(html)
    expect(items.map(i => i.status)).toEqual(['exact', 'exact'])
    expect(items.map(i => doc.slice(i.quoteAt!.start, i.quoteAt!.end))).toEqual([QUOTE, 'Fees are waived.'])
    expect(items.map(i => i.matched)).toEqual([QUOTE, 'Fees are waived.'])
    const summary = 'Requires a drop box in each county. Waives fees.'
    expect(items.map(i => summary.slice(i.claimAt.start, i.claimAt.end))).toEqual(['Requires a drop box in each county.', 'Waives fees.'])
  })

  it('marks a faithful copy broken by line numbers fuzzy', async () => {
    const numbered = '<p>Section 1. Each county shall<br>14 provide at least one<br>15 drop box. Fees are waived.</p>'
    central(numbered)
    model({ ...analysis, claimSources: [{ claim: analysis.summary, quote: QUOTE }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const [item] = await stored()
    expect(item.status).toBe('fuzzy')
    expect(billHtmlToText(numbered).slice(item.quoteAt!.start, item.quoteAt!.end)).toBe('Each county shall\n14 provide at least one\n15 drop box.')
    expect(item.matched).toBe('Each county shall 14 provide at least one 15 drop box.')
  })

  it('marks a quote that is not in the document ungrounded, and keeps it', async () => {
    central(html)
    const quote = 'Every county shall plant a heron beside each drop box door.'
    model({ ...analysis, claimSources: [{ claim: analysis.summary, quote }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await stored()).toEqual([{ claim: analysis.summary, quote, status: 'ungrounded', claimAt: { start: 0, end: analysis.summary.length } }])
  })

  it('drops a claim that is not in the summary the bill stores', async () => {
    central(html)
    model({ ...analysis, claimSources: [{ claim: 'Requires a heron statue.', quote: 'drop box' }, { claim: analysis.summary, quote: QUOTE }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const items = await stored()
    expect(items).toHaveLength(1)
    expect(items[0].claim).toBe(analysis.summary)
  })

  it('leaves a PDF\'s quotes unverified, and keeps the page', async () => {
    stubFetch(url => url.includes('/text')
      ? new Response(JSON.stringify({ type: 'pdf', content: btoa('%PDF fake'), docId: '5001', textHash: 'hash-5001' }), { status: 200 })
      : new Response(JSON.stringify(centralBill), { status: 200 }))
    model({ ...analysis, claimSources: [{ claim: analysis.summary, quote: QUOTE, page: 3 }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await stored()).toEqual([{ claim: analysis.summary, quote: QUOTE, page: 3, status: 'unverified', claimAt: { start: 0, end: analysis.summary.length } }])
  })

  it('stores a status that a count by status can read', async () => {
    central(html)
    model({ ...analysis, summary: 'A. B. C.', claimSources: [
      { claim: 'A.', quote: QUOTE },
      { claim: 'B.', quote: 'Each  county shall\nprovide at least one drop box.' },
      { claim: 'C.', quote: 'Every county shall plant a heron beside each drop box door.' },
    ] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const counts = await env.DB.prepare(
      `SELECT json_extract(j.value, '$.status') AS status, count(*) AS n FROM bills b, json_each(b.claim_sources) j GROUP BY 1 ORDER BY 1`,
    ).all<{ status: string; n: number }>()
    expect(counts.results).toEqual([{ status: 'exact', n: 1 }, { status: 'normalized', n: 1 }, { status: 'ungrounded', n: 1 }])
  })

  it('resolves 100 items, marks the rest ungrounded, and logs the cap once', async () => {
    central(html)
    const claims = Array.from({ length: 103 }, (_, i) => `Claim ${i} is made.`)
    model({ ...analysis, summary: claims.join(' '), claimSources: claims.map(claim => ({ claim, quote: QUOTE })) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await processCentralNotification(msg, testEnv, getDb(env.DB))
      const capWarnings = warn.mock.calls.filter(c => String(c[0]).includes('claim source') && String(c[0]).includes('3'))
      expect(capWarnings).toHaveLength(1)
    } finally { warn.mockRestore() }
    const items = await stored()
    expect(items).toHaveLength(103)
    expect(items.slice(0, 100).every(i => i.status === 'exact')).toBe(true)
    expect(items.slice(100).map(i => i.status)).toEqual(['ungrounded', 'ungrounded', 'ungrounded'])
  })

  it('stores nothing when claim links are off for the analysis', async () => {
    central(html)
    claimLinksEnabledMock.mockResolvedValue(false)
    model({ ...analysis, claimSources: [{ claim: analysis.summary, quote: QUOTE }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    expect(await row()).toMatchObject({ claim_sources: null })
  })

  it('keeps the summary, tags, and score when resolving throws, and stores no claim sources', async () => {
    central(html)
    model({ ...analysis, claimSources: [{ claim: analysis.summary, quote: QUOTE }] })
    resolveMock.mockImplementationOnce(() => { throw new Error('matcher blew up') })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const r = await row()
    expect(r).toMatchObject({ tenant_summary: analysis.summary, relevance_score: 7, ai_error: null, claim_sources: '[]', claim_sources_doc_id: '5001' })
    expect(r.ai_processed_at).not.toBeNull()
  })

  it('does not let an unmatchable quote fail the analysis', async () => {
    central(html)
    model({ ...analysis, claimSources: [{ claim: analysis.summary, quote: 'x'.repeat(20_000) }] })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    const r = await row()
    expect(r.tenant_summary).toBe(analysis.summary)
    expect(r.ai_error).toBeNull()
    expect((await stored())[0].status).toBe('ungrounded')
  })
})

// The bill page shows its group's current analysis, which may be another
// member's. Claim sources resolve against the analyzed member's own document,
// and are read through that member, never through the page's bill.
describe('a companion group whose members\' texts differ', () => {
  const A = { billId: 'bill:9001', docId: '6001', number: 'A 100' }
  const S = { billId: 'bill:9002', docId: '6002', number: 'S 200' }
  const textA = '<p>A 100. Introduced by the Assembly Committee on Elections.</p><p>Section 1. Each county shall provide at least one drop box.</p><p>Section 2. Boxes are emptied daily.</p>'
  const textS = '<p>S 200 -- Senate Committee on Rules, second reading, as amended, with a longer header.</p><p>Section 1. Each county shall provide at least one drop box.</p><p>Section 2. Drop boxes shall be emptied each business day by two employees.</p>'
  const docA = billHtmlToText(textA)
  const docS = billHtmlToText(textS)
  const ONLY_IN_S = 'emptied each business day by two employees'
  const summaryA = 'Requires a drop box in each county.'
  const summaryS = 'Requires a drop box in each county. Boxes are emptied by two employees.'

  let textRequests: string[]
  let idA: string
  let idS: string

  function centralPair() {
    textRequests = []
    stubFetch(url => {
      const which = url.includes('9002') ? S : A
      if (url.includes('/text')) {
        textRequests.push(which.number)
        return new Response(JSON.stringify({ type: 'html', content: which === S ? textS : textA, docId: which.docId, textHash: `hash-${which.docId}` }), { status: 200 })
      }
      return new Response(JSON.stringify({
        ...centralBill, billId: which.billId, number: which.number, textHash: `hash-${which.docId}`,
        texts: [{ docId: which.docId, note: 'Introduced', date: '2026-01-01', links: [{ url: `https://legislature.example/${which.docId}.html`, mediaType: 'text/html' }] }],
      }), { status: 200 })
    })
  }

  async function analyze(bill: typeof A, summary: string, claimSources: unknown[], at: string): Promise<string> {
    model({ ...analysis, summary, claimSources })
    await processCentralNotification({ ...msg, billId: bill.billId, forceAI: true }, testEnv, getDb(env.DB))
    const found = await env.DB.prepare('SELECT id FROM bills WHERE external_id = ?').bind(bill.billId).first<{ id: string }>()
    await env.DB.prepare('UPDATE bills SET ai_processed_at = ? WHERE id = ?').bind(at, found!.id).run()
    return found!.id
  }

  beforeEach(async () => {
    centralPair()
    // A100 is analyzed first, then S200 a day later. S200 is further along, so it leads and the group shows S200's.
    idA = await analyze(A, summaryA, [{ claim: summaryA, quote: QUOTE }], '2026-01-01 10:00:00')
    idS = await analyze(S, summaryS, [
      { claim: summaryA, quote: QUOTE },
      { claim: 'Boxes are emptied by two employees.', quote: ONLY_IN_S },
    ], '2026-01-02 10:00:00')
    await getDb(env.DB).update(bills).set({ groupKey: [idA, idS].sort()[0] }).where(inArray(bills.id, [idA, idS]))
    await getDb(env.DB).update(bills).set({ statusRank: 300 }).where(eq(bills.id, idS))
  })

  const shownAnalysis = async (pageId: string) => (await loadTeamValuesOf(getDb(env.DB), [pageId])).get(pageId)!.analysis!

  it('shows S200\'s analysis on A100\'s page, with claim sources that locate passages in S200\'s document', async () => {
    const shown = await shownAnalysis(idA)
    expect(shown.billId).toBe(idS)
    expect(shown.tenantSummary).toBe(summaryS)

    const read = (await readClaimSources(getDb(env.DB), shown.billId))!
    expect(read.billId).toBe(idS)
    expect(read.docId).toBe(S.docId)
    expect(read.textHash).toBe('hash-6002')
    expect(read.items.map(i => i.status)).toEqual(['exact', 'exact'])
    for (const item of read.items) expect(docS.slice(item.quoteAt!.start, item.quoteAt!.end)).toBe(item.quote)
    // Each claim is where the shown summary has it.
    for (const item of read.items) expect(shown.tenantSummary!.slice(item.claimAt.start, item.claimAt.end)).toBe(item.claim)
  })

  it('puts the same quote at a different place in each document, so the page\'s own text would be the wrong one', async () => {
    const [shared] = (await readClaimSources(getDb(env.DB), idS))!.items
    const own = (await readClaimSources(getDb(env.DB), idA))!.items[0]
    expect(docA.indexOf(QUOTE)).not.toBe(docS.indexOf(QUOTE))
    expect(shared.quoteAt).toEqual({ start: docS.indexOf(QUOTE), end: docS.indexOf(QUOTE) + QUOTE.length })
    expect(own.quoteAt).toEqual({ start: docA.indexOf(QUOTE), end: docA.indexOf(QUOTE) + QUOTE.length })
    // Read against A100's document, S200's offsets don't land on the quote.
    expect(docA.slice(shared.quoteAt!.start, shared.quoteAt!.end)).not.toBe(QUOTE)
  })

  it('does not ground a passage that is only in the analyzed member\'s text against the page\'s', async () => {
    const second = (await readClaimSources(getDb(env.DB), idS))!.items[1]
    expect(second.status).toBe('exact')
    expect(docA).not.toContain(ONLY_IN_S)
    const asIfPage = resolveClaimSources([{ claim: second.claim, quote: second.quote }], summaryS, docA).items[0]
    expect(asIfPage.status).toBe('ungrounded')
  })

  it('resolved each member against its own text when analyzed, and fetched no other member\'s', async () => {
    expect(textRequests).toEqual(['A 100', 'S 200'])
    const own = (await readClaimSources(getDb(env.DB), idA))!
    expect(own.docId).toBe(A.docId)
    expect(own.items[0].status).toBe('exact')
  })

  it('reads the same analysis from S200\'s own page', async () => {
    const shown = await shownAnalysis(idS)
    expect(shown.billId).toBe(idS)
    expect((await readClaimSources(getDb(env.DB), shown.billId))!.docId).toBe(S.docId)
  })

  it('stays on S200 when A100 is analyzed again, later, since S200 still leads', async () => {
    await env.DB.prepare('UPDATE bills SET ai_processed_at = ? WHERE id = ?').bind('2026-01-03 10:00:00', idA).run()
    expect((await shownAnalysis(idA)).billId).toBe(idS)
  })

  it('follows the analysis when A100 moves further along and leads', async () => {
    await env.DB.prepare('UPDATE bills SET status_rank = 400 WHERE id = ?').bind(idA).run()
    const shown = await shownAnalysis(idS)
    expect(shown.billId).toBe(idA)
    const read = (await readClaimSources(getDb(env.DB), shown.billId))!
    expect(read.docId).toBe(A.docId)
    expect(docA.slice(read.items[0].quoteAt!.start, read.items[0].quoteAt!.end)).toBe(QUOTE)
  })

  it('a bill in no group shows and reads its own', async () => {
    await getDb(env.DB).update(bills).set({ groupKey: null }).where(inArray(bills.id, [idA, idS]))
    const shown = await shownAnalysis(idA)
    expect(shown.billId).toBe(idA)
    expect((await readClaimSources(getDb(env.DB), shown.billId))!.docId).toBe(A.docId)
  })

  it('reads nothing for S200 when its pinned document is gone, though A100 still lists its own', async () => {
    await env.DB.prepare('DELETE FROM bill_texts WHERE doc_id = ?').bind(S.docId).run()
    expect(await readClaimSources(getDb(env.DB), idS)).toBeNull()
    expect(await readClaimSources(getDb(env.DB), idA)).not.toBeNull()
  })
})

describe('reading stored claim sources', () => {
  const html = `<p>Section 1. ${QUOTE}</p>`
  const first = (): ResolvedClaimSource => ({
    claim: analysis.summary, quote: QUOTE, status: 'exact',
    claimAt: { start: 0, end: analysis.summary.length },
    quoteAt: { start: 'Section 1. '.length, end: 'Section 1. '.length + QUOTE.length },
    matched: QUOTE,
  })

  async function analyzed(sources: unknown[] = [{ claim: analysis.summary, quote: QUOTE }]): Promise<string> {
    central(html)
    model({ ...analysis, claimSources: sources })
    await processCentralNotification(msg, testEnv, getDb(env.DB))
    return (await row()).id as string
  }

  it('reads nothing for a bill that has none', async () => {
    claimLinksEnabledMock.mockResolvedValue(false)
    expect(await readClaimSources(getDb(env.DB), await analyzed())).toBeNull()
  })

  it('reads nothing for a bill that does not exist', async () => {
    expect(await readClaimSources(getDb(env.DB), 'no-such-bill')).toBeNull()
  })

  it('reads the items with the pin, while the pinned document is still in the bill\'s texts', async () => {
    const id = await analyzed()
    expect(await readClaimSources(getDb(env.DB), id)).toEqual({ billId: id, docId: '5001', textHash: 'hash-5001', document: expect.objectContaining({ docId: '5001', mime: 'text/html' }), items: [first()] })
  })

  it('reads an empty list as asked, with nothing usable returned', async () => {
    const id = await analyzed([])
    expect(await readClaimSources(getDb(env.DB), id)).toMatchObject({ docId: '5001', items: [] })
  })

  it('reads nothing once the pinned document is no longer in the bill\'s texts (a stale pin), and keeps the claim sources', async () => {
    const id = await analyzed()
    expect(await readClaimSources(getDb(env.DB), id)).not.toBeNull()
    await env.DB.prepare('DELETE FROM bill_texts WHERE doc_id = ?').bind('5001').run()
    expect(await readClaimSources(getDb(env.DB), id)).toBeNull()
    expect((await row()).claim_sources).not.toBeNull()
  })

  it('is stale when the pinned document is listed under another bill, not this one', async () => {
    const id = await analyzed()
    const other = await seedBill({ id: 'some-other-bill', externalId: 'legiscan:1' })
    await env.DB.prepare('UPDATE bill_texts SET bill_id = ? WHERE doc_id = ?').bind(other, '5001').run()
    expect(await readClaimSources(getDb(env.DB), id)).toBeNull()
  })

  it('is stale when the text list moved on to a newer version only', async () => {
    const id = await analyzed()
    await env.DB.prepare('DELETE FROM bill_texts WHERE doc_id = ?').bind('5001').run()
    await env.DB.prepare(`INSERT INTO bill_texts (id, bill_id, doc_id, type, date, mime, text_hash) VALUES ('t2', ?, '5002', 'Amended', '2026-02-01', 'text/html', '')`).bind(id).run()
    expect(await readClaimSources(getDb(env.DB), id)).toBeNull()
  })

  it('skips an item stored before items carried a status', async () => {
    const id = await analyzed()
    await env.DB.prepare('UPDATE bills SET claim_sources = ? WHERE id = ?').bind(JSON.stringify([{ claim: 'c', quote: 'q' }, first()]), id).run()
    expect((await readClaimSources(getDb(env.DB), id))!.items).toEqual([first()])
  })

  it('reads nothing from claim sources that are not JSON, or not a list', async () => {
    const id = await analyzed()
    for (const bad of ['not json', '{"claim":"c"}', '"text"', '3']) {
      await env.DB.prepare('UPDATE bills SET claim_sources = ? WHERE id = ?').bind(bad, id).run()
      expect(await readClaimSources(getDb(env.DB), id)).toBeNull()
    }
  })

  it('reads on the doc id alone while the stored hash is empty, and reads nothing once it differs from the pin (#603)', async () => {
    const id = await analyzed()
    // This central's text list carries no per-document hash, so an empty one is stored.
    const listed = await env.DB.prepare('SELECT text_hash FROM bill_texts WHERE doc_id = ?').bind('5001').first<{ text_hash: string }>()
    expect(listed!.text_hash).toBe('')
    expect(await readClaimSources(getDb(env.DB), id)).not.toBeNull()
    await env.DB.prepare('UPDATE bill_texts SET text_hash = ? WHERE doc_id = ?').bind('some-other-hash', '5001').run()
    expect(await readClaimSources(getDb(env.DB), id)).toBeNull()
  })

  it('reads nothing when a pin has no document id', async () => {
    const id = await analyzed()
    await env.DB.prepare('UPDATE bills SET claim_sources_doc_id = NULL WHERE id = ?').bind(id).run()
    expect(await readClaimSources(getDb(env.DB), id)).toBeNull()
  })
})
