import { describe, it, expect } from 'vitest'
import { renderEmailShell } from './emailShell'

describe('renderEmailShell', () => {
  const html = renderEmailShell({
    instanceName: 'Rhode Island Association',
    signalHtml: '<strong>Sam Ortiz</strong> mentioned you in a comment',
    dateLabel: 'Today at 2:14 PM',
    bodyHtml: '<div id="body-marker">CARDS</div>',
    footerHtml: '<a href="https://example.com">example.com</a>',
  })
  it('is a full HTML doc on the gray surface at 560px', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('width="560"')
    expect(html).toContain('#f8fafc')
  })
  it('includes instance name, signal sentence, date, and body', () => {
    expect(html).toContain('Rhode Island Association')
    expect(html).toContain('mentioned you in a comment')
    expect(html).toContain('Today at 2:14 PM')
    expect(html).toContain('id="body-marker"')
  })
  it('omits the date row when no dateLabel is given', () => {
    const h = renderEmailShell({ instanceName: 'X', signalHtml: 'Hi', bodyHtml: 'x', footerHtml: 'y' })
    expect(h).not.toContain('email-date')
  })
  it('escapes instanceName (it is a plain string, not HTML)', () => {
    const h = renderEmailShell({ instanceName: '<script>A & B', signalHtml: 'x', bodyHtml: 'y', footerHtml: 'z' })
    expect(h).not.toContain('<script>')
    expect(h).toContain('&amp;')
    expect(h).toContain('&lt;')
  })
})
