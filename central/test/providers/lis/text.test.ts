import { describe, it, expect, vi, beforeEach } from 'vitest'
import s2026Raw from '../../fixtures/lis/20261-sample.json?raw'

// Virginia bill text from the LIS API (#487), behind an optional LIS_API_KEY:
// the pure helpers that filter and build texts, the two API calls, and the
// provider's `snapshot` and `fetchMeasure` with `fetch` stubbed at the wire.
vi.mock('../../../src/lib/rateLimitedFetch', () => import('../../helpers/unpacedFetch'))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { lis, packEtags, unpackEtags } from '../../../src/providers/lis'
import {
  getLisTextList, getLisTextPdf, LIS_FILES, LIS_FILES_BASE, LIS_API_BASE, type LisFile, type LisFiles, type LisTextRow,
} from '../../../src/providers/lis/client'
import {
  buildLisBill, LisAssembler, LIS_FILE_ORDER, lisIsFullText, lisRecordHash, lisTextBillNumber, lisTextHash, type LisIds, type LisRecord,
} from '../../../src/providers/lis/map'

const files2026 = JSON.parse(s2026Raw) as LisFiles

// ── Hand-written API rows ──

const VERSIONS: Record<number, string> = {
  1: 'Introduced', 2: 'Engrossed', 3: 'Enrolled', 4: 'Chaptered', 5: 'Substitute', 6: 'Reengrossed', 7: 'Reenrolled',
  8: 'Amendment', 9: 'Veto Explanation', 10: 'Gov Recommendation', 11: 'Conference Report',
}

/** A row of the text list, as the API writes one: the file links are empty. */
function row(number: string, textId: number, versionId: number, code: string | null, extra: Partial<Record<string, unknown>> = {}): LisTextRow {
  return {
    LegislationID: 98542, LegislationNumber: number, Description: VERSIONS[versionId], SessionID: 59,
    LegislationTextID: textId, DraftDate: '2025-11-17T00:00:00', DocumentCode: code, LDNumber: '26100576D',
    LegislationVersionID: versionId, Version: VERSIONS[versionId], IsPublic: true, IsComplete: true, GovernorsRequest: false,
    PDFFile: [], HTMLFile: [], ImpactFile: [], LinkFile: [], IsEmergency: false, IsReprint: false, TextDispositionID: 11,
    ...extra,
  } as unknown as LisTextRow
}

const blob = (n: number) => `https://lis.blob.core.windows.net/files/${n}.PDF`
/** A by-id answer: the blob PDF link and the text as HTML. */
const byIdAnswer = (textId: number, pdfs: number[] = [textId + 1_000_000]) => ({
  LegislationTextID: textId, DraftText: '<p>Be it enacted.</p>',
  PDFFile: pdfs.map(n => ({ FileURL: blob(n), FileName: `${n}.PDF` })), HTMLFile: [], ImpactFile: [], LinkFile: [],
})

// ── Pure helpers ──

describe('which versions are full text', () => {
  it('counts versions 1 through 7 as bill text', () => {
    for (let id = 1; id <= 7; id++) expect(lisIsFullText(id), VERSIONS[id]).toBe(true)
  })

  it('leaves out amendments, veto explanations, governor\'s recommendations, and conference reports', () => {
    expect(lisIsFullText(7)).toBe(true)
    for (let id = 8; id <= 11; id++) expect(lisIsFullText(id), VERSIONS[id]).toBe(false)
  })

  it('leaves out a version id the LIS adds later, or an invalid one', () => {
    expect(lisIsFullText(1)).toBe(true)
    expect(lisIsFullText(12)).toBe(false)
    expect(lisIsFullText(0)).toBe(false)
    expect(lisIsFullText(-1)).toBe(false)
    expect(lisIsFullText(Number.NaN)).toBe(false)
  })
})

describe('lisTextBillNumber', () => {
  it('writes a bill number as the CSVs key it, with no padding, spaces, or case', () => {
    expect(lisTextBillNumber('HB1')).toBe('HB1')
    expect(lisTextBillNumber(' hb0001 ')).toBe('HB1')
    expect(lisTextBillNumber('SB1078')).toBe('SB1078')
  })

  it('keeps joint resolutions as HJ and SJ, whether the feed writes HJ or HJR', () => {
    expect(lisTextBillNumber('HJ4')).toBe('HJ4')
    expect(lisTextBillNumber('SJ12')).toBe('SJ12')
    expect(lisTextBillNumber('HJR4')).toBe('HJ4')
    expect(lisTextBillNumber('sjr 0012')).toBe('SJ12')
  })

  it('leaves simple resolutions alone, which HR and SR already name', () => {
    expect(lisTextBillNumber('HR1')).toBe('HR1')
    expect(lisTextBillNumber('SR17')).toBe('SR17')
  })
})

describe('lisTextHash', () => {
  it('is a non-empty hash that is the same every time', async () => {
    const h = await lisTextHash('20261', 'HB1ER', 1199670)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(await lisTextHash('20261', 'HB1ER', 1199670)).toBe(h)
  })

  it('changes with the session, the document code, and the text id', async () => {
    const base = await lisTextHash('20261', 'HB1ER', 100)
    expect(await lisTextHash('20262', 'HB1ER', 100)).not.toBe(base)
    expect(await lisTextHash('20261', 'HB1E', 100)).not.toBe(base)
    // The LIS reuses a document code for another version of a bill (a substitute written as "SB34", as the
    // introduced bill was), so the code alone would give two versions one hash and AI would skip the second.
    expect(await lisTextHash('20261', 'HB1ER', 101)).not.toBe(base)
  })
})

