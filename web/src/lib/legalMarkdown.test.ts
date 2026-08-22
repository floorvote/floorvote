import { describe, it, expect } from 'vitest'
import { renderLegalMarkdown, headingSlug } from './legalMarkdown'

describe('renderLegalMarkdown', () => {
  it('renders headings, bold, and mailto links', () => {
    const html = renderLegalMarkdown('# Terms\n\nHello **world** and [contact](mailto:a@b.org).')
    expect(html).toContain('<h1 id="terms">Terms</h1>')
    expect(html).toContain('<strong>world</strong>')
    expect(html).toContain('href="mailto:a@b.org"')
  })

  it('gives headings anchor ids the document TOC can link to', () => {
    const html = renderLegalMarkdown('## HOW IS YOUR ORGANIZATION\'S DATA ISOLATED?')
    expect(html).toContain('id="how-is-your-organizations-data-isolated"')
    expect(headingSlug("HOW IS YOUR ORGANIZATION'S DATA ISOLATED?"))
      .toBe('how-is-your-organizations-data-isolated')
  })

  it('strips script tags and javascript: URLs', () => {
    const html = renderLegalMarkdown('[x](javascript:alert(1))\n\n<script>alert(2)</script>')
    expect(html).not.toContain('<script')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  it('forces rel=noopener on links that open a new context', () => {
    const html = renderLegalMarkdown('<a href="https://x.org" target="_blank">x</a>')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('unescapes generator-style backslash-escaped punctuation snarkdown leaves literal', () => {
    // Legal-doc generators over-escape inert punctuation (e.g. "1\." so it is not
    // parsed as a list). snarkdown passes the backslash through unchanged; we strip it.
    const html = renderLegalMarkdown('Registered at DC 20005\\. Done.\n\n1\\. OUR SERVICES')
    expect(html).not.toContain('\\')
    expect(html).toContain('20005. Done.')
    expect(html).toContain('1. OUR SERVICES')
  })
})
