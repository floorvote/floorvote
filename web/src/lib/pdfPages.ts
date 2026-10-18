// PDF claim links (#572, design in #560): which page a claim opens, and whether
// bytes are a PDF at all.
//
// The tenant extracts no PDF text and counts no pages, so it can't tell that a
// cited page is past the end of the file. The viewer can: Chromium's shows the
// last page for `#page=999` on a shorter file. That is left to it. What the
// page can tell is whether the cited page is a page number at all.

export type PageTarget = {
  /** The page to open the PDF at, counting the first page as 1. */
  page: number
  /** Why the file opens at page 1 instead of the cited page, or null when it opens at the cited page. */
  fallback: null | 'missing' | 'invalid'
}

/**
 * The page a claim's PDF opens at. A positive whole number is used as cited.
 * No page (null, undefined, or anything that isn't a number) is `missing`; a
 * number that can't be a page (zero, negative, a fraction, NaN, infinite, or
 * too large to be exact) is `invalid`. Both open at page 1.
 */
export function pdfPageTarget(cited: unknown): PageTarget {
  if (typeof cited !== 'number') return { page: 1, fallback: 'missing' }
  if (Number.isSafeInteger(cited) && cited >= 1) return { page: cited, fallback: null }
  return { page: 1, fallback: 'invalid' }
}

/** A short sentence saying which page the PDF opens at, and why when it isn't the cited one. */
export function describePageTarget(target: PageTarget): string {
  if (target.fallback === 'missing') return 'No page was cited, so the PDF opens at page 1'
  if (target.fallback === 'invalid') return 'The cited page isn’t usable, so the PDF opens at page 1'
  return `Page ${target.page}`
}

const HEADER = '%PDF-'
const HEADER_WINDOW = 1024

/**
 * Whether bytes look like a PDF: the `%PDF-` header within the first 1,024
 * bytes, where viewers look for it. A legislature's HTML error page served
 * under a PDF's key fails this, and is never handed to a frame.
 */
export function looksLikePdf(bytes: ArrayBuffer | Uint8Array): boolean {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const head = view.subarray(0, HEADER_WINDOW)
  for (let i = 0; i + HEADER.length <= head.length; i++) {
    let j = 0
    while (j < HEADER.length && head[i + j] === HEADER.charCodeAt(j)) j++
    if (j === HEADER.length) return true
  }
  return false
}
