import { useState, useEffect, useRef } from 'react'
import { useVerticalResize, ResizeHandle } from './ResizeHandle'
import { BillTextChip } from './BillTextChip'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import { getScrollContainer } from '../lib/scrollUtils'
import { color, radius, fontSize } from '../styles/tokens'

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

interface BillTextPanelProps {
  billId: string
  texts: TextVersion[]
  externalOpen?: boolean
  requestedDocId?: string | null
}

export function BillTextPanel({ billId, texts, externalOpen, requestedDocId }: BillTextPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = externalOpen !== undefined ? externalOpen : internalOpen
  const [selectedDocId, setSelectedDocId] = useState<string | null>(
    texts.length > 0 ? texts[0].docId : null
  )
  const [loadedContent, setLoadedContent] = useState<Map<string, string>>(new Map())
  const [pdfBlobUrls, setPdfBlobUrls] = useState<Map<string, string>>(new Map())
  const [failedDocIds, setFailedDocIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const blobUrlsRef = useRef<Map<string, string>>(new Map())
  const panelRef = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState(false)

  const selectedVersion = texts.find(t => t.docId === selectedDocId) ?? texts[0] ?? null
  const isPdf = selectedVersion?.mime === 'application/pdf'
  const { height: pdfHeight, handlePointerDown: handlePdfResize } = useVerticalResize(480, 200)
  const { height: htmlHeight, handlePointerDown: handleHtmlResize } = useVerticalResize(320, 200)

  // Revoke all blob URLs on unmount — capture ref value at effect time per react-hooks/exhaustive-deps
  useEffect(() => {
    const blobUrls = blobUrlsRef.current
    return () => { blobUrls.forEach(url => URL.revokeObjectURL(url)) }
  }, [])

  // Load content when panel opens or version changes
  useEffect(() => {
    if (!open || selectedDocId === null) return
    const version = texts.find(t => t.docId === selectedDocId)
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

    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedDocId, texts])

  async function loadPdf(docId: string) {
    setLoading(true)
    try {
      const res = await fetch(`/api/bills/${billId}/text/${docId}`, { credentials: 'include' })
      if (!res.ok) {
        setFailedDocIds(prev => new Set(prev).add(docId))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      blobUrlsRef.current.set(docId, url)
      setPdfBlobUrls(prev => new Map(prev).set(docId, url))
    } finally {
      setLoading(false)
    }
  }

  async function loadText(docId: string) {
    setLoading(true)
    try {
      const res = await fetch(`/api/bills/${billId}/text/${docId}`, { credentials: 'include' })
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
      setLoading(false)
    }
  }

  async function handleOpen() {
    if (!open && selectedDocId !== null) {
      const version = texts.find(t => t.docId === selectedDocId)
      if (version?.mime === 'application/pdf') {
        if (!blobUrlsRef.current.has(selectedDocId)) await loadPdf(selectedDocId)
      } else {
        if (!loadedContent.has(selectedDocId)) await loadText(selectedDocId)
      }
    }
    setInternalOpen(s => !s)
  }

  async function handleSelectVersion(docId: string) {
    setSelectedDocId(docId)
    const version = texts.find(t => t.docId === docId)
    if (version?.mime === 'application/pdf') {
      if (!blobUrlsRef.current.has(docId)) await loadPdf(docId)
    } else {
      if (!loadedContent.has(docId)) await loadText(docId)
    }
  }

  if (texts.length === 0) {
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

  const content = selectedDocId !== null ? (loadedContent.get(selectedDocId) ?? null) : null
  const pdfBlobUrl = selectedDocId !== null ? (pdfBlobUrls.get(selectedDocId) ?? null) : null
  const loadFailed = selectedDocId !== null && failedDocIds.has(selectedDocId)

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
          {texts.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              {texts.map(t => (
                <BillTextChip
                  key={t.docId}
                  type={t.type}
                  date={t.date}
                  selected={t.docId === selectedDocId}
                  onClick={() => handleSelectVersion(t.docId)}
                />
              ))}
            </div>
          )}

          {isPdf ? (
            <div>
              {!loadFailed && (
                <>
                  <div style={{ height: pdfHeight, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, overflow: 'hidden' }}>
                    {loading ? (
                      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <p style={{ fontSize: fontSize.sm, color: color.textMuted, margin: 0 }}>Loading…</p>
                      </div>
                    ) : pdfBlobUrl ? (
                      <iframe
                        src={pdfBlobUrl}
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
                    {!loadFailed && <a href={`/api/bills/${billId}/text/${selectedDocId}`} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>Open in new tab <ExternalLinkIcon size={14} /></a>}
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
                    {!loadFailed && <a href={`/api/bills/${billId}/text/${selectedDocId}`} target="_blank" rel="noreferrer" className="blue-link" style={{ fontSize: fontSize.sm }}>Open in new tab <ExternalLinkIcon size={14} /></a>}
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
                        download={`${billId.replace('legiscan:', '')}-${selectedVersion?.type ?? 'text'}.pdf`}
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
