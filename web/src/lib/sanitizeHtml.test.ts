import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from './sanitizeHtml'

const opts = { allowedTags: ['p', 'a', 'strong'], allowedAttr: ['href', 'target', 'rel'] }

describe('sanitizeHtml', () => {
  it('keeps allowed tags and drops disallowed ones', () => {
    const html = sanitizeHtml('<p>ok <strong>bold</strong></p><script>bad()</script>', opts)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('<script')
  })

  it('allows mailto but strips javascript: URLs', () => {
    expect(sanitizeHtml('<a href="mailto:a@b.org">m</a>', opts)).toContain('href="mailto:a@b.org"')
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>', opts).toLowerCase()).not.toContain('javascript:')
  })

  it('forces rel=noopener on target-blank links', () => {
    expect(sanitizeHtml('<a href="https://x.org" target="_blank">x</a>', opts)).toContain('rel="noopener noreferrer"')
  })
})