// ── Assembling a record's versions ──

function assemble(files: LisFiles, code = '20261') {
  const a = new LisAssembler(code, files.bills)
  for (const file of LIS_FILE_ORDER) if (file !== 'bills' && files[file]) a.add(file, files[file])
  return a
}

describe('LisAssembler.addTexts', () => {
  it('puts a bill\'s full-text versions on its record, each with its id, code, version, description, and draft date', () => {
    const a = assemble(files2026)
    a.addTexts([
      row('HB1', 257001, 1, 'HB1', { DraftDate: '2025-11-17T00:01:00' }),
      row('HB1', 268485, 4, 'CHAP0350', { DraftDate: '2026-04-11T00:00:00', Description: 'Chaptered by Secretary of the Commonwealth' }),
    ])
    expect(a.result().records.get('HB1')!.texts).toEqual([
      [257001, 'HB1', 'Introduced', 'Introduced', '2025-11-17'],
      [268485, 'CHAP0350', 'Chaptered', 'Chaptered by Secretary of the Commonwealth', '2026-04-11'],
    ])
  })

  it('keeps only versions 1 through 7, so an amendment can never read as the bill\'s newest text', () => {
    const a = assemble(files2026)
    a.addTexts(Object.keys(VERSIONS).map(v => row('HB1', 1000 + Number(v), Number(v), `HB1V${v}`)))
    const kept = a.result().records.get('HB1')!.texts!
    expect(kept.map(t => t[0])).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007])
    expect(kept.map(t => t[2])).toEqual(['Introduced', 'Engrossed', 'Enrolled', 'Chaptered', 'Substitute', 'Reengrossed', 'Reenrolled'])
  })

  it('trims a document code, as the LIS writes at least one with a trailing space', () => {
    const a = assemble(files2026)
    a.addTexts([row('HB9', 5, 5, 'HB9HC3 ')])
    expect(a.result().records.get('HB9')!.texts![0][1]).toBe('HB9HC3')
  })

  it('reads a missing document code as empty rather than failing', () => {
    const a = assemble(files2026)
    a.addTexts([row('HB9', 5, 1, null)])
    expect(a.result().records.get('HB9')!.texts![0][1]).toBe('')
  })

  it('ignores a row for a bill the CSVs don\'t have, and makes no record for it', () => {
    const a = assemble(files2026)
    const before = [...a.result().records.keys()].sort()
    a.addTexts([row('HB9999', 7, 1, 'HB9999'), row('SB1', 8, 1, 'SB1'), row('HB9', 9, 1, 'HB9')])
    const { records } = a.result()
    expect([...records.keys()].sort()).toEqual(before)
    expect(records.has('HB9999')).toBe(false)
    expect(records.get('HB9')!.texts!.map(t => t[0])).toEqual([9])
  })

  it('attaches a joint resolution\'s texts to the bill the CSVs key as HJ or SJ, whichever way the API writes it', () => {
    const files = { ...files2026, bills: files2026.bills.replace('\n"HR1","Celebrating', '\n"HJ1","Celebrating') }
    const a = assemble(files)
    a.addTexts([row('HJ1', 31, 1, 'HJ1'), row('HJR1', 32, 3, 'HJ1ER')])
    const rec = a.result().records.get('HJ1')!
    expect(rec.texts!.map(t => t[0])).toEqual([31, 32])
  })

  it('writes the same versions whatever order the API lists them in, and counts a text id once', () => {
    const rows = [
      row('HB1', 30, 3, 'HB1ER', { DraftDate: '2026-02-20T00:00:00' }),
      row('HB1', 10, 1, 'HB1', { DraftDate: '2025-11-17T00:00:00' }),
      row('HB1', 20, 2, 'HB1E', { DraftDate: '2026-02-10T00:00:00' }),
      row('HB1', 20, 2, 'HB1E', { DraftDate: '2026-02-10T00:00:00' }),
    ]
    const a = assemble(files2026)
    a.addTexts(rows)
    const b = assemble(files2026)
    b.addTexts([...rows].reverse())
    expect(a.result().records.get('HB1')!.texts!.map(t => t[0])).toEqual([10, 20, 30])
    expect(b.result().records.get('HB1')!.texts).toEqual(a.result().records.get('HB1')!.texts)
  })

  it('keeps two versions that share a document code, since each is its own text', () => {
    const a = assemble(files2026)
    a.addTexts([
      row('HB9', 11, 1, 'HB9', { DraftDate: '2025-11-19T10:35:00' }),
      row('HB9', 12, 5, 'HB9', { DraftDate: '2026-07-01T06:35:00' }),
    ])
    expect(a.result().records.get('HB9')!.texts!.map(t => [t[0], t[2]])).toEqual([[11, 'Introduced'], [12, 'Substitute']])
  })

  it('writes the date alone, so a draft time that moves doesn\'t change the record', () => {
    const a = assemble(files2026)
    a.addTexts([row('HB9', 11, 1, 'HB9', { DraftDate: '2025-12-17T09:48:00' })])
    expect(a.result().records.get('HB9')!.texts![0][4]).toBe('2025-12-17')
    const b = assemble(files2026)
    b.addTexts([row('HB9', 11, 1, 'HB9', { DraftDate: '2025-12-17T00:00:00' })])
    expect(b.result().records.get('HB9')!.texts).toEqual(a.result().records.get('HB9')!.texts)
  })

  it('reads a missing draft date as empty', () => {
    const a = assemble(files2026)
    a.addTexts([row('HB9', 11, 1, 'HB9', { DraftDate: null })])
    expect(a.result().records.get('HB9')!.texts![0][4]).toBe('')
  })

  it('leaves a bill with no full-text version without a texts field, so its record is what it was', async () => {
    const plain = assemble(files2026).result().records.get('HB61')!
    const a = assemble(files2026)
    a.addTexts([row('HB61', 1, 8, 'HB61AB'), row('HB1', 2, 1, 'HB1')])
    const rec = a.result().records.get('HB61')!
    expect(a.result().records.get('HB1')!.texts!.map(t => t[0])).toEqual([2])
    expect('texts' in rec).toBe(false)
    expect(await lisRecordHash(rec)).toBe(await lisRecordHash(plain))
  })

  it('moves only the record hash of the bill that got a new version', async () => {
    const hashes = async (rows: LisTextRow[]) => {
      const a = assemble(files2026)
      a.addTexts(rows)
      return Object.fromEntries(await Promise.all([...a.result().records].map(async ([n, r]) => [n, await lisRecordHash(r)])))
    }
    const base = [row('HB1', 10, 1, 'HB1'), row('HB9', 20, 1, 'HB9')]
    const before = await hashes(base)
    const after = await hashes([...base, row('HB1', 11, 3, 'HB1ER')])
    const changed = Object.keys(before).filter(n => before[n] !== after[n])
    expect(changed).toEqual(['HB1'])
  })
})

