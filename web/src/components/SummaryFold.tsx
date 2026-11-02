import type { CSSProperties } from 'react'
import { Fold } from './Fold'
import { MarkdownSummary } from './MarkdownSummary'

// The last block's bottom edge is where the preview should end. A trailing margin on it
// (the last list item's 2px, a loose item's paragraph) would count toward scrollHeight, so a
// summary that fits exactly would grow a toggle and a fade. Zeroed only along the chain that
// ends the content; spacing between items is untouched.
const TRAILING_MARGINS = `
  .summary-fold .markdown-summary > :last-child { margin-bottom: 0; }
  .summary-fold .markdown-summary > :last-child li:last-child { margin-bottom: 0; }
  .summary-fold .markdown-summary > :last-child li:last-child > :last-child { margin-bottom: 0; }
`

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
      {/* After the renderer's own sheet, so it wins on order as well as on specificity. */}
      <style>{TRAILING_MARGINS}</style>
    </>
  )
}
