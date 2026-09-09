/**
 * Renderer for AI-generated bill summaries and plain-markdown comments.
 *
 * Parsing is marked (GFM); DOMPurify sanitizes the result. Both were already
 * dependencies — marked for the legal pages, DOMPurify for comment HTML — so
 * this consolidates on the parser the app already ships rather than adding one.
 *
 * What this file still owns is the part a CommonMark parser cannot do: making
 * model output *be* markdown in the first place. Gemini returns bullets glued
 * inline behind a "•", sometimes returns HTML instead of markdown, and writes
 * one block per line with no blank lines between them. isHtml/htmlToMarkdown,
 * normalizeInlineBullets and separateBlocks handle those three; everything
 * after them is ordinary markdown and is treated as such.
 */

import React, { useMemo } from 'react'
import { marked } from 'marked'
import { color, radius } from '../styles/tokens'
import { sanitizeHtml } from '../lib/sanitizeHtml'
import { isHtml, htmlToMarkdown, normalizeInlineBullets, normalizeListIndent, separateBlocks, stripMarkdown } from '../lib/markdown'

// Re-exported for existing importers (BillList, BillHoverTooltip).
export { stripMarkdown }

// Summaries are model output, not operator input, so the allowlist is only what
// a summary legitimately needs. Anything else is dropped rather than escaped.
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel']

interface Props {
  children: string
  fontSize?: number | string
  color?: string
  lineHeight?: number | string
  fontFamily?: string
}

export function MarkdownSummary({ children, fontSize, color: textColor = color.textSlate, lineHeight = 1.5, fontFamily = "'Source Serif 4', serif" }: Props) {
  const html = useMemo(() => {
    const raw = children.trim()
    const md = isHtml(raw) ? htmlToMarkdown(raw) : raw
    const parsed = marked.parse(separateBlocks(normalizeListIndent(normalizeInlineBullets(md))), { async: false, gfm: true }) as string
    return sanitizeHtml(parsed, { allowedTags: ALLOWED_TAGS, allowedAttr: ALLOWED_ATTR })
  }, [children])

  return (
    <>
      {/* Block spacing and list indentation match what the previous element-based
          renderer applied inline; scoping by class is how CommentContent already
          styles its sanitized HTML. The class sits on the element that HOSTS the
          markup, so `> *` selects the rendered blocks rather than a wrapper. */}
      <style>{`
        .markdown-summary { display: flex; flex-direction: column; gap: 6px; }
        .markdown-summary > * { margin: 0; }
        .markdown-summary ul, .markdown-summary ol { margin: 0 0 0 18px; padding: 0; }
        .markdown-summary li { margin: 2px 0; }
        .markdown-summary li > ul, .markdown-summary li > ol { margin-top: 2px; }
        .markdown-summary code {
          font-family: monospace; font-size: 0.9em;
          background: ${color.surfaceMuted}; border-radius: ${radius.sm}px; padding: 1px 4px;
        }
        .markdown-summary table { border-collapse: collapse; }
        .markdown-summary th, .markdown-summary td { border: 1px solid ${color.borderDefault}; padding: 2px 6px; text-align: left; }
      `}</style>
      <div
        className="markdown-summary"
        style={{ fontSize, color: textColor, lineHeight, fontFamily }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  )
}
