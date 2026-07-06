import { describe, it, expect } from 'vitest'
// Lives in shared/ (consumed by api). Tested here because shared/*.test.ts is
// orphaned by the per-package vitest roots and never runs in CI.
import { htmlToText } from '../../../shared/htmlToText'

describe('htmlToText', () => {
  it('strips tags and keeps the visible text', () => {
    expect(htmlToText('<p>Hello <strong>world</strong></p>')).toBe('Hello world')
  })

  it('turns block elements into line breaks', () => {
    const html = '<h2>Title</h2><p>First.</p><p>Second.</p>'
    expect(htmlToText(html)).toBe('Title\n\nFirst.\n\nSecond.')
  })

  it('treats <br> as a single newline', () => {
    expect(htmlToText('line one<br>line two')).toBe('line one\nline two')
  })

  it('preserves anchor URLs as "text (url)"', () => {
    const html = '<a href="https://example.com/profile#setting-week-ahead">Unsubscribe</a>'
    expect(htmlToText(html)).toBe('Unsubscribe (https://example.com/profile#setting-week-ahead)')
  })

  it('omits the parenthetical when link text already is the url', () => {
    const html = '<a href="https://example.com">https://example.com</a>'
    expect(htmlToText(html)).toBe('https://example.com')
  })

  it('decodes common HTML entities', () => {
    expect(htmlToText('Town &amp; City &lt;clerks&gt; &quot;2026&quot; &#39;here&#39;&nbsp;now'))
      .toBe('Town & City <clerks> "2026" \'here\' now')
  })

  it('decodes numeric (decimal + hex) and typographic named entities', () => {
    // Common editorial style uses em-dashes; a template emitting them as entities must
    // not leak the literal token into the text/plain part.
    expect(htmlToText('FY2026&#8212;2027')).toBe('FY2026—2027')
    expect(htmlToText('they&#x2019;re here')).toBe('they’re here')
    expect(htmlToText('past&mdash;present')).toBe('past—present')
  })

  it('drops style/script content entirely', () => {
    const html = '<style>.x{color:red}</style><p>Visible</p><script>alert(1)</script>'
    expect(htmlToText(html)).toBe('Visible')
  })

  it('collapses runs of blank lines and trims the result', () => {
    const html = '\n\n<div>A</div>\n\n\n<div>B</div>\n\n'
    expect(htmlToText(html)).toBe('A\n\nB')
  })

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('')
  })
})
