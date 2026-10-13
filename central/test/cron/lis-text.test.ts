import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import s2026Raw from '../fixtures/lis/20261-sample.json?raw'

// Virginia bill text from the LIS API at the main seam (#487): the recorded
// data files plus a hand-written text list and by-id answers, with the network
// stubbed at fetch, and central's bill API and stored texts out. The key is
// optional, so most of this runs both ways.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { lis } from '../../src/providers/lis'
import { LIS_API_BASE, LIS_FILES, LIS_FILES_BASE, type LisFile, type LisFiles } from '../../src/providers/lis/client'
import { toHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral } from '../helpers/mainSeam'

const s2026 = () => JSON.parse(s2026Raw) as LisFiles
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const blob = (n: number) => `https://lis.blob.core.windows.net/files/${n}.PDF`

const NAMES: Record<number, string> = { 1: 'Introduced', 2: 'Engrossed', 3: 'Enrolled', 4: 'Chaptered', 5: 'Substitute', 8: 'Amendment' }
function row(number: string, textId: number, versionId: number, code: string, draftDate = '2025-11-17T00:00:00') {
  return {
    LegislationID: 1, LegislationNumber: number, Description: NAMES[versionId], SessionID: 59, LegislationTextID: textId,
    DraftDate: draftDate, DocumentCode: code, LDNumber: null, LegislationVersionID: versionId, Version: NAMES[versionId],
    IsPublic: true, IsComplete: true, GovernorsRequest: false, PDFFile: [], HTMLFile: [], ImpactFile: [], LinkFile: [],
  }
}

/** The text list the stubbed API serves, and the by-id answers: a PDF for every text but those listed. */
let textList: unknown[]
let listStatus: number
let noPdf: Set<number>
let served: Partial<Record<LisFile, { text: string; etag: string } | null>>
let requests: { method: string; url: string; key: string | null }[]
const apiCalls = () => requests.filter(r => r.url.startsWith(LIS_API_BASE))
const blobGets = () => requests.filter(r => r.url.startsWith('https://lis.blob.core.windows.net/files/'))

const KEY = 'test-lis-key'
const keyed = mainSeam(lis, { tenantId: 'vateam', env: { LIS_API_KEY: KEY } })
const unkeyed = mainSeam(lis, { tenantId: 'vateam' })
const claim = (seam: typeof keyed) => seam.claim('VA', 'lis')

beforeEach(async () => {
  await resetCentral()
  requests = []
  textList = []
  listStatus = 200
  noPdf = new Set()
  served = Object.fromEntries((Object.keys(LIS_FILES) as LisFile[]).map(file => {
    const text = s2026()[file]
    return [file, text ? { text, etag: `"20261-${file}-v1"` } : null]
  }))
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const key = new Headers(init?.headers).get('WebAPIKey')
    requests.push({ method, url, key })
    if (url.startsWith(`${LIS_API_BASE}/`)) {
      if (key !== KEY) return new Response('unauthorized', { status: 401 })
      if (url.includes('getlegislationtextlistasync')) {
        return listStatus === 200 ? new Response(JSON.stringify({ LegislationTextList: textList, Success: true, FailureMessage: '' })) : new Response('boom', { status: listStatus })
      }
      if (url.includes('getlegislationtextbyidasync')) {
        const id = Number(new URL(url).searchParams.get('legislationTextID'))
        // The shape of a real answer, trimmed: the one text in TextsList, with its file lists.
        const pdf = noPdf.has(id) ? [] : [{ PageCount: 1, LegislationTextID: id, TextFormatID: 1, TextFormat: 'PDF', FileURL: blob(id + 1_000_000), ReferenceNumber: null, SessionID: 59, Description: null }]
        return new Response(JSON.stringify({
          TextsList: [{ LegislationTextID: id, LegislationVersionID: 3, DocumentCode: 'HB1ER', SessionCode: '20261', PDFFile: pdf, HTMLFile: [], ImpactFile: [], LinkFile: null }],
          Success: true, FailureMessage: '', CacheKeyName: null,
        }))
      }
    }
    if (url.startsWith('https://lis.blob.core.windows.net/files/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    if (url.startsWith(`${LIS_FILES_BASE}/`)) {
      const [code, name] = url.slice(LIS_FILES_BASE.length + 1).split('/')
      const file = (Object.keys(LIS_FILES) as LisFile[]).find(f => LIS_FILES[f] === name)
      // Only the 2026 regular session is published.
      const s = file && code === '20261' ? served[file] : null
      if (!s) return new Response('<Error><Code>BlobNotFound</Code></Error>', { status: 404 })
      return new Response(method === 'HEAD' ? null : s.text, { headers: { ETag: s.etag } })
    }
    throw new Error(`no network in this test: ${method} ${url}`)
  })
  await keyed.addTenant('VA', ['minimum wage', 'daylight', 'procurement'])
})

