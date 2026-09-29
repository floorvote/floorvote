import { describe, it, expect } from 'vitest'
import { billHtmlToText } from '../../src/lib/billText'

describe('billHtmlToText', () => {
  it('drops script and style CONTENTS, not just their tags', () => {
    const html = `<html><head>
      <style>td { font-family: Courier; } .footerLink a { color: white; }</style>
      <script>function googleTranslateElementInit() { new google.translate.TranslateElement(); }</script>
      </head><body><p>SECTION 1. The Election Code is amended.</p></body></html>`
    const out = billHtmlToText(html)
    expect(out).toContain('SECTION 1. The Election Code is amended.')
    expect(out).not.toContain('font-family')
    expect(out).not.toContain('googleTranslateElementInit')
    expect(out).not.toContain('footerLink')
  })

  it('preserves California strike and font-colour redline verbatim', () => {
    // Shape taken from CA AB2230, doc 3425474.
    const html = `<p>is<font color="#B30000"><strike><s>guilty of a felony,</s></strike></font>` +
      ` punishable by a fine<font color="blue" class="blue_text"><i> of ten thousand dollars</i></font></p>`
    const out = billHtmlToText(html)
    expect(out).toContain('<strike>')
    expect(out).toContain('<s>')
    expect(out).toContain('<font color="#B30000">')
    expect(out).toContain('<font color="blue" class="blue_text">')
    expect(out).toContain('guilty of a felony,')
    expect(out).toContain('of ten thousand dollars')
  })

  it('preserves Texas underline and strike AND the literal brackets', () => {
    // Shape taken from TX SB1209.
    const html = `<td>&#xA0;&#xA0;&#xA0;; [<s>or</s>]</td><td><u>for a special taxing unit</u></td>`
    const out = billHtmlToText(html)
    expect(out).toContain('<s>')
    expect(out).toContain('<u>')
    expect(out).toContain('[')
    expect(out).toContain(']')
    expect(out).toContain('for a special taxing unit')
  })

  it('preserves New Jersey bolded bracket deletions', () => {
    const html = `<p>(14) (Deleted by amendment<b><span style="font-family:Albertus">[</span></b>` +
      `.<b><span style="font-family:Albertus">]</span></b>)</p>`
    const out = billHtmlToText(html)
    expect(out).toContain('<b>')
    expect(out).toContain('[')
    expect(out).toContain(']')
    expect(out).not.toContain('<span')
  })

  it('is inert on a document with no redline markup', () => {
    const html = `<html><body><p>Requires counties to report within 48 hours.</p>` +
      `<p>This act takes effect immediately.</p></body></html>`
    const out = billHtmlToText(html)
    expect(out.replace(/\s+/g, ' ').trim())
      .toBe('Requires counties to report within 48 hours. This act takes effect immediately.')
    expect(out).not.toMatch(/<[a-z]/i)
  })

  it('decodes entities and collapses whitespace', () => {
    const html = `<p>A&nbsp;&nbsp;B &amp; C &lt;D&gt; &quot;E&quot; &#39;F&#39;</p>`
    const out = billHtmlToText(html)
    expect(out).toBe(`A B & C <D> "E" 'F'`)
  })

  it('separates block elements with newlines rather than joining words', () => {
    const html = `<div>first line</div><div>second line</div>`
    expect(billHtmlToText(html)).toBe('first line\nsecond line')
  })

  it('drops HTML comments', () => {
    expect(billHtmlToText(`<p>kept</p><!-- dropped --><p>also kept</p>`))
      .toBe('kept\nalso kept')
  })
})
