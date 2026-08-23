import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { Wordmark } from '../components/Wordmark'
import { renderLegalMarkdown } from '../lib/legalMarkdown'
import { usePageTitle } from '../hooks/usePageTitle'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, fontSize, radius, shadow } from '../styles/tokens'

interface Props {
  /** Page + document title, e.g. "Terms of Use". */
  title: string
  /** Raw markdown for the document. */
  content: string
}

/**
 * Standalone legal document page: no sidebar, no app shell, no auth. Rendered by
 * the public /terms and /privacy routes with content supplied by the route.
 *
 * Demo tenants send the reader home instead. Both documents scope the Services to
 * an organization and its registered users, which a demo has none of, so serving
 * them here would present a contract to someone it does not govern. The links are
 * already hidden (see `legalVisibility.ts`); this closes the typed-URL path.
 *
 * The check needs its own request because this route renders outside every
 * provider — no DemoContext above it — and `/auth/demo-mode` is the public
 * endpoint the login page already uses for the same question. Rendering first and
 * redirecting when the answer arrives, rather than blocking on it, keeps real
 * tenants (where the answer is always "not a demo") free of a spinner.
 */
export function LegalPage({ title, content }: Props) {
  usePageTitle(title)
  const [isDemo, setIsDemo] = useState(false)
  useEffect(() => {
    let live = true
    apiFetch<{ demoMode: boolean }>('/auth/demo-mode')
      .then((r) => { if (live) setIsDemo(!!r.demoMode) })
      // A tenant whose /auth/demo-mode is down is not a demo as far as this can
      // tell, and the document is the safer thing to keep showing.
      .catch(() => {})
    return () => { live = false }
  }, [])
  if (isDemo) return <Navigate to="/" replace />
  const html = renderLegalMarkdown(content)
  return (
    <div style={{ minHeight: '100vh', background: color.bgLoginPage, padding: '40px 20px' }}>
      <div style={{
        maxWidth: 760, margin: '0 auto', background: color.white,
        border: `1px solid ${color.borderDefault}`, borderRadius: radius.xl,
        boxShadow: shadow.sm, padding: '40px 48px',
      }}>
        <div style={{ marginBottom: 24 }}>
          <Link to="/" style={{ textDecoration: 'none' }}><Wordmark /></Link>
        </div>
        <div
          style={{ fontSize: fontSize.base, color: color.textSlate, lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div style={{ marginTop: 32, paddingTop: 20, borderTop: `1px solid ${color.borderDefault}` }}>
          <Link to="/" style={{ fontSize: fontSize.sm, color: color.textMuted }}>← Back to {PRODUCT_NAME}</Link>
        </div>
      </div>
    </div>
  )
}
