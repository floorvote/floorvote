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

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import { color, radius, fontSize as fontSizeToken, fontWeight } from '../styles/tokens'
import { sanitizeHtml } from '../lib/sanitizeHtml'
import { isHtml, htmlToMarkdown, normalizeInlineBullets, normalizeListIndent, separateBlocks, stripMarkdown } from '../lib/markdown'
import { linkClaimsInHtml } from '../lib/claimLinks'
import { claimGlow } from '../lib/claimGlow'

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
   * #572, or an HTML claim's passage, #696) previews it on hover and on keyboard
   * focus, in a card portaled to the body so the summary box can't clip it, and
   * the link is described by it for a screen reader. Escape dismisses it.
   */
  claimLinks?: readonly { index: number; claim: string; popover?: string }[]
  /**
   * Called with a claim's index, and its link, when the link is activated by
   * click or Enter. The link is where focus returns when what it opened closes.
   */
  onClaimActivate?: (index: number, link: HTMLElement) => void
}

type Preview = { link: HTMLElement; text: string }

/** Where a preview goes: centered above its claim, or below when there's no room, kept inside the viewport. A phone gets a card at the bottom. */
type Place = { left: number; top: number } | 'bottom'

/** The hover and focus preview of a claim's quote: portaled to the body, so no ancestor's overflow can clip it. */
function QuotePreview({ preview }: { preview: Preview }) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<Place | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.innerWidth <= 600) { setPlace('bottom'); return }
    const { width, height } = el.getBoundingClientRect()
    const r = preview.link.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8))
    const above = r.top - height - 10
    setPlace({ left, top: above >= 8 ? above : r.bottom + 10 })
  }, [preview])
  const box: React.CSSProperties = place === 'bottom'
    ? { left: 16, right: 16, bottom: 16, top: 'auto', width: 'auto', maxWidth: 'none' }
    : { left: place?.left ?? 0, top: place?.top ?? 0, width: 'max-content', maxWidth: 'min(26rem, calc(100vw - 16px))' }
  // The quote is the link's accessible description already (the hidden `.claim-quote` beside it), so this copy is for sight only.
  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      data-claim-preview=""
      style={{
        ...claimGlow, ...box, position: 'fixed', zIndex: 9000, pointerEvents: 'none', visibility: place ? 'visible' : 'hidden',
        borderRadius: radius.md, padding: '8px 12px', fontSize: fontSizeToken.sm, lineHeight: 1.45, color: color.textSlate,
        fontFamily: "'Source Serif 4', serif", fontWeight: fontWeight.normal, fontStyle: 'normal', textAlign: 'left',
      }}
    >
      <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: fontSizeToken.xs, fontWeight: fontWeight.semibold, letterSpacing: '0.06em', textTransform: 'uppercase', color: color.textMuted, marginBottom: 3 }}>
        From the bill text
      </div>
      {/* A long quote is cut at eight lines on screen; a screen reader gets all of it. */}
      <div data-claim-preview-text="" style={{ overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 8 }}>{preview.text}</div>
    </div>,
    document.body,
  )
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
      onClaimActivate(Number(link.getAttribute('data-claim')), link as HTMLElement)
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [onClaimActivate])

  // The quote preview (#572, #696): shown on hover and keyboard focus, dismissed
  // with Escape (WCAG 1.4.13), and shown again once the pointer or focus has left
  // the claim. The links are in the HTML string, so these are listeners on the box.
  const [preview, setPreview] = useState<Preview | null>(null)
  const previewRef = useRef<Preview | null>(null)
  previewRef.current = preview
  useEffect(() => {
    const el = ref.current
    if (!el || !hasQuotes) return
    let dismissed: Element | null = null
    const refOf = (n: EventTarget | null) => (n instanceof Element ? n.closest('.claim-ref') : null)
    const show = (target: EventTarget | null) => {
      const r = refOf(target)
      if (!r || !el.contains(r) || r === dismissed) return
      const link = r.querySelector('a.claim-link') as HTMLElement | null
      const text = r.querySelector('.claim-quote')?.textContent
      if (link && text) setPreview(prev => (prev?.link === link ? prev : { link, text }))
    }
    const leave = (e: MouseEvent | FocusEvent) => {
      const r = refOf(e.target)
      if (!r || r.contains(e.relatedTarget as Node | null)) return
      if (r === dismissed) dismissed = null
      setPreview(prev => (prev && r.contains(prev.link) ? null : prev))
    }
    // Where the device can't hover, a hover that reveals content would hold iOS's first tap, so only focus shows it.
    const onOver = (e: MouseEvent) => { if (typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover)').matches) show(e.target) }
    const onFocusIn = (e: FocusEvent) => show(e.target)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const open = previewRef.current
      if (!open) return
      dismissed = refOf(open.link)
      setPreview(null)
    }
    const hide = () => setPreview(null)
    el.addEventListener('mouseover', onOver)
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('mouseout', leave)
    el.addEventListener('focusout', leave)
    document.addEventListener('keydown', onKeyDown)
    // A card fixed to the viewport would float off its claim, so it goes when the page moves.
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      el.removeEventListener('mouseover', onOver)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('mouseout', leave)
      el.removeEventListener('focusout', leave)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      setPreview(null)
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
            color: inherit; cursor: pointer; border-radius: ${radius.xs}px;
            text-decoration: underline; text-decoration-color: ${color.claimUnderlineRest};
            text-decoration-thickness: 1px; text-underline-offset: 3px;
            transition: text-decoration-color 120ms, background-color 120ms;
          }
          .markdown-summary a.claim-link:hover,
          .markdown-summary a.claim-link:focus-visible {
            text-decoration-thickness: 2px; text-decoration-color: ${color.claimUnderline}; background: ${color.claimHoverBg};
          }
          .markdown-summary a.claim-link:focus-visible { outline: 2px solid ${color.focusRing}; outline-offset: 2px; }
          @media (prefers-reduced-motion: reduce) {
            .markdown-summary a.claim-link[data-claim] { transition: none; }
          }
        `}</style>
      )}
      {hasQuotes && (
        <style>{`
          .markdown-summary .claim-ref { position: relative; }
          /* The quote stays in the document, off screen, as the link's description for a screen reader. Sighted readers get the preview card. */
          .markdown-summary .claim-quote {
            position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
            clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
          }
        `}</style>
      )}
      {preview && <QuotePreview preview={preview} />}
      <div
        ref={ref}
        className="markdown-summary"
        style={{ fontSize, color: textColor, lineHeight, fontFamily }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  )
}
