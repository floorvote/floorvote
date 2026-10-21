import { useState, useEffect, useId, useMemo, useRef } from 'react'
import { useVerticalResize, ResizeHandle } from './ResizeHandle'
import { BillBadge } from './BillBadge'
import { BillTextChip } from './BillTextChip'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import { getScrollContainer } from '../lib/scrollUtils'
import { canRenderPdfInline } from '../lib/pdfInline'
import { parseHandle } from '../../../shared/billHandle'
import type { GroupBillTexts } from '../../../shared/companionGroups'
import { orderGroupTexts } from '../lib/groupTexts'
import { claimGlow, CLAIM_GLOW_FLASH } from '../lib/claimGlow'
import { focusPassage, markPassage, scrollToPassage, type ClaimDocument, type PageQuote, type Passage, type Span } from '../lib/claimLinks'
import { describePageTarget, looksLikePdf, pdfPageTarget } from '../lib/pdfPages'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'

function DownloadIcon({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline', verticalAlign: 'middle', marginLeft: 2, ...style }}>
      <path d="M5 20h14v-2H5v2zm14-9h-4V3H9v8H5l7 7 7-7z"/>
    </svg>
  )
}

interface TextVersion {
  docId: string
  type: string
  date: string
  mime: string
  stateLink: string | null
  altStateLink: string | null
}

/**
 * A request to show a claim's passage (#571): the document the claim sources
 * are pinned to, on the bill whose analysis the page shows, and the passage in
 * it. That bill can be another member of the page bill's companion group, whose
 * document then opens beside this bill's own versions. Each request has a new
 * `key`, so asking for the same passage again opens it again.
 */
type RequestBase = { key: number; billId: string; billNumber: string | null; document: ClaimDocument }

/** An HTML claim: the passage to highlight, as the claim's `matched` text and where it is. */
export type HtmlPassageRequest = RequestBase & {
  matched: string
  quoteAt: Span
  /** The claim's other passages (#802), all highlighted with the first. */
  rest?: Passage[]
  quote?: undefined
  page?: undefined
}

/**
 * A PDF claim (#572): the page the model cited (null when it gave none, and
 * anything that isn't a page number opens at page 1) and the quote to show
 * beside the PDF. The quote was never matched, so nothing is highlighted.
 */
export type PdfPageRequest = RequestBase & {
  quote: string
  page: number | null
  /** The claim's other quotes (#802), each listed under its page. */
  rest?: PageQuote[]
  matched?: undefined
  quoteAt?: undefined
  /**
   * The claim link that was activated (#696). The quote box closes by its button
   * or Escape, and focus returns to this link, or to the one with its claim index
   * if the summary has rendered again since.
   */
  opener?: HTMLElement | null
}

export type PassageRequest = HtmlPassageRequest | PdfPageRequest

const isPdfRequest = (r: PassageRequest): r is PdfPageRequest => r.quote !== undefined

/**
 * A request to open another bill's document (#601): the one the summary was
 * based on, when the page shows a companion's analysis. It opens beside this
 * bill's own versions, as a claim's passage does. Each request has a new `key`.
 */
export type DocumentRequest = { key: number; billId: string; billNumber: string | null; document: ClaimDocument }

interface BillTextPanelProps {
  billId: string
  texts: TextVersion[]
  externalOpen?: boolean
  requestedDocId?: string | null
  requestedDocument?: DocumentRequest | null
  passage?: PassageRequest | null
  /**
   * Every bill in the page bill's companion group with its versions (#712). The
   * list is then one row per bill, and a version of any of them is selected in
   * its own row. Absent from a server that predates it, and the list is then
   * `texts`, with another bill's document appended when one is opened.
   */
  groupTexts?: GroupBillTexts[]
  /** Head each bill's row with its badge: the page bill is in a group. */
  groupBadges?: boolean
}

