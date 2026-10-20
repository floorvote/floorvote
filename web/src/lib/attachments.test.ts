import { describe, it, expect, vi, afterEach } from 'vitest'
import { attachmentKind, formatFileSize, uploadAttachment, removeAttachment, type AttachmentSummary } from './attachments'

afterEach(() => { vi.unstubAllGlobals() })

describe('attachmentKind', () => {
  it.each([
    ['application/pdf', 'report.pdf', 'PDF'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'memo.docx', 'Word'],
    ['application/msword', 'memo.doc', 'Word'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'budget.xlsx', 'Spreadsheet'],
    ['text/csv', 'rows.csv', 'Spreadsheet'],
    ['image/png', 'chart.png', 'Image'],
    ['image/jpeg', 'photo.jpg', 'Image'],
    ['application/octet-stream', 'notes.bin', 'File'],
  ])('calls %s (%s) a %s', (contentType, name, label) => {
    expect(attachmentKind(contentType, name).label).toBe(label)
  })

  it('goes by the extension when the type is generic', () => {
    expect(attachmentKind('application/octet-stream', 'budget.XLSX').label).toBe('Spreadsheet')
  })
})

describe('formatFileSize', () => {
  it.each([
    [0, '0 B'], [900, '900 B'], [1024, '1 KB'], [1536, '1.5 KB'], [1048576, '1 MB'], [26214400, '25 MB'],
  ])('shows %i as %s', (n, text) => { expect(formatFileSize(n)).toBe(text) })
})

describe('uploadAttachment', () => {
  const file = new File(['hello'], 'a b&c.pdf', { type: 'application/pdf' })
  const summary: AttachmentSummary = { id: 'att1', name: 'a b&c.pdf', contentType: 'application/pdf', size: 5 }

  it('posts the file itself as the body, with its name encoded in the query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(summary), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(uploadAttachment(file)).resolves.toEqual(summary)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/attachments?name=a%20b%26c.pdf')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(file)
    expect(init.credentials).toBe('include')
  })

  it("throws the server's message when it refuses the file", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Scripts are not allowed' }), { status: 400 })))
    await expect(uploadAttachment(file)).rejects.toThrow('Scripts are not allowed')
  })

  it('says so when the connection fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(uploadAttachment(file)).rejects.toThrow(/connection/i)
  })

  it('stops when aborted', async () => {
    const ctl = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    })))
    const p = uploadAttachment(file, ctl.signal)
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('removeAttachment', () => {
  it('deletes a pending upload by id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await removeAttachment('att1')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/attachments/att1')
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
  })
})