// ── Building MeasureText ──

const counter = (base: number) => { const m = new Map<string, number>(); return (k: string) => m.get(k) ?? (m.set(k, base + m.size), base + m.size - 1) }
const ids = (): LisIds => ({ person: counter(3000000200), rollCall: counter(3000000400), doc: counter(3000000600), committee: counter(3000000800) })
const SESSION = { session_id: 3000000001, session_name: '2026 Regular Session', year_start: 2026, year_end: 2026 }

function withTexts(versions: LisRecord['texts']): LisRecord {
  const rec = structuredClone(assemble(files2026).result().records.get('HB1')!)
  rec.texts = versions
  return rec
}

describe('buildLisBill texts', () => {
  const versions: LisRecord['texts'] = [
    [10, 'HB1', 'Introduced', 'Introduced', '2025-11-17'],
    [20, 'HB1E', 'Engrossed', 'Engrossed', '2026-02-10'],
    [30, 'HB1ER', 'Enrolled', 'Enrolled', '2026-02-20'],
    [40, 'CHAP0350', 'Chaptered', 'Chaptered by Secretary of the Commonwealth', '2026-04-11'],
    [50, 'HB1S1', 'Substitute', 'Committee substitute', '2026-01-30'],
    [60, 'HB1ER2', 'Reengrossed', 'Reengrossed', '2026-03-01'],
    [70, 'HB1RE', 'Reenrolled', 'Reenrolled', '2026-03-05'],
  ]
  const pdfs = new Map(versions!.map(v => [v[0], blob(v[0] + 1_000_000)]))

  it('emits one PDF text per version, with the blob link, the version as its type, and the draft date', async () => {
    const bill = await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), pdfs)
    expect(bill.texts).toHaveLength(7)
    const t = bill.texts[0]
    expect(t).toMatchObject({
      date: '2025-11-17', type: 'Introduced', mime: 'application/pdf', mime_id: 2, url: '', state_link: blob(1_000_010),
      text_size: 0, alt_bill_text: 0, alt_state_link: '',
    })
    expect(bill.texts.map(x => x.type)).toEqual(['Introduced', 'Engrossed', 'Enrolled', 'Chaptered', 'Substitute', 'Reengrossed', 'Reenrolled'])
  })

  it('gives each version a type id the way LegiScan numbers them', async () => {
    const bill = await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), pdfs)
    expect(bill.texts.map(x => [x.type, x.type_id])).toEqual([
      ['Introduced', 1], ['Engrossed', 4], ['Enrolled', 5], ['Chaptered', 6], ['Substitute', 2], ['Reengrossed', 4], ['Reenrolled', 5],
    ])
  })

  it('gives each text a doc id of its own, apart from the fiscal impact statements\' ids, and the same each build', async () => {
    const a = await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), pdfs)
    const b = await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), pdfs)
    const docIds = a.texts.map(t => t.doc_id)
    expect(new Set(docIds).size).toBe(7)
    expect(b.texts.map(t => t.doc_id)).toEqual(docIds)
    const supplementIds = a.supplements.map(s => s.supplement_id)
    expect(supplementIds.length).toBeGreaterThan(0)
    expect(docIds.filter(id => supplementIds.includes(id))).toEqual([])
  })

  it('gives each text a stable, non-empty hash from the session and trimmed document code', async () => {
    const a = await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), pdfs)
    const b = await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), pdfs)
    expect(a.texts.every(t => /^[0-9a-f]{64}$/.test(t.text_hash))).toBe(true)
    expect(b.texts.map(t => t.text_hash)).toEqual(a.texts.map(t => t.text_hash))
    expect(new Set(a.texts.map(t => t.text_hash)).size).toBe(7)
    expect(a.texts[0].text_hash).toBe(await lisTextHash('20261', 'HB1', 10))
  })

  it('leaves out a version with no PDF in hand', async () => {
    const some = new Map([...pdfs].filter(([id]) => id !== 20))
    const bill = await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), some)
    expect(bill.texts.map(t => t.type)).toEqual(['Introduced', 'Enrolled', 'Chaptered', 'Substitute', 'Reengrossed', 'Reenrolled'])
  })

  it('has no texts when nothing resolved to a PDF, as without a key', async () => {
    expect((await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids(), pdfs)).texts).toHaveLength(7)
    expect((await buildLisBill(withTexts(versions), '20261', 1, 'h', SESSION, ids())).texts).toEqual([])
    expect((await buildLisBill(withTexts(undefined), '20261', 1, 'h', SESSION, ids(), pdfs)).texts).toEqual([])
  })
})

