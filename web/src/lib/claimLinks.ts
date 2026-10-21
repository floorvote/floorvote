import { billHtmlToText, KEEP_TAG } from '../../../shared/billHtmlToText'
import { stripMarkdown } from './markdown'
import { color as lightColor } from '../../../shared/tokens'
import { describePageTarget, pdfPageTarget } from './pdfPages'

// Claim links on an HTML bill (#571, design in #560). A claim in the AI summary
// links to the passage behind it, which opens in the bill text panel,
// highlighted.
//
// The panel shows the bill's HTML in a `sandbox=""` frame: no scripts, an
// opaque origin, no forms, popups, or top navigation, and nothing the page can
// reach into. The highlight is put into the document before it renders
// (`markPassage`), and the frame is loaded at the highlight's fragment, so the
// browser scrolls to it and the sandbox stays as it was. The page never adds a
// permission to the frame and never runs anything in it.
//
// Both halves work on text and add only their own fixed elements. A claim or a
// passage is matched as characters and never parsed as markup, so model output
// and stored offsets can't inject anything into the summary or the document.

/** A half-open character range `[start, end)`. */
export type Span = { start: number; end: number }

export type ClaimSourceStatus = 'exact' | 'normalized' | 'fuzzy' | 'anchored' | 'ungrounded' | 'unverified'

/** One claim source as the bill detail carries it: the claim, how its quote resolved, and where. */
export type ClaimSourceItem = {
  claim: string
  status: ClaimSourceStatus
  quoteAt?: Span
  matched?: string
  /** A PDF item's quote and cited page (#572), as the model gave them. The page is null when it gave none. */
  quote?: string
  page?: number | null
}

/** The document claim sources are pinned to, as the bill's text list has it. */
export type ClaimDocument = { docId: string; type: string; date: string; mime: string; stateLink: string | null; altStateLink: string | null }

/**
 * The bill detail's `claimSources`: those of the analysis the page shows. On a
 * companion group's page `billId` can be another member, whose document the
 * links open.
 */
export type ClaimSourcesDetail = { billId: string; document: ClaimDocument; items: ClaimSourceItem[] }

/**
 * An HTML claim that renders as a link, with the passage it opens. `index` is
 * its first item's place in the items. A claim with several items (#802) is
 * still one link: `rest` holds its other passages, and is absent for one. The `popover` is that passage in quotation marks, which
 * the link previews on hover and focus (#696), as a PDF claim does its quote.
 */
export type PassageLink = { index: number; claim: string; quoteAt: Span; matched: string; popover: string; rest?: Passage[] }

/** One passage of an HTML claim: its `matched` text and where it is. */
export type Passage = { matched: string; quoteAt: Span }

/** One quote of a PDF claim and the page the model cited for it. */
export type PageQuote = { quote: string; page: number | null }

/**
 * A PDF claim that renders as a link (#572): it opens the PDF at `page`, which
 * is null when the model cited none, and shows `quote` beside the link as
 * `popover`. The quote was never matched against the file. A claim with several
 * items (#802) lists the others in `rest`.
 */
export type PageLink = { index: number; claim: string; quote: string; page: number | null; popover: string; rest?: PageQuote[] }

export type ClaimLink = PassageLink | PageLink

/** The id of the highlight the frame scrolls to. */
export const PASSAGE_ID = 'fv-claim-passage'

/** The statuses whose quote was found in the document. `ungrounded` wasn't, and `unverified` is a PDF's, linked by page. */
const LINKED: ReadonlySet<ClaimSourceStatus> = new Set<ClaimSourceStatus>(['exact', 'normalized', 'fuzzy', 'anchored'])

/**
 * The claims that render as links, with the instance's setting on (#570). On an
 * HTML document, the resolved ones with a location, which open a highlighted
 * passage (#571). On a PDF, the `unverified` ones with a quote, which open the
 * cited page and show the quote (#572): the tenant extracts no PDF text, so
 * nothing in a PDF is resolved or highlighted, and a resolved status on a PDF is
 * plain text. An `unverified` item on an HTML document is plain text too.
 */
