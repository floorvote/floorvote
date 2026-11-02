import { abridgeSummary, parseSummaryBlocks } from '../../../shared/markdown'
import { color, fontSize, fontWeight } from '../../../shared/tokens'
import { escHtml } from './escHtml'

/**
 * The summary an email bill card shows: AI output, abridged and rendered as a
 * short list. Escape by construction: the only way text reaches the output is
 * through esc(), and every tag is written here, so no markup in a summary can
 * come through. Only p, ul, ol, li, strong, em, and the "Full summary" link
 * are ever produced. (The web's renderer is `marked` plus a sanitizer; the api
 * has neither, and shared/markdown.ts takes no dependencies.)
 */

const esc = escHtml

// Inline styles, because Gmail and Outlook drop <style>. Top-level blocks keep a
// 6px gap (trimmed from the last one); a nested list sits flush in its item.
const P_STYLE = 'margin:0 0 6px 0;'
const TOP_LIST_STYLE = 'margin:0 0 6px 18px;padding:0;'
const NESTED_LIST_STYLE = 'margin:0 0 0 18px;padding:0;'
const LI_STYLE = 'margin:2px 0;'
const LAST_P_STYLE = 'margin:0;'
const LAST_TOP_LIST_STYLE = 'margin:0 0 0 18px;padding:0;'

// **bold**, __bold__, *em*, _em_. A marker opens only before a non-space and
// closes only after one, and an underscore never opens inside a word
// (snake_case stays text), so a stray marker is left as literal text.
const INLINE = /\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|\*(?!\*)(?=\S)(.+?)(?<=[^\s*])\*(?!\*)|(?<![A-Za-z0-9_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![A-Za-z0-9_])/g

function renderInline(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index))
    const bold = m[1] ?? m[2]
    out += bold !== undefined
      ? `<strong style="font-weight:${fontWeight.bold};">${renderInline(bold)}</strong>`
      : `<em style="font-style:italic;">${renderInline(m[3] ?? m[4])}</em>`
    last = m.index! + m[0].length
  }
  return out + esc(text.slice(last))
}

/**
 * Render normalized summary markdown (paragraphs, `-`/`1.` items nested by two
 * spaces) as inline-styled HTML. Every piece of text is escaped.
 */
export function renderSummaryHtml(md: string): string {
  let html = ''
  let lastTopStart = 0   // where the last top-level block's opening tag begins
  const open: boolean[] = []   // for each open list, whether it is ordered
  const tag = (ordered: boolean) => (ordered ? 'ol' : 'ul')
  const closeLists = (keep: number) => {
    while (open.length > keep) html += `</li></${tag(open.pop()!)}>`
  }
  const openList = (ordered: boolean, depth: number) => {
    if (depth === 0) lastTopStart = html.length
    html += `<${tag(ordered)} style="${depth ? NESTED_LIST_STYLE : TOP_LIST_STYLE}">`
  }
  for (const { text, item } of parseSummaryBlocks(md)) {
    if (!item) {
      closeLists(0)
      lastTopStart = html.length
      html += `<p style="${P_STYLE}">${renderInline(text)}</p>`
      continue
    }
    // An item can go at most one level deeper than the list before it.
    const depth = Math.min(item.depth, open.length)
    const ordered = item.marker !== '-'
    closeLists(depth + 1)
    if (open.length === depth + 1) {
      html += '</li>'
      if (open[depth] !== ordered) {
        html += `</${tag(open[depth])}>`
        open[depth] = ordered
        openList(ordered, depth)
      }
    } else {
      open.push(ordered)
      openList(ordered, depth)
    }
    html += `<li style="${LI_STYLE}">${renderInline(text)}`
  }
  closeLists(0)
  // The card's own padding closes the summary: no gap under the last block. The
  // block's opening tag starts at lastTopStart, so its style is the first match in the tail.
  const tail = html.slice(lastTopStart)
  const [from, to] = tail.startsWith('<p ') ? [P_STYLE, LAST_P_STYLE] : [TOP_LIST_STYLE, LAST_TOP_LIST_STYLE]
  return html.slice(0, lastTopStart) + tail.replace(from, to)
}

/**
 * A bill card's summary row content: the abridged summary, then (only when
 * something was left out) a "Full summary on FloorVote →" link to the bill.
 * An empty summary gives ''.
 */
export function renderEmailSummary(raw: string | null | undefined, billHref: string): string {
  const { md, cut } = abridgeSummary(raw)
  if (!md) return ''
  const link = cut
    ? `<p style="margin:6px 0 0 0;font-family:system-ui,sans-serif;font-size:${fontSize.sm}px;"><a href="${esc(billHref)}" style="color:${color.linkBlue};text-decoration:none;font-weight:${fontWeight.semibold};">Full summary on FloorVote →</a></p>`
    : ''
  return renderSummaryHtml(md) + link
}
