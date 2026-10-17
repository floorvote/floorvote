/**
 * A small, strict XML reader for GovInfo's Bill Status files, which are
 * machine-written and well-formed. A Worker has no DOM parser, and a
 * dependency would be a lot of code for one file shape, so this reads exactly
 * what those files use: elements, text, attributes, the five predefined
 * entities and numeric references, CDATA, comments, and the declaration.
 * (Bill Status files use no attributes. The House Clerk's roll call files name
 * each voter in them, and senate.gov's member list gives a senator's LIS id in
 * one.)
 *
 * It is strict, since the provider fails closed on anything that isn't a
 * Bill Status file. Anything else throws an `XmlError`: unclosed or mismatched
 * tags, text or a second element outside the root, an entity it doesn't know,
 * a DOCTYPE (so no entity can be declared), a stray `<`, a bare `&`, an
 * unquoted attribute or one named twice, or nesting past `MAX_DEPTH`.
 *
 * It builds the whole tree of one file, which is the most the provider ever
 * holds (the largest 119th Congress file is 2.5 MB of XML).
 */

export interface XmlNode {
  name: string
  /** The element's attributes, entities decoded. An element with none shares one empty set. */
  attrs: Readonly<Record<string, string>>
  /** The element's own text: entities decoded, CDATA included, and any run of only whitespace left out. */
  text: string
  children: XmlNode[]
}

export class XmlError extends Error {
  constructor(message: string, at?: number) {
    super(at === undefined ? message : `${message} (at character ${at})`)
    this.name = 'XmlError'
  }
}

/** Real Bill Status files nest 8 levels deep. */
const MAX_DEPTH = 100

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y
const CLOSE_TAG = /<\/([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*>/y
const ATTRIBUTE = /[ \t\r\n]+([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/y
const NO_ATTRS: Readonly<Record<string, string>> = Object.freeze(Object.create(null))
const SPACE = /[ \t\r\n]*/y
const NOT_AN_ENTITY = /&(?!(?:#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);)/
const ENTITY = /&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }
const BLANK = /^[ \t\r\n]*$/

function decode(text: string, at: number): string {
  if (!text.includes('&')) return text
  if (NOT_AN_ENTITY.test(text)) throw new XmlError('an & that isn\'t one of the five entities or a numeric reference', at)
  return text.replace(ENTITY, (_m, body: string) => {
    if (body[0] !== '#') return NAMED[body]
    const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    if (!(code > 0 && code <= 0x10FFFF) || (code >= 0xD800 && code <= 0xDFFF)) throw new XmlError(`&${body}; isn't a character`, at)
    return String.fromCodePoint(code)
  })
}

/**
 * Parse one XML document. `spans` names elements (at any depth) whose start and
 * end positions in `text` to collect, for leaving them out of a hash: each is
 * `[start, end)`, from the `<` of the start tag to just past the end tag, in
 * the order the elements close.
 */
export function parseXml(
  text: string,
  opts: { spans?: readonly string[] } = {},
): { root: XmlNode; spans: [number, number][] } {
  const spanNames = opts.spans && opts.spans.length > 0 ? new Set(opts.spans) : null
  const spans: [number, number][] = []
  const n = text.length
  const stack: XmlNode[] = []
  const starts: number[] = []
  let root: XmlNode | null = null
  let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0

  const closeElement = (node: XmlNode, start: number, end: number) => {
    if (spanNames?.has(node.name)) spans.push([start, end])
  }

  while (i < n) {
    const lt = text.indexOf('<', i)
    const segment = text.slice(i, lt === -1 ? n : lt)
    if (stack.length === 0) {
      if (!BLANK.test(segment)) throw new XmlError(root ? 'text after the root element' : 'text before the root element', i)
    } else if (segment !== '' && !BLANK.test(segment)) {
      stack[stack.length - 1].text += decode(segment, i)
    }
    if (lt === -1) break
    i = lt

    const next = text.charCodeAt(i + 1)
    if (next === 0x2F /* / */) {
      CLOSE_TAG.lastIndex = i
      const m = CLOSE_TAG.exec(text)
      if (!m) throw new XmlError('a close tag that isn\'t well-formed', i)
      const open = stack[stack.length - 1]
      if (!open) throw new XmlError(`a close tag </${m[1]}> with nothing open`, i)
      if (open.name !== m[1]) throw new XmlError(`expected </${open.name}> but found </${m[1]}>`, i)
      stack.pop()
      closeElement(open, starts.pop()!, i + m[0].length)
      i += m[0].length
    } else if (next === 0x21 /* ! */) {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        if (end === -1) throw new XmlError('a comment that never ends', i)
        i = end + 3
      } else if (text.startsWith('<![CDATA[', i)) {
        if (stack.length === 0) throw new XmlError('CDATA outside the root element', i)
        const end = text.indexOf(']]>', i + 9)
        if (end === -1) throw new XmlError('a CDATA section that never ends', i)
        stack[stack.length - 1].text += text.slice(i + 9, end)
        i = end + 3
      } else {
        throw new XmlError('a DOCTYPE or other declaration, which Bill Status files don\'t have', i)
      }
    } else if (next === 0x3F /* ? */) {
      const end = text.indexOf('?>', i + 2)
      if (end === -1) throw new XmlError('a processing instruction that never ends', i)
      i = end + 2
    } else {
      NAME.lastIndex = i + 1
      const m = NAME.exec(text)
      if (!m) throw new XmlError('a < that doesn\'t start a tag', i)
      const node: XmlNode = { name: m[0], attrs: NO_ATTRS, text: '', children: [] }
      let p = i + 1 + m[0].length
      for (;;) {
        ATTRIBUTE.lastIndex = p
        const a = ATTRIBUTE.exec(text)
        if (!a) break
        if (node.attrs === NO_ATTRS) node.attrs = Object.create(null) as Record<string, string>
        const attrs = node.attrs as Record<string, string>
        if (a[1] in attrs) throw new XmlError(`<${node.name}> names the attribute ${a[1]} twice`, p)
        attrs[a[1]] = decode(a[2] ?? a[3], p)
        p += a[0].length
      }
      SPACE.lastIndex = p
      p += SPACE.exec(text)![0].length
      let selfClosing = false
      if (text.charCodeAt(p) === 0x2F) { selfClosing = true; p++ }
      if (text.charCodeAt(p) !== 0x3E) throw new XmlError(`the start tag <${node.name}> isn't well-formed`, i)
      p++

      if (stack.length === 0) {
        if (root) throw new XmlError('a second root element', i)
        root = node
      } else {
        stack[stack.length - 1].children.push(node)
      }
      if (selfClosing) {
        closeElement(node, i, p)
      } else {
        if (stack.length >= MAX_DEPTH) throw new XmlError(`elements nested more than ${MAX_DEPTH} deep`, i)
        stack.push(node)
        starts.push(i)
      }
      i = p
    }
  }

  if (stack.length > 0) throw new XmlError(`<${stack[stack.length - 1].name}> is never closed`, n)
  if (!root) throw new XmlError('no root element')
  return { root, spans }
}