export function linkableClaims(cs: ClaimSourcesDetail | null | undefined, enabled: boolean | undefined): ClaimLink[] {
  if (enabled === false || !cs) return []
  if (cs.document.mime === 'application/pdf') {
    const links = new Map<string, PageLink>()
    cs.items.forEach((item, index) => {
      if (item.status !== 'unverified' || typeof item.quote !== 'string' || item.quote.trim() === '') return
      const page = typeof item.page === 'number' ? item.page : null
      const have = links.get(item.claim)
      if (have) {
        have.rest = [...(have.rest ?? []), { quote: item.quote, page }]
        have.popover += ` ${pdfPopover(item.quote, page)}`
      } else {
        links.set(item.claim, { index, claim: item.claim, quote: item.quote, page, popover: pdfPopover(item.quote, page) })
      }
    })
    return [...links.values()]
  }
  // A claim with several items is one link, from its first item that was found.
  const links = new Map<string, PassageLink>()
  cs.items.forEach((item, index) => {
    if (!LINKED.has(item.status) || !item.quoteAt || typeof item.matched !== 'string' || item.matched.trim() === '') return
    // An anchored item's `matched` is only the anchor: the preview shows the model's whole quote (#802).
    const shown = item.status === 'anchored' && typeof item.quote === 'string' && item.quote.trim() !== '' ? item.quote : item.matched
    const have = links.get(item.claim)
    if (have) {
      have.rest = [...(have.rest ?? []), { matched: item.matched, quoteAt: item.quoteAt }]
      have.popover += ` \u2026 \u201c${shown}\u201d`
    } else {
      links.set(item.claim, { index, claim: item.claim, quoteAt: item.quoteAt, matched: item.matched, popover: `\u201c${shown}\u201d` })
    }
  })
  return [...links.values()]
}

const pdfPopover = (quote: string, page: number | null) => `${describePageTarget(pdfPageTarget(page))}: \u201c${quote}\u201d`

// ── Linking claims in the summary ────────────────────────────────────────────

/** Elements a claim stays inside: one paragraph, list item, heading, or cell. */
const BLOCK = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'BLOCKQUOTE', 'PRE', 'DD', 'DT'])
const BLOCK_SELECTOR = [...BLOCK].map(t => t.toLowerCase()).join(',') + ',ul,ol,table,hr,br'

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The summary's HTML with each claim's own text made a link, or the HTML as it
 * was when no claim is found. A claim is found in one block's rendered text,
 * with whitespace collapsed, as copied or with its markdown syntax removed
 * (a list item copied with its `**Label:**`). The first place it can be linked
 * wins. A claim is never linked inside a link (the summary's own, or another
 * claim's), so links never nest, and never across blocks.
 *
 * Each link is an `<a href>` so it's reachable from the keyboard and activates
 * with Enter. It carries a fixed href, a class, and its claim's index, nothing
 * taken from the claim.
 *
 * A claim with a `popover` (a PDF's quote, #572, or an HTML claim's passage,
 * #696) is wrapped with it:
 * `span.claim-ref` holds the link and a `span.claim-quote` tooltip, and the link
 * is described by the tooltip's id (`idPrefix` and the index), so a screen reader
 * announces the quote on focus. The quote is set as text only, and its text is
 * never searched for a later claim.
 */
export function linkClaimsInHtml(
  html: string,
  claims: readonly { index: number; claim: string; popover?: string }[],
  idPrefix = 'claim-quote',
): string {
  if (claims.length === 0) return html
  // A template's content is inert: nothing in it loads or runs.
  const template = document.createElement('template')
  template.innerHTML = html
  let changed = false
  for (const c of claims) {
    if (linkOne(template.content, c, idPrefix)) changed = true
  }
  return changed ? template.innerHTML : html
}

function closestBlock(node: Node, root: Node): Node {
  for (let n = node.parentNode; n && n !== root; n = n.parentNode) {
    if (n.nodeType === Node.ELEMENT_NODE && BLOCK.has((n as Element).tagName)) return n
  }
  return root
}

function insideLink(node: Node, root: Node): boolean {
  for (let n = node.parentNode; n && n !== root; n = n.parentNode) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'A') return true
  }
  return false
}

/** Whether a node is inside a claim's quote tooltip, which is not the summary's text. */
function insideQuote(node: Node, root: Node): boolean {
  for (let n = node.parentNode; n && n !== root; n = n.parentNode) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).classList.contains('claim-quote')) return true
  }
  return false
}

/** Each block's text nodes, in document order, leaving out a quote tooltip's. */
function textByBlock(root: DocumentFragment): Text[][] {
  const groups = new Map<Node, Text[]>()
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (insideQuote(n, root)) continue
    const block = closestBlock(n, root)
    const g = groups.get(block)
    if (g) g.push(n as Text)
    else groups.set(block, [n as Text])
  }
  return [...groups.values()]
}

