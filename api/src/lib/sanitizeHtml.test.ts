import { describe, it, expect } from 'vitest'
import { sanitizeCommentHtml } from './sanitizeHtml'

describe('sanitizeCommentHtml', () => {
  describe('strips dangerous content', () => {
    it('removes <script> tags and their contents', () => {
      const out = sanitizeCommentHtml('<p>Hi</p><script>alert(1)</script>')
      expect(out).not.toMatch(/<script/i)
      expect(out).not.toContain('alert(1)')
      expect(out).toContain('<p>Hi</p>')
    })

    it('removes <img> tags entirely (not on allowlist), including onerror', () => {
      const out = sanitizeCommentHtml('<p>x</p><img src=x onerror="alert(1)">')
      expect(out).not.toMatch(/<img/i)
      expect(out).not.toMatch(/onerror/i)
      expect(out).not.toContain('alert(1)')
      expect(out).toContain('<p>x</p>')
    })

    it('strips event-handler attributes from allowed tags', () => {
      const out = sanitizeCommentHtml('<p onclick="alert(1)">hi</p>')
      expect(out).not.toMatch(/onclick/i)
      expect(out).not.toContain('alert(1)')
      expect(out).toContain('hi')
      expect(out).toMatch(/<p\b[^>]*>hi<\/p>/i)
    })

    it('strips style attributes (not on the attribute allowlist)', () => {
      const out = sanitizeCommentHtml('<p style="position:fixed">hi</p>')
      expect(out).not.toMatch(/style=/i)
      expect(out).toContain('hi')
    })

    it('neutralizes javascript: hrefs on anchors', () => {
      const out = sanitizeCommentHtml('<a href="javascript:alert(1)">click</a>')
      expect(out).not.toMatch(/javascript:/i)
      expect(out).toContain('click')
    })

    it('removes disallowed tags (e.g. iframe, object) but keeps inner text', () => {
      const out = sanitizeCommentHtml('<p>before</p><iframe src="evil"></iframe><p>after</p>')
      expect(out).not.toMatch(/<iframe/i)
      expect(out).toContain('<p>before</p>')
      expect(out).toContain('<p>after</p>')
    })

    it('removes <style> tags and their contents', () => {
      const out = sanitizeCommentHtml('<p>hi</p><style>body{display:none}</style>')
      expect(out).not.toMatch(/<style/i)
      expect(out).not.toContain('display:none')
    })
  })

  describe('preserves legitimate tiptap output', () => {
    it('keeps formatting tags', () => {
      const out = sanitizeCommentHtml('<p>A <strong>bold</strong> and <em>italic</em> and <s>strike</s>.</p>')
      expect(out).toContain('<strong>bold</strong>')
      expect(out).toContain('<em>italic</em>')
      expect(out).toContain('<s>strike</s>')
    })

    it('keeps lists', () => {
      const out = sanitizeCommentHtml('<ul><li>one</li><li>two</li></ul>')
      expect(out).toContain('<ul>')
      expect(out).toContain('<li>one</li>')
      expect(out).toContain('<li>two</li>')
      expect(out).toContain('</ul>')
    })

    it('keeps blockquote and br', () => {
      const out = sanitizeCommentHtml('<blockquote>quote</blockquote><p>line<br>break</p>')
      expect(out).toContain('<blockquote>quote</blockquote>')
      expect(out).toMatch(/<br\s*\/?>/)
    })

    it('keeps safe anchors with href/target/rel', () => {
      const out = sanitizeCommentHtml('<a href="https://example.com" target="_blank" rel="noopener">link</a>')
      expect(out).toContain('href="https://example.com"')
      expect(out).toContain('target="_blank"')
      expect(out).toContain('rel="noopener"')
      expect(out).toContain('>link</a>')
    })

    it('keeps mention spans with their data attributes', () => {
      const input = '<span data-type="mention" data-id="user:abc-123" data-label="Jane Smith">@Jane Smith</span>'
      const out = sanitizeCommentHtml(input)
      expect(out).toContain('data-type="mention"')
      expect(out).toContain('data-id="user:abc-123"')
      expect(out).toContain('data-label="Jane Smith"')
      expect(out).toContain('@Jane Smith')
    })

    it('keeps a realistic mixed comment intact', () => {
      const input = '<p>Hey <span data-type="mention" data-id="role:r1" data-label="Finance">@Finance</span>, see <a href="https://x.com">this</a>:</p><ul><li><strong>point</strong></li></ul>'
      const out = sanitizeCommentHtml(input)
      expect(out).toContain('data-type="mention"')
      expect(out).toContain('href="https://x.com"')
      expect(out).toContain('<strong>point</strong>')
      expect(out).toContain('<li>')
    })
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeCommentHtml('')).toBe('')
  })
})