// ── The API client ──

const reply = (body: unknown, init?: ResponseInit) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init)
const sentRequest = (i = 0) => {
  const [input, init] = fetchMock.mock.calls[i]
  return { url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) }
}

describe('getLisTextList', () => {
  beforeEach(() => fetchMock.mockReset())

  it('asks for the whole session with the key in a WebAPIKey header', async () => {
    fetchMock.mockResolvedValue(reply({ LegislationTextList: [row('HB1', 1, 1, 'HB1')], Success: true, FailureMessage: '' }))
    const rows = await getLisTextList('20261', 'secret-key')
    expect(rows).toHaveLength(1)
    const { url, headers } = sentRequest()
    expect(url).toBe(`${LIS_API_BASE}/getlegislationtextlistasync?sessionCode=20261`)
    expect(headers.get('WebAPIKey')).toBe('secret-key')
    expect(url).not.toContain('secret-key')
  })

  it('calls onRequest once for the request sent', async () => {
    fetchMock.mockResolvedValue(reply({ LegislationTextList: [] }))
    const onRequest = vi.fn()
    await getLisTextList('20261', 'k', onRequest)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('reads an empty list as empty', async () => {
    fetchMock.mockResolvedValue(reply({ LegislationTextList: [], Success: true }))
    expect(await getLisTextList('20261', 'k')).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an HTTP error', async () => {
    fetchMock.mockResolvedValue(reply('nope', { status: 401 }))
    await expect(getLisTextList('20261', 'bad')).rejects.toThrow(/LIS HTTP 401/)
    fetchMock.mockResolvedValue(reply('boom', { status: 500 }))
    await expect(getLisTextList('20261', 'k')).rejects.toThrow(/LIS HTTP 500/)
  })

  it('fails closed on a body that isn\'t JSON', async () => {
    fetchMock.mockResolvedValue(reply('<html>maintenance</html>'))
    await expect(getLisTextList('20261', 'k')).rejects.toThrow(/LIS/)
  })

  it('fails closed on an answer with no LegislationTextList, or one that isn\'t a list', async () => {
    fetchMock.mockResolvedValue(reply({ Success: true }))
    await expect(getLisTextList('20261', 'k')).rejects.toThrow(/LegislationTextList/)
    fetchMock.mockResolvedValue(reply({ LegislationTextList: null, Success: true }))
    await expect(getLisTextList('20261', 'k')).rejects.toThrow(/LegislationTextList/)
    fetchMock.mockResolvedValue(reply({ LegislationTextList: {}, Success: true }))
    await expect(getLisTextList('20261', 'k')).rejects.toThrow(/LegislationTextList/)
    fetchMock.mockResolvedValue(reply([]))
    await expect(getLisTextList('20261', 'k')).rejects.toThrow(/LIS/)
  })

  it('fails closed when the API says it failed', async () => {
    fetchMock.mockResolvedValue(reply({ LegislationTextList: [], Success: false, FailureMessage: 'Invalid session' }))
    await expect(getLisTextList('20261', 'k')).rejects.toThrow(/Invalid session/)
  })

  it('fails closed on a row without the fields the mapping reads', async () => {
    for (const bad of [
      { ...row('HB1', 1, 1, 'HB1'), LegislationNumber: undefined },
      { ...row('HB1', 1, 1, 'HB1'), LegislationTextID: '12' },
      { ...row('HB1', 1, 1, 'HB1'), LegislationVersionID: null },
      null,
    ]) {
      fetchMock.mockResolvedValue(reply({ LegislationTextList: [row('HB2', 2, 1, 'HB2'), bad], Success: true }))
      await expect(getLisTextList('20261', 'k')).rejects.toThrow(/LIS/)
    }
  })

  it('takes a row with the fields the real answers leave null', async () => {
    const sparse = row('SJ1', 3, 8, null, { LDNumber: null, TextDispositionID: null, IsComplete: null, GovernorsRequest: null })
    fetchMock.mockResolvedValue(reply({ LegislationTextList: [sparse], Success: true }))
    expect(await getLisTextList('20261', 'k')).toHaveLength(1)
  })
})

describe('getLisTextPdf', () => {
  beforeEach(() => fetchMock.mockReset())

  it('asks for one text by id, with the key in a WebAPIKey header, and returns its PDF link', async () => {
    fetchMock.mockResolvedValue(reply(byIdAnswer(268485, [1217586])))
    expect(await getLisTextPdf(268485, 'secret-key')).toBe(blob(1217586))
    const { url, headers } = sentRequest()
    expect(url).toBe(`${LIS_API_BASE}/getlegislationtextbyidasync?legislationTextID=268485`)
    expect(headers.get('WebAPIKey')).toBe('secret-key')
  })

  it('calls onRequest once for the request sent', async () => {
    fetchMock.mockResolvedValue(reply(byIdAnswer(1)))
    const onRequest = vi.fn()
    await getLisTextPdf(1, 'k', onRequest)
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('returns null for an empty PDFFile, a version with no PDF', async () => {
    fetchMock.mockResolvedValue(reply({ ...byIdAnswer(1), PDFFile: [] }))
    expect(await getLisTextPdf(1, 'k')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('takes the first link when the answer lists several', async () => {
    fetchMock.mockResolvedValue(reply(byIdAnswer(1, [11, 12])))
    expect(await getLisTextPdf(1, 'k')).toBe(blob(11))
  })

  it('reads an answer whose one text sits in a LegislationTextList', async () => {
    fetchMock.mockResolvedValue(reply({ LegislationTextList: [byIdAnswer(1, [11])], Success: true }))
    expect(await getLisTextPdf(1, 'k')).toBe(blob(11))
  })

  it('fails closed on an HTTP error', async () => {
    fetchMock.mockResolvedValue(reply('x', { status: 500 }))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/LIS HTTP 500/)
    fetchMock.mockResolvedValue(reply('x', { status: 404 }))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/LIS HTTP 404/)
  })

  it('fails closed on an answer that isn\'t JSON, or lacks PDFFile', async () => {
    fetchMock.mockResolvedValue(reply('<html></html>'))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/LIS/)
    const { PDFFile: _pdf, ...lacking } = byIdAnswer(1)
    fetchMock.mockResolvedValue(reply(lacking))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/PDFFile/)
    fetchMock.mockResolvedValue(reply({ ...byIdAnswer(1), PDFFile: null }))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/PDFFile/)
    fetchMock.mockResolvedValue(reply(null))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/LIS/)
  })

  it('fails closed on a PDFFile entry with no usable link', async () => {
    fetchMock.mockResolvedValue(reply({ ...byIdAnswer(1), PDFFile: [{ FileName: 'x.PDF' }] }))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/FileURL/)
    fetchMock.mockResolvedValue(reply({ ...byIdAnswer(1), PDFFile: [{ FileURL: 12 }] }))
    await expect(getLisTextPdf(1, 'k')).rejects.toThrow(/FileURL/)
  })
})

