import { describe, it, expect } from 'vitest'
import { sanitize } from './CommentContent'

// Finding L3: anchor rel + URI hardening in the comment HTML sanitizer.
describe('CommentContent sanitize()', () => {
  it('forces rel="noopener noreferrer" on a target anchor', () => {
    const out = sanitize('<a href="https://example.com" target="_blank">x</a>')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('href="https://example.com"')
  })

  it('drops a javascript: URI', () => {
    const out = sanitize('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
  })

  it('drops a data: URI', () => {
    const out = sanitize('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(out).not.toContain('data:')
  })

  it('keeps a normal https link and mailto', () => {
    expect(sanitize('<a href="https://example.com">x</a>')).toContain('href="https://example.com"')
    expect(sanitize('<a href="mailto:a@b.org">x</a>')).toContain('href="mailto:a@b.org"')
  })

  it('strips script and event-handler attributes', () => {
    const out = sanitize('<img src=x onerror="alert(1)"><script>alert(1)</script><strong>bold</strong>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<script')
    expect(out).toContain('<strong>bold</strong>')
  })

  it('preserves mention spans', () => {
    const out = sanitize('<span data-type="mention" data-id="user:123" data-label="Ada">@Ada</span>')
    expect(out).toContain('data-type="mention"')
    expect(out).toContain('data-id="user:123"')
  })
})
