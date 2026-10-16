import { describe, it, expect } from 'vitest'
import { decodeStoredHtml } from '../../src/lib/decodeHtml'

// Build bytes one-to-one from a string whose code units are all <= 0xFF, so a
// fixture reads as the exact bytes a windows-1252 server would send.
function raw(s: string): Uint8Array {
  return Uint8Array.from(s, ch => {
    const code = ch.charCodeAt(0)
    if (code > 0xff) throw new Error('fixture char out of byte range')
    return code
  })
}
const utf8 = (s: string) => new TextEncoder().encode(s)

// 0x93/0x94 curly double quotes, 0x92 apostrophe, 0x96 en dash, 0xA7 section sign.
const CP1252_BODY = '<p>\x93Sample Act\x94 \xA7 12\x9613 isn\x92t binding.</p>'
const CP1252_DECODED = '<p>“Sample Act” § 12–13 isn’t binding.</p>'

describe('decodeStoredHtml', () => {
  it('decodes undeclared windows-1252 bytes instead of producing U+FFFD', () => {
    const out = decodeStoredHtml(raw(CP1252_BODY))
    expect(out).toBe(CP1252_DECODED)
    expect(out).not.toContain('�')
  })

  it('treats a null or bare content type as undeclared', () => {
    expect(decodeStoredHtml(raw(CP1252_BODY), null)).toBe(CP1252_DECODED)
    expect(decodeStoredHtml(raw(CP1252_BODY), 'text/html')).toBe(CP1252_DECODED)
  })

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const buf = raw(CP1252_BODY).buffer as ArrayBuffer
    expect(decodeStoredHtml(buf)).toBe(CP1252_DECODED)
  })

  it('decodes by a <meta charset> declaration', () => {
    const html = `<html><head><meta charset="windows-1252"></head>${CP1252_BODY}</html>`
    expect(decodeStoredHtml(raw(html))).toBe(
      `<html><head><meta charset="windows-1252"></head>${CP1252_DECODED}</html>`,
    )
  })

  it('decodes by an http-equiv Content-Type declaration', () => {
    const head = '<head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head>'
    expect(decodeStoredHtml(raw(head + CP1252_BODY))).toBe(head + CP1252_DECODED)
  })

  it('reads single-quoted, unquoted, uppercase, and self-closed meta forms', () => {
    // Latin-2 byte 0xA1 is "A with ogonek", where windows-1252 would give an inverted bang.
    const forms = [
      "<meta charset='iso-8859-2'>",
      '<meta charset=iso-8859-2>',
      '<META CHARSET="ISO-8859-2">',
      '<meta charset="iso-8859-2" />',
      "<META HTTP-EQUIV='content-type' CONTENT='text/html;charset=ISO-8859-2'>",
    ]
    for (const meta of forms) {
      expect(decodeStoredHtml(raw(`${meta}<p>\xA1</p>`)), meta).toBe(`${meta}<p>Ą</p>`)
    }
  })

  it('decodes by the stored content-type charset', () => {
    expect(decodeStoredHtml(raw('<p>\xA1</p>'), 'text/html; charset=iso-8859-2')).toBe('<p>Ą</p>')
    expect(decodeStoredHtml(raw(CP1252_BODY), 'text/html; charset=windows-1252')).toBe(CP1252_DECODED)
    expect(decodeStoredHtml(raw(CP1252_BODY), 'text/html; Charset="Windows-1252"')).toBe(CP1252_DECODED)
  })

  it('prefers the stored content-type charset over a conflicting meta tag', () => {
    const html = '<meta charset="windows-1252"><p>\xA1</p>'
    expect(decodeStoredHtml(raw(html), 'text/html; charset=iso-8859-2')).toBe('<meta charset="windows-1252"><p>Ą</p>')
  })

  it('treats iso-8859-1 as windows-1252, as browsers do', () => {
    expect(decodeStoredHtml(raw(CP1252_BODY), 'text/html; charset=iso-8859-1')).toBe(CP1252_DECODED)
    expect(decodeStoredHtml(raw(CP1252_BODY), 'text/html; charset=latin1')).toBe(CP1252_DECODED)
  })

  it('keeps valid UTF-8 as UTF-8 when it is mislabelled windows-1252 or iso-8859-1', () => {
    // Misconfigured servers send a Latin-1 header over UTF-8 files. These decode correctly
    // today, so a windows-1252 label must not turn them into mojibake.
    const html = '<p>“Sample Act” § 12 café</p>'
    expect(decodeStoredHtml(utf8(html), 'text/html; charset=iso-8859-1')).toBe(html)
    expect(decodeStoredHtml(utf8(html), 'text/html; charset=windows-1252')).toBe(html)
    expect(decodeStoredHtml(utf8(`<meta charset="windows-1252">${html}`))).toBe(`<meta charset="windows-1252">${html}`)
  })

  it('decodes valid UTF-8 by a non-UTF-8, non-windows-1252 declaration all the same', () => {
    // 0xC3 0xA9 is valid UTF-8 for e-acute, but a Latin-2 declaration is taken at its word.
    expect(decodeStoredHtml(Uint8Array.from([0xc3, 0xa9]), 'text/html; charset=iso-8859-2')).toBe('ĂŠ')
  })

  it('treats a UTF-16 meta declaration as UTF-8, as browsers do', () => {
    // A UTF-16 meta tag cannot be read from a byte-oriented head, so it means UTF-8.
    const html = '<meta charset="utf-16"><p>café</p>'
    expect(decodeStoredHtml(utf8(html))).toBe(html)
  })

  it('leaves valid UTF-8 with multibyte characters unchanged', () => {
    const html = '<p>“Sample Act” § 12–13 café 日本 \u{1F4DC}</p>'
    expect(decodeStoredHtml(utf8(html))).toBe(html)
    expect(decodeStoredHtml(utf8(html), 'text/html; charset=utf-8')).toBe(html)
    expect(decodeStoredHtml(utf8(`<meta charset="utf-8">${html}`))).toBe(`<meta charset="utf-8">${html}`)
  })

  it('leaves ASCII-only documents unchanged', () => {
    const html = '<html><body><p>Section 1. Nothing special.</p></body></html>'
    expect(decodeStoredHtml(utf8(html))).toBe(html)
    expect(decodeStoredHtml(utf8(html), 'text/html; charset=windows-1252')).toBe(html)
  })

  it('falls back to windows-1252 when a UTF-8 declaration lies', () => {
    const viaMeta = '<meta charset="utf-8">' + CP1252_BODY
    expect(decodeStoredHtml(raw(viaMeta))).toBe('<meta charset="utf-8">' + CP1252_DECODED)
    expect(decodeStoredHtml(raw(CP1252_BODY), 'text/html; charset=utf-8')).toBe(CP1252_DECODED)
  })

  it('ignores an unknown charset label and detects instead', () => {
    expect(decodeStoredHtml(raw(CP1252_BODY), 'text/html; charset=x-no-such-charset')).toBe(CP1252_DECODED)
    const html = '<meta charset="x-no-such-charset"><p>é</p>'
    expect(decodeStoredHtml(utf8(html))).toBe(html)
  })

  it('returns an empty string for an empty body', () => {
    expect(decodeStoredHtml(new Uint8Array(0))).toBe('')
    expect(decodeStoredHtml(new Uint8Array(0), 'text/html; charset=windows-1252')).toBe('')
  })

  it('does not honour a charset declaration far past the head of the document', () => {
    // A bill that quotes markup deep in its body must not change how the document decodes.
    const html = `<p>${'x'.repeat(8000)}</p><p>&lt;meta charset="iso-8859-2"&gt;</p><p>\xA1</p>`
    const out = decodeStoredHtml(raw(html))
    expect(out.endsWith('<p>¡</p>')).toBe(true)
  })

  it('does not carry a leading UTF-8 byte-order mark into the text', () => {
    const out = decodeStoredHtml(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('<p>hi</p>')]))
    expect(out).toBe('<p>hi</p>')
  })
})