// ── The packed ETag ──

describe('packEtags and unpackEtags', () => {
  const files = { bills: '"a"', history: '"b"' }

  it('round-trips the files, the docketed flag, and whether texts were read', () => {
    expect(unpackEtags(packEtags(files, true, true))).toEqual({ files, docketed: true, texts: true })
    expect(unpackEtags(packEtags(files, false, false))).toEqual({ files, docketed: false, texts: false })
  })

  it('packs a different string for a pass that read texts than for one that didn\'t', () => {
    expect(packEtags(files, true, true)).not.toBe(packEtags(files, true, false))
  })

  it('reads an ETag packed by the last version as none, so the next pass reads in full', () => {
    expect(unpackEtags(JSON.stringify({ v: 2, files, docketed: true }))).toBeNull()
  })

  it('reads nothing, a malformed string, or another shape as none', () => {
    expect(unpackEtags(packEtags(files, true, true))).not.toBeNull()
    expect(unpackEtags(null)).toBeNull()
    expect(unpackEtags('')).toBeNull()
    expect(unpackEtags('not json')).toBeNull()
    expect(unpackEtags(JSON.stringify({ bills: '"a"' }))).toBeNull()
    expect(unpackEtags(packEtags({ nonsense: '"a"' }, false, true))).toBeNull()
  })

  it('reads a texts flag that isn\'t true as false', () => {
    expect(unpackEtags(packEtags(files, true, true))?.texts).toBe(true)
    const raw = JSON.parse(packEtags(files, true, true))
    expect(unpackEtags(JSON.stringify({ ...raw, texts: 'yes' }))?.texts).toBe(false)
    const { texts: _t, ...without } = raw
    expect(unpackEtags(JSON.stringify(without))?.texts).toBe(false)
  })
})

// ── The provider ──

describe('the provider\'s surface', () => {
  it('takes an optional LIS_API_KEY and runs without one', () => {
    expect(lis.envKeys).toEqual(['LIS_API_KEY'])
    expect(lis.configured).toBeUndefined()
  })
})

type Served = { text: string; etag: string } | null
let served: Partial<Record<LisFile, Served>>
/** Every request to the LIS: the data files, and the API with its key header. */
let requests: { method: string; url: string; key: string | null }[]
let listAnswer: () => Response
let byId: (textId: number) => Response
const apiRequests = () => requests.filter(r => r.url.startsWith(LIS_API_BASE))
const lists = () => apiRequests().filter(r => r.url.includes('getlegislationtextlistasync'))
const byIds = () => apiRequests().filter(r => r.url.includes('getlegislationtextbyidasync'))
const fileGets = () => requests.filter(r => r.method === 'GET' && r.url.startsWith(LIS_FILES_BASE))

function serve(files: LisFiles, version = 'v1') {
  served = Object.fromEntries((Object.keys(LIS_FILES) as LisFile[]).map(file =>
    [file, files[file] ? { text: files[file], etag: `"20261-${file}-${version}"` } : null]))
}

/** The ids central would mint, the same for a key every time. */
const minted = new Map<string, number>()
function makeCtx(key?: string) {
  const logged: { type: string; params: Record<string, unknown> }[] = []
  const asked: Record<string, string[]> = {}
  const ctx = {
    env: { LIS_API_KEY: key },
    today: '2026-10-13',
    logCall: (type: string, params: Record<string, unknown>) => { logged.push({ type, params }) },
    ids: async (kind: string, keys: readonly string[]) => {
      ;(asked[kind] ??= []).push(...keys)
      return new Map(keys.map(k => {
        const full = `${kind}/${k}`
        if (!minted.has(full)) minted.set(full, 7_000_000_000 + minted.size)
        return [k, minted.get(full)!] as const
      }))
    },
    knownIds: async () => new Map<string, number>(),
    people: async () => [],
  }
  return { ctx: ctx as any, logged, asked }
}

