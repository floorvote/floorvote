import { describe, it, expect } from 'vitest'
import { describePageTarget, looksLikePdf, pdfPageTarget } from './pdfPages'

// Which page a PDF claim opens (#572). The tenant extracts no PDF text and
// counts no pages (#560), so a page past the end of the file is left to the
// viewer, which shows the last page; only a page that can't be a page number at
// all opens the file at page 1.

describe('pdfPageTarget', () => {
  it('opens the cited page when it is a positive whole number', () => {
    expect(pdfPageTarget(1)).toEqual({ page: 1, fallback: null })
    expect(pdfPageTarget(7)).toEqual({ page: 7, fallback: null })
    expect(pdfPageTarget(412)).toEqual({ page: 412, fallback: null })
  })

  it('leaves a page past the end of the file to the viewer', () => {
    expect(pdfPageTarget(9999)).toEqual({ page: 9999, fallback: null })
  })

  it('opens at page 1, as missing, when no page was cited', () => {
    expect(pdfPageTarget(null)).toEqual({ page: 1, fallback: 'missing' })
    expect(pdfPageTarget(undefined)).toEqual({ page: 1, fallback: 'missing' })
  })

  it('opens at page 1, as invalid, for zero, a negative, or a fraction', () => {
    expect(pdfPageTarget(0)).toEqual({ page: 1, fallback: 'invalid' })
    expect(pdfPageTarget(-3)).toEqual({ page: 1, fallback: 'invalid' })
    expect(pdfPageTarget(2.5)).toEqual({ page: 1, fallback: 'invalid' })
  })

  it('opens at page 1, as invalid, for a number that is no page number', () => {
    expect(pdfPageTarget(NaN)).toEqual({ page: 1, fallback: 'invalid' })
    expect(pdfPageTarget(Infinity)).toEqual({ page: 1, fallback: 'invalid' })
    expect(pdfPageTarget(Number.MAX_SAFE_INTEGER + 2)).toEqual({ page: 1, fallback: 'invalid' })
  })

  it('opens at page 1 for anything that is not a number, including numeric text', () => {
    expect(pdfPageTarget('7')).toEqual({ page: 1, fallback: 'missing' })
    expect(pdfPageTarget({})).toEqual({ page: 1, fallback: 'missing' })
    expect(pdfPageTarget([4])).toEqual({ page: 1, fallback: 'missing' })
    expect(pdfPageTarget(true)).toEqual({ page: 1, fallback: 'missing' })
  })
})

describe('describePageTarget', () => {
  it('names the page when it is the cited one', () => {
    expect(describePageTarget(pdfPageTarget(7))).toBe('Page 7')
  })

  it('says no page was cited, and that the file opens at page 1', () => {
    expect(describePageTarget(pdfPageTarget(null))).toBe('No page was cited, so the PDF opens at page 1')
  })

  it('says the cited page is not usable, and that the file opens at page 1', () => {
    expect(describePageTarget(pdfPageTarget(0))).toBe('The cited page isn’t usable, so the PDF opens at page 1')
    expect(describePageTarget(pdfPageTarget(-3))).toBe('The cited page isn’t usable, so the PDF opens at page 1')
  })
})

describe('looksLikePdf', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  it('accepts bytes that start with the PDF header', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n%âã'))).toBe(true)
  })

  it('accepts a header after a few bytes of leading junk, as viewers do', () => {
    expect(looksLikePdf(bytes('\n\n  junk %PDF-1.4\n'))).toBe(true)
  })

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    expect(looksLikePdf(bytes('%PDF-1.4').buffer as ArrayBuffer)).toBe(true)
  })

  it('refuses an HTML error page', () => {
    expect(looksLikePdf(bytes('<!DOCTYPE html><html><body><h1>Not found</h1></body></html>'))).toBe(false)
  })

  it('refuses an empty body and a short one', () => {
    expect(looksLikePdf(new Uint8Array(0))).toBe(false)
    expect(looksLikePdf(bytes('%PDF'))).toBe(false)
  })

  it('refuses a document that mentions the header only after its first 1024 bytes', () => {
    expect(looksLikePdf(bytes('x'.repeat(1100) + '%PDF-1.4'))).toBe(false)
  })

  it('refuses the header in the wrong case or without its dash', () => {
    expect(looksLikePdf(bytes('%pdf-1.4'))).toBe(false)
    expect(looksLikePdf(bytes('%PDF1.4'))).toBe(false)
  })
})
