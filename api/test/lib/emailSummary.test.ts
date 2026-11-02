import { describe, it, expect } from 'vitest'
import { renderSummaryHtml, renderEmailSummary } from '../../src/lib/emailSummary'

// Fixture text is invented.
const filler = (n: number) => Array(n).fill('word').join(' ')
const ALLOWED = new Set(['p', 'ul', 'ol', 'li', 'strong', 'em', 'a'])
const tagNames = (html: string) => [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map(m => m[1].toLowerCase())

describe('renderSummaryHtml: blocks', () => {
  it('renders a paragraph as an inline-styled p', () => {
    expect(renderSummaryHtml('Lead sentence.')).toMatch(/^<p style="[^"]+">Lead sentence\.<\/p>$/)
  })

  it('renders list items as an inline-styled ul and li', () => {
    const html = renderSummaryHtml('Lead.\n\n- One.\n- Two.')
    expect(html).toMatch(/<ul style="[^"]+"><li style="[^"]+">One\.<\/li><li style="[^"]+">Two\.<\/li><\/ul>/)
    expect(html).toMatch(/^<p style="[^"]+">Lead\.<\/p><ul/)
  })

  it('renders numbered items as an ol', () => {
    const html = renderSummaryHtml('1. First.\n2. Second.')
    expect(html).toMatch(/^<ol style="[^"]+"><li style="[^"]+">First\.<\/li><li style="[^"]+">Second\.<\/li><\/ol>$/)
  })

  it('nests a child list inside its parent li', () => {
    const html = renderSummaryHtml('- Parent.\n  - Child one.\n  - Child two.\n    - Grandchild.\n- Next.')
    const strip = html.replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<ul><li>Parent.<ul><li>Child one.</li><li>Child two.<ul><li>Grandchild.</li></ul></li></ul></li><li>Next.</li></ul>')
  })

  it('puts a paragraph after a list outside it', () => {
    const strip = renderSummaryHtml('- One.\n\nAfter.').replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<ul><li>One.</li></ul><p>After.</p>')
  })

  it('switches between an ordered and an unordered list at the same level', () => {
    const strip = renderSummaryHtml('- A.\n1. B.').replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<ul><li>A.</li></ul><ol><li>B.</li></ol>')
  })

  it('tolerates a list that starts nested', () => {
    const html = renderSummaryHtml('  - Deep first.\n- Shallow.')
    expect(html).toContain('Deep first.')
    expect(html).toContain('Shallow.')
    expect(html.match(/<ul/g)).toHaveLength(html.match(/<\/ul>/g)!.length)
    expect(html.match(/<li/g)).toHaveLength(html.match(/<\/li>/g)!.length)
  })

  it('renders nothing for empty markdown', () => {
    expect(renderSummaryHtml('')).toBe('')
  })
})

describe('renderSummaryHtml: inline', () => {
  it('renders **bold** and __bold__ as strong', () => {
    const strip = renderSummaryHtml('- **Fees**: Lowers it. And __Forms__ too.').replace(/ style="[^"]*"/g, '')
    expect(strip).toContain('<strong>Fees</strong>: Lowers it.')
    expect(strip).toContain('<strong>Forms</strong> too.')
  })

  it('renders *em* and _em_ as em', () => {
    const strip = renderSummaryHtml('An *important* and _second_ word.').replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<p>An <em>important</em> and <em>second</em> word.</p>')
  })

  it('does not treat snake_case or a lone asterisk as emphasis', () => {
    const strip = renderSummaryHtml('Uses a_b_c and 5 * 3.').replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<p>Uses a_b_c and 5 * 3.</p>')
  })

  it('renders bold inside emphasis without closing the em on the bold marker', () => {
    const strip = renderSummaryHtml('*x **y** z*').replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<p><em>x <strong>y</strong> z</em></p>')
  })

  it('trims the last block margin by position, never by matching text', () => {
    const html = renderSummaryHtml('Lead.\n\nmargin:0 0 6px')
    expect(html).toContain('>margin:0 0 6px</p>')
    expect(html.match(/<p style="([^"]*)">/g)).toEqual(['<p style="margin:0 0 6px 0;">', '<p style="margin:0;">'])
  })

  it('trims the last list margin by position too', () => {
    const html = renderSummaryHtml('- margin:0 0 6px')
    expect(html).toContain('>margin:0 0 6px</li>')
    expect(html).toMatch(/^<ul style="margin:0 0 0 18px;padding:0;">/)
  })

  it('leaves an unclosed marker as literal text', () => {
    const strip = renderSummaryHtml('Half **open text').replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<p>Half **open text</p>')
  })

  it('renders emphasis inside bold', () => {
    const strip = renderSummaryHtml('**A *b* c**').replace(/ style="[^"]*"/g, '')
    expect(strip).toBe('<p><strong>A <em>b</em> c</strong></p>')
  })
})

describe('renderSummaryHtml: escaping', () => {
  const hostile = 'Run <script>alert(1)</script> or <a href="https://evil.test">click</a> & "quote" \'single\' <img src=x onerror=1>'

  it('escapes every special character in a paragraph', () => {
    const html = renderSummaryHtml(hostile)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;a href=&quot;https://evil.test&quot;&gt;click&lt;/a&gt;')
    expect(html).toContain('&amp; &quot;quote&quot;')
    expect(html).toContain("'single'")
  })

  it('escapes inside list items and bold', () => {
    const html = renderSummaryHtml(`- **<b>x</b>**: ${hostile}`)
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<script')
    expect(html).toContain('<strong style="')
  })

  it('produces no tag outside p, ul, ol, li, strong, and em', () => {
    const md = `${hostile}\n- ${hostile}\n  - **${hostile}**\n1. *${hostile}*`
    const names = tagNames(renderSummaryHtml(md))
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(['p', 'ul', 'ol', 'li', 'strong', 'em']).toContain(n)
  })

  it('leaves a markdown link as literal text instead of making an anchor', () => {
    const html = renderSummaryHtml('See [here](javascript:alert(1)) now.')
    expect(html).not.toContain('<a')
    expect(html).toContain('[here](javascript:alert(1))')
  })

  it('escapes the markers it cannot parse, rather than emitting them raw', () => {
    const html = renderSummaryHtml('**<script>**')
    expect(html).not.toContain('<script')
  })
})

describe('renderEmailSummary', () => {
  const href = 'https://x.test/RI/2026/HB 1234'
  const long = `Revises the permit renewal process.\n- **Fees**: ${filler(30)}\n- **Forms**: ${filler(30)}\n- **Dates**: ${filler(30)}`

  it('renders a summary that fits whole, with no ellipsis and no link', () => {
    const html = renderEmailSummary('Lead.\n- One.\n- Two.', href)
    expect(html).toContain('<ul style=')
    expect(html).toContain('<li style=')
    expect(html).not.toContain('…')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('Full summary')
  })

  it('cuts a long summary and adds the full-summary link to the bill', () => {
    const html = renderEmailSummary(long, href)
    expect(html).toContain('<ul style=')
    expect(html).toContain('…</li>')
    expect(html).not.toContain('Dates')
    expect(html).toContain(`<a href="${href}"`)
    expect(html).toContain('Full summary on FloorVote →')
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it('escapes the link target', () => {
    const html = renderEmailSummary(long, 'https://x.test/a?b="c"&d=<e>')
    expect(html).toContain('href="https://x.test/a?b=&quot;c&quot;&amp;d=&lt;e&gt;"')
  })

  it('cuts a prose-only summary at a word and links', () => {
    const html = renderEmailSummary(filler(100), href)
    expect(html).toMatch(/word…<\/p>/)
    expect(html).toContain('Full summary on FloorVote →')
  })

  it('renders an HTML-form summary as a list', () => {
    const html = renderEmailSummary('<p>Lead.</p><ul><li>One</li><li>Two</li></ul>', href)
    expect(html.match(/<li /g)).toHaveLength(2)
    expect(html).not.toContain('&lt;ul')
  })

  it('renders a one-line bold-label list as a list', () => {
    const html = renderEmailSummary('Lead sentence. - **Fees**: Lowers a fee. - **Forms**: Adds a form.', href)
    expect(html.match(/<li /g)).toHaveLength(2)
    expect(html).toContain('<strong style=')
  })

  it('emits only the allowed tags, the link being the one anchor', () => {
    const html = renderEmailSummary(`<script>x</script> & "q"\n- ${filler(80)}`, href)
    for (const n of tagNames(html)) expect(ALLOWED.has(n)).toBe(true)
    expect(html).not.toContain('<script')
  })

  it('renders nothing for an empty or missing summary', () => {
    expect(renderEmailSummary('', href)).toBe('')
    expect(renderEmailSummary('   ', href)).toBe('')
    expect(renderEmailSummary(null, href)).toBe('')
    expect(renderEmailSummary(undefined, href)).toBe('')
  })
})