const session = (etag: string | null = null) => ({ sessionId: 3000000001, state: 'VA', sessionTag: '20261', yearStart: 2026, yearEnd: 2026, etag })

beforeEach(() => {
  fetchMock.mockReset()
  minted.clear()
  requests = []
  serve(files2026)
  listAnswer = () => reply({ LegislationTextList: [], Success: true, FailureMessage: '' })
  byId = id => reply(byIdAnswer(id))
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const key = new Headers(init?.headers).get('WebAPIKey')
    requests.push({ method, url, key })
    if (url.startsWith(`${LIS_API_BASE}/`)) {
      if (key === null) return reply('unauthorized', { status: 401 })
      if (url.includes('getlegislationtextlistasync')) return listAnswer()
      if (url.includes('getlegislationtextbyidasync')) return byId(Number(new URL(url).searchParams.get('legislationTextID')))
      throw new Error(`unexpected API call: ${url}`)
    }
    if (!url.startsWith(`${LIS_FILES_BASE}/`)) throw new Error(`no network in this test: ${method} ${url}`)
    const name = url.split('/').pop()!
    const file = (Object.keys(LIS_FILES) as LisFile[]).find(f => LIS_FILES[f] === name)
    const s = file ? served[file] : null
    if (!s) return new Response('<Error><Code>BlobNotFound</Code></Error>', { status: 404 })
    return new Response(method === 'HEAD' ? null : s.text, { headers: { ETag: s.etag } })
  })
})

const rows = (...r: LisTextRow[]) => { listAnswer = () => reply({ LegislationTextList: r, Success: true, FailureMessage: '' }) }
const snap = (ctx: any, etag: string | null = null) => lis.snapshot!(session(etag), ctx)
const rec = (snapshot: Awaited<ReturnType<typeof snap>>, n: string) => snapshot.records.find(r => r.nativeKey === `20261/${n}`)!.raw as LisRecord

describe('snapshot without a key', () => {
  it('makes no API call, and no record carries texts', async () => {
    rows(row('HB1', 10, 1, 'HB1'))
    const { ctx, logged } = makeCtx(undefined)
    const snapshot = await snap(ctx)
    expect(apiRequests()).toEqual([])
    expect(logged).toEqual([])
    expect(snapshot.records.length).toBe(6)
    for (const r of snapshot.records) expect('texts' in (r.raw as LisRecord)).toBe(false)
    expect(unpackEtags(snapshot.etag!)?.texts).toBe(false)
  })

  it('treats an empty key as none', async () => {
    const { ctx } = makeCtx('')
    await snap(ctx)
    expect(apiRequests()).toEqual([])
  })
})

describe('snapshot with a key', () => {
  it('makes one text-list call, with the key in a header, logged as a LIS call', async () => {
    rows(row('HB1', 10, 1, 'HB1'))
    const { ctx, logged } = makeCtx('k-123')
    await snap(ctx)
    expect(lists()).toHaveLength(1)
    expect(lists()[0].url).toBe(`${LIS_API_BASE}/getlegislationtextlistasync?sessionCode=20261`)
    expect(lists()[0].key).toBe('k-123')
    expect(byIds()).toEqual([])
    expect(logged.map(l => l.type)).toEqual(['lis:getlegislationtextlistasync'])
    expect(JSON.stringify(logged)).not.toContain('k-123')
  })

  it('puts only the full-text versions on each bill\'s record', async () => {
    rows(...Object.keys(VERSIONS).map(v => row('HB1', 100 + Number(v), Number(v), `HB1V${v}`)), row('HB9', 200, 1, 'HB9'))
    const snapshot = await snap(makeCtx('k').ctx)
    expect(rec(snapshot, 'HB1').texts!.map(t => t[0])).toEqual([101, 102, 103, 104, 105, 106, 107])
    expect(rec(snapshot, 'HB9').texts!.map(t => t[0])).toEqual([200])
    expect('texts' in rec(snapshot, 'HB61')).toBe(false)
  })

  it('records the trimmed document code', async () => {
    rows(row('HB9', 5, 5, 'HB9HC3 '))
    expect(rec(await snap(makeCtx('k').ctx), 'HB9').texts![0][1]).toBe('HB9HC3')
  })

  it('ignores a row for a bill the CSVs don\'t have, and mints no bill id for it', async () => {
    rows(row('HB1', 10, 1, 'HB1'), row('HB9999', 11, 1, 'HB9999'))
    const { ctx, asked } = makeCtx('k')
    const snapshot = await snap(ctx)
    expect(rec(snapshot, 'HB1').texts).toHaveLength(1)
    expect(snapshot.records.map(r => r.nativeKey).sort()).toEqual(['20261/HB1', '20261/HB133', '20261/HB447', '20261/HB61', '20261/HB9', '20261/HR1'])
    expect(asked.bill).not.toContain('20261/HB9999')
    expect(asked.bill).toHaveLength(6)
  })

  it('attaches a joint resolution\'s texts to the right bill', async () => {
    serve({ ...files2026, bills: files2026.bills.replace('\n"HR1","Celebrating', '\n"HJ1","Celebrating') })
    rows(row('HJ1', 31, 1, 'HJ1'), row('HR1', 32, 1, 'HR1'))
    const snapshot = await snap(makeCtx('k').ctx)
    expect(rec(snapshot, 'HJ1').texts!.map(t => t[0])).toEqual([31])
    expect(snapshot.records.some(r => r.nativeKey === '20261/HR1')).toBe(false)
  })

  it('changes only the record hash of a bill that got a new version', async () => {
    rows(row('HB1', 10, 1, 'HB1'), row('HB9', 20, 1, 'HB9'))
    const first = await snap(makeCtx('k').ctx)
    rows(row('HB1', 10, 1, 'HB1'), row('HB9', 20, 1, 'HB9'), row('HB1', 11, 3, 'HB1ER'))
    const second = await snap(makeCtx('k').ctx)
    const changed = first.records.filter(r => r.hash !== second.records.find(s => s.nativeKey === r.nativeKey)!.hash).map(r => r.nativeKey)
    expect(changed).toEqual(['20261/HB1'])
  })

  it('adds nothing to a record for a list that has only amendments', async () => {
    rows(row('HB1', 10, 8, 'HB1AB'), row('HB9', 20, 1, 'HB9'))
    const first = await snap(makeCtx('k').ctx)
    const none = await snap(makeCtx(undefined).ctx)
    const differ = first.records.filter(r => r.hash !== none.records.find(n => n.nativeKey === r.nativeKey)!.hash).map(r => r.nativeKey)
    expect(differ).toEqual(['20261/HB9'])
  })

  it('makes the text-list call once for the session, however many bills it names', async () => {
    rows(...['HB1', 'HB9', 'HB61', 'HB133', 'HB447'].map((n, i) => row(n, 40 + i, 1, n)))
    await snap(makeCtx('k').ctx)
    expect(lists()).toHaveLength(1)
  })

  it('fails when the list answers with an HTTP error, so no record is stored from the pass', async () => {
    listAnswer = () => reply('server error', { status: 500 })
    await expect(snap(makeCtx('k').ctx)).rejects.toThrow(/LIS HTTP 500/)
    listAnswer = () => reply('{"LegislationTextList": [', { status: 200 })
    await expect(snap(makeCtx('k').ctx)).rejects.toThrow(/LIS/)
    listAnswer = () => reply({ Success: true })
    await expect(snap(makeCtx('k').ctx)).rejects.toThrow(/LegislationTextList/)
  })

  it('does not call the API when a CSV file already failed the pass', async () => {
    served.history = null
    await expect(snap(makeCtx('k').ctx)).rejects.toThrow(/HISTORY.CSV is missing/)
    expect(apiRequests()).toEqual([])
    serve(files2026)
    await snap(makeCtx('k').ctx)
    expect(lists()).toHaveLength(1)
  })
})

