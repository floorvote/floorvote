import { describe, it, expect } from 'vitest'
import { parseXml, XmlError, type XmlNode } from '../../../src/providers/govinfo/xml'
import { fixtureFiles } from '../../helpers/govinfoZip'

// The parser reads GovInfo's machine-written Bill Status files and nothing
// else, so it is strict: anything that isn't well-formed XML throws, and the
// provider fails closed on it.

const root = (xml: string) => parseXml(xml).root
const names = (n: XmlNode) => n.children.map(c => c.name)

describe('reading well-formed XML', () => {
  it('reads elements, their text, and their children in order', () => {
    const r = root('<a><b>one</b><c><d>two</d><d>three</d></c></a>')
    expect(r.name).toBe('a')
    expect(names(r)).toEqual(['b', 'c'])
    expect(r.children[0].text).toBe('one')
    expect(r.children[1].children.map(c => c.text)).toEqual(['two', 'three'])
  })

  it('skips the declaration, comments, processing instructions, and the whitespace between elements', () => {
    const r = root('<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<!-- generated -->\n<a>\n  <b>x</b>\n  <!-- inner -->\n</a>\n')
    expect(r.name).toBe('a')
    expect(r.text.trim()).toBe('')
    expect(names(r)).toEqual(['b'])
  })

  it('reads empty and self-closing elements as empty text', () => {
    const r = root('<a><b/><c></c><d />' + '</a>')
    expect(r.children.map(c => [c.name, c.text, c.children.length])).toEqual([['b', '', 0], ['c', '', 0], ['d', '', 0]])
  })

  it('decodes the five predefined entities and numeric references', () => {
    expect(root('<a>&lt;p&gt;Tom &amp; Jerry&apos;s &quot;show&quot; &#8212; &#x2019;</a>').text).toBe('<p>Tom & Jerry\'s "show" — ’')
  })

  it('does not decode twice: &amp;lt; is the text &lt;', () => {
    expect(root('<a>&amp;lt;</a>').text).toBe('&lt;')
  })

  it('reads a CDATA section as its text, entities and all', () => {
    expect(root('<a><![CDATA[<p>5 < 6 &amp; more</p>]]></a>').text).toBe('<p>5 < 6 &amp; more</p>')
  })

  it('reads names with a namespace prefix, and attributes it ignores', () => {
    const r = root('<billStatus><dublinCore xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format a=\'1\' b="2 > 1">text/xml</dc:format></dublinCore></billStatus>')
    expect(r.children[0].children[0]).toMatchObject({ name: 'dc:format', text: 'text/xml' })
  })

  it('keeps non-ASCII text, and reads a file as large as the largest bill', () => {
    expect(root('<a>Veterans’ Affairs — Español</a>').text).toBe('Veterans’ Affairs — Español')
    const big = `<a>${'<b><c>x</c></b>'.repeat(200_000)}</a>`
    expect(root(big).children).toHaveLength(200_000)
  })

  it('reads every recorded Bill Status file', () => {
    for (const [name, xml] of fixtureFiles) {
      const r = root(xml)
      expect(r.name, name).toBe('billStatus')
      expect(names(r), name).toEqual(expect.arrayContaining(['version', 'bill', 'dublinCore']))
    }
  })
})

describe('the spans of the elements to leave out of a hash', () => {
  const xml = '<a><updateDate>1</updateDate><b><updateDate>2</updateDate><keep>k</keep></b><dublinCore><x>y</x></dublinCore></a>'

  it('lists the start and end of every element with a named tag, at any depth', () => {
    const { spans } = parseXml(xml, { spans: ['updateDate', 'dublinCore'] })
    expect(spans.map(([s, e]) => xml.slice(s, e))).toEqual([
      '<updateDate>1</updateDate>', '<updateDate>2</updateDate>', '<dublinCore><x>y</x></dublinCore>',
    ])
  })

  it('lists none by default', () => {
    expect(parseXml(xml).root.children).toHaveLength(3)
    expect(parseXml(xml).spans).toEqual([])
  })

  it('counts positions in the text, past multi-byte characters', () => {
    const text = '<a><t>Veterans’ — </t><updateDate>1</updateDate></a>'
    const { spans } = parseXml(text, { spans: ['updateDate'] })
    expect(text.slice(spans[0][0], spans[0][1])).toBe('<updateDate>1</updateDate>')
  })
})

describe('failing closed on anything that isn\'t well-formed', () => {
  it.each([
    ['an empty document', ''],
    ['only whitespace', '  \n '],
    ['text and no element', 'this is not XML'],
    ['an unclosed element', '<a><b>text</b>'],
    ['an element cut off in a tag', '<a><b>text</b></a'],
    ['a start tag cut off', '<a><b'],
    ['mismatched tags', '<a><b>text</c></a>'],
    ['a close tag with nothing open', '</a>'],
    ['content after the root', '<a>x</a><b>y</b>'],
    ['text after the root', '<a>x</a> trailing'],
    ['text before the root', 'leading <a>x</a>'],
    ['a DOCTYPE', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ['an entity it doesn\'t know', '<a>&nbsp;</a>'],
    ['a bare ampersand', '<a>fish & chips</a>'],
    ['an unterminated entity', '<a>&amp</a>'],
    ['a numeric reference to nothing', '<a>&#xZZ;</a>'],
    ['a numeric reference past Unicode', '<a>&#99999999;</a>'],
    ['an attribute without quotes', '<a b=1>x</a>'],
    ['an unterminated attribute', '<a b="1>x</a>'],
    ['an unterminated comment', '<a><!-- x</a>'],
    ['an unterminated CDATA section', '<a><![CDATA[ x</a>'],
    ['a stray less-than in text', '<a>5 < 6</a>'],
    ['an empty tag name', '<a><></a>'],
    ['a tag name that starts with a digit', '<a><1b>x</1b></a>'],
    ['an element nested a thousand deep', '<a>'.repeat(1000) + '</a>'.repeat(1000)],
  ])('throws on %s', (_what, text) => {
    expect(() => parseXml(text)).toThrow(XmlError)
  })

  it('says what was wrong and where', () => {
    expect(() => parseXml('<a><b>text</c></a>')).toThrow(/<\/c>.*<b>|expected.*<\/b>/i)
  })
})
