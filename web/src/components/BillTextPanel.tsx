import { useState, useEffect, useId, useMemo, useRef } from 'react'
import { useVerticalResize, ResizeHandle } from './ResizeHandle'
import { BillTextChip } from './BillTextChip'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import { getScrollContainer } from '../lib/scrollUtils'
import { canRenderPdfInline } from '../lib/pdfInline'
import { parseHandle } from '../../../shared/billHandle'
import { focusPassage, markPassage, PASSAGE_ID, type ClaimDocument, type Span } from '../lib/claimLinks'
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
export type HtmlPassageRequest = RequestBase & { matched: string; quoteAt: Span; quote?: undefined; page?: undefined }

/**
 * A PDF claim (#572): the page the model cited (null when it gave none, and
 * anything that isn't a page number opens at page 1) and the quote to show
 * beside the PDF. The quote was never matched, so nothing is highlighted.
 */
export type PdfPageRequest = RequestBase & { quote: string; page: number | null; matched?: undefined; quoteAt?: undefined }

export type PassageRequest = HtmlPassageRequest | PdfPageRequest

const isPdfRequest = (r: PassageRequest): r is PdfPageRequest => r.quote !== undefined

interface BillTextPanelProps {
  billId: string
  texts: TextVersion[]
  externalOpen?: boolean
  requestedDocId?: string | null
  passage?: PassageRequest | null
}

export function BillTextPanel({ billId, texts, externalOpen, requestedDocId, passage }: BillTextPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = externalOpen !== undefined ? externalOpen : internalOpen
  const [selectedDocId, setSelectedDocId] = useState<string | null>(
    texts.length > 0 ? texts[0].docId : null
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

  // Another bill's version: the analyzed member's document a claim on a
  // companion's page opens, which is never in this bill's list (#571).
  const [foreign, setForeign] = useState<{ billId: string; billNumber: string | null; version: TextVersion } | null>(null)
  // The claim passage being shown, until the reader picks a version.
  const [activePassage, setActivePassage] = useState<PassageRequest | null>(null)
  const allTexts = foreign && !texts.some(t => t.docId === foreign.version.docId) ? [...texts, foreign.version] : texts
  const textBillId = (docId: string | null) => (foreign && docId === foreign.version.docId ? foreign.billId : billId)
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
    const target = texts.find(t => t.docId === requestedDocId)
    if (!target) return
    void handleSelectVersion(requestedDocId)
    const rafId = reveal()
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedDocId, texts])

  // A claim's passage (#571): open its document, beside this bill's versions
  // when it is another bill's, and show it highlighted. The frame takes focus
  // when it loads (below).
  useEffect(() => {
    if (!passage) return
    consumedPassageRef.current = passage.key
    const doc = passage.document
    const own = passage.billId === billId && texts.some(t => t.docId === doc.docId)
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
  // put in before it renders, and the frame loads at the mark's fragment so the
  // browser scrolls to it (lib/claimLinks.ts). A blob URL, unlike srcdoc, can
  // carry the fragment. Null when the passage isn't in the document.
  const requestShown = activePassage && activePassage.document.docId === selectedDocId ? activePassage : null
  const passageShown = requestShown && !isPdfRequest(requestShown) ? requestShown : null
  const marked = useMemo(() => (passageShown && content !== null ? markPassage(content, passageShown) : null), [passageShown, content])
  const passageMissing = passageShown !== null && content !== null && marked === null
  const [passageUrl, setPassageUrl] = useState<string | null>(null)
  useEffect(() => {
    if (marked === null) {
      setPassageUrl(null)
      return
    }
    const url = URL.createObjectURL(new Blob([marked], { type: 'text/html;charset=utf-8' }))
    setPassageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [marked, passageShown?.key])
  // Focus moves to the passage's frame once per request, when it loads.
  const focusedUrlRef = useRef<string | null>(null)

  // A PDF claim (#572): the PDF opens at the cited page, and its quote shows
  // beside it, since the page can't highlight a PDF. Focus moves to the quote,
  // once per request, so a keyboard or screen reader user gets it.
  const pdfRequest = requestShown && isPdfRequest(requestShown) ? requestShown : null
  const pdfTarget = pdfRequest ? pdfPageTarget(pdfRequest.page) : null
  const pageFragment = pdfTarget ? `#page=${pdfTarget.page}` : ''
  const captionRef = useRef<HTMLDivElement>(null)
  const captionId = `pdf-quote${useId()}`
  const focusedRequestRef = useRef<number | null>(null)
  const pdfRequestKey = pdfRequest?.key ?? null
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
  const quoteCaption = pdfRequest && pdfTarget ? (
    <div
      ref={captionRef}
      tabIndex={-1}
      role="group"
      aria-label="Quote behind the claim you opened"
      // Focus lands here, and not every screen reader reads a group's contents
      // on focus, so the page line and the quote are its description.
      aria-describedby={`${captionId}-page ${captionId}-quote`}
      style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, background: color.surfaceSubtle, padding: '8px 12px', marginBottom: 8 }}
    >
      <p id={`${captionId}-page`} style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textSecondary, margin: 0 }}>{describePageTarget(pdfTarget)}</p>
      <blockquote id={`${captionId}-quote`} style={{ fontSize: fontSize.sm, color: color.textSlate, margin: '4px 0 0' }}>{`“${pdfRequest.quote}”`}</blockquote>
    </div>
  ) : null

  return (
    <div
      ref={panelRef}
      style={{
        boxShadow: highlight ? '0 0 0 3px #fde68a' : 'none',
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
          {allTexts.length > 0 && (
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
                style={{ background: color.billBadgeNavy, color: color.white, fontSize: fontSize.base, fontWeight: fontWeight.semibold, padding: '10px 20px', borderRadius: radius.md, textDecoration: 'none' }}
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
                        key={`${selectedDocId}:${pdfRequest?.key ?? 'plain'}`}
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
                    ) : passageUrl && passageShown ? (
                      // The same sandbox as the plain text: no permissions at all.
                      <iframe
                        key={passageUrl}
                        src={`${passageUrl}#${PASSAGE_ID}`}
                        sandbox=""
                        style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: color.white }}
                        title="Bill text, with the claim's passage highlighted"
                        onLoad={e => {
                          if (focusedUrlRef.current === passageUrl) return
                          focusedUrlRef.current = passageUrl
                          focusPassage(e.currentTarget, passageUrl)
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