describe('snapshot and the stored ETag', () => {
  it('records that texts were read, so adding the key reads again', async () => {
    rows(row('HB1', 10, 1, 'HB1'))
    const first = await snap(makeCtx('k').ctx)
    expect(unpackEtags(first.etag!)?.texts).toBe(true)
  })

  it('reports unchanged when the files are, and the ETag was packed with texts', async () => {
    const first = await snap(makeCtx('k').ctx)
    expect(unpackEtags(first.etag!)?.texts).toBe(true)
    requests = []
    const again = await snap(makeCtx('k').ctx, first.etag!)
    expect(again).toEqual({ records: [], unchanged: true })
    expect(fileGets()).toEqual([])
    expect(apiRequests()).toEqual([])
  })

  it('reads in full when the ETag was packed without texts and a key is now set', async () => {
    const first = await snap(makeCtx(undefined).ctx)
    expect(unpackEtags(first.etag!)?.texts).toBe(false)
    requests = []
    rows(row('HB1', 10, 1, 'HB1'))
    const again = await snap(makeCtx('k').ctx, first.etag!)
    expect(again.unchanged).toBeFalsy()
    expect(fileGets().length).toBe(Object.keys(LIS_FILES).length)
    expect(lists()).toHaveLength(1)
    expect(rec(again, 'HB1').texts).toHaveLength(1)
    expect(unpackEtags(again.etag!)?.texts).toBe(true)
  })

  it('reads in full when the key is taken away, so the records lose their texts', async () => {
    rows(row('HB1', 10, 1, 'HB1'))
    const first = await snap(makeCtx('k').ctx)
    requests = []
    const again = await snap(makeCtx(undefined).ctx, first.etag!)
    expect(again.unchanged).toBeFalsy()
    expect(fileGets().length).toBe(Object.keys(LIS_FILES).length)
    expect(apiRequests()).toEqual([])
    expect('texts' in rec(again, 'HB1')).toBe(false)
    expect(unpackEtags(again.etag!)?.texts).toBe(false)
  })

  it('reads in full when the stored ETag is from before texts', async () => {
    const first = await snap(makeCtx('k').ctx)
    const raw = JSON.parse(first.etag!)
    const old = JSON.stringify({ v: 2, files: raw.files, docketed: raw.docketed })
    requests = []
    const again = await snap(makeCtx('k').ctx, old)
    expect(again.unchanged).toBeFalsy()
    expect(lists()).toHaveLength(1)
  })

  it('makes a text-list call only for a session whose files changed', async () => {
    const first = await snap(makeCtx('k').ctx)
    requests = []
    await snap(makeCtx('k').ctx, first.etag!)
    expect(lists()).toEqual([])
    serve(files2026, 'v2')
    requests = []
    const changed = await snap(makeCtx('k').ctx, first.etag!)
    expect(changed.unchanged).toBeFalsy()
    expect(lists()).toHaveLength(1)
  })

  it('still checks that a file the last pass read hasn\'t gone, when reading again for the key', async () => {
    const first = await snap(makeCtx(undefined).ctx)
    served.subdockets = null
    await expect(snap(makeCtx('k').ctx, first.etag!)).rejects.toThrow('SUBDOCKET.CSV is missing')
    expect(lists()).toEqual([])
  })
})