export function BillTextPanel({ billId, texts, externalOpen, requestedDocId, requestedDocument, passage, groupTexts, groupBadges = false }: BillTextPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = externalOpen !== undefined ? externalOpen : internalOpen
  // The group's bills as rows, in the order every page in the group shares (#712); null from a server without them.
  const rows = useMemo(() => (groupTexts ? orderGroupTexts(groupTexts) : null), [groupTexts])
  // The versions the list holds before another bill's document is appended.
  const baseTexts = useMemo(() => (rows ? rows.flatMap(r => r.texts) : texts), [rows, texts])
  const [selectedDocId, setSelectedDocId] = useState<string | null>(
    texts.length > 0 ? texts[0].docId : (baseTexts[0]?.docId ?? null)
  )
  const [loadedContent, setLoadedContent] = useState<Map<string, string>>(new Map())
  const [pdfBlobUrls, setPdfBlobUrls] = useState<Map<string, string>>(new Map())
  const [failedDocIds, setFailedDocIds] = useState<Set<string>>(new Set())
  // PDF documents whose bytes aren't a PDF (an HTML error page under a PDF's key): never put in a frame.
  const [notPdfDocIds, setNotPdfDocIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const blobUrlsRef = useRef<Map<string, string>>(new Map())
  const panelRef = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState(false)
  const pendingRef = useRef<Set<string>>(new Set())
  const consumedPassageRef = useRef<number | null>(null)
  const consumedDocumentRef = useRef<number | null>(null)

  // Another bill's version: the analyzed member's document a claim on a
  // companion's page opens, which is never in this bill's list (#571).
  const [foreign, setForeign] = useState<{ billId: string; billNumber: string | null; version: TextVersion } | null>(null)
  // The claim passage being shown, until the reader picks a version.
  const [activePassage, setActivePassage] = useState<PassageRequest | null>(null)
  const allTexts = foreign && !baseTexts.some(t => t.docId === foreign.version.docId) ? [...baseTexts, foreign.version] : baseTexts
  const textBillId = (docId: string | null) => {
    const listed = rows?.find(r => r.texts.some(t => t.docId === docId))
    if (listed) return listed.billId
    return foreign && docId === foreign.version.docId ? foreign.billId : billId
  }
  const textUrl = (docId: string | null, from = textBillId(docId)) => `/api/bills/${from}/text/${docId}`

  const selectedVersion = allTexts.find(t => t.docId === selectedDocId) ?? allTexts[0] ?? null
  const content = selectedDocId !== null ? (loadedContent.get(selectedDocId) ?? null) : null
  const isPdf = selectedVersion?.mime === 'application/pdf'
  const [inlinePdf] = useState(() => canRenderPdfInline())
  const { height: pdfHeight, handlePointerDown: handlePdfResize } = useVerticalResize(480, 200)
  const { height: htmlHeight, handlePointerDown: handleHtmlResize } = useVerticalResize(320, 200)

  // Revoke all blob URLs on unmount — capture ref value at effect time per react-hooks/exhaustive-deps
  useEffect(() => {
    const blobUrls = blobUrlsRef.current
    return () => { blobUrls.forEach(url => URL.revokeObjectURL(url)) }
  }, [])

  // Load content when panel opens or version changes. A passage request not yet
  // taken up chooses the version itself, so the version shown before it (this
  // bill's newest) isn't fetched on the way.
  useEffect(() => {
    if (!open || selectedDocId === null) return
    if (passage && consumedPassageRef.current !== passage.key) return
    if (requestedDocument && consumedDocumentRef.current !== requestedDocument.key) return
    const version = allTexts.find(t => t.docId === selectedDocId)
    if (!version) return
    if (version.mime === 'application/pdf') {
      if (!blobUrlsRef.current.has(selectedDocId)) loadPdf(selectedDocId)
    } else {
      if (!loadedContent.has(selectedDocId)) loadText(selectedDocId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedDocId])

  // Respond to external requests to focus a particular version (e.g. AI summary reference link).
  // We store the fade-out timer in a ref so it survives the no-op effect re-runs that happen
  // when the parent clears requestedDocId or when texts changes — otherwise the cleanup would
  // tear down the timer before it fires and highlight would stick on.
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current) }, [])
  useEffect(() => {
    if (!requestedDocId) return
    const target = baseTexts.find(t => t.docId === requestedDocId)
    if (!target) return
    void handleSelectVersion(requestedDocId)
    const rafId = reveal()
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedDocId, baseTexts])

  // Another bill's document (#601): open it beside this bill's versions.
  useEffect(() => {
    if (!requestedDocument) return
    consumedDocumentRef.current = requestedDocument.key
    const doc = requestedDocument.document
    // A version the list already holds is selected in its row; only another is appended.
    if (!rows || !baseTexts.some(t => t.docId === doc.docId)) setForeign({ billId: requestedDocument.billId, billNumber: requestedDocument.billNumber, version: doc })
    setActivePassage(null)
    setSelectedDocId(doc.docId)
    if (doc.mime === 'application/pdf') {
      if (!blobUrlsRef.current.has(doc.docId)) void loadPdf(doc.docId, requestedDocument.billId)
    } else if (!loadedContent.has(doc.docId)) {
      void loadText(doc.docId, requestedDocument.billId)
    }
    const rafId = reveal()
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedDocument?.key])

  // A claim's passage (#571): open its document, beside this bill's versions
  // when it is another bill's, and show it highlighted. The frame takes focus
  // when it loads (below).
  useEffect(() => {
    if (!passage) return
    consumedPassageRef.current = passage.key
    const doc = passage.document
    // Without the group's rows the list is this bill's own, so another bill's document is appended to it.
    const own = baseTexts.some(t => t.docId === doc.docId) && (rows !== null || passage.billId === billId)
    if (!own) setForeign({ billId: passage.billId, billNumber: passage.billNumber, version: doc })
    setActivePassage(passage)
    setSelectedDocId(doc.docId)
    if (doc.mime === 'application/pdf') {
      if (!blobUrlsRef.current.has(doc.docId)) void loadPdf(doc.docId, passage.billId)
    } else if (!loadedContent.has(doc.docId)) {
      void loadText(doc.docId, passage.billId)
    }
    const rafId = reveal()
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passage?.key])

  // The highlighted document, for a frame that keeps `sandbox=""`: the mark is
  // put in before it renders, and the frame goes to the mark's fragment once it
  // loads so the browser scrolls to it (scrollToPassage and focusPassage in lib/claimLinks.ts, per frame below).
  // Null when the passage isn't in the document.
  const requestShown = activePassage && activePassage.document.docId === selectedDocId ? activePassage : null
  const passageShown = requestShown && !isPdfRequest(requestShown) ? requestShown : null
  const marked = useMemo(() => (passageShown && content !== null ? markPassage(content, [passageShown, ...(passageShown.rest ?? [])]) : null), [passageShown, content])
  const passageMissing = passageShown !== null && content !== null && marked === null
  // Each passage frame goes to the passage on its first load, since going there
  // loads it again. Focus moves to it once per request, so a frame shown again
  // (Bill texts closed and opened) scrolls without taking focus.
  const sentToPassage = useRef(new WeakSet<HTMLIFrameElement>())
  const focusedKeyRef = useRef<number | null>(null)
  // Where focus was when a frame shown again went to the passage. Chromium
  // focuses a frame that loads at a fragment, so the load that follows puts it back.
  const focusBefore = useRef(new WeakMap<HTMLIFrameElement, Element | null>())

  // A PDF claim (#572): the PDF opens at the cited page, and its quote shows
  // beside it, since the page can't highlight a PDF. Focus moves to the quote,
  // once per request, so a keyboard or screen reader user gets it.
  const pdfRequest = requestShown && isPdfRequest(requestShown) ? requestShown : null
  // The quote whose page the frame shows: the first until the reader picks another's page label (#802).
  const [pickedPage, setPickedPage] = useState<{ key: number; at: number } | null>(null)
  const pdfQuotes: PageQuote[] = pdfRequest ? [{ quote: pdfRequest.quote, page: pdfRequest.page }, ...(pdfRequest.rest ?? [])] : []
  const shownQuote = pdfRequest && pickedPage?.key === pdfRequest.key ? pickedPage.at : 0
  const pdfTarget = pdfRequest ? pdfPageTarget(pdfQuotes[shownQuote]?.page ?? pdfRequest.page) : null
  const pageFragment = pdfTarget ? `#page=${pdfTarget.page}` : ''
  const captionRef = useRef<HTMLDivElement>(null)
  const captionId = `pdf-quote${useId()}`
  const focusedRequestRef = useRef<number | null>(null)
  const pdfRequestKey = pdfRequest?.key ?? null
  // The quote box closes (#696) until the next request, which has a new key and opens it again.
  const [closedQuoteKey, setClosedQuoteKey] = useState<number | null>(null)
  function closeQuote() {
    if (!pdfRequest) return
    setClosedQuoteKey(pdfRequest.key)
    const { opener } = pdfRequest
    // The summary can render again and replace its links, so a detached opener is found again by its claim.
    const index = opener?.getAttribute('data-claim')
    const back = opener?.isConnected ? opener : index != null ? document.querySelector<HTMLElement>(`a.claim-link[data-claim="${index}"]`) : null
    back?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!open || pdfRequestKey === null || focusedRequestRef.current === pdfRequestKey) return
    const caption = captionRef.current
    if (!caption) return
    focusedRequestRef.current = pdfRequestKey
    // The panel is scrolled into view by `reveal`; focus shouldn't jump the page first.
    caption.focus({ preventScroll: true })
  }, [open, pdfRequestKey, selectedDocId])

  /** Bring the panel into view and glow it briefly. Returns the frame request to cancel. */
  function reveal(): number {
    // Defer measure-and-scroll one frame so the panel's expanded layout is committed
    // (the chip click can also flip externalOpen false→true, which resizes the panel).
    const rafId = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (panel) {
        const container = getScrollContainer()
        const rect = panel.getBoundingClientRect()
        const isFullyInView = rect.top >= 0 && rect.bottom <= window.innerHeight
        if (!isFullyInView) {
          const targetY = container.scrollTop + rect.top - 20  // 20px above the panel
          container.scrollTo({ top: targetY, behavior: 'smooth' })
        }
      }
    })

    setHighlight(true)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => {
      setHighlight(false)
      highlightTimerRef.current = null
    }, 1200)
    return rafId
  }

  async function loadPdf(docId: string, from = textBillId(docId)) {
    if (pendingRef.current.has(docId)) return
    pendingRef.current.add(docId)
    setLoading(true)
    try {
      const res = await fetch(textUrl(docId, from), { credentials: 'include' })
      if (!res.ok) {
        setFailedDocIds(prev => new Set(prev).add(docId))
        return
      }
      if (!inlinePdf) {
        // The fallback card links straight to the API; the fetch only checks the text is cached.
        void res.body?.cancel()
        return
      }
      // Never the response's type: the frame can't carry a `sandbox` (Chromium's
      // PDF viewer renders in no sandboxed frame), so an HTML page served under
      // a PDF's key must not become an HTML document of the app's origin. The
      // blob is a PDF or it is not shown at all.
      const bytes = await res.arrayBuffer()
      if (!looksLikePdf(bytes)) {
        setNotPdfDocIds(prev => new Set(prev).add(docId))
        return
      }
      // A later load that is a PDF clears an earlier "not a PDF" (the file was re-ingested).
      setNotPdfDocIds(prev => {
        if (!prev.has(docId)) return prev
        const next = new Set(prev)
        next.delete(docId)
        return next
      })
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      blobUrlsRef.current.set(docId, url)
      setPdfBlobUrls(prev => new Map(prev).set(docId, url))
    } finally {
      pendingRef.current.delete(docId)
      setLoading(false)
    }
  }

  async function loadText(docId: string, from = textBillId(docId)) {
    if (pendingRef.current.has(docId)) return
    pendingRef.current.add(docId)
    setLoading(true)
    try {
      const res = await fetch(textUrl(docId, from), { credentials: 'include' })
      if (!res.ok) {
        setFailedDocIds(prev => new Set(prev).add(docId))
        return
      }
      // response.text() always decodes as UTF-8 per spec, ignoring Content-Type charset.
      // Use arrayBuffer + TextDecoder so non-UTF-8 sources (e.g. windows-1252) render correctly.
      const buf = await res.arrayBuffer()
      const charset = res.headers.get('content-type')?.match(/charset=([^\s;]+)/i)?.[1] ?? 'utf-8'
      const text = new TextDecoder(charset).decode(buf)
      setLoadedContent(prev => new Map(prev).set(docId, text))
    } finally {
      pendingRef.current.delete(docId)
      setLoading(false)
    }
  }

  async function handleOpen() {
    if (!open && selectedDocId !== null) {
      const version = allTexts.find(t => t.docId === selectedDocId)
      if (version?.mime === 'application/pdf') {
        if (!blobUrlsRef.current.has(selectedDocId)) await loadPdf(selectedDocId)
      } else {
        if (!loadedContent.has(selectedDocId)) await loadText(selectedDocId)
      }
    }
    setInternalOpen(s => !s)
  }

  async function handleSelectVersion(docId: string) {
    // Picking a version shows it plain: the highlight was for the passage's request.
    setActivePassage(null)
    setSelectedDocId(docId)
    const version = allTexts.find(t => t.docId === docId)
    if (version?.mime === 'application/pdf') {
      if (!blobUrlsRef.current.has(docId)) await loadPdf(docId)
    } else {
      if (!loadedContent.has(docId)) await loadText(docId)
    }
  }

  if (allTexts.length === 0) {
    return (
      <div>
        {externalOpen === undefined && (
          <button
            onClick={() => setInternalOpen(s => !s)}
            style={{ fontSize: fontSize.sm, color: color.textSlate, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
          >
            Bill text {open ? '▲' : '▼'}
          </button>
        )}
        {open && <p style={{ fontSize: fontSize.sm, color: color.textMuted, marginTop: 8 }}>Bill text not yet available.</p>}
      </div>
    )
  }

  const pdfBlobUrl = selectedDocId !== null ? (pdfBlobUrls.get(selectedDocId) ?? null) : null
  const loadFailed = selectedDocId !== null && failedDocIds.has(selectedDocId)
  const notPdf = selectedDocId !== null && notPdfDocIds.has(selectedDocId)

  // The quote behind a PDF claim, above the PDF, whether or not the PDF loads.
  // It wears the preview's glow, animates in (not under reduced motion), and closes (#696).
  const quoteCaption = pdfRequest && pdfTarget && closedQuoteKey !== pdfRequest.key ? (
    <>
      <style>{`
        @keyframes claim-quote-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); box-shadow: ${CLAIM_GLOW_FLASH}; }
          to { opacity: 1; transform: none; }
        }
        .claim-quote-box { animation: claim-quote-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
        @media (prefers-reduced-motion: reduce) { .claim-quote-box { animation: none; } }
        .claim-quote-close {
          background: none; border: none; cursor: pointer; padding: 2px 8px; border-radius: ${radius.sm}px;
          font-size: ${fontSize.base}px; line-height: 1.2; color: ${color.textSlate500};
        }
        .claim-quote-close:hover { background: ${color.surfaceMuted}; color: ${color.textPrimary}; }
        .claim-quote-close:focus-visible { outline: 2px solid ${color.focusRing}; outline-offset: 1px; }
      `}</style>
      {/* Escape closes from anywhere inside, and focus lands on this group by script, so the group takes the key. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        key={pdfRequest.key}
        ref={captionRef}
        className="claim-quote-box"
        tabIndex={-1}
        role="group"
        aria-label="Quote behind the claim you opened"
        // Focus lands here, and not every screen reader reads a group's contents
        // on focus, so the page line and the quote are its description.
        aria-describedby={pdfQuotes.length === 1 ? `${captionId}-page ${captionId}-quote` : `${captionId}-page`}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeQuote() } }}
        style={{ ...claimGlow, borderRadius: radius.md, padding: '8px 8px 10px 12px', marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {pdfQuotes.length === 1 ? (
            <>
              <p id={`${captionId}-page`} style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textSecondary, margin: 0 }}>{describePageTarget(pdfTarget)}</p>
              <blockquote id={`${captionId}-quote`} style={{ fontSize: fontSize.sm, color: color.textSlate, margin: '4px 0 0' }}>{`“${pdfRequest.quote}”`}</blockquote>
            </>
          ) : (
            // Several quotes (#802): each under its page, whose label moves the frame there.
            <div id={`${captionId}-page`}>
              {pdfQuotes.map((q, i) => {
                const target = pdfPageTarget(q.page)
                return (
                  <div key={i} style={{ marginTop: i === 0 ? 0 : 8 }}>
                    <p style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textSecondary, margin: 0 }}>
                      <a
                        href={`#page=${target.page}`}
                        className="blue-link"
                        aria-current={i === shownQuote ? 'true' : undefined}
                        title={target.fallback ? describePageTarget(target) : undefined}
                        onClick={e => { e.preventDefault(); setPickedPage({ key: pdfRequest.key, at: i }) }}
                      >{`Page ${target.page}`}</a>
                    </p>
                    <blockquote style={{ fontSize: fontSize.sm, color: color.textSlate, margin: '4px 0 0' }}>{`“${q.quote}”`}</blockquote>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <button type="button" className="claim-quote-close" aria-label="Close quote" onClick={closeQuote}>×</button>
      </div>
    </>
  ) : null

  return (
    <div
      ref={panelRef}
      style={{
        boxShadow: highlight ? `0 0 0 3px ${color.borderAmber}` : 'none',
        transition: 'box-shadow 0.4s ease',
        borderRadius: radius.md,
      }}
    >
      {externalOpen === undefined && (
        <button
          onClick={handleOpen}
          style={{ fontSize: fontSize.sm, color: color.textSlate, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
        >
          Bill text {open ? '▲' : '▼'}
        </button>
      )}

      {open && (
        <div style={{ marginTop: 8 }}>
          {allTexts.length > 0 && rows && groupBadges ? (
            // One row per bill in the group, each headed once by its badge (#712).
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {[...rows, ...(foreign && !baseTexts.some(t => t.docId === foreign.version.docId)
                ? [{ billId: foreign.billId, billNumber: foreign.billNumber ?? '', state: null as string | null, texts: [foreign.version] }]
                : [])].map(row => (
                <div key={row.billId} role="group" aria-label={`${row.billNumber} bill texts`} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* A flex slot, so no text baseline sets the badge lower than the chips. */}
                  <span style={{ minWidth: 52, display: 'inline-flex', alignItems: 'center' }}><BillBadge billNumber={row.billNumber} state={row.state} mini /></span>
                  {row.texts.map(t => (
                    <BillTextChip
                      key={t.docId}
                      type={t.type}
                      date={t.date}
                      selected={t.docId === selectedDocId}
                      onClick={() => handleSelectVersion(t.docId)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : allTexts.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              {allTexts.map(t => (
                <BillTextChip
                  key={t.docId}
                  billNumber={foreign && t.docId === foreign.version.docId ? foreign.billNumber ?? undefined : undefined}
                  type={t.type}
                  date={t.date}
                  selected={t.docId === selectedDocId}
                  onClick={() => handleSelectVersion(t.docId)}
                />
              ))}
            </div>
          )}

          {isPdf && !loadFailed && !inlinePdf ? (
            <>
            {quoteCaption}
            <div style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, background: color.surfaceSubtle, padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
              <p style={{ fontSize: fontSize.sm, color: color.textSecondary, margin: 0 }}>
                This browser can't show the PDF inline.
              </p>
              <a
                href={`${textUrl(selectedDocId)}${pageFragment}`}
                target="_blank"
                rel="noreferrer"
                style={{ background: color.billBadgeNavy, color: color.textOnFill, fontSize: fontSize.base, fontWeight: fontWeight.semibold, padding: '10px 20px', borderRadius: radius.md, textDecoration: 'none' }}
              >
                Open PDF <ExternalLinkIcon size={14} />
              </a>
              {selectedVersion?.stateLink && (
                <a href={selectedVersion.stateLink} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>
                  View on legislature <ExternalLinkIcon size={14} />
                </a>
              )}
            </div>
            </>
          ) : isPdf ? (
            <div>
              {quoteCaption}
              {!loadFailed && notPdf && (
                <p role="status" style={{ fontSize: fontSize.sm, color: color.textMuted, margin: '0 0 4px' }}>
                  This file isn't a PDF, so it isn't shown here.
                </p>
              )}
              {!loadFailed && !notPdf && (
                <>
                  <div style={{ height: pdfHeight, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, overflow: 'hidden' }}>
                    {loading ? (
                      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <p style={{ fontSize: fontSize.sm, color: color.textMuted, margin: 0 }}>Loading…</p>
                      </div>
                    ) : pdfBlobUrl ? (
                      // No `sandbox`: Chromium's PDF viewer renders in no sandboxed
                      // frame, under any value, so the safety is the blob's forced
                      // `application/pdf` type and the `%PDF-` check in `loadPdf`.
                      // A new frame for each request: a loaded viewer ignores a
                      // fragment-only change, so the page wouldn't move.
                      <iframe
                        key={`${selectedDocId}:${pdfRequest?.key ?? 'plain'}:${shownQuote}`}
                        src={`${pdfBlobUrl}${pageFragment}`}
                        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                        title="Bill text"
                      />
                    ) : null}
                  </div>
                  <ResizeHandle onPointerDown={handlePdfResize} />
                </>
              )}
              <div style={{ display: 'flex', gap: 12, marginTop: 4, alignItems: 'center' }}>
                {loadFailed && selectedVersion?.stateLink ? (
                  <span style={{ fontSize: fontSize.sm, color: color.textSecondary }}>
                    Text not cached —{' '}
                    <a href={selectedVersion.stateLink} target="_blank" rel="noreferrer" className="blue-link">
                      view PDF on legislature site <ExternalLinkIcon size={14} />
                    </a>
                  </span>
                ) : (
                  <>
                    {!loadFailed && <a href={`${textUrl(selectedDocId)}${pageFragment}`} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>Open in new tab <ExternalLinkIcon size={14} /></a>}
                    {!loadFailed && selectedVersion?.stateLink && <span style={{ color: color.borderStrong }}>·</span>}
                    {selectedVersion?.stateLink && (
                      <a href={selectedVersion.stateLink} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>
                        View on legislature <ExternalLinkIcon size={14} />
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div>
              {!loadFailed && (
                <>
                  <div style={{ overflow: 'hidden', height: htmlHeight, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md }}>
                    {loading ? (
                      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <p style={{ fontSize: fontSize.sm, color: color.textMuted, margin: 0 }}>Loading…</p>
                      </div>
                    ) : marked !== null && passageShown ? (
                      // The same sandbox as the plain text: no permissions at all.
                      // A new frame for each request, so each one's load moves focus.
                      <iframe
                        key={`passage:${passageShown.key}`}
                        srcDoc={marked}
                        sandbox=""
                        style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: color.white }}
                        title="Bill text, with the claim's passage highlighted"
                        onLoad={e => {
                          const frame = e.currentTarget
                          if (sentToPassage.current.has(frame)) {
                            const before = focusBefore.current.get(frame)
                            focusBefore.current.delete(frame)
                            if (before instanceof HTMLElement && document.activeElement === frame) before.focus({ preventScroll: true })
                            return
                          }
                          sentToPassage.current.add(frame)
                          if (focusedKeyRef.current === passageShown.key) {
                            focusBefore.current.set(frame, document.activeElement)
                            scrollToPassage(frame)
                          } else {
                            focusedKeyRef.current = passageShown.key
                            focusPassage(frame)
                          }
                        }}
                      />
                    ) : (
                      <iframe
                        srcDoc={content ?? ''}
                        sandbox=""
                        style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: color.white }}
                        title="Bill text"
                      />
                    )}
                  </div>
                  <ResizeHandle onPointerDown={handleHtmlResize} />
                  {passageMissing && (
                    <p role="status" style={{ fontSize: fontSize.sm, color: color.textMuted, margin: '4px 0 0' }}>
                      Couldn't find the passage in this version of the text.
                    </p>
                  )}
                </>
              )}
              <div style={{ display: 'flex', gap: 12, marginTop: 4, alignItems: 'center' }}>
                {loadFailed && selectedVersion?.stateLink ? (
                  <span style={{ fontSize: fontSize.sm, color: color.textSecondary }}>
                    Text not cached —{' '}
                    <a href={selectedVersion.stateLink} target="_blank" rel="noreferrer" className="blue-link">
                      view on legislature site <ExternalLinkIcon size={14} />
                    </a>
                  </span>
                ) : (
                  <>
                    {!loadFailed && <a href={textUrl(selectedDocId)} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>Open in new tab <ExternalLinkIcon size={14} /></a>}
                    {!loadFailed && selectedVersion?.stateLink && <span style={{ color: color.borderStrong }}>·</span>}
                    {selectedVersion?.stateLink && (
                      <a href={selectedVersion.stateLink} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>
                        View on legislature <ExternalLinkIcon size={14} />
                      </a>
                    )}
                    {(!loadFailed || selectedVersion?.stateLink) && selectedVersion?.altStateLink && <span style={{ color: color.borderStrong }}>·</span>}
                    {selectedVersion?.altStateLink && (
                      <a
                        href={selectedVersion.altStateLink}
                        download={`${parseHandle(textBillId(selectedDocId)) ?? textBillId(selectedDocId)}-${selectedVersion?.type ?? 'text'}.pdf`}
                        className="blue-link"
                        style={{ fontSize: fontSize.sm }}
                      >
                        Download PDF <DownloadIcon />
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