afterEach(() => {
  vi.useRealTimers()
})

const billJson = async (seam: typeof keyed, number: string) => seam.getJson(`/bills/${toHandle(await seam.billIdOf(number, '20261'))}`)
const callTypes = async () => (await drizzle(env.DB, { schema }).select().from(schema.apiCallLog).all()).map(r => r.callType)

describe('Virginia bill text with a key', () => {
  beforeEach(() => {
    textList = [
      row('HB1', 100, 1, 'HB1', '2025-11-17T00:00:00'),
      row('HB1', 101, 3, 'HB1ER ', '2026-03-14T00:00:00'),
      row('HB1', 102, 4, 'CHAP0350', '2026-04-11T00:00:00'),
      row('HB1', 103, 8, 'HB1AB'),
      row('HB9', 110, 1, 'HB9'),
      row('HB9999', 120, 1, 'HB9999'),
    ]
  })

  it('serves a bill\'s full-text versions as texts, and stores each PDF', async () => {
    await claim(keyed)
    await keyed.syncAndIngest()
    const bill = await billJson(keyed, 'HB1')
    expect(bill.texts.map((t: any) => [t.note, t.date, t.links[0].url, t.links[0].mediaType])).toEqual([
      ['Introduced', '2025-11-17', blob(1_000_100), 'application/pdf'],
      ['Enrolled', '2026-03-14', blob(1_000_101), 'application/pdf'],
      ['Chaptered', '2026-04-11', blob(1_000_102), 'application/pdf'],
    ])
    expect((await billJson(keyed, 'HB9')).texts.map((t: any) => t.note)).toEqual(['Introduced'])
    expect((await billJson(keyed, 'HB61')).texts).toEqual([])

    // Core downloaded each PDF from the blob link, with no key, and kept it.
    const stored = await drizzle(env.DB, { schema }).select().from(schema.billTexts).where(eq(schema.billTexts.billId, await keyed.billIdOf('HB1', '20261'))).all()
    expect(stored).toHaveLength(3)
    expect(stored.every(t => t.r2Key && t.textHash && t.mime === 'application/pdf')).toBe(true)
    expect(blobGets().map(r => r.url)).toEqual(expect.arrayContaining([blob(1_000_100), blob(1_000_101), blob(1_000_102), blob(1_000_110)]))
    expect(blobGets().every(r => r.key === null)).toBe(true)
  })

  it('makes one list call and one by-id call per version, each logged as a LIS call, and none for a bill the CSVs lack', async () => {
    await claim(keyed)
    await keyed.syncAndIngest()
    const types = (await callTypes()).filter(t => t.startsWith('lis:'))
    expect(types.filter(t => t === 'lis:getlegislationtextlistasync')).toHaveLength(1)
    expect(types.filter(t => t === 'lis:getlegislationtextbyidasync')).toHaveLength(4)
    expect(apiCalls().filter(r => r.url.includes('legislationTextID=120'))).toEqual([])
    expect(apiCalls().filter(r => r.url.includes('legislationTextID=103'))).toEqual([])
    expect((await callTypes()).filter(t => !t.includes(':'))).toEqual([])
  })

  it('leaves a version with no PDF out, and keeps the rest', async () => {
    noPdf.add(101)
    await claim(keyed)
    await keyed.syncAndIngest()
    expect((await billJson(keyed, 'HB1')).texts.map((t: any) => t.note)).toEqual(['Introduced', 'Chaptered'])
  })

  it('re-ingests only the bill that got a new version', async () => {
    await claim(keyed)
    await keyed.syncAndIngest()
    textList = [...textList, row('HB1', 104, 5, 'HB1S1', '2026-04-20T00:00:00')]
    served = Object.fromEntries(Object.entries(served).map(([f, s]) => [f, s && { ...s, etag: `${s.etag}+` }]))
    const { run } = await keyed.syncAndIngest()
    expect(keyed.queuedIds(run)).toEqual([await keyed.billIdOf('HB1', '20261')])
    expect((await billJson(keyed, 'HB1')).texts.map((t: any) => t.note)).toEqual(['Introduced', 'Enrolled', 'Chaptered', 'Substitute'])
  })

  it('reads again, and queues the bills, when the key is added after a pass without it', async () => {
    await claim(unkeyed)
    await unkeyed.syncAndIngest()
    expect((await billJson(unkeyed, 'HB1')).texts).toEqual([])
    expect(apiCalls()).toEqual([])

    // The files haven't changed, but the pass was read without texts.
    requests = []
    const { run } = await keyed.syncAndIngest()
    expect(requests.filter(r => r.method === 'GET' && r.url.startsWith(LIS_FILES_BASE))).toHaveLength(Object.keys(LIS_FILES).length)
    expect(keyed.queuedIds(run).sort()).toEqual([await keyed.billIdOf('HB1', '20261'), await keyed.billIdOf('HB9', '20261')].sort())
    expect((await billJson(keyed, 'HB1')).texts).toHaveLength(3)
  })

  it('makes no call at all on a pass where nothing changed', async () => {
    await claim(keyed)
    await keyed.syncAndIngest()
    requests = []
    await keyed.sync(keyed.makeRun())
    expect(apiCalls()).toEqual([])
    expect(requests.filter(r => r.method === 'GET' && r.url.startsWith(LIS_FILES_BASE))).toEqual([])
  })

  it('fails the pass when the text list answers with an error, and keeps what it had', async () => {
    await claim(keyed)
    await keyed.syncAndIngest()
    const before = await billJson(keyed, 'HB1')
    listStatus = 500
    served = Object.fromEntries(Object.entries(served).map(([f, s]) => [f, s && { ...s, etag: `${s.etag}+` }]))
    await expect(keyed.sync(keyed.makeRun())).rejects.toThrow(/LIS HTTP 500/)
    expect(await billJson(keyed, 'HB1')).toEqual(before)
  })
})

describe('Virginia bill text without a key', () => {
  it('makes no API call, and serves no texts, as before', async () => {
    textList = [row('HB1', 100, 1, 'HB1')]
    await claim(unkeyed)
    await unkeyed.syncAndIngest()
    expect(apiCalls()).toEqual([])
    expect((await billJson(unkeyed, 'HB1')).texts).toEqual([])
    expect((await callTypes()).filter(t => t.startsWith('lis:'))).toEqual([])
  })

  it('syncs the same bills with and without a key', async () => {
    textList = [row('HB1', 100, 1, 'HB1')]
    await claim(keyed)
    const { run } = await keyed.syncAndIngest()
    const withKey = keyed.queuedIds(run).length
    await resetCentral()
    await keyed.addTenant('VA', ['minimum wage', 'daylight', 'procurement'])
    await claim(unkeyed)
    const { run: plain } = await unkeyed.syncAndIngest()
    expect(unkeyed.queuedIds(plain).length).toBe(withKey)
  })
})
