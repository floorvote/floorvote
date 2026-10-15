import { describe, it, expect } from 'vitest'
import { canRenderPdfInline } from './pdfInline'

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

describe('canRenderPdfInline', () => {
  it('is false on iPhone Safari', () => {
    expect(canRenderPdfInline({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5, pdfViewerEnabled: true })).toBe(false)
  })

  it('is false on iPhone Chrome, which is WebKit underneath', () => {
    expect(canRenderPdfInline({ userAgent: IPHONE_CHROME, maxTouchPoints: 5 })).toBe(false)
  })

  it('is false on iPadOS, which reports a Macintosh user agent but has a touch screen', () => {
    expect(canRenderPdfInline({ userAgent: MAC_SAFARI, maxTouchPoints: 5, pdfViewerEnabled: true })).toBe(false)
  })

  it('is true on desktop Safari, which has no touch points', () => {
    expect(canRenderPdfInline({ userAgent: MAC_SAFARI, maxTouchPoints: 0, pdfViewerEnabled: true })).toBe(true)
  })

  it('is true on desktop Chrome', () => {
    expect(canRenderPdfInline({ userAgent: MAC_CHROME, maxTouchPoints: 0, pdfViewerEnabled: true })).toBe(true)
  })

  it('is true when the browser does not report pdfViewerEnabled', () => {
    expect(canRenderPdfInline({ userAgent: MAC_CHROME, maxTouchPoints: 0 })).toBe(true)
  })

  it('is false when the browser reports its PDF viewer is off', () => {
    expect(canRenderPdfInline({ userAgent: MAC_CHROME, maxTouchPoints: 0, pdfViewerEnabled: false })).toBe(false)
  })
})