/** A block's text with whitespace collapsed, and where each character came from. */
function streamOf(nodes: Text[]): { s: string; at: { node: Text; offset: number }[] } {
  const out: string[] = []
  const at: { node: Text; offset: number }[] = []
  for (const node of nodes) {
    const data = node.data
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i])) {
        if (out.length > 0 && out[out.length - 1] !== ' ') { out.push(' '); at.push({ node, offset: i }) }
        continue
      }
      out.push(data[i])
      at.push({ node, offset: i })
    }
  }
  return { s: out.join(''), at }
}

function linkOne(root: DocumentFragment, { index, claim, popover }: { index: number; claim: string; popover?: string }, idPrefix: string): boolean {
  const needles = [...new Set([collapse(claim), collapse(stripMarkdown(claim))])].filter(n => n.length > 0)
  if (needles.length === 0) return false
  const doc = root.ownerDocument
  for (const nodes of textByBlock(root)) {
    const { s, at } = streamOf(nodes)
    for (const needle of needles) {
      for (let from = s.indexOf(needle); from !== -1; from = s.indexOf(needle, from + 1)) {
        const first = at[from]
        const last = at[from + needle.length - 1]
        const range = doc.createRange()
        range.setStart(first.node, first.offset)
        range.setEnd(last.node, last.offset + 1)
        if (!linkable(range, nodes, root)) continue
        const a = doc.createElement('a')
        a.setAttribute('href', `#${PASSAGE_ID}`)
        a.setAttribute('class', 'claim-link')
        a.setAttribute('data-claim', String(index))
        a.appendChild(range.extractContents())
        if (popover === undefined) {
          range.insertNode(a)
          return true
        }
        const tipId = `${idPrefix}-${index}`
        a.setAttribute('aria-describedby', tipId)
        const tip = doc.createElement('span')
        tip.setAttribute('class', 'claim-quote')
        tip.setAttribute('id', tipId)
        tip.setAttribute('role', 'tooltip')
        tip.textContent = popover
        const ref = doc.createElement('span')
        ref.setAttribute('class', 'claim-ref')
        ref.append(a, tip)
        range.insertNode(ref)
        return true
      }
    }
  }
  return false
}

/** Whether a range can be a link: no part of it in a link, and no block or link inside it. */
function linkable(range: Range, nodes: Text[], root: Node): boolean {
  for (const node of nodes) {
    if (range.intersectsNode(node) && insideLink(node, root)) return false
  }
  return range.cloneContents().querySelector(`a,${BLOCK_SELECTOR}`) === null
}

// ── Marking the passage in the bill's document ────────────────────────────────

/** Elements whose text the document doesn't render, or where a highlight can't go. */
const UNMARKABLE = new Set(['HEAD', 'TITLE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP', 'SVG', 'MATH', 'TEMPLATE', 'IFRAME', 'NOEMBED', 'NOFRAMES', 'XMP', 'PLAINTEXT'])
/** Parents a highlight around whitespace would be moved out of when the document is parsed again. */
const TABLE_PARENTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP'])

// The frame can't use the app's colors as the web has them. They are
// `var(--fv-...)` references, and the frame defines none, so each would compute
// to nothing. The frame also shows a light page in both of the app's modes: a
// bill's document has its own (default) color scheme, which differs from the
// app's in dark mode, so the browser paints it on an opaque white canvas with
// black text (checked in Chromium). So the style carries the light palette's
// literal values, which read on that page, whichever mode the app is in. The
// text color is set too, so the passage is legible even on a bill that sets its
// own colors.
//
/**
 * The passage's colors in the frame: the light palette's values, which read on
 * the light page the frame always shows. They are not tokens, since the app's
 * color mode never changes them. Text on the fill is checked in tokens.test.ts.
 */
export const PASSAGE_FRAME = {
  fill: lightColor.borderAmber,
  text: lightColor.textPrimary,
  line: lightColor.claimUnderline,
  ring: lightColor.focusRing,
} as const

