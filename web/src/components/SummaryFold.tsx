import type { CSSProperties } from 'react'
import { Fold } from './Fold'
import { MarkdownSummary } from './MarkdownSummary'

// The last block's bottom edge is where the preview should end. A trailing margin inside it
// (the last list item's 2px, a loose item's paragraph, a blockquote's last paragraph) would
// count toward scrollHeight, so a summary that fits exactly would grow a toggle and a fade.
// `.markdown-summary > *` already zeroes the blocks themselves, so these walk only the chain
// that ends the content, with child combinators: the last item of a list that is the last
// block, then the last item of a list that ends that item, and so on (four deep is far past
// any summary). Spacing between items, and lists that are not last, are untouched.
const ROOT = '.summary-fold .markdown-summary > '
const trailing: string[] = [`${ROOT}blockquote:last-child > :last-child`]
let chain = ROOT
for (let depth = 0; depth < 4; depth++) {
  chain += ':is(ul, ol):last-child > li:last-child'
  trailing.push(chain, `${chain} > p:last-child`)
  chain += ' > '
}
const TRAILING_MARGINS = `${trailing.join(',\n')} { margin-bottom: 0; }`

/**
 * A bill summary as a folded preview: rendered by the same markdown renderer the bill page
 * uses (so a lead plus a list reads as a lead plus a list), clipped to `lines` lines of its
 * own line height with a fade where it is cut off, and unfolded in place by the shared
 * "Show more" toggle. The surface keeps its own font, size, and color.
 */
export function SummaryFold({ markdown, lines, lineHeight, fontSize, fontFamily, color, wrapperStyle }: {
  markdown: string | null | undefined
  lines: number
  lineHeight: number
  fontSize?: number | string
  fontFamily?: string
  color?: string
  /** Spacing around the fold. Not on the clipped content, where it would jump the height. */
  wrapperStyle?: CSSProperties
}) {
  if (!markdown || !markdown.trim()) return null
  // em, so it follows the content's own font size; rounded off float noise (3 × 1.45).
  const maxHeight = `calc(${Number((lines * lineHeight).toFixed(3))}em)`
  return (
    <>
      <Fold
        className="summary-fold"
        collapsed={{ maxHeight, fade: true }}
        style={{ fontSize, lineHeight, fontFamily, color }}
        wrapperStyle={wrapperStyle}
      >
        <MarkdownSummary fontSize="inherit" lineHeight="inherit" fontFamily="inherit" color="inherit">{markdown}</MarkdownSummary>
      </Fold>
      {/* One sheet for every fold on the page (React hoists and dedupes it by href); the selectors beat the renderer's on specificity, so order doesn't matter. */}
      <style href="summary-fold" precedence="default">{TRAILING_MARGINS}</style>
    </>
  )
}
