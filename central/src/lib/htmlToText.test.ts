import { describe, it, expect } from 'vitest'
import { htmlToText } from './htmlToText'

// Mirror of shared/htmlToText (central is a standalone package and does not
// import from shared/). Keep these behaviors in sync with api's copy.
describe('htmlToText', () => {
  it('strips tags and keeps the visible text', () => {
    expect(htmlToText('<p>Hello <strong>world</strong></p>')).toBe('Hello world')
  })

  it('turns block elements into line breaks', () => {
    expect(htmlToText('<h2>Title</h2><p>First.</p><p>Second.</p>')).toBe('Title\n\nFirst.\n\nSecond.')
  })

  it('treats <br> as a single newline', () => {
    expect(htmlToText('line one<br>line two')).toBe('line one\nline two')
  })

  it('preserves anchor URLs as "text (url)"', () => {
    expect(htmlToText('<a href="https://example.com/x">Open</a>')).toBe('Open (https://example.com/x)')
  })

  it('decodes common HTML entities', () => {
    expect(htmlToText('A &amp; B &lt;c&gt; &quot;d&quot;&nbsp;e')).toBe('A & B <c> "d" e')
  })

  it('decodes numeric (decimal + hex) and typographic named entities', () => {
    expect(htmlToText('FY2026&#8212;2027')).toBe('FY2026—2027')
    expect(htmlToText('they&#x2019;re here')).toBe('they’re here')
    expect(htmlToText('past&mdash;present')).toBe('past—present')
  })

  it('drops style/script content entirely', () => {
    expect(htmlToText('<style>.x{}</style><p>Visible</p><script>x()</script>')).toBe('Visible')
  })

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('')
  })
})