// `!important`, so the bill's own CSS can't hide the highlight or its focus ring.
const PASSAGE_CSS = `mark[data-fv-passage]{background:${PASSAGE_FRAME.fill} !important;color:${PASSAGE_FRAME.text} !important;`
  + `box-shadow:inset 0 -2px 0 ${PASSAGE_FRAME.line} !important}`
  + `#${PASSAGE_ID}{scroll-margin-top:40px !important}`
  // The ring is drawn inside the mark (a negative offset). A ring outside it was cut off by the frame's edge
  // wherever the bill's text runs to that edge, as it does on the right (#696).
  // Only :focus-visible, so a keyboard reader sees the ring and a mouse reader doesn't (#802).
  + `#${PASSAGE_ID}:focus-visible{outline:2px solid ${PASSAGE_FRAME.ring} !important;outline-offset:-2px}`

const ENTITY = /&[A-Za-z][A-Za-z0-9]{0,31};/g
const ENTITY_CACHE = new Map<string, string>()

/**
 * A named entity's character. `billHtmlToText` decodes only a few entities and
 * leaves the rest as written, while the rendered document decodes them all.
 * The token matches `ENTITY`, so it has no markup in it.
 */
function decodeEntity(token: string): string {
  let ch = ENTITY_CACHE.get(token)
  if (ch === undefined) {
    ch = new DOMParser().parseFromString(`<!DOCTYPE html><body>${token}`, 'text/html').body.textContent ?? token
    ENTITY_CACHE.set(token, ch)
  }
  return ch
}

/**
 * Text as the matcher compares it: without the retained redline markup the
 * instance's text keeps, with entities decoded, and with no whitespace at all,
 * since the instance's text and the rendered document break lines and space
 * inline markup differently.
 */
function squash(text: string): string {
  return text
    .replace(/<[^>]{0,300}>/g, tag => (KEEP_TAG.test(tag) ? '' : tag))
    .replace(ENTITY, decodeEntity)
    .replace(/\s+/g, '')
}

function insideMark(node: Node): boolean {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).hasAttribute('data-fv-passage')) return true
  }
  return false
}

function unmarkable(node: Node): boolean {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.nodeType === Node.ELEMENT_NODE && UNMARKABLE.has((n as Element).tagName.toUpperCase())) return true
  }
  return false
}

/**
 * How many times the passage occurs before its stored location, in the text
 * the model read, so a passage that repeats is found where it was. Zero when
 * the location is unusable, which is the first occurrence.
 */
function occurrenceBefore(html: string, needle: string, quoteAt: Span): number {
  const { start } = quoteAt
  if (!Number.isInteger(start) || start <= 0) return 0
  const text = billHtmlToText(html)
  if (start > text.length) return 0
  const before = squash(text.slice(0, start)).length
  const full = squash(text)
  let k = 0
  for (let i = full.indexOf(needle); i !== -1 && i < before; i = full.indexOf(needle, i + 1)) k++
  return k
}

const quoted = (id: string) => (id.includes('"') ? `'${id}'` : `"${id}"`)

function doctypeOf(doc: Document): string {
  const dt = doc.doctype
  if (!dt) return ''
  if (dt.publicId) return `<!DOCTYPE ${dt.name} PUBLIC ${quoted(dt.publicId)}${dt.systemId ? ` ${quoted(dt.systemId)}` : ''}>`
  if (dt.systemId) return `<!DOCTYPE ${dt.name} SYSTEM ${quoted(dt.systemId)}>`
  return `<!DOCTYPE ${dt.name}>`
}

/**
 * The bill's document with the passage highlighted, for the sandboxed frame,
 * or null when the passage isn't in it (the document changed, or nothing was
 * stored to find).
 *
 * A claim can have several passages (#802): each is marked, the first one found
 * carries the id below, and one that isn't found is skipped. Null only when none is.
 *
 * Each passage is the stored `matched` text, found in the rendered document's
 * text with whitespace ignored. Where it occurs more than once, the stored
 * location (offsets into `billHtmlToText` of the document) says which. The
 * highlight is one `<mark>` around each text node's part of the passage, and
 * the first carries `PASSAGE_ID`, which no other element in the document is
 * left with, and a fixed `tabindex="-1"`: loading the frame at that fragment
 * runs the browser's focusing steps on it, so focus lands on the passage
 * itself once the page focuses the frame. A style for the marks goes in the head. Nothing else changes:
 * the document is parsed inertly (`DOMParser` runs nothing and loads nothing)
 * and serialized back with its doctype, script and all, for the sandbox to
 * keep inert as it does the plain text.
 */