// ── The ingest ──

async function storedMeasure(number: string, rows3: LisTextRow[]) {
  rows(...rows3)
  const snapshot = await snap(makeCtx('k').ctx)
  const r = snapshot.records.find(x => x.nativeKey === `20261/${number}`)!
  return {
    billId: r.billId, sessionId: 3000000001, nativeKey: r.nativeKey, record: { raw: r.raw, hash: r.hash },
    session: { sessionId: 3000000001, sessionName: '2026 Regular Session', yearStart: 2026, yearEnd: 2026 } as any,
  }
}

const threeVersions = [row('HB1', 10, 1, 'HB1'), row('HB1', 20, 2, 'HB1E', { DraftDate: '2026-02-10T00:00:00' }), row('HB1', 30, 3, 'HB1ER', { DraftDate: '2026-02-20T00:00:00' })]

describe('fetchMeasure', () => {
  it('makes one by-id call per version and emits one PDF text for each', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    requests = []
    const { ctx, logged } = makeCtx('k-456')
    const bill = (await lis.fetchMeasure(measure, ctx)) as any
    expect(byIds().map(r => r.url)).toEqual([10, 20, 30].map(id => `${LIS_API_BASE}/getlegislationtextbyidasync?legislationTextID=${id}`))
    expect(byIds().every(r => r.key === 'k-456')).toBe(true)
    expect(logged.map(l => l.type)).toEqual(Array(3).fill('lis:getlegislationtextbyidasync'))
    expect(JSON.stringify(logged)).not.toContain('k-456')
    expect(bill.texts).toHaveLength(3)
    expect(bill.texts.map((t: any) => [t.type, t.date, t.state_link, t.mime])).toEqual([
      ['Introduced', '2025-11-17', blob(1_000_010), 'application/pdf'],
      ['Engrossed', '2026-02-10', blob(1_000_020), 'application/pdf'],
      ['Enrolled', '2026-02-20', blob(1_000_030), 'application/pdf'],
    ])
  })

  it('gives the same text hash and doc id on every run', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    const a = (await lis.fetchMeasure(measure, makeCtx('k').ctx)) as any
    const b = (await lis.fetchMeasure(measure, makeCtx('k').ctx)) as any
    expect(a.texts.map((t: any) => t.text_hash)).toEqual(b.texts.map((t: any) => t.text_hash))
    expect(a.texts.every((t: any) => t.text_hash.length > 0)).toBe(true)
    expect(a.texts.map((t: any) => t.doc_id)).toEqual(b.texts.map((t: any) => t.doc_id))
    expect(new Set(a.texts.map((t: any) => t.doc_id)).size).toBe(3)
  })

  it('mints text doc ids from central\'s id table, keyed on the LIS text id', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    const { ctx, asked } = makeCtx('k')
    await lis.fetchMeasure(measure, ctx)
    expect(asked.doc!.filter(k => /(^|[^\d])(10|20|30)$/.test(k) && !k.startsWith('http'))).toHaveLength(3)
  })

  it('leaves out a version whose answer has no PDF, and emits the others', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    byId = id => reply(id === 20 ? { ...byIdAnswer(id), PDFFile: [] } : byIdAnswer(id))
    const bill = (await lis.fetchMeasure(measure, makeCtx('k').ctx)) as any
    expect(bill.texts.map((t: any) => t.type)).toEqual(['Introduced', 'Enrolled'])
  })

  it('fails when a by-id answer is an HTTP error, so nothing is written from it', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    byId = id => (id === 20 ? reply('boom', { status: 500 }) : reply(byIdAnswer(id)))
    await expect(lis.fetchMeasure(measure, makeCtx('k').ctx)).rejects.toThrow(/LIS HTTP 500/)
  })

  it('fails when a by-id answer lacks PDFFile', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    byId = id => { const { PDFFile: _p, ...rest } = byIdAnswer(id); return reply(rest) }
    await expect(lis.fetchMeasure(measure, makeCtx('k').ctx)).rejects.toThrow(/PDFFile/)
  })

  it('makes no API call and has no texts without a key, even for a record that holds versions', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    requests = []
    const bill = (await lis.fetchMeasure(measure, makeCtx(undefined).ctx)) as any
    expect(apiRequests()).toEqual([])
    expect(bill.texts).toEqual([])
    // The same record, with the key, reads its versions.
    expect(((await lis.fetchMeasure(measure, makeCtx('k').ctx)) as any).texts).toHaveLength(3)
    expect(byIds()).toHaveLength(3)
  })

  it('makes no API call for a bill whose record holds no versions', async () => {
    const measure = await storedMeasure('HB61', threeVersions)
    requests = []
    const bill = (await lis.fetchMeasure(measure, makeCtx('k').ctx)) as any
    expect(apiRequests()).toEqual([])
    expect(bill.texts).toEqual([])
  })

  it('still builds the rest of the bill as it did, with the texts added', async () => {
    const measure = await storedMeasure('HB1', threeVersions)
    const withKey = (await lis.fetchMeasure(measure, makeCtx('k').ctx)) as any
    const without = (await lis.fetchMeasure(measure, makeCtx(undefined).ctx)) as any
    expect(withKey.texts).toHaveLength(3)
    const { texts: _a, ...restWith } = withKey
    const { texts: _b, ...restWithout } = without
    expect(restWith).toEqual(restWithout)
    expect(withKey.supplements.length).toBeGreaterThan(0)
  })
})
