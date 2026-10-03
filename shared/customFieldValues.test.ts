import { describe, it, expect } from 'vitest'
import { normalizeDocument, parseStoredDocuments } from './customFieldValues'

describe('normalizeDocument', () => {
  it('trims the title and normalizes the URL', () => {
    expect(normalizeDocument({ title: '  Testimony ', url: ' https://docs.google.com/document/d/abc ' }))
      .toEqual({ ok: true, doc: { title: 'Testimony', url: 'https://docs.google.com/document/d/abc' } })
  })

  it.each([
    ['javascript:alert(1)'],
    ['http://example.com/letter'],
    ['data:text/html,<script>alert(1)</script>'],
    ['docs.google.com/document/d/abc'],
  ])('refuses %s', (url) => {
    expect(normalizeDocument({ title: 'Letter', url }).ok).toBe(false)
  })

  it('refuses a missing or blank title', () => {
    expect(normalizeDocument({ url: 'https://example.com' }).ok).toBe(false)
    expect(normalizeDocument({ title: '   ', url: 'https://example.com' }).ok).toBe(false)
  })

  it('refuses anything that is not a { title, url } object', () => {
    expect(normalizeDocument('https://example.com').ok).toBe(false)
    expect(normalizeDocument(null).ok).toBe(false)
    expect(normalizeDocument([{ title: 'a', url: 'https://example.com' }]).ok).toBe(false)
  })
})

describe('parseStoredDocuments', () => {
  it('reads a stored JSON array', () => {
    const raw = JSON.stringify([{ title: 'Letter', url: 'https://example.com/letter' }])
    expect(parseStoredDocuments(raw)).toEqual([{ title: 'Letter', url: 'https://example.com/letter' }])
  })

  it('drops entries that are not https links instead of rendering them', () => {
    const raw = JSON.stringify([
      { title: 'Bad', url: 'javascript:alert(1)' },
      { title: 'Good', url: 'https://example.com/good' },
    ])
    expect(parseStoredDocuments(raw)).toEqual([{ title: 'Good', url: 'https://example.com/good' }])
  })

  it('returns nothing for empty, malformed, or non-array values', () => {
    expect(parseStoredDocuments(null)).toEqual([])
    expect(parseStoredDocuments('')).toEqual([])
    expect(parseStoredDocuments('not json')).toEqual([])
    expect(parseStoredDocuments('"https://example.com"')).toEqual([])
  })
})