export function markPassage(html: string, passage: Passage | readonly Passage[]): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // The scroll target is the highlight's alone.
  for (const el of doc.querySelectorAll(`[id="${PASSAGE_ID}"]`)) el.removeAttribute('id')
  for (const el of doc.querySelectorAll(`a[name="${PASSAGE_ID}"]`)) el.removeAttribute('name')

  // Each passage is marked on its own, found again in the text as the earlier
  // ones left it. The first one found carries the id, whichever item it was.
  let marked = 0
  for (const p of Array.isArray(passage) ? passage : [passage as Passage]) {
    if (markOne(doc, html, p, marked === 0)) marked++
  }
  if (marked === 0) return null

  const style = doc.createElement('style')
  style.setAttribute('data-fv-passage', '')
  style.textContent = PASSAGE_CSS
  doc.head.appendChild(style)

  return doctypeOf(doc) + doc.documentElement.outerHTML
}

/** Highlight one passage in the parsed document, with the scroll target on it when `target`. False when it isn't found. */
function markOne(doc: Document, html: string, passage: Passage, target: boolean): boolean {
  const needle = squash(passage.matched)
  if (needle.length === 0) return false
  // Every text node `billHtmlToText` reads (all but script and style), with
  // where each character of the squashed text came from.
  const nodes: Text[] = []
  const chars: string[] = []
  const nodeAt: number[] = []
  const offsetAt: number[] = []
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentNode as Element | null
    const tag = parent?.tagName?.toUpperCase()
    if (tag === 'SCRIPT' || tag === 'STYLE') continue
    const node = n as Text
    nodes.push(node)
    const data = node.data
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i])) continue
      chars.push(data[i])
      nodeAt.push(nodes.length - 1)
      offsetAt.push(i)
    }
  }
  const text = chars.join('')

  // The occurrence the stored location points to, or the next one a reader
  // can see, or the first one a reader can see.
  const found: number[] = []
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) found.push(i)
  const visible = found.filter(i => !unmarkable(nodes[nodeAt[i]]))
  if (visible.length === 0) return false
  const k = occurrenceBefore(html, needle, passage.quoteAt)
  const at = visible.find(i => i >= (found[k] ?? Infinity)) ?? visible[0]

  const firstNode = nodeAt[at]
  const lastNode = nodeAt[at + needle.length - 1]
  const parts: { node: Text; from: number; to: number }[] = []
  for (let j = firstNode; j <= lastNode; j++) {
    const node = nodes[j]
    const from = j === firstNode ? offsetAt[at] : 0
    const to = j === lastNode ? offsetAt[at + needle.length - 1] + 1 : node.data.length
    if (to <= from || unmarkable(node)) continue
    const parentTag = (node.parentNode as Element | null)?.tagName?.toUpperCase() ?? ''
    if (TABLE_PARENTS.has(parentTag) && node.data.slice(from, to).trim() === '') continue
    parts.push({ node, from, to })
  }
  if (parts.length === 0) return false
  // A passage the claim cites twice is already marked: that is found, and left as it is.
  if (parts.every(({ node }) => insideMark(node))) return true

  parts.forEach(({ node, from, to }, i) => {
    const mid = from > 0 ? node.splitText(from) : node
    if (to - from < mid.data.length) mid.splitText(to - from)
    const mark = doc.createElement('mark')
    mark.setAttribute('data-fv-passage', '')
    if (target && i === 0) {
      mark.setAttribute('id', PASSAGE_ID)
      mark.setAttribute('tabindex', '-1')
    }
    mid.parentNode!.insertBefore(mark, mid)
    mark.appendChild(mid)
  })

  return true
}

/**
 * Move focus to the passage in a frame whose srcdoc is `markPassage`'s
 * document. The srcdoc loads with no fragment, so the page focuses the frame,
 * then goes to the passage's fragment of that same document. That scrolls to
 * the mark and focuses it (its fixed `tabindex="-1"`): Chromium runs the
 * focusing steps for a fragment's target only on a fragment navigation within
 * a loaded document. The page navigates only its own frame, and reads nothing
 * from it: the frame keeps `sandbox=""`. Where that can't be done, focus stays
 * on the frame.
 *
 * Not a blob: URL. A blob: document inherits the app's CSP, and WebKit
 * enforces its `frame-ancestors 'none'` on it, so iOS showed a blank frame.
 */
export function focusPassage(frame: HTMLIFrameElement): void {
  frame.focus()
  try {
    frame.contentWindow?.location.replace(`about:srcdoc#${PASSAGE_ID}`)
  } catch {
    // Focus stays on the frame.
  }
}
