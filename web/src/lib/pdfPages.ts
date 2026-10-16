// PDF claim links (#572): which page a claim opens, and whether bytes are a PDF.
// Stubs for the red run; the real code follows.

export type PageTarget = { page: number; fallback: null | 'missing' | 'invalid' }

export function pdfPageTarget(_cited: unknown): PageTarget {
  return { page: 0, fallback: null }
}

export function describePageTarget(_target: PageTarget, _cited: unknown): string {
  return ''
}

export function looksLikePdf(_bytes: ArrayBuffer | Uint8Array): boolean {
  return true
}
