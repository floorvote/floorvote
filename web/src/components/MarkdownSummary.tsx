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

import React, { useEffect, useId, useMemo, useRef } from 'react'
import { marked } from 'marked'
import { color, radius } from '../styles/tokens'
import { sanitizeHtml } from '../lib/sanitizeHtml'
import { isHtml, htmlToMarkdown, normalizeInlineBullets, normalizeListIndent, separateBlocks, stripMarkdown } from '../lib/markdown'
import { linkClaimsInHtml } from '../lib/claimLinks'

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
  /**
   * Claims whose own text becomes a link to the passage behind it (#571), by
   * their index in the bill's claim sources. None, or absent, renders the
   * summary exactly as before. A claim with a `popover` (a PDF claim's quote,
   * #572) shows it in a tooltip beside its link, on hover and on keyboard focus,
   * and the link is described by it for a screen reader. Escape dismisses it.
   */
  claimLinks?: readonly { index: number; claim: string; popover?: string }[]
  /** Called with a claim's index when its link is activated, by click or Enter. */
  onClaimActivate?: (index: number) => void
}

export function MarkdownSummary({ children, fontSize, color: textColor = color.textSlate, lineHeight = 1.5, fontFamily = "'Source Serif 4', serif", claimLinks, onClaimActivate }: Props) {
  const sanitized = useMemo(() => {
    const raw = children.trim()
    const md = isHtml(raw) ? htmlToMarkdown(raw) : raw
    const parsed = marked.parse(separateBlocks(normalizeListIndent(normalizeInlineBullets(md))), { async: false, gfm: true }) as string
    return sanitizeHtml(parsed, { allowedTags: ALLOWED_TAGS, allowedAttr: ALLOWED_ATTR })
  }, [children])

  // Claims are linked after sanitizing: the links are the page's own elements,
  // made from text, and nothing of the claim becomes markup (lib/claimLinks.ts).
  const claimsKey = JSON.stringify(claimLinks ?? [])
  const quoteIdPrefix = `claim-quote${useId()}`
  const html = useMemo(
    () => linkClaimsInHtml(sanitized, JSON.parse(claimsKey) as { index: number; claim: string; popover?: string }[], quoteIdPrefix),
    [sanitized, claimsKey, quoteIdPrefix],
  )
  const hasClaimLinks = html !== sanitized
  const hasQuotes = hasClaimLinks && (claimLinks ?? []).some(c => c.popover !== undefined)

  // One listener for every claim link, since the links are in the HTML string.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !onClaimActivate) return
    const onClick = (e: MouseEvent) => {
      // The class, not data-claim alone: sanitizing keeps data-* attributes,
      // but not class, so only the page's own claim links have it.
      const link = (e.target as Element | null)?.closest?.('a.claim-link[data-claim]')
      if (!link || !el.contains(link)) return
      e.preventDefault()
      onClaimActivate(Number(link.getAttribute('data-claim')))
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [onClaimActivate])

  // A quote tooltip is dismissed with Escape (WCAG 1.4.13) and shows again once
  // the pointer or focus has left its claim.
  useEffect(() => {
    const el = ref.current
    if (!el || !hasQuotes) return
    const refOf = (n: EventTarget | null) => (n instanceof Element ? n.closest('.claim-ref') : null)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const open = new Set<Element>()
      for (const n of [e.target, document.activeElement]) {
        const r = refOf(n)
        if (r && el.contains(r)) open.add(r)
      }
      for (const r of el.querySelectorAll('.claim-ref')) {
        try { if (r.matches(':hover')) open.add(r) } catch { /* no :hover in this environment */ }
      }
      for (const r of open) r.setAttribute('data-dismissed', '')
    }
    const onLeave = (e: MouseEvent | FocusEvent) => {
      const r = refOf(e.target)
      if (r && !r.contains(e.relatedTarget as Node | null)) r.removeAttribute('data-dismissed')
    }
    document.addEventListener('keydown', onKeyDown)
    el.addEventListener('mouseout', onLeave)
    el.addEventListener('focusout', onLeave)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('mouseout', onLeave)
      el.removeEventListener('focusout', onLeave)
    }
  }, [hasQuotes])

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
      {hasClaimLinks && (
        <style>{`
          .markdown-summary a.claim-link {
            color: inherit; text-decoration: underline; text-decoration-color: ${color.borderStrong};
            text-underline-offset: 2px; cursor: pointer;
          }
          .markdown-summary a.claim-link:hover { color: ${color.linkBlue}; text-decoration-color: currentColor; }
        `}</style>
      )}
      {hasQuotes && (
        <style>{`
          .markdown-summary .claim-ref { position: relative; }
          .markdown-summary .claim-quote {
            display: none; position: absolute; left: 0; top: 100%; z-index: 20;
            width: max-content; max-width: min(26rem, 90vw); padding: 6px 8px;
            border: 1px solid ${color.borderDefault}; border-radius: ${radius.md}px; background: ${color.white};
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); color: ${color.textSlate};
            font-size: 0.875em; font-weight: 400; font-style: normal; line-height: 1.4; text-align: left; white-space: normal;
          }
          /* Hover only where the device can: on iOS a hover that reveals content holds the first tap. */
          @media (hover: hover) {
            .markdown-summary .claim-ref:not([data-dismissed]):hover > .claim-quote { display: block; }
          }
          .markdown-summary .claim-ref:not([data-dismissed]):focus-within > .claim-quote { display: block; }
          @media (max-width: 600px) {
            .markdown-summary .claim-quote { position: fixed; left: 16px; right: 16px; bottom: 16px; top: auto; width: auto; max-width: none; }
          }
        `}</style>
      )}
      <div
        ref={ref}
        className="markdown-summary"
        style={{ fontSize, color: textColor, lineHeight, fontFamily }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  )
}
